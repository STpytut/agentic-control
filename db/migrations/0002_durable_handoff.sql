BEGIN;

SET search_path TO control_plane, public;

CREATE OR REPLACE FUNCTION request_implementation(
  p_project_id uuid,
  p_task_id uuid,
  p_from_agent_id uuid,
  p_to_agent_id uuid,
  p_revision_number integer,
  p_objective text,
  p_instructions jsonb,
  p_constraints jsonb,
  p_acceptance_criteria jsonb,
  p_relevant_paths jsonb,
  p_workspace_ref text,
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
  v_handoff handoffs%ROWTYPE;
  v_event domain_events%ROWTYPE;
  v_payload jsonb;
  v_result jsonb;
BEGIN
  v_payload := jsonb_build_object(
    'task_id', p_task_id,
    'from_agent_id', p_from_agent_id,
    'to_agent_id', p_to_agent_id,
    'revision_number', p_revision_number,
    'objective', p_objective,
    'instructions', p_instructions,
    'constraints', p_constraints,
    'acceptance_criteria', p_acceptance_criteria,
    'relevant_paths', p_relevant_paths,
    'workspace_ref', p_workspace_ref
  );

  v_command := submit_command(
    p_project_id, p_task_id, 'DelegateTask', 'agent', p_from_agent_id::text,
    p_idempotency_key, v_payload, p_expected_version, p_correlation_id
  );

  IF v_command.status = 'completed' THEN
    RETURN v_command.result;
  END IF;

  SELECT * INTO v_task
  FROM tasks t
  WHERE t.id = p_task_id AND t.project_id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'task % does not belong to project %', p_task_id, p_project_id
      USING ERRCODE = '23503';
  END IF;
  IF v_task.version <> p_expected_version THEN
    RAISE EXCEPTION 'stale task version: expected %, actual %', p_expected_version, v_task.version
      USING ERRCODE = '40001';
  END IF;
  IF v_task.status NOT IN ('ready', 'changes_requested') THEN
    RAISE EXCEPTION 'task % cannot be delegated from state %', p_task_id, v_task.status
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = p_to_agent_id AND a.enabled AND a.role = 'implementer'
  ) THEN
    RAISE EXCEPTION 'implementer agent % is unavailable', p_to_agent_id
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO handoffs (
    task_id, from_agent_id, to_agent_id, revision_number, objective,
    instructions, constraints, acceptance_criteria, relevant_paths, workspace_ref
  ) VALUES (
    p_task_id, p_from_agent_id, p_to_agent_id, p_revision_number, p_objective,
    p_instructions, p_constraints, p_acceptance_criteria, p_relevant_paths, p_workspace_ref
  )
  RETURNING * INTO v_handoff;

  UPDATE tasks
  SET status = 'implementation_requested',
      active_agent_id = p_to_agent_id,
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = p_task_id
  RETURNING * INTO v_task;

  v_event := append_event(
    'implementation.requested', p_project_id, p_task_id, NULL,
    'agent', p_from_agent_id::text, v_command.id, p_correlation_id,
    'event:' || p_idempotency_key, 'task', p_task_id, v_task.version,
    jsonb_build_object('handoff_id', v_handoff.id, 'revision_number', p_revision_number)
  );

  v_result := jsonb_build_object(
    'status', 'accepted',
    'command_id', v_command.id,
    'event_id', v_event.id,
    'handoff_id', v_handoff.id,
    'task_id', p_task_id,
    'task_version', v_task.version,
    'idempotency_key', p_idempotency_key
  );

  UPDATE commands
  SET status = 'completed', result = v_result, completed_at = clock_timestamp()
  WHERE id = v_command.id;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION start_implementation(
  p_event_id uuid,
  p_session_id uuid,
  p_dispatcher_id text,
  p_lock_ttl interval DEFAULT interval '5 minutes'
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_event domain_events%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_handoff handoffs%ROWTYPE;
  v_run task_runs%ROWTYPE;
  v_started_event domain_events%ROWTYPE;
  v_token bigint;
BEGIN
  SELECT * INTO v_event
  FROM domain_events e
  WHERE e.id = p_event_id AND e.event_type = 'implementation.requested';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'implementation request event % not found', p_event_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM outbox_messages o
    WHERE o.event_id = p_event_id
      AND o.status = 'in_flight'
      AND o.leased_by = p_dispatcher_id
      AND o.leased_until > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'dispatcher % does not hold event %', p_dispatcher_id, p_event_id
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_task FROM tasks t WHERE t.id = v_event.task_id FOR UPDATE;
  IF v_task.status <> 'implementation_requested' THEN
    RAISE EXCEPTION 'task % cannot start implementation from state %', v_task.id, v_task.status
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_handoff
  FROM handoffs h
  WHERE h.id = (v_event.payload->>'handoff_id')::uuid
  FOR UPDATE;
  IF v_handoff.to_agent_id <> v_task.active_agent_id THEN
    RAISE EXCEPTION 'handoff assignee does not match active task agent'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = p_session_id
      AND s.project_id = v_event.project_id
      AND s.agent_id = v_handoff.to_agent_id
      AND s.active
  ) THEN
    RAISE EXCEPTION 'worker session % is not active for the handoff agent', p_session_id
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO task_runs(task_id, session_id, agent_id, phase, status, write_capable)
  VALUES (v_task.id, p_session_id, v_handoff.to_agent_id, 'implementation', 'starting', true)
  RETURNING * INTO v_run;

  v_token := acquire_workspace_lock(v_event.project_id, v_run.id, 'implementation', p_lock_ttl);

  UPDATE task_runs
  SET status = 'running', started_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
  WHERE id = v_run.id
  RETURNING * INTO v_run;

  UPDATE handoffs SET target_run_id = v_run.id WHERE id = v_handoff.id;
  UPDATE tasks
  SET status = 'implementing', version = version + 1, updated_at = clock_timestamp()
  WHERE id = v_task.id
  RETURNING * INTO v_task;

  v_started_event := append_event(
    'implementation.started', v_event.project_id, v_task.id, v_run.id,
    'system', p_dispatcher_id, v_event.causation_id, v_event.correlation_id,
    'start:' || v_event.id, 'task', v_task.id, v_task.version,
    jsonb_build_object('handoff_id', v_handoff.id, 'fencing_token', v_token)
  );

  PERFORM acknowledge_outbox(o.id, p_dispatcher_id)
  FROM outbox_messages o
  WHERE o.event_id = p_event_id;

  RETURN jsonb_build_object(
    'status', 'running',
    'run_id', v_run.id,
    'task_id', v_task.id,
    'task_version', v_task.version,
    'handoff_id', v_handoff.id,
    'fencing_token', v_token,
    'started_event_id', v_started_event.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION complete_implementation(
  p_project_id uuid,
  p_task_id uuid,
  p_run_id uuid,
  p_agent_id uuid,
  p_reviewer_agent_id uuid,
  p_fencing_token bigint,
  p_result_summary jsonb,
  p_checks_summary jsonb,
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
  v_run task_runs%ROWTYPE;
  v_handoff handoffs%ROWTYPE;
  v_event domain_events%ROWTYPE;
  v_payload jsonb;
  v_result jsonb;
BEGIN
  v_payload := jsonb_build_object(
    'task_id', p_task_id,
    'run_id', p_run_id,
    'agent_id', p_agent_id,
    'reviewer_agent_id', p_reviewer_agent_id,
    'fencing_token', p_fencing_token,
    'result_summary', p_result_summary,
    'checks_summary', p_checks_summary
  );
  v_command := submit_command(
    p_project_id, p_task_id, 'CompleteImplementation', 'agent', p_agent_id::text,
    p_idempotency_key, v_payload, p_expected_version, p_correlation_id
  );
  IF v_command.status = 'completed' THEN
    RETURN v_command.result;
  END IF;

  SELECT * INTO v_task FROM tasks t
  WHERE t.id = p_task_id AND t.project_id = p_project_id
  FOR UPDATE;
  SELECT * INTO v_run FROM task_runs r WHERE r.id = p_run_id FOR UPDATE;

  IF v_task.version <> p_expected_version THEN
    RAISE EXCEPTION 'stale task version: expected %, actual %', p_expected_version, v_task.version
      USING ERRCODE = '40001';
  END IF;
  IF v_task.status NOT IN ('implementing', 'revising') THEN
    RAISE EXCEPTION 'task % cannot complete implementation from state %', p_task_id, v_task.status
      USING ERRCODE = '55000';
  END IF;
  IF v_run.task_id <> p_task_id OR v_run.agent_id <> p_agent_id
     OR v_run.status NOT IN ('running', 'waiting_for_input', 'blocked', 'interrupted')
     OR v_task.active_agent_id <> p_agent_id THEN
    RAISE EXCEPTION 'run/agent/assignee validation failed for completion'
      USING ERRCODE = '55000';
  END IF;

  PERFORM assert_workspace_fence(p_project_id, p_run_id, p_fencing_token);

  SELECT * INTO v_handoff FROM handoffs h WHERE h.target_run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'handoff for run % not found', p_run_id USING ERRCODE = '23503';
  END IF;

  UPDATE task_runs
  SET status = 'completed', finished_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
  WHERE id = p_run_id;
  UPDATE handoffs
  SET result_summary = p_result_summary,
      checks_summary = p_checks_summary,
      completed_at = clock_timestamp()
  WHERE id = v_handoff.id;
  UPDATE tasks
  SET status = 'awaiting_review', active_agent_id = p_reviewer_agent_id,
      version = version + 1, updated_at = clock_timestamp()
  WHERE id = p_task_id
  RETURNING * INTO v_task;

  v_event := append_event(
    'implementation.completed', p_project_id, p_task_id, p_run_id,
    'agent', p_agent_id::text, v_command.id, p_correlation_id,
    'event:' || p_idempotency_key, 'task', p_task_id, v_task.version,
    jsonb_build_object(
      'handoff_id', v_handoff.id,
      'result_summary', p_result_summary,
      'checks_summary', p_checks_summary
    )
  );

  PERFORM release_workspace_lock(p_project_id, p_run_id, p_fencing_token);

  v_result := jsonb_build_object(
    'status', 'awaiting_review',
    'command_id', v_command.id,
    'event_id', v_event.id,
    'handoff_id', v_handoff.id,
    'run_id', p_run_id,
    'task_id', p_task_id,
    'task_version', v_task.version,
    'idempotency_key', p_idempotency_key
  );
  UPDATE commands
  SET status = 'completed', result = v_result, completed_at = clock_timestamp()
  WHERE id = v_command.id;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION claim_outbox_event(
  p_event_id uuid,
  p_worker_id text,
  p_lease interval DEFAULT interval '30 seconds'
)
RETURNS outbox_messages
LANGUAGE plpgsql
AS $$
DECLARE
  v_message outbox_messages%ROWTYPE;
BEGIN
  UPDATE outbox_messages
  SET status = 'in_flight',
      attempt_count = attempt_count + 1,
      leased_by = p_worker_id,
      leased_until = clock_timestamp() + p_lease,
      last_error = NULL
  WHERE event_id = p_event_id
    AND available_at <= clock_timestamp()
    AND (status = 'pending' OR (status = 'in_flight' AND leased_until <= clock_timestamp()))
  RETURNING * INTO v_message;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'event % is not available for dispatcher %', p_event_id, p_worker_id
      USING ERRCODE = '55P03';
  END IF;
  RETURN v_message;
END;
$$;

COMMIT;
