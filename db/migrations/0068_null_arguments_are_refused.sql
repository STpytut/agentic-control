-- A guard that does not guard (found on the host, rc.36).
--
-- `submit_worker_completion` checks `jsonb_typeof(p_checks_summary) <> 'object'`
-- and refuses what is not an object. It does not refuse NULL, because
-- `jsonb_typeof(NULL)` is NULL, `NULL <> 'object'` is NULL, and `IF NULL THEN`
-- does not fire. Confirmed on the production database:
--
--   SELECT CASE WHEN (jsonb_typeof(NULL) <> 'object') THEN 'refused'
--               ELSE 'passed through' END;   -->  passed through
--
-- So a call with the field missing reached the INSERT and died on the table's
-- NOT NULL constraint. What the operator's journal got was
--
--   worker_tool_gateway.refused: null value in column "checks_summary" of
--   relation "worker_completion_reports" violates not-null constraint
--
-- which is the shape WP-8a exists to remove: a refusal with no product reason,
-- naming a column instead of the thing the caller did. Seen twice on the rc.36
-- verification run — the executor recovered by calling again with the field, so
-- nothing failed; only the account of it was wrong.
--
-- `submit_worker_interaction` has the same hole in `p_payload`, and the worker
-- tool gateway reaches it the same way: `JSON.stringify(request.payload)` is
-- `undefined` when a tool omits the field, which binds as NULL.
--
-- The shape is general — every `jsonb_typeof(x) <> '…'` guard in this schema
-- passes NULL — and the rest are converted when a migration touches them
-- (prework B2's rule). These two are the ones a runtime can reach directly, and
-- one of them has now done so.
--
-- No BEGIN/COMMIT: migrate.mjs owns the transaction (0039 onwards).
SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('interaction_payload_invalid','invalid_argument','a report type outside the two, or a payload that is not a JSON object'),
  ('interaction_run_not_active','conflict','the run is not running, or the task has moved on'),
  ('interaction_session_mismatch','conflict','a different native session than the one the run opened')
ON CONFLICT (reason) DO UPDATE SET code=EXCLUDED.code, note=EXCLUDED.note;

-- Only the two guards change. `IS NULL OR` in front of each, so an absent
-- argument is refused by the same reason as a wrong one — which is what the
-- caller did in both cases: failed to send an object.
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
  -- `IS NULL OR` is the fix: without it a missing summary is not refused here,
  -- it is refused by the table four statements later, as a column name.
  IF p_result_summary IS NULL OR p_checks_summary IS NULL
     OR jsonb_typeof(p_result_summary) <> 'object' OR jsonb_typeof(p_checks_summary) <> 'object' THEN
    PERFORM refuse('completion_summary_not_object',
      'completion summaries must be JSON objects, and both must be present', '22023');
  END IF;

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

-- The same hole, reachable the same way: a tool that omits `payload` sends
-- `undefined`, which binds as NULL. Its three refusals get reasons while the
-- function is open.
CREATE OR REPLACE FUNCTION submit_worker_interaction(
  p_project_id uuid, p_task_id uuid, p_run_id uuid, p_agent_id uuid, p_fencing_token bigint,
  p_native_session_id text, p_report_type text, p_payload jsonb, p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_run task_runs%ROWTYPE; v_task tasks%ROWTYPE; v_session agent_sessions%ROWTYPE; v worker_interaction_reports%ROWTYPE;
BEGIN
  SELECT * INTO v_task FROM tasks WHERE id=p_task_id AND project_id=p_project_id FOR UPDATE;
  SELECT * INTO v_run FROM task_runs WHERE id=p_run_id FOR UPDATE;
  IF v_task.id IS NULL OR v_run.id IS NULL OR v_run.task_id<>p_task_id OR v_run.agent_id<>p_agent_id
     OR v_run.status<>'running' OR v_task.active_agent_id<>p_agent_id OR v_task.status NOT IN ('implementing','revising') THEN
    PERFORM refuse('interaction_run_not_active', 'active worker interaction validation failed');
  END IF;
  IF p_report_type IS NULL OR p_report_type NOT IN ('blocker','input_request')
     OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN
    PERFORM refuse('interaction_payload_invalid',
      'a worker interaction is a blocker or an input_request with a JSON object payload', '22023');
  END IF;
  PERFORM assert_workspace_fence(p_project_id,p_run_id,p_fencing_token);
  SELECT * INTO v_session FROM agent_sessions WHERE id=v_run.session_id;
  IF v_session.native_session_id IS NOT NULL AND v_session.native_session_id<>p_native_session_id THEN
    PERFORM refuse('interaction_session_mismatch',
      format('session %s opened as %s, not %s', v_session.id, v_session.native_session_id, p_native_session_id));
  END IF;
  INSERT INTO worker_interaction_reports(project_id,task_id,run_id,agent_id,fencing_token,native_session_id,report_type,payload,idempotency_key)
  VALUES(p_project_id,p_task_id,p_run_id,p_agent_id,p_fencing_token,p_native_session_id,p_report_type,p_payload,p_idempotency_key)
  ON CONFLICT(run_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING * INTO v;
  RETURN jsonb_build_object('report_id',v.id,'status',v.status,'report_type',v.report_type,'run_id',v.run_id);
END; $$;

ALTER FUNCTION submit_worker_interaction(uuid,uuid,uuid,uuid,bigint,text,text,jsonb,text)
  SET search_path=control_plane,public,extensions,pg_temp;
