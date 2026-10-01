-- A runtime removed while a job for it is being dispatched (11.1 acceptance
-- item 3.8), and the way back from dead_letter (prework C2).
--
-- 3.8 on the tree before this migration, reproduced in the gate
-- (services/control-plane/test/runtime-removal-race.test.mjs):
--
--   * a launch of a runtime the host had just reported removed was recorded
--     and spawned — dispatch never asked; only task *creation* did (0054);
--   * a launch racing the removal read the snapshot from before it, so which
--     of the two won was the order the statements happened to run in;
--   * the failure that followed was retried as transient, three times, and
--     then dead-lettered with the run still `running`, the workspace lock
--     `held` and the task `implementing` — until the lease ran out and the
--     reconciler turned the lock into `reconciliation_required`, which is the
--     leak the item names ("no held workspace lock"). The job said why in
--     free text only.
--
-- So:
--
--   * `runtime_undispatchable_reason` reads the one row the host's report
--     writes (`runtime_health`) under a share lock. A removal and a launch are
--     ordered by that lock rather than interleaved: a removal written first is
--     waited for and seen; one written after waits for the launch and meets it
--     as a running process. Only a report that *says* not installed or not
--     authenticated refuses: a stale or missing snapshot, or a runtime the
--     report could not read, is "cannot say", which task creation already
--     refuses (0054) and a launch leaves to the launch.
--   * `record_runtime_dispatch` asks it before it records anything, so a
--     refused launch appends no attempt and the supervisor opens no socket
--     and spawns nothing (it records before both).
--   * `retry_runtime_job` asks it too. A job whose runtime is gone is not put
--     back to fail again; it ends now, with that reason. A job whose attempts
--     run out ends the same way, as `runtime_attempts_exhausted`.
--   * Ending a job (`end_runtime_job`) ends what it holds: its run fails with
--     the reason, the workspace lock is released under the run's own fencing
--     token, grants are revoked (by the run's trigger), an attempt the
--     supervisor never finished is closed as not reported, the task needs
--     attention, and the conversation says why.
--   * Every dead letter carries a reason from the closed vocabulary
--     (`runtime_jobs.failure_reason`). The two writers this migration does not
--     rewrite — the reconciler's expired lease and project deletion — are
--     named by a trigger, and the rows already dead are backfilled the same
--     way.
--
-- The way back from dead_letter (C2). Before this, retry_runtime_job took only
-- a job in flight under a live lease, resolve_runtime_job_incident marked the
-- incident resolved and resumed nothing, and requeuing revision 4 in 11.1's
-- §3.5 took two statements typed against the production database. Now the
-- operator has two actions, both idempotent per dead letter and both recorded
-- in runtime_job_recoveries with who, why and what the job had died of:
--
--   * retry_dead_letter_job puts the same job back — not a new one, so a double
--     click cannot make two — with a fresh attempt budget. It refuses, by
--     reason, a runtime the host still reports removed, a task that is closed
--     or approved, work the task has moved past, and a workspace another run
--     holds or that needs reconciling first. The job's recorded selection
--     (0071) is reused when the host reports the version it recorded, and
--     superseded, naming both versions, when it does not.
--   * dismiss_dead_letter_job closes it without a retry, with the operator's
--     reason, as resolve_runtime_job_incident did.
--
-- No BEGIN/COMMIT: migrate.mjs owns the transaction.
SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('runtime_not_provisioned','unavailable','the host reports the runtime is not installed — removed, or never provisioned'),
  ('runtime_not_authenticated','unavailable','the host reports the runtime holds no usable credential — disconnected or expired'),
  ('runtime_attempts_exhausted','unavailable','every attempt the worker allows failed; the last error says how'),
  ('project_deletion_cancelled','conflict','the project was deleted before the job ran')
ON CONFLICT (reason) DO NOTHING;

ALTER TABLE runtime_jobs ADD COLUMN failure_reason text REFERENCES failure_reasons(reason);
-- The attempt count a retry from dead_letter started from: the operator's retry
-- gets the worker's whole budget again, and attempt_count itself keeps counting,
-- because every attempt is a numbered dispatch attempt (0071) and a run.
ALTER TABLE runtime_jobs ADD COLUMN attempt_base integer NOT NULL DEFAULT 0;
ALTER TABLE runtime_jobs ADD CONSTRAINT runtime_jobs_attempt_base_check
  CHECK (attempt_base >= 0 AND attempt_base <= attempt_count);

-- The reason of a dead letter its writer did not name. Two writers are older
-- than the vocabulary and are not rewritten here; each says what it is in
-- last_error, and that is what this reads.
CREATE OR REPLACE FUNCTION dead_letter_reason_of(p_last_error text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_last_error LIKE 'workspace lease expired%' THEN 'workspace_lease_expired'
    WHEN p_last_error LIKE '%cancelled by project deletion;%' THEN 'project_deletion_cancelled'
    ELSE 'runtime_attempts_exhausted'
  END;
$$;

CREATE OR REPLACE FUNCTION name_dead_letter()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='dead_letter' AND NEW.failure_reason IS NULL THEN
    NEW.failure_reason:=dead_letter_reason_of(NEW.last_error);
  ELSIF NEW.status<>'dead_letter' THEN
    NEW.failure_reason:=NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER runtime_jobs_name_dead_letter BEFORE UPDATE OF status ON runtime_jobs
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status) EXECUTE FUNCTION name_dead_letter();
CREATE TRIGGER runtime_jobs_name_inserted_dead_letter BEFORE INSERT ON runtime_jobs
  FOR EACH ROW EXECUTE FUNCTION name_dead_letter();

UPDATE runtime_jobs SET failure_reason=dead_letter_reason_of(last_error)
WHERE status='dead_letter' AND failure_reason IS NULL;

ALTER TABLE runtime_jobs ADD CONSTRAINT runtime_jobs_dead_letter_has_reason
  CHECK ((status='dead_letter') = (failure_reason IS NOT NULL));

-- Whether the host's last report says this runtime cannot run. NULL is "not
-- that it says": no report, a stale one, a runtime it does not mention or
-- could not read. SECURITY DEFINER for the share lock, which asks for more
-- than the SELECT a worker has on runtime_health.
CREATE OR REPLACE FUNCTION runtime_undispatchable_reason(p_runtime text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_observed timestamptz; v_runtimes jsonb; v_entry jsonb;
BEGIN
  IF p_runtime IS NULL THEN RETURN NULL; END IF;
  SELECT h.observed_at, h.snapshot->'runtimes' INTO v_observed, v_runtimes
  FROM runtime_health h WHERE h.singleton FOR SHARE;
  IF v_observed IS NULL OR jsonb_typeof(v_runtimes) IS DISTINCT FROM 'array'
     OR clock_timestamp()-v_observed > runtime_dispatch_staleness() THEN
    RETURN NULL;
  END IF;
  SELECT e INTO v_entry FROM jsonb_array_elements(v_runtimes) e WHERE e->>'runtime'=p_runtime LIMIT 1;
  IF v_entry IS NULL OR v_entry ? 'unreadable' THEN RETURN NULL; END IF;
  IF (v_entry->>'installed') IS DISTINCT FROM 'true' THEN RETURN 'runtime_not_provisioned'; END IF;
  IF (v_entry->>'authenticated') IS DISTINCT FROM 'true' THEN RETURN 'runtime_not_authenticated'; END IF;
  RETURN NULL;
END $$;

-- The runtime a job runs on: what its launch recorded (0071), else what its
-- grant was issued for, else what it was routed to.
CREATE OR REPLACE FUNCTION runtime_job_runtime(p_job runtime_jobs)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (current_runtime_job_selection(p_job.id)).runtime_type,
    (SELECT rp.runtime_type FROM workspace_access_grants g
       JOIN project_agent_assignments pa ON pa.id=g.assignment_id
       JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
     WHERE g.job_id=p_job.id ORDER BY g.issued_at DESC LIMIT 1),
    CASE WHEN p_job.job_type IN ('codex_chat_turn','resume_codex') THEN
      (SELECT rp.runtime_type FROM tasks t
         JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
         JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id WHERE t.id=p_job.task_id)
    ELSE
      (SELECT rp.runtime_type FROM domain_events e
         JOIN handoffs h ON h.id=NULLIF(e.payload->>'handoff_id','')::uuid
         JOIN agents a ON a.id=h.to_agent_id
         JOIN runtime_profiles rp ON rp.id=a.runtime_profile_id WHERE e.id=p_job.source_event_id)
    END);
$$;

-- Ends a job and what it holds. The caller holds the job's row and has decided;
-- this is only how. Granted to the worker role only because retry_runtime_job
-- runs as the worker; nothing in the product calls it directly.
CREATE OR REPLACE FUNCTION end_runtime_job(p_job_id bigint, p_actor text, p_reason text, p_error text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_run task_runs%ROWTYPE; v_task tasks%ROWTYPE; v_lock workspace_locks%ROWTYPE;
  v_note text; v_event domain_events%ROWTYPE; v_aggregate text; v_aggregate_id uuid; v_version bigint;
BEGIN
  SELECT note INTO v_note FROM failure_reasons WHERE reason=p_reason;
  IF v_note IS NULL THEN PERFORM refuse(p_reason, 'a job ends with a reason from the vocabulary'); END IF;
  UPDATE runtime_jobs SET status='dead_letter',failure_reason=p_reason,leased_by=NULL,leased_until=NULL,
    last_error=left(COALESCE(p_error,p_reason),4000),completed_at=clock_timestamp(),
    activity_detail=left(v_note,500)
  WHERE id=p_job_id RETURNING * INTO v_job;

  -- A turn's run is closed by its own trigger (0059/0061) when the job leaves
  -- in_flight. An implementation's run is this function's.
  IF v_job.run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM task_runs WHERE id=v_job.run_id FOR UPDATE;
    IF v_run.write_capable AND v_run.status IN ('queued','starting','running','waiting_for_input','blocked') THEN
      SELECT * INTO v_lock FROM workspace_locks
      WHERE project_id=v_job.project_id AND status='held' AND owner_run_id=v_run.id FOR UPDATE;
      IF v_lock.project_id IS NOT NULL AND v_lock.lease_expires_at<=clock_timestamp() THEN
        -- The lease ran out before the job ended — a job reclaimed after its
        -- worker died carries such a run. Whoever held it may still be writing,
        -- so the lock is not released: it is left exactly as the reconciler
        -- leaves an expired lease, and the run is lost, not failed, because the
        -- reconciler cannot move a failed run to lost and would stop on it.
        UPDATE task_runs SET status='lost',failure_code='workspace_lease_expired',finished_at=clock_timestamp(),
          updated_at=clock_timestamp(),version=version+1 WHERE id=v_run.id RETURNING * INTO v_run;
        UPDATE workspace_locks SET owner_run_id=NULL,lease_expires_at=NULL,status='reconciliation_required',
          reason='lease_expired',version=version+1 WHERE project_id=v_job.project_id;
      ELSE
        UPDATE task_runs SET status='failed',failure_code=p_reason,finished_at=clock_timestamp(),
          updated_at=clock_timestamp(),version=version+1 WHERE id=v_run.id RETURNING * INTO v_run;
        IF v_lock.project_id IS NOT NULL THEN
          PERFORM release_workspace_lock(v_job.project_id,v_run.id,v_lock.fencing_token);
        END IF;
      END IF;
    END IF;
  END IF;
  -- What the supervisor started and never said how it ended.
  UPDATE runtime_dispatch_attempts SET finished_at=clock_timestamp(),
    native_result=jsonb_build_object('status','not_reported','job_ended',p_reason)
  WHERE job_id=v_job.id AND finished_at IS NULL;

  IF v_job.job_type='start_implementation' THEN
    UPDATE tasks SET status='needs_attention',version=version+1,updated_at=clock_timestamp()
    WHERE id=v_job.task_id AND status IN ('implementation_requested','implementing','revising')
    RETURNING * INTO v_task;
  END IF;
  IF v_task.id IS NOT NULL THEN
    v_aggregate:='task'; v_aggregate_id:=v_task.id; v_version:=v_task.version;
  ELSIF v_job.run_id IS NOT NULL THEN
    SELECT 'run',id,version INTO v_aggregate,v_aggregate_id,v_version FROM task_runs WHERE id=v_job.run_id;
  END IF;
  IF v_aggregate IS NOT NULL THEN
    v_event:=append_event('runtime_job.dead_lettered',v_job.project_id,v_job.task_id,v_job.run_id,'system',p_actor,
      NULL,v_job.task_id::text,'dead-letter:'||v_job.id||':'||v_job.attempt_count,v_aggregate,v_aggregate_id,v_version,
      jsonb_build_object('job_id',v_job.id,'job_type',v_job.job_type,'reason',p_reason,
        'message','This work stopped: '||v_note||'.','error',left(COALESCE(p_error,''),500)));
  END IF;
  RETURN jsonb_build_object('job_id',v_job.id,'status','dead_letter','failure_reason',p_reason,
    'run_id',v_job.run_id,'event_id',v_event.id);
END $$;

-- 0003's retry, which decided only by counting. It now asks first whether a
-- retry can succeed at all.
CREATE OR REPLACE FUNCTION retry_runtime_job(
  p_job_id bigint,
  p_supervisor_id text,
  p_error text,
  p_delay interval DEFAULT interval '10 seconds',
  p_max_attempts integer DEFAULT 5
)
RETURNS text LANGUAGE plpgsql AS $$
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
END $$;


-- 0071's, with the host's report asked before anything is recorded.
CREATE OR REPLACE FUNCTION record_runtime_dispatch(p_job_id bigint, p_worker_id text, p_launch jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_job runtime_jobs%ROWTYPE; v_run task_runs%ROWTYPE; v_grant workspace_access_grants%ROWTYPE;
  v_assignment project_agent_assignments%ROWTYPE; v_runtime text; v_selection runtime_job_selections%ROWTYPE;
  v_capabilities text[]; v_attempt runtime_dispatch_attempts%ROWTYPE; v_reused boolean := true;
  v_blocked text;
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
END $$;

ALTER FUNCTION dead_letter_reason_of(text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION name_dead_letter() SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION runtime_undispatchable_reason(text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION runtime_job_runtime(runtime_jobs) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION end_runtime_job(bigint,text,text,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION retry_runtime_job(bigint,text,text,interval,integer) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION record_runtime_dispatch(bigint,text,jsonb) SET search_path=control_plane,public,extensions,pg_temp;

REVOKE EXECUTE ON FUNCTION dead_letter_reason_of(text) FROM PUBLIC;
-- Trigger functions: nothing calls them, so nothing is granted.
REVOKE EXECUTE ON FUNCTION name_dead_letter() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime_undispatchable_reason(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime_job_runtime(runtime_jobs) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION end_runtime_job(bigint,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dead_letter_reason_of(text) TO infra_worker;
GRANT EXECUTE ON FUNCTION runtime_undispatchable_reason(text) TO infra_worker;
GRANT EXECUTE ON FUNCTION runtime_job_runtime(runtime_jobs) TO infra_worker;
GRANT EXECUTE ON FUNCTION end_runtime_job(bigint,text,text,text) TO infra_worker;

-- ---------------------------------------------------------------------------
-- The way back from dead_letter
-- ---------------------------------------------------------------------------

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('dead_letter_not_found','not_found','no dead-lettered job with that id in a project this operator owns'),
  ('dead_letter_already_handled','conflict','this dead letter was already retried or dismissed, or the card is out of date'),
  ('dead_letter_note_invalid','invalid_argument','a retry says why in at least three characters, a dismissal in at least eight'),
  ('dead_letter_task_closed','conflict','the task is closed or approved; a retry would reopen finished work'),
  ('dead_letter_superseded','conflict','the task has moved past this job: a later handoff, review or turn replaced it'),
  ('dead_letter_workspace_busy','conflict','another run holds the workspace, or the workspace needs reconciliation first')
ON CONFLICT (reason) DO NOTHING;

CREATE TABLE runtime_job_recoveries (
  id bigserial PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES runtime_jobs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  action text NOT NULL CHECK (action IN ('retry','dismiss')),
  -- Which dead letter this answers: the job's attempt count when it died. A
  -- job can die, be retried and die again; each death is answered once.
  dead_letter_attempt integer NOT NULL CHECK (dead_letter_attempt >= 0),
  recovered_from text NOT NULL REFERENCES failure_reasons(reason),
  last_error text,
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  note text NOT NULL CHECK (length(note) BETWEEN 3 AND 2000),
  selection_id bigint REFERENCES runtime_job_selections(id),
  selection_superseded boolean NOT NULL DEFAULT false,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, dead_letter_attempt)
);

-- A record of who did what; it is not edited.
CREATE OR REPLACE FUNCTION guard_runtime_job_recoveries()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM runtime_jobs WHERE id=OLD.job_id) THEN RETURN OLD; END IF;
  PERFORM refuse('dead_letter_already_handled', 'a recovery is recorded once and never changed');
  RETURN NULL;
END $$;
CREATE TRIGGER runtime_job_recoveries_immutable BEFORE UPDATE OR DELETE ON runtime_job_recoveries
  FOR EACH ROW EXECUTE FUNCTION guard_runtime_job_recoveries();

-- The dead letter a card shows, locked, with the answer already given to it if
-- there is one. Shared by both actions so they refuse and repeat identically.
CREATE OR REPLACE FUNCTION locked_dead_letter(p_job_id bigint, p_attempt integer, p_owner_id uuid,
  p_action text, OUT o_job runtime_jobs, OUT o_recovery runtime_job_recoveries)
LANGUAGE plpgsql AS $$
BEGIN
  SELECT j.* INTO o_job FROM runtime_jobs j JOIN projects p ON p.id=j.project_id
  WHERE j.id=p_job_id AND p.owner_id=p_owner_id FOR UPDATE OF j;
  IF o_job.id IS NULL THEN
    PERFORM refuse('dead_letter_not_found', format('no job %s in a project of this operator', p_job_id));
  END IF;
  SELECT * INTO o_recovery FROM runtime_job_recoveries WHERE job_id=p_job_id AND dead_letter_attempt=p_attempt;
  IF o_recovery.id IS NOT NULL THEN
    IF o_recovery.action<>p_action THEN
      PERFORM refuse('dead_letter_already_handled',
        format('job %s''s dead letter was already answered: %s by %s', p_job_id, o_recovery.action, o_recovery.actor));
    END IF;
    RETURN;
  END IF;
  IF o_job.status<>'dead_letter' OR o_job.resolved_at IS NOT NULL OR o_job.attempt_count<>p_attempt THEN
    PERFORM refuse('dead_letter_already_handled',
      format('job %s is %s at attempt %s; the card showed a dead letter at attempt %s',
        p_job_id, CASE WHEN o_job.resolved_at IS NOT NULL THEN 'dismissed' ELSE o_job.status END, o_job.attempt_count, p_attempt));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION retry_dead_letter_job(p_job_id bigint, p_attempt integer, p_owner_id uuid,
  p_actor text, p_note text, p_correlation_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
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

  IF v_job.job_type='start_implementation' THEN
    SELECT h.* INTO v_handoff FROM domain_events e JOIN handoffs h ON h.id=NULLIF(e.payload->>'handoff_id','')::uuid
    WHERE e.id=v_job.source_event_id;
    IF v_task.status NOT IN ('needs_attention','implementation_requested','implementing','revising')
       OR EXISTS (SELECT 1 FROM handoffs h WHERE h.task_id=v_task.id AND h.revision_number>v_handoff.revision_number)
       OR v_handoff.to_agent_id IS DISTINCT FROM v_task.active_agent_id
       OR EXISTS (SELECT 1 FROM runtime_jobs o WHERE o.task_id=v_task.id AND o.id<>v_job.id
                  AND o.job_type='start_implementation' AND o.status IN ('pending','in_flight')) THEN
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
  ELSIF v_job.job_type='resume_codex' AND v_task.status<>'reviewing' THEN
    PERFORM refuse('dead_letter_superseded', format('task %s is %s, no longer waiting for this review', v_task.id, v_task.status));
  ELSIF EXISTS (SELECT 1 FROM runtime_jobs o WHERE o.task_id=v_task.id AND o.id>v_job.id
                AND o.job_type IN ('codex_chat_turn','resume_codex') AND o.status='completed') THEN
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
    run_id=CASE WHEN job_type='start_implementation' THEN NULL ELSE run_id END,
    result=CASE WHEN job_type='start_implementation' THEN NULL ELSE result END,
    activity_detail='Retried by the operator'
  WHERE id=v_job.id RETURNING * INTO v_job;
  IF v_job.job_type='start_implementation' AND v_task.status<>'implementation_requested' THEN
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
END $$;

CREATE OR REPLACE FUNCTION dismiss_dead_letter_job(p_job_id bigint, p_attempt integer, p_owner_id uuid,
  p_actor text, p_note text, p_correlation_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_recovery runtime_job_recoveries%ROWTYPE; v_task tasks%ROWTYPE; v_audit uuid;
  v_locked record;
BEGIN
  IF p_note IS NULL OR length(trim(p_note)) < 8 OR length(p_note) > 2000 THEN
    PERFORM refuse('dead_letter_note_invalid', 'a dismissal says why, in 8 to 2000 characters', '22023');
  END IF;
  SELECT * INTO v_locked FROM locked_dead_letter(p_job_id, p_attempt, p_owner_id, 'dismiss');
  v_job:=v_locked.o_job; v_recovery:=v_locked.o_recovery;
  IF v_recovery.id IS NOT NULL THEN
    RETURN jsonb_build_object('job_id',v_job.id,'recovery_id',v_recovery.id,'action','dismiss','repeat',true,
      'resolved_at',v_job.resolved_at);
  END IF;
  INSERT INTO runtime_job_recoveries(job_id,project_id,task_id,action,dead_letter_attempt,recovered_from,last_error,
    actor,note,correlation_id)
  VALUES(v_job.id,v_job.project_id,v_job.task_id,'dismiss',v_job.attempt_count,v_job.failure_reason,
    left(v_job.last_error,2000),p_actor,trim(p_note),p_correlation_id)
  RETURNING * INTO v_recovery;
  UPDATE runtime_jobs SET resolved_at=clock_timestamp(),resolved_by=p_actor,resolution=trim(p_note)
  WHERE id=v_job.id RETURNING * INTO v_job;
  -- What resolve_runtime_job_incident did for a review that will not come.
  IF v_job.job_type='resume_codex' THEN
    UPDATE tasks SET status='awaiting_review',version=version+1,updated_at=clock_timestamp()
    WHERE id=v_job.task_id AND status='reviewing' RETURNING * INTO v_task;
  END IF;
  v_audit:=write_audit_event(v_job.project_id,v_job.task_id,NULL,'operator',p_actor,'runtime_job.dismissed',
    'runtime_job',v_job.id::text,'allowed',NULL,
    jsonb_build_object('recovery_id',v_recovery.id,'recovered_from',v_recovery.recovered_from,'note',v_recovery.note,
      'task_status',v_task.status),p_correlation_id);
  RETURN jsonb_build_object('job_id',v_job.id,'recovery_id',v_recovery.id,'action','dismiss','repeat',false,
    'resolved_at',v_job.resolved_at,'task_status',v_task.status,'audit_event_id',v_audit);
END $$;

-- 0067's, with the start of a retried job named apart from the first.
CREATE OR REPLACE FUNCTION start_implementation_job(
  p_job_id bigint, p_session_id uuid, p_supervisor_id text,
  p_lock_ttl interval DEFAULT interval '5 minutes'
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_job runtime_jobs%ROWTYPE; v_event domain_events%ROWTYPE; v_task tasks%ROWTYPE;
  v_handoff handoffs%ROWTYPE; v_run task_runs%ROWTYPE; v_started_event domain_events%ROWTYPE;
  v_token bigint; v_result jsonb; v_event_type text;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM refuse('job_not_found', format('no runtime job %s', p_job_id)); END IF;
  IF v_job.job_type<>'start_implementation' THEN
    PERFORM refuse('job_type_mismatch', format('job %s is a %s, not a start_implementation', p_job_id, v_job.job_type));
  END IF;
  IF v_job.status<>'in_flight' THEN
    PERFORM refuse('job_not_in_flight', format('job %s is %s, not claimed', p_job_id, v_job.status));
  END IF;
  IF v_job.leased_by<>p_supervisor_id THEN
    PERFORM refuse('job_lease_held_by_another', format('job %s is leased by %s', p_job_id, v_job.leased_by));
  END IF;
  IF v_job.leased_until<=clock_timestamp() THEN
    PERFORM refuse('job_lease_expired', format('the lease on job %s expired at %s', p_job_id, v_job.leased_until));
  END IF;
  IF v_job.result IS NOT NULL THEN RETURN v_job.result; END IF;
  SELECT * INTO v_event FROM domain_events e WHERE e.id=v_job.source_event_id AND e.event_type='implementation.requested';
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_event.task_id FOR UPDATE;
  IF v_task.status<>'implementation_requested' THEN
    PERFORM refuse('task_not_implementation_requested',
      format('task %s is %s, not waiting for an implementation', v_task.id, v_task.status));
  END IF;
  SELECT * INTO v_handoff FROM handoffs h WHERE h.id=(v_event.payload->>'handoff_id')::uuid FOR UPDATE;
  IF v_handoff.to_agent_id<>v_task.active_agent_id THEN
    PERFORM refuse('handoff_assignee_mismatch',
      format('handoff %s names agent %s; the task assigns %s', v_handoff.id, v_handoff.to_agent_id, v_task.active_agent_id));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM agent_sessions s WHERE s.id=p_session_id AND s.project_id=v_event.project_id
    AND s.agent_id=v_handoff.to_agent_id AND s.active) THEN
    PERFORM refuse('worker_session_not_active',
      format('session %s is not active for agent %s', p_session_id, v_handoff.to_agent_id));
  END IF;
  INSERT INTO task_runs(task_id,session_id,agent_id,phase,status,write_capable)
    VALUES(v_task.id,p_session_id,v_handoff.to_agent_id,
      CASE WHEN v_handoff.revision_number>1 THEN 'revision' ELSE 'implementation' END,'starting',true)
    RETURNING * INTO v_run;
  v_token:=acquire_workspace_lock(v_event.project_id,v_run.id,'implementation',p_lock_ttl);
  UPDATE task_runs SET status='running',started_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1
    WHERE id=v_run.id RETURNING * INTO v_run;
  UPDATE handoffs SET target_run_id=v_run.id WHERE id=v_handoff.id;
  UPDATE tasks SET status=CASE WHEN v_handoff.revision_number>1 THEN 'revising' ELSE 'implementing' END,
    version=version+1,updated_at=clock_timestamp() WHERE id=v_task.id RETURNING * INTO v_task;
  v_event_type:=CASE WHEN v_handoff.revision_number>1 THEN 'revision.started' ELSE 'implementation.started' END;
  v_started_event:=append_event(v_event_type,v_event.project_id,v_task.id,v_run.id,'system',p_supervisor_id,
    v_event.causation_id,v_event.correlation_id,
    -- 0072: a retry from dead_letter starts again, and its start is a new
    -- event; the first start keeps the key it always had.
    'start:'||v_event.id||CASE WHEN v_job.attempt_base>0 THEN ':retry:'||v_job.attempt_base ELSE '' END,
    'task',v_task.id,v_task.version,
    jsonb_build_object('handoff_id',v_handoff.id,'revision_number',v_handoff.revision_number,'fencing_token',v_token));
  v_result:=jsonb_build_object('status','running','run_id',v_run.id,'task_id',v_task.id,'task_version',v_task.version,
    'handoff_id',v_handoff.id,'revision_number',v_handoff.revision_number,'fencing_token',v_token,
    'started_event_id',v_started_event.id,'started_event_type',v_event_type);
  UPDATE runtime_jobs SET run_id=v_run.id,result=v_result WHERE id=p_job_id;
  RETURN v_result;
END; $$;

ALTER FUNCTION guard_runtime_job_recoveries() SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION locked_dead_letter(bigint,integer,uuid,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION retry_dead_letter_job(bigint,integer,uuid,text,text,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION dismiss_dead_letter_job(bigint,integer,uuid,text,text,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION start_implementation_job(bigint,uuid,text,interval) SET search_path=control_plane,public,extensions,pg_temp;

-- The panel's two buttons, and nothing under them: infra_web executes the two
-- actions, which run as their owner (0062's rule, held by 0026's allowlist),
-- and has no grant on the table or on the helper.
REVOKE EXECUTE ON FUNCTION guard_runtime_job_recoveries() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION locked_dead_letter(bigint,integer,uuid,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION retry_dead_letter_job(bigint,integer,uuid,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION dismiss_dead_letter_job(bigint,integer,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retry_dead_letter_job(bigint,integer,uuid,text,text,text) TO infra_web;
GRANT EXECUTE ON FUNCTION dismiss_dead_letter_job(bigint,integer,uuid,text,text,text) TO infra_web;
GRANT SELECT ON runtime_job_recoveries TO infra_worker;
