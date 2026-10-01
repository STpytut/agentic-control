-- Stage 11.1: two defects the first end-to-end task flow on the host exposed.
-- Both are on paths that are taken every time, and neither could be seen without
-- running a task from the panel to a finished revision.
--
-- 1. An operator asking for changes killed the task
-- --------------------------------------------------
-- `request_revision` inherits everything from the previous handoff — objective,
-- instructions, constraints, acceptance criteria, relevant paths, workspace ref
-- — except the one field that says who implements it. The orchestrator's path
-- writes it afterwards from outside:
--
--   UPDATE handoffs SET executor_assignment_id=v_handoff.executor_assignment_id
--     WHERE id=(v_result#>>'{delegation,handoff_id}')::uuid ...   -- 0014
--
-- The web tier calls `request_revision` directly, so the handoff it creates has
-- `executor_assignment_id IS NULL`. `resolve_executor_launch_model` then looks
-- for a snapshot entry whose `assignment_ids` contains that null, finds nothing,
-- and the fallback is deliberately disabled whenever the snapshot carries
-- provenance — so the launch is refused as `snapshot_mismatch` and the job
-- dead-letters after three attempts.
--
-- Observed on the host, revisions 1-3 requested by Codex and revision 4 by the
-- operator:
--
--   revision 1  executor_assignment_id 23155b54-...  -> ran
--   revision 2  executor_assignment_id 23155b54-...  -> ran
--   revision 3  executor_assignment_id 23155b54-...  -> ran
--   revision 4  executor_assignment_id (null)        -> dead_letter
--
-- So the panel's "Request changes" button ends the task, every time, for any
-- task whose snapshot records which assignment each model belongs to.
--
-- Fixed inside `request_revision` rather than by adding the same line to the web
-- tier's caller. The field is inherited exactly like the other six, and a caller
-- can no longer forget it. 0014's external UPDATE stays correct and becomes a
-- no-op: it only writes where the column is still null.
--
-- 2. A worker could not learn that its completion had been accepted
-- -----------------------------------------------------------------
-- `submit_worker_completion` checks that the run is `running` and the task is
-- `implementing`/`revising` before it looks for an existing report. Accepting a
-- completion moves the task to `awaiting_review` and the run to `completed` — so
-- the second call arrives at a state the first call created, fails the liveness
-- check, and never reaches the idempotency branch below it.
--
-- The branch exists precisely for this and was unreachable in the only case it
-- was written for.
--
-- What the worker sees is `active worker run validation failed`, which does not
-- say "already accepted", so it tries again. On the host:
--
--   15:40:54  complete_task completed
--   15:41:48  complete_task error
--   15:42:10  complete_task error
--   15:42:35  complete_task error
--   15:43:01  complete_task error
--   15:43:29  complete_task error
--
-- Five model turns, about two and a half minutes, after the work was already
-- accepted. A run that spends its remaining turns this way is a run that
-- dead-letters with "did not submit a terminal report" — while its report sits
-- in the table.
--
-- The repeat is answered from the stored report, before liveness is considered.
-- It creates nothing and changes nothing: the row must already exist, it must
-- belong to this project, task, run and agent, and the payload must match — a
-- reused key with a different payload still raises, as it did. Liveness is
-- checked only when there is a new report to write, which is the case it was
-- there to protect.

SET search_path TO control_plane, public, extensions;

-- 0019's body, with the inheritance completed.
CREATE OR REPLACE FUNCTION request_revision(
  p_project_id uuid,
  p_task_id uuid,
  p_reviewer_agent_id uuid,
  p_changes_required jsonb,
  p_acceptance_criteria jsonb,
  p_idempotency_key text,
  p_expected_version bigint,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_command commands%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_previous handoffs%ROWTYPE;
  v_change_event domain_events%ROWTYPE;
  v_delegate jsonb;
  v_result jsonb;
BEGIN
  v_command := submit_command(
    p_project_id, p_task_id, 'RequestRevision', 'agent', p_reviewer_agent_id::text,
    p_idempotency_key,
    jsonb_build_object('changes_required', p_changes_required, 'acceptance_criteria', p_acceptance_criteria),
    p_expected_version, p_correlation_id
  );
  IF v_command.status = 'completed' THEN RETURN v_command.result; END IF;

  SELECT * INTO v_task FROM tasks t
  WHERE t.id = p_task_id AND t.project_id = p_project_id FOR UPDATE;
  IF v_task.version <> p_expected_version OR v_task.status NOT IN ('awaiting_review','reviewing')
     OR v_task.active_agent_id <> p_reviewer_agent_id THEN
    RAISE EXCEPTION 'task is not reviewable at the expected version' USING ERRCODE = '40001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agents a WHERE a.id = p_reviewer_agent_id AND a.enabled
      AND a.role IN ('architect', 'reviewer')
  ) THEN
    RAISE EXCEPTION 'reviewer agent is unavailable' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_previous FROM handoffs h
  WHERE h.task_id = p_task_id ORDER BY h.revision_number DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR v_previous.acceptance_criteria <> p_acceptance_criteria THEN
    RAISE EXCEPTION 'revision cannot alter acceptance criteria' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_changes_required) <> 'array' OR jsonb_array_length(p_changes_required) = 0 THEN
    RAISE EXCEPTION 'changes_required must be a non-empty array' USING ERRCODE = '22023';
  END IF;

  UPDATE tasks SET status = 'changes_requested', version = version + 1,
    updated_at = clock_timestamp() WHERE id = p_task_id RETURNING * INTO v_task;
  v_change_event := append_event(
    'changes.requested', p_project_id, p_task_id, NULL,
    'agent', p_reviewer_agent_id::text, v_command.id, p_correlation_id,
    'changes:' || p_idempotency_key, 'task', p_task_id, v_task.version,
    jsonb_build_object('previous_handoff_id', v_previous.id, 'changes_required', p_changes_required)
  );

  v_delegate := request_implementation(
    p_project_id, p_task_id, p_reviewer_agent_id, v_previous.to_agent_id,
    v_previous.revision_number + 1, v_previous.objective,
    v_previous.instructions || jsonb_build_object('changes_required', p_changes_required),
    v_previous.constraints, v_previous.acceptance_criteria, v_previous.relevant_paths,
    v_previous.workspace_ref, 'delegate-revision:' || p_idempotency_key,
    v_task.version, p_correlation_id
  );

  -- The seventh inherited field. Without it the new handoff names no executor,
  -- `resolve_executor_launch_model` matches no snapshot entry, and the launch is
  -- refused as a snapshot mismatch — which is what every revision requested from
  -- the panel did.
  UPDATE handoffs SET executor_assignment_id = v_previous.executor_assignment_id
  WHERE id = (v_delegate->>'handoff_id')::uuid AND executor_assignment_id IS NULL;

  v_result := jsonb_build_object(
    'status', 'revision_requested', 'command_id', v_command.id,
    'changes_event_id', v_change_event.id, 'revision_number', v_previous.revision_number + 1,
    'delegation', v_delegate
  );
  UPDATE commands SET status = 'completed', result = v_result, completed_at = clock_timestamp()
  WHERE id = v_command.id;
  RETURN v_result;
END;
$$;

-- 0005's body, with the idempotent repeat answered before liveness.
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
    RAISE EXCEPTION 'completion idempotency key is invalid' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_result_summary) <> 'object' OR jsonb_typeof(p_checks_summary) <> 'object' THEN
    RAISE EXCEPTION 'completion summaries must be JSON objects' USING ERRCODE = '22023';
  END IF;

  -- The repeat, answered from what is already stored. No liveness check, because
  -- the state this call is refused by is the state the accepted report created.
  -- Nothing is written here; the row has to exist, it has to belong to this
  -- caller's project, task, run and agent, and the payload has to match.
  SELECT * INTO v_report FROM worker_completion_reports r
  WHERE r.run_id = p_run_id AND r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_report.project_id <> p_project_id OR v_report.task_id <> p_task_id
       OR v_report.agent_id <> p_agent_id THEN
      RAISE EXCEPTION 'completion report does not belong to this caller' USING ERRCODE = '55000';
    END IF;
    IF v_report.result_summary <> p_result_summary OR v_report.checks_summary <> p_checks_summary
       OR v_report.native_session_id <> p_native_session_id THEN
      RAISE EXCEPTION 'completion idempotency key reused with different payload' USING ERRCODE = '23505';
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
  IF NOT FOUND OR v_run.task_id <> p_task_id OR v_run.agent_id <> p_agent_id
     OR v_run.status <> 'running' OR NOT v_run.write_capable
     OR v_task.active_agent_id <> p_agent_id
     OR v_task.status NOT IN ('implementing', 'revising') THEN
    RAISE EXCEPTION 'active worker run validation failed' USING ERRCODE = '55000';
  END IF;
  PERFORM assert_workspace_fence(p_project_id, p_run_id, p_fencing_token);

  SELECT * INTO v_session FROM agent_sessions s WHERE s.id = v_run.session_id FOR UPDATE;
  IF p_native_session_id IS NULL OR p_native_session_id = '' THEN
    RAISE EXCEPTION 'native worker session id is required' USING ERRCODE = '22023';
  END IF;
  IF v_session.native_session_id IS NOT NULL AND v_session.native_session_id <> p_native_session_id THEN
    RAISE EXCEPTION 'worker session continuity validation failed' USING ERRCODE = '55000';
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

ALTER FUNCTION request_revision(uuid,uuid,uuid,jsonb,jsonb,text,bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION submit_worker_completion(uuid,uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
