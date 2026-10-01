-- A refusal says which refusal it is (WP-8a, prework B2).
--
-- `submit_worker_completion` distinguishes twelve conditions and raised one
-- sentence — "active worker run validation failed" — for six of them. A worker
-- that cannot tell "your report was already accepted" from "you no longer own
-- this run" has one move left, and it made it: resubmitted an accepted
-- completion five times (defect 104).
--
-- The same shape is in `start_implementation_job`, whose "start job is not
-- actively leased by supervisor" covers four conditions, and in
-- `assert_workspace_fence`, whose single sentence is what reached the operator
-- as `run.lost: workspace_lease_expired` when the truth might have been that
-- another run held the lock.
--
-- So a refusal carries a machine-readable reason in `DETAIL`, as JSON beside
-- the human sentence, and the reasons are a closed vocabulary. `refuse()` is
-- the only way to raise one, and it checks the reason against the table, so a
-- reason invented at a call site fails there instead of reaching a caller that
-- branches on it.
--
-- Existing functions are converted when a migration touches them. These three
-- are converted deliberately, because each demonstrably cost something.
--
-- No BEGIN/COMMIT: migrate.mjs owns the transaction (0039 onwards).
SET search_path TO control_plane, public, extensions;

CREATE TABLE IF NOT EXISTS failure_reasons (
  reason text PRIMARY KEY,
  -- The family the envelope maps to (services/control-plane/failure.mjs). Kept
  -- here so the classification is one fact, not two that drift.
  code text NOT NULL CHECK (code IN (
    'invalid_argument','not_found','conflict','permission_denied',
    'unavailable','timeout','lease_lost','database','internal'
  )),
  note text NOT NULL
);

INSERT INTO failure_reasons(reason, code, note) VALUES
  -- submit_worker_completion
  ('completion_idempotency_key_invalid','invalid_argument','the key is absent or shorter than eight characters'),
  ('completion_summary_not_object','invalid_argument','a result or checks summary that is not a JSON object'),
  ('completion_report_foreign','permission_denied','the stored report belongs to another project, task or agent'),
  ('completion_idempotency_key_reused','conflict','the same key with a different payload'),
  ('run_not_found','not_found','no run with that id'),
  ('run_not_running','conflict','the run is not running — usually because it already finished'),
  ('run_not_write_capable','conflict','a turn cannot report an implementation'),
  ('run_agent_mismatch','permission_denied','the run belongs to another agent'),
  ('task_agent_mismatch','conflict','the task has moved to another agent'),
  ('task_not_implementing','conflict','the task is not in an implementing or revising state'),
  ('native_session_id_missing','invalid_argument','a completion must name the native session it ran in'),
  ('session_continuity_mismatch','conflict','a different native session than the one the run opened'),
  -- start_implementation_job
  ('job_not_found','not_found','no job with that id'),
  ('job_type_mismatch','conflict','the job is not the type this call starts'),
  ('job_not_in_flight','conflict','the job is not claimed'),
  ('job_lease_held_by_another','lease_lost','another worker holds the lease'),
  ('job_lease_expired','lease_lost','the lease ran out before this call'),
  ('task_not_implementation_requested','conflict','the task is not waiting for an implementation to start'),
  ('handoff_assignee_mismatch','conflict','the handoff names an agent the task no longer assigns'),
  ('worker_session_not_active','conflict','the session is not active for the handoff agent'),
  -- assert_workspace_fence
  ('workspace_lock_not_held','conflict','nothing holds the workspace lock'),
  ('workspace_lock_owned_by_another_run','lease_lost','another run holds the workspace'),
  ('workspace_fencing_token_stale','lease_lost','the token is not the one the current holder was given'),
  ('workspace_lease_expired','lease_lost','the holder''s lease ran out'),
  -- refuse() itself
  ('unknown_failure_reason','internal','a call site named a reason that is not in the vocabulary')
ON CONFLICT (reason) DO UPDATE SET code=EXCLUDED.code, note=EXCLUDED.note;

-- The only way to raise a refusal. The sentence stays for a human; the reason
-- is what a caller branches on.
CREATE OR REPLACE FUNCTION refuse(p_reason text, p_message text, p_errcode text DEFAULT '55000')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM failure_reasons WHERE reason = p_reason) THEN
    RAISE EXCEPTION 'refusal named the reason %, which is not in the vocabulary', p_reason
      USING ERRCODE = '55000', DETAIL = jsonb_build_object('reason','unknown_failure_reason','named',p_reason)::text;
  END IF;
  RAISE EXCEPTION '%', p_message
    USING ERRCODE = p_errcode, DETAIL = jsonb_build_object('reason', p_reason)::text;
END $$;

ALTER FUNCTION refuse(text,text,text) SET search_path=control_plane,public,extensions,pg_temp;

-- ------------------------------------------------------- assert_workspace_fence
--
-- One sentence became four reasons. The distinction that matters to a worker:
-- `workspace_lock_not_held` means the lock was released and this run may be
-- able to take it again, while `workspace_lock_owned_by_another_run` means
-- somebody else is writing and it must not.
CREATE OR REPLACE FUNCTION assert_workspace_fence(
  p_project_id uuid,
  p_run_id uuid,
  p_fencing_token bigint
)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_lock workspace_locks%ROWTYPE;
BEGIN
  SELECT * INTO v_lock FROM workspace_locks l WHERE l.project_id = p_project_id;
  IF NOT FOUND OR v_lock.status <> 'held' THEN
    PERFORM refuse('workspace_lock_not_held',
      format('no run holds the workspace of project %s', p_project_id));
  END IF;
  IF v_lock.owner_run_id <> p_run_id THEN
    PERFORM refuse('workspace_lock_owned_by_another_run',
      format('run %s holds the workspace, not run %s', v_lock.owner_run_id, p_run_id));
  END IF;
  IF v_lock.fencing_token <> p_fencing_token THEN
    PERFORM refuse('workspace_fencing_token_stale',
      format('stale fencing token for run %s', p_run_id));
  END IF;
  IF v_lock.lease_expires_at <= clock_timestamp() THEN
    PERFORM refuse('workspace_lease_expired',
      format('the workspace lease of run %s expired at %s', p_run_id, v_lock.lease_expires_at));
  END IF;
END $$;

ALTER FUNCTION assert_workspace_fence(uuid,uuid,bigint) SET search_path=control_plane,public,extensions,pg_temp;

-- ------------------------------------------------------ start_implementation_job
--
-- Only the refusals change. Everything the function does when it accepts is
-- carried over unchanged from 0005.
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
    v_event.causation_id,v_event.correlation_id,'start:'||v_event.id,'task',v_task.id,v_task.version,
    jsonb_build_object('handoff_id',v_handoff.id,'revision_number',v_handoff.revision_number,'fencing_token',v_token));
  v_result:=jsonb_build_object('status','running','run_id',v_run.id,'task_id',v_task.id,'task_version',v_task.version,
    'handoff_id',v_handoff.id,'revision_number',v_handoff.revision_number,'fencing_token',v_token,
    'started_event_id',v_started_event.id,'started_event_type',v_event_type);
  UPDATE runtime_jobs SET run_id=v_run.id,result=v_result WHERE id=p_job_id;
  RETURN v_result;
END; $$;

ALTER FUNCTION start_implementation_job(bigint,uuid,text,interval) SET search_path=control_plane,public,extensions,pg_temp;

-- ------------------------------------------------------ submit_worker_completion
--
-- The function of defect 104. Six conditions shared "active worker run
-- validation failed"; they are six reasons now, and the two that a worker acts
-- on differently — the run finished, versus the task moved to another agent —
-- no longer look identical from outside.
CREATE OR REPLACE FUNCTION submit_worker_completion(
  p_project_id uuid,
  p_task_id uuid,
  p_run_id uuid,
  p_agent_id uuid,
  p_fencing_token bigint,
  p_native_session_id text,
  p_result_summary jsonb,
  p_checks_summary jsonb,
  p_notes text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_run task_runs%ROWTYPE;
  v_session agent_sessions%ROWTYPE;
  v_report worker_completion_reports%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 8 THEN
    PERFORM refuse('completion_idempotency_key_invalid', 'completion idempotency key is invalid', '22023');
  END IF;
  IF jsonb_typeof(p_result_summary) <> 'object' OR jsonb_typeof(p_checks_summary) <> 'object' THEN
    PERFORM refuse('completion_summary_not_object', 'completion summaries must be JSON objects', '22023');
  END IF;

  -- The repeat, answered from what is already stored. No liveness check, because
  -- the state this call is refused by is the state the accepted report created.
  SELECT * INTO v_report FROM worker_completion_reports r
  WHERE r.run_id = p_run_id AND r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_report.project_id <> p_project_id OR v_report.task_id <> p_task_id
       OR v_report.agent_id <> p_agent_id THEN
      PERFORM refuse('completion_report_foreign', 'completion report does not belong to this caller');
    END IF;
    IF v_report.result_summary <> p_result_summary OR v_report.checks_summary <> p_checks_summary
       OR v_report.native_session_id <> p_native_session_id THEN
      PERFORM refuse('completion_idempotency_key_reused',
        'completion idempotency key reused with different payload', '23505');
    END IF;
    RETURN jsonb_build_object(
      'status', v_report.status, 'report_id', v_report.id, 'run_id', v_report.run_id,
      'native_session_id', v_report.native_session_id, 'submitted_at', v_report.submitted_at,
      'repeat', true
    );
  END IF;

  SELECT * INTO v_task FROM tasks t
  WHERE t.id = p_task_id AND t.project_id = p_project_id FOR UPDATE;
  SELECT * INTO v_run FROM task_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.task_id <> p_task_id THEN
    PERFORM refuse('run_not_found', format('no run %s on task %s', p_run_id, p_task_id), '55000');
  END IF;
  IF v_run.agent_id <> p_agent_id THEN
    PERFORM refuse('run_agent_mismatch', format('run %s belongs to another agent', p_run_id));
  END IF;
  IF NOT v_run.write_capable THEN
    PERFORM refuse('run_not_write_capable', format('run %s is a turn, and a turn does not report an implementation', p_run_id));
  END IF;
  IF v_run.status <> 'running' THEN
    PERFORM refuse('run_not_running', format('run %s is %s, not running', p_run_id, v_run.status));
  END IF;
  IF v_task.active_agent_id <> p_agent_id THEN
    PERFORM refuse('task_agent_mismatch', format('task %s has moved to another agent', p_task_id));
  END IF;
  IF v_task.status NOT IN ('implementing', 'revising') THEN
    PERFORM refuse('task_not_implementing', format('task %s is %s', p_task_id, v_task.status));
  END IF;
  PERFORM assert_workspace_fence(p_project_id, p_run_id, p_fencing_token);

  SELECT * INTO v_session FROM agent_sessions s WHERE s.id = v_run.session_id FOR UPDATE;
  IF p_native_session_id IS NULL OR p_native_session_id = '' THEN
    PERFORM refuse('native_session_id_missing', 'native worker session id is required', '22023');
  END IF;
  IF v_session.native_session_id IS NOT NULL AND v_session.native_session_id <> p_native_session_id THEN
    PERFORM refuse('session_continuity_mismatch',
      format('session %s opened as %s, not %s', v_session.id, v_session.native_session_id, p_native_session_id));
  END IF;
  UPDATE agent_sessions
  SET native_session_id = COALESCE(native_session_id, p_native_session_id),
      last_resumed_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
  WHERE id = v_session.id;

  INSERT INTO worker_completion_reports(
    project_id, task_id, run_id, agent_id, fencing_token, native_session_id,
    idempotency_key, result_summary, checks_summary, notes
  ) VALUES (
    p_project_id, p_task_id, p_run_id, p_agent_id, p_fencing_token, p_native_session_id,
    p_idempotency_key, p_result_summary, p_checks_summary, p_notes
  ) RETURNING * INTO v_report;

  RETURN jsonb_build_object(
    'status', v_report.status, 'report_id', v_report.id, 'run_id', v_report.run_id,
    'native_session_id', v_report.native_session_id, 'submitted_at', v_report.submitted_at
  );
END;
$$;

ALTER FUNCTION submit_worker_completion(uuid,uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;

GRANT SELECT ON failure_reasons TO infra_web, infra_worker;

-- A function is executable by PUBLIC unless it is told otherwise, and the lease
-- contract refuses a migration that leaves one that way. `refuse()` raises an
-- exception with a reason of the caller's choosing: nothing is lost by calling
-- it, but nothing outside the product's own roles has a use for it either.
REVOKE EXECUTE ON FUNCTION refuse(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refuse(text,text,text) TO infra_worker;
