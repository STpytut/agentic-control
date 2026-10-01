-- Revocation at dispatch (Stage 11.4, sprint B A4; ADR-0018).
--
-- A task's snapshot fixes the model it runs on and, with it, the connection
-- that model is reached through (0028, 0083). Nothing asked that connection
-- again: a job routed while the connection was live, and dispatched after the
-- operator disconnected it — or after its key expired, or needed action — was
-- launched against a credential the operator had withdrawn, failed as a
-- transient error, and was retried against it until its attempts ran out.
--
-- The connection is now asked where the runtime already is (0072), at each
-- point a job can meet a revocation:
--
--   claim     — claim_executor_jobs and claim_orchestrator_jobs. A job whose
--               connection is revoked is claimed and ended in the same
--               transaction, so it leaves exactly as a refused launch does:
--               with its run closed, and a review turn's task where a retry
--               expects it. It is not handed to the worker.
--   launch    — record_runtime_dispatch, the last statement before a process
--               is spawned, refuses it with the reason.
--   report    — retry_runtime_job ends, instead of retrying, a job whose
--               connection is revoked: the refused launch, and a process that
--               failed because its credential went away under it.
--   recovery  — retry_dead_letter_job refuses to put the job back while the
--               connection is still revoked.
--
-- Revoked means: the connection's row is gone, its status is anything but
-- connected (disconnected, expired, action_required, pending_finalize), or the
-- operator has asked for it to be disconnected and the broker has not yet done
-- it — the operator's decision is made when they ask. The connection's row is
-- read under a share lock, which every revocation's UPDATE conflicts with, so a
-- dispatch and a revocation are ordered and never interleaved.
--
-- A job whose task has no catalog snapshot (a runtime profile's model, before
-- 0028) names no connection and is not asked.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('model_access_revoked','unavailable','the connection this task''s model is reached through was disconnected, expired or needs action');

-- The connection the job's model is reached through, as the task's snapshot
-- recorded it: the orchestrator's for a turn, and for an implementation the
-- executor entry its launch resolves to (resolve_executor_launch_model).
CREATE FUNCTION job_model_connection(p_job runtime_jobs)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $function$
  WITH snap AS (SELECT get_task_runtime_snapshot(p_job.task_id) AS s)
  SELECT CASE
    WHEN p_job.job_type IN ('orchestrator_turn','resume_orchestrator') THEN
      NULLIF(snap.s->'orchestrator'->>'connection_id','')::uuid
    ELSE (
      SELECT COALESCE(NULLIF(e->>'connection_id','')::uuid, m.connection_id)
      FROM jsonb_array_elements(snap.s->'executors') e
      LEFT JOIN provider_model_catalog m ON m.id=NULLIF(e->>'entry_id','')::uuid
      WHERE e->>'entry_id' = resolve_executor_launch_model(p_job.id)->>'snapshot_entry_id'
      LIMIT 1)
  END
  FROM snap
  WHERE snap.s->>'source'='catalog';
$function$;

-- The job's connection when it is revoked, NULL when it is live or the job
-- names none. SECURITY DEFINER for the share lock, which asks for more than the
-- worker may do to the row.
CREATE FUNCTION revoked_model_access(p_job runtime_jobs)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $function$
DECLARE v_connection uuid; v_status text; v_action text;
BEGIN
  v_connection:=job_model_connection(p_job);
  IF v_connection IS NULL THEN RETURN NULL; END IF;
  SELECT c.status, c.broker_requested_action INTO v_status, v_action
  FROM provider_connections c WHERE c.id=v_connection FOR SHARE;
  IF NOT FOUND OR v_status<>'connected' OR v_action='disconnect' THEN
    RETURN v_connection;
  END IF;
  RETURN NULL;
END $function$;

-- The claims, one job at a time so each can be ended in place. A claimed job
-- matches no longer (in flight under a live lease, or ended), and the ids
-- already taken are skipped besides, so a lease that is already over cannot
-- bring one back into the loop.
CREATE OR REPLACE FUNCTION claim_executor_jobs(p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT '00:05:00'::interval)
 RETURNS SETOF runtime_jobs
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_id bigint; v_job runtime_jobs%ROWTYPE; v_revoked uuid; v_seen bigint[] := '{}'; v_taken integer := 0;
BEGIN
  LOOP
    EXIT WHEN v_taken >= GREATEST(p_limit,0);
    SELECT j.id INTO v_id FROM runtime_jobs j
    WHERE j.job_type = 'implementation_run' AND j.available_at<=clock_timestamp()
      AND (j.status='pending' OR (j.status='in_flight' AND j.leased_until<=clock_timestamp()))
      AND ingress_blocker(j.id) IS NULL
      AND j.id <> ALL (v_seen)
    ORDER BY j.available_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1;
    EXIT WHEN NOT FOUND;
    v_seen := v_seen || v_id;
    UPDATE runtime_jobs j
    SET status='in_flight',attempt_count=j.attempt_count+1,leased_by=p_worker_id,
        leased_until=clock_timestamp()+p_lease,last_error=NULL,
        activity_phase='starting_runtime',activity_detail='Preparing the selected executor runtime',
        started_at=COALESCE(j.started_at,clock_timestamp()),heartbeat_at=clock_timestamp()
    WHERE j.id=v_id RETURNING j.* INTO v_job;
    v_revoked := revoked_model_access(v_job);
    IF v_revoked IS NOT NULL THEN
      PERFORM end_runtime_job(v_job.id, p_worker_id, 'model_access_revoked',
        format('job %s was not dispatched: connection %s of its model is no longer connected', v_job.id, v_revoked));
      CONTINUE;
    END IF;
    v_taken := v_taken + 1;
    RETURN NEXT v_job;
  END LOOP;
END $function$;

CREATE OR REPLACE FUNCTION claim_orchestrator_jobs(p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT '00:05:00'::interval)
 RETURNS SETOF runtime_jobs
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_id bigint; v_job runtime_jobs%ROWTYPE; v_revoked uuid; v_seen bigint[] := '{}'; v_taken integer := 0;
BEGIN
  LOOP
    EXIT WHEN v_taken >= GREATEST(p_limit,0);
    SELECT j.id INTO v_id FROM runtime_jobs j
    WHERE j.job_type IN ('orchestrator_turn','resume_orchestrator')
      AND j.available_at<=clock_timestamp()
      AND (j.status='pending' OR (j.status='in_flight' AND j.leased_until<=clock_timestamp()))
      AND NOT EXISTS (
        SELECT 1 FROM runtime_jobs earlier
        WHERE earlier.job_type IN ('orchestrator_turn','resume_orchestrator')
          AND earlier.task_id=j.task_id AND earlier.id<j.id
          AND earlier.status IN ('pending','in_flight')
      )
      AND NOT workspace_has_foreign_writer(j.project_id, NULL)
      -- 0070: a run of this conversation is live, or an earlier message has not
      -- run yet. The job waits, in order, and becomes a run after it.
      AND ingress_blocker(j.id) IS NULL
      AND j.id <> ALL (v_seen)
    ORDER BY j.available_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1;
    EXIT WHEN NOT FOUND;
    v_seen := v_seen || v_id;
    UPDATE runtime_jobs j
    SET status='in_flight',attempt_count=j.attempt_count+1,leased_by=p_worker_id,
        leased_until=clock_timestamp()+p_lease,last_error=NULL,
        activity_phase='starting_runtime',activity_detail='Preparing the Codex runtime',
        started_at=COALESCE(j.started_at,clock_timestamp()),heartbeat_at=clock_timestamp()
    WHERE j.id=v_id RETURNING j.* INTO v_job;
    IF v_job.job_type = 'resume_orchestrator' THEN
      UPDATE tasks t SET status='reviewing',version=t.version+1,updated_at=clock_timestamp()
      WHERE t.id=v_job.task_id AND t.status='awaiting_review';
    END IF;
    v_revoked := revoked_model_access(v_job);
    IF v_revoked IS NOT NULL THEN
      PERFORM end_runtime_job(v_job.id, p_worker_id, 'model_access_revoked',
        format('job %s was not dispatched: connection %s of its model is no longer connected', v_job.id, v_revoked));
      CONTINUE;
    END IF;
    v_taken := v_taken + 1;
    RETURN NEXT v_job;
  END LOOP;
END $function$;

CREATE OR REPLACE FUNCTION control_plane.record_runtime_dispatch(p_job_id bigint, p_worker_id text, p_launch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_job runtime_jobs%ROWTYPE; v_run task_runs%ROWTYPE; v_grant workspace_access_grants%ROWTYPE;
  v_assignment project_agent_assignments%ROWTYPE; v_runtime text; v_selection runtime_job_selections%ROWTYPE;
  v_capabilities text[]; v_attempt runtime_dispatch_attempts%ROWTYPE; v_reused boolean := true;
  v_blocked text; v_revoked uuid;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'in_flight' OR v_job.leased_by IS DISTINCT FROM p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    PERFORM refuse('run_command_not_leased', format('job %s is not leased by %s', p_job_id, p_worker_id));
  END IF;
  -- Every term IS DISTINCT FROM, not <>: a missing key is NULL, and one NULL
  -- term makes the whole OR NULL, which IF reads as false — the hole 0068
  -- closed in a guard and f519986 in a test.
  IF p_launch IS NULL OR jsonb_typeof(p_launch) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_launch->'capabilities') IS DISTINCT FROM 'array'
     OR COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p_launch->'capabilities')='array' THEN p_launch->'capabilities' END),0)=0
     OR COALESCE(p_launch->>'runtime','')='' OR COALESCE(p_launch->>'adapter_version','')=''
     OR COALESCE(p_launch->>'executable','')='' OR COALESCE(p_launch->>'surface','')=''
     OR COALESCE(p_launch->>'capability_verification','') NOT IN ('verified','unverified') THEN
    PERFORM refuse('runtime_selection_invalid', 'a launch names its runtime, adapter version, executable, surface, capabilities and verification', '22023');
  END IF;
  SELECT array_agg(value ORDER BY value) INTO v_capabilities FROM jsonb_array_elements_text(p_launch->'capabilities');

  v_run.id:=active_run_of_job(v_job);
  IF v_run.id IS NOT NULL THEN SELECT * INTO v_run FROM task_runs WHERE id=v_run.id; END IF;
  SELECT * INTO v_grant FROM workspace_access_grants
  WHERE run_id=v_run.id ORDER BY (revoked_at IS NULL) DESC, issued_at DESC LIMIT 1;
  IF v_grant.id IS NULL THEN
    PERFORM refuse('runtime_selection_no_grant', format('run %s of job %s holds no workspace grant', v_run.id, p_job_id));
  END IF;
  SELECT * INTO v_assignment FROM project_agent_assignments WHERE id=v_grant.assignment_id;
  SELECT rp.runtime_type INTO v_runtime FROM runtime_profiles rp WHERE rp.id=v_assignment.runtime_profile_id;
  IF v_runtime IS DISTINCT FROM p_launch->>'runtime' THEN
    PERFORM refuse('runtime_selection_mismatch',
      format('job %s selected %s through its assignment, and the launch is %s', p_job_id, v_runtime, p_launch->>'runtime'));
  END IF;
  -- 0072: the runtime as the host last reported it, read under a share lock on
  -- the one row the report writes. A removal that has written and not yet
  -- committed is waited for and then seen; one that comes after waits for this
  -- launch to commit and meets it as a running process instead. Either way the
  -- launch and the removal are ordered, never interleaved.
  v_blocked:=runtime_undispatchable_reason(v_runtime);
  IF v_blocked IS NOT NULL THEN
    PERFORM refuse(v_blocked, format('job %s cannot launch %s: %s', p_job_id, v_runtime,
      (SELECT note FROM failure_reasons WHERE reason=v_blocked)));
  END IF;
  -- 0084: the connection the task's model reaches its models through, read
  -- under a share lock on its row. A revocation written and not yet committed
  -- is waited for and then seen; one that comes after waits for this launch.
  v_revoked:=revoked_model_access(v_job);
  IF v_revoked IS NOT NULL THEN
    PERFORM refuse('model_access_revoked', format('job %s cannot launch: connection %s of its model is no longer connected',
      p_job_id, v_revoked));
  END IF;

  v_selection:=current_runtime_job_selection(p_job_id);
  IF v_selection.id IS NULL OR v_selection.source='backfill' THEN
    INSERT INTO runtime_job_selections(job_id,project_id,task_id,source,supersedes,supersede_reason,
      assignment_id,agent_id,runtime_type,adapter_version,runtime_version,verified_runtime_version,
      capability_verification,capabilities,session_id,access_mode,model,selected_by)
    VALUES(v_job.id,v_job.project_id,v_job.task_id,
      CASE WHEN v_selection.id IS NULL THEN 'launch' ELSE 'supersede' END,
      v_selection.id, CASE WHEN v_selection.id IS NULL THEN NULL ELSE 'the first launch recorded under 0071 replaces a backfilled selection' END,
      v_assignment.id,v_assignment.agent_id,v_runtime,p_launch->>'adapter_version',p_launch->>'runtime_version',
      p_launch->>'verified_runtime_version',p_launch->>'capability_verification',v_capabilities,
      v_run.session_id,v_grant.mode,NULLIF(p_launch->>'model',''),p_worker_id)
    RETURNING * INTO v_selection;
    v_reused:=false;
  ELSIF v_selection.assignment_id IS DISTINCT FROM v_assignment.id
     OR v_selection.runtime_type IS DISTINCT FROM v_runtime
     OR v_selection.access_mode IS DISTINCT FROM v_grant.mode THEN
    -- A retry that would run for another assignment, on another runtime or
    -- with other access. Recording it over the first selection is exactly the
    -- history this table exists to keep, and choosing it is not a launcher's.
    PERFORM refuse('runtime_selection_changed',
      format('job %s was selected as %s for assignment %s with %s access, and this launch is %s for %s with %s',
        p_job_id, v_selection.runtime_type, v_selection.assignment_id, v_selection.access_mode,
        v_runtime, v_assignment.id, v_grant.mode));
  ELSIF v_selection.adapter_version IS DISTINCT FROM p_launch->>'adapter_version'
     OR v_selection.runtime_version IS DISTINCT FROM p_launch->>'runtime_version'
     OR v_selection.capabilities IS DISTINCT FROM v_capabilities THEN
    -- The same selection on a host whose runtime or driver moved between
    -- attempts (a `runtime install`, a release). Not an update: a superseding
    -- selection that names the old one and says what changed.
    INSERT INTO runtime_job_selections(job_id,project_id,task_id,source,supersedes,supersede_reason,
      assignment_id,agent_id,runtime_type,adapter_version,runtime_version,verified_runtime_version,
      capability_verification,capabilities,session_id,access_mode,model,selected_by)
    VALUES(v_job.id,v_job.project_id,v_job.task_id,'supersede',v_selection.id,
      left(format('the runtime moved between attempts: adapter %s -> %s, runtime %s -> %s%s',
        v_selection.adapter_version, p_launch->>'adapter_version',
        COALESCE(v_selection.runtime_version,'unknown'), COALESCE(p_launch->>'runtime_version','unknown'),
        CASE WHEN v_selection.capabilities IS DISTINCT FROM v_capabilities THEN ', declared capabilities changed' ELSE '' END),500),
      v_assignment.id,v_assignment.agent_id,v_runtime,p_launch->>'adapter_version',p_launch->>'runtime_version',
      p_launch->>'verified_runtime_version',p_launch->>'capability_verification',v_capabilities,
      v_selection.session_id,v_grant.mode,COALESCE(NULLIF(p_launch->>'model',''),v_selection.model),p_worker_id)
    RETURNING * INTO v_selection;
    v_reused:=false;
  END IF;

  INSERT INTO runtime_dispatch_attempts(job_id,selection_id,attempt_number,run_id,runtime_type,executable,
    adapter_version,runtime_version,capability_verification,session_id,native_session_id,grant_id,access_mode,
    worker_id,surface)
  VALUES(v_job.id,v_selection.id,GREATEST(v_job.attempt_count,1),v_run.id,v_runtime,p_launch->>'executable',
    p_launch->>'adapter_version',p_launch->>'runtime_version',p_launch->>'capability_verification',
    v_run.session_id,NULLIF(p_launch->>'native_session_id',''),v_grant.id,v_grant.mode,p_worker_id,p_launch->>'surface')
  RETURNING * INTO v_attempt;

  RETURN jsonb_build_object('selection_id',v_selection.id,'selection_reused',v_reused,'attempt_id',v_attempt.id,
    'attempt_number',v_attempt.attempt_number,'runtime_type',v_runtime,'access_mode',v_grant.mode,
    'assignment_id',v_assignment.id,'grant_id',v_grant.id);
END $function$;

CREATE OR REPLACE FUNCTION control_plane.retry_runtime_job(p_job_id bigint, p_supervisor_id text, p_error text, p_delay interval DEFAULT '00:00:10'::interval, p_max_attempts integer DEFAULT 5)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE; v_reason text;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  -- The same SQLSTATE 0003 raised, now with the reason beside it.
  IF NOT FOUND THEN PERFORM refuse('job_not_found', format('no runtime job %s', p_job_id)); END IF;
  IF v_job.status<>'in_flight' THEN
    PERFORM refuse('job_not_in_flight', format('runtime job %s is %s, not leased by supervisor %s', p_job_id, v_job.status, p_supervisor_id));
  END IF;
  IF v_job.leased_by IS DISTINCT FROM p_supervisor_id THEN
    PERFORM refuse('job_lease_held_by_another', format('runtime job %s is not leased by supervisor %s', p_job_id, p_supervisor_id));
  END IF;
  v_reason:=runtime_undispatchable_reason(runtime_job_runtime(v_job));
  -- 0084: a job whose model's connection was revoked is not retried against it.
  IF v_reason IS NULL AND revoked_model_access(v_job) IS NOT NULL THEN
    v_reason:='model_access_revoked';
  END IF;
  IF v_reason IS NULL AND v_job.attempt_count - v_job.attempt_base >= p_max_attempts THEN
    v_reason:='runtime_attempts_exhausted';
  END IF;
  IF v_reason IS NOT NULL THEN
    PERFORM end_runtime_job(p_job_id, p_supervisor_id, v_reason, p_error);
    RETURN 'dead_letter';
  END IF;
  UPDATE runtime_jobs SET status='pending',available_at=clock_timestamp()+p_delay,
    leased_by=NULL,leased_until=NULL,last_error=left(p_error,4000)
  WHERE id=p_job_id;
  RETURN 'pending';
END $function$;

CREATE OR REPLACE FUNCTION control_plane.retry_dead_letter_job(p_job_id bigint, p_attempt integer, p_owner_id uuid, p_actor text, p_note text, p_correlation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE; v_recovery runtime_job_recoveries%ROWTYPE; v_task tasks%ROWTYPE;
  v_blocked text; v_runtime text; v_handoff handoffs%ROWTYPE; v_lock workspace_locks%ROWTYPE;
  v_selection runtime_job_selections%ROWTYPE; v_reported text; v_superseded boolean := false; v_audit uuid;
  v_event domain_events%ROWTYPE; v_locked record;
BEGIN
  IF p_note IS NULL OR length(trim(p_note)) < 3 OR length(p_note) > 2000 THEN
    PERFORM refuse('dead_letter_note_invalid', 'a retry says why, in 3 to 2000 characters', '22023');
  END IF;
  SELECT * INTO v_locked FROM locked_dead_letter(p_job_id, p_attempt, p_owner_id, 'retry');
  v_job:=v_locked.o_job; v_recovery:=v_locked.o_recovery;
  IF v_recovery.id IS NOT NULL THEN
    -- The same click again: the answer it already had.
    RETURN jsonb_build_object('job_id',v_job.id,'recovery_id',v_recovery.id,'action','retry','repeat',true,
      'status',v_job.status,'selection_id',v_recovery.selection_id,'selection_superseded',v_recovery.selection_superseded);
  END IF;

  SELECT * INTO v_task FROM tasks WHERE id=v_job.task_id FOR UPDATE;
  IF v_task.status IN ('approved','publishing','deployed','completed','cancelled','failed') THEN
    PERFORM refuse('dead_letter_task_closed', format('task %s is %s', v_task.id, v_task.status));
  END IF;
  -- Nothing to retry into while the runtime is still gone: restore it first.
  v_runtime:=runtime_job_runtime(v_job);
  v_blocked:=runtime_undispatchable_reason(v_runtime);
  IF v_blocked IS NOT NULL THEN
    PERFORM refuse(v_blocked, format('job %s runs on %s: %s; restore it, then retry',
      p_job_id, v_runtime, (SELECT note FROM failure_reasons WHERE reason=v_blocked)));
  END IF;
  -- 0084: nor while the connection of the task's model is revoked: reconnect it first.
  IF revoked_model_access(v_job) IS NOT NULL THEN
    PERFORM refuse('model_access_revoked', format('job %s: connection %s of its model is no longer connected; reconnect it, then retry',
      p_job_id, revoked_model_access(v_job)));
  END IF;

  IF v_job.job_type = 'implementation_run' THEN
    SELECT h.* INTO v_handoff FROM domain_events e JOIN handoffs h ON h.id=NULLIF(e.payload->>'handoff_id','')::uuid
    WHERE e.id=v_job.source_event_id;
    IF v_task.status NOT IN ('needs_attention','implementation_requested','implementing','revising')
       OR EXISTS (SELECT 1 FROM handoffs h WHERE h.task_id=v_task.id AND h.revision_number>v_handoff.revision_number)
       OR v_handoff.to_agent_id IS DISTINCT FROM v_task.active_agent_id
       OR EXISTS (SELECT 1 FROM runtime_jobs o WHERE o.task_id=v_task.id AND o.id<>v_job.id
                  AND o.job_type = 'implementation_run' AND o.status IN ('pending','in_flight')) THEN
      PERFORM refuse('dead_letter_superseded',
        format('task %s is %s and has moved past handoff %s', v_task.id, v_task.status, v_handoff.revision_number));
    END IF;
    -- Released is the only state a new run can start from. Held is another
    -- run's; reconciliation_required and expired are the operator's to recover
    -- first (request_workspace_operation), not something a retry steps over.
    SELECT * INTO v_lock FROM workspace_locks WHERE project_id=v_job.project_id FOR UPDATE;
    IF v_lock.status IS DISTINCT FROM 'released' AND v_lock.project_id IS NOT NULL THEN
      PERFORM refuse('dead_letter_workspace_busy',
        format('the workspace is %s%s', v_lock.status,
          CASE WHEN v_lock.owner_run_id IS NOT NULL THEN ' by run '||v_lock.owner_run_id ELSE '' END));
    END IF;
  ELSIF v_job.job_type = 'resume_orchestrator' AND v_task.status<>'reviewing' THEN
    PERFORM refuse('dead_letter_superseded', format('task %s is %s, no longer waiting for this review', v_task.id, v_task.status));
  ELSIF EXISTS (SELECT 1 FROM runtime_jobs o WHERE o.task_id=v_task.id AND o.id>v_job.id
                AND o.job_type IN ('orchestrator_turn','resume_orchestrator') AND o.status='completed') THEN
    PERFORM refuse('dead_letter_superseded', format('a later turn of task %s has already answered', v_task.id));
  END IF;

  -- The selection (0071): reused when the host reports the version it
  -- recorded; superseded, saying from what to what, when it reports another.
  v_selection:=current_runtime_job_selection(v_job.id);
  IF v_selection.id IS NOT NULL AND v_selection.source<>'backfill' THEN
    SELECT e->>'version' INTO v_reported FROM runtime_health h, jsonb_array_elements(h.snapshot->'runtimes') e
    WHERE h.singleton AND e->>'runtime'=v_selection.runtime_type;
    IF v_reported IS NOT NULL AND v_reported IS DISTINCT FROM v_selection.runtime_version THEN
      PERFORM supersede_runtime_job_selection(v_job.id, p_actor,
        format('retried from dead letter (%s): the host reports %s %s, the selection recorded %s',
          v_job.failure_reason, v_selection.runtime_type, v_reported, COALESCE(v_selection.runtime_version,'no version')),
        jsonb_build_object('runtime_version', v_reported));
      v_selection:=current_runtime_job_selection(v_job.id);
      v_superseded:=true;
    END IF;
  END IF;

  INSERT INTO runtime_job_recoveries(job_id,project_id,task_id,action,dead_letter_attempt,recovered_from,last_error,
    actor,note,selection_id,selection_superseded,correlation_id)
  VALUES(v_job.id,v_job.project_id,v_job.task_id,'retry',v_job.attempt_count,v_job.failure_reason,left(v_job.last_error,2000),
    p_actor,trim(p_note),v_selection.id,v_superseded,p_correlation_id)
  RETURNING * INTO v_recovery;

  -- The same job, back in the queue with the worker's whole budget. An
  -- implementation starts a new run under a new lock: its old run ended with
  -- the dead letter, and the start result that named it is cleared so
  -- start_implementation_job does not hand it back.
  UPDATE runtime_jobs SET status='pending',available_at=clock_timestamp(),attempt_base=attempt_count,
    last_error=NULL,completed_at=NULL,
    run_id=CASE WHEN job_type = 'implementation_run' THEN NULL ELSE run_id END,
    result=CASE WHEN job_type = 'implementation_run' THEN NULL ELSE result END,
    activity_detail='Retried by the operator'
  WHERE id=v_job.id RETURNING * INTO v_job;
  IF v_job.job_type = 'implementation_run' AND v_task.status<>'implementation_requested' THEN
    UPDATE tasks SET status='implementation_requested',version=version+1,updated_at=clock_timestamp()
    WHERE id=v_task.id RETURNING * INTO v_task;
    v_event:=append_event('runtime_job.retried',v_job.project_id,v_job.task_id,NULL,'user',p_actor,NULL,
      COALESCE(p_correlation_id,v_task.id::text),'dead-letter-retry:'||v_recovery.id,'task',v_task.id,v_task.version,
      jsonb_build_object('job_id',v_job.id,'recovery_id',v_recovery.id,'recovered_from',v_recovery.recovered_from,
        'message','You retried the work that had stopped ('||v_recovery.recovered_from||').'));
  END IF;
  v_audit:=write_audit_event(v_job.project_id,v_job.task_id,NULL,'operator',p_actor,'runtime_job.retried',
    'runtime_job',v_job.id::text,'allowed',NULL,
    jsonb_build_object('recovery_id',v_recovery.id,'recovered_from',v_recovery.recovered_from,'note',v_recovery.note,
      'selection_id',v_selection.id,'selection_superseded',v_superseded),p_correlation_id);
  RETURN jsonb_build_object('job_id',v_job.id,'recovery_id',v_recovery.id,'action','retry','repeat',false,
    'status',v_job.status,'selection_id',v_selection.id,'selection_superseded',v_superseded,
    'audit_event_id',v_audit,'event_id',v_event.id);
END $function$;

REVOKE EXECUTE ON FUNCTION job_model_connection(runtime_jobs) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION revoked_model_access(runtime_jobs) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoked_model_access(runtime_jobs) TO infra_worker;
