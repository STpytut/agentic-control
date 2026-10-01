BEGIN;

SET search_path TO control_plane, public;

CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE worker_completion_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  run_id uuid NOT NULL REFERENCES task_runs(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  native_session_id text NOT NULL,
  idempotency_key text NOT NULL,
  result_summary jsonb NOT NULL,
  checks_summary jsonb NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'accepted', 'rejected')),
  completion_result jsonb,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalized_at timestamptz,
  UNIQUE (run_id, idempotency_key),
  CHECK ((status = 'submitted') = (finalized_at IS NULL)),
  CHECK (status <> 'accepted' OR completion_result IS NOT NULL)
);

CREATE UNIQUE INDEX worker_completion_reports_one_submitted_run
  ON worker_completion_reports(run_id) WHERE status = 'submitted';

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

  SELECT * INTO v_report FROM worker_completion_reports r
  WHERE r.run_id = p_run_id AND r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_report.result_summary <> p_result_summary OR v_report.checks_summary <> p_checks_summary
       OR v_report.native_session_id <> p_native_session_id THEN
      RAISE EXCEPTION 'completion idempotency key reused with different payload' USING ERRCODE = '23505';
    END IF;
  ELSE
    INSERT INTO worker_completion_reports(
      project_id, task_id, run_id, agent_id, fencing_token, native_session_id,
      idempotency_key, result_summary, checks_summary, notes
    ) VALUES (
      p_project_id, p_task_id, p_run_id, p_agent_id, p_fencing_token, p_native_session_id,
      p_idempotency_key, p_result_summary, p_checks_summary, p_notes
    ) RETURNING * INTO v_report;
  END IF;

  RETURN jsonb_build_object(
    'status', v_report.status, 'report_id', v_report.id, 'run_id', v_report.run_id,
    'native_session_id', v_report.native_session_id, 'submitted_at', v_report.submitted_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION finalize_worker_completion(
  p_report_id uuid,
  p_job_id bigint,
  p_supervisor_id text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_report worker_completion_reports%ROWTYPE;
  v_job runtime_jobs%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_handoff handoffs%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT * INTO v_report FROM worker_completion_reports r WHERE r.id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'worker completion report % not found', p_report_id USING ERRCODE = '23503';
  END IF;
  IF v_report.status = 'accepted' THEN RETURN v_report.completion_result; END IF;
  IF v_report.status <> 'submitted' THEN
    RAISE EXCEPTION 'worker completion report % is not finalizable', p_report_id USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.run_id <> v_report.run_id OR v_job.job_type <> 'start_implementation'
     OR v_job.status <> 'in_flight' OR v_job.leased_by <> p_supervisor_id
     OR v_job.leased_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'runtime supervisor does not own the completion run' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id = v_report.task_id FOR UPDATE;
  SELECT * INTO v_handoff FROM handoffs h WHERE h.target_run_id = v_report.run_id;

  v_result := complete_implementation(
    v_report.project_id, v_report.task_id, v_report.run_id, v_report.agent_id,
    v_handoff.from_agent_id, v_report.fencing_token,
    v_report.result_summary, v_report.checks_summary,
    'complete:' || v_report.run_id, v_task.version, v_report.task_id::text
  );
  UPDATE worker_completion_reports
  SET status = 'accepted', completion_result = v_result, finalized_at = clock_timestamp()
  WHERE id = p_report_id;
  RETURN v_result;
END;
$$;

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
  IF v_task.version <> p_expected_version OR v_task.status <> 'awaiting_review'
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

CREATE OR REPLACE FUNCTION complete_implementation(
  p_project_id uuid, p_task_id uuid, p_run_id uuid, p_agent_id uuid,
  p_reviewer_agent_id uuid, p_fencing_token bigint, p_result_summary jsonb,
  p_checks_summary jsonb, p_idempotency_key text, p_expected_version bigint,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_command commands%ROWTYPE; v_task tasks%ROWTYPE; v_run task_runs%ROWTYPE;
  v_handoff handoffs%ROWTYPE; v_event domain_events%ROWTYPE; v_result jsonb; v_event_type text;
BEGIN
  v_command := submit_command(p_project_id, p_task_id, 'CompleteImplementation', 'agent', p_agent_id::text,
    p_idempotency_key, jsonb_build_object('run_id', p_run_id, 'result_summary', p_result_summary,
    'checks_summary', p_checks_summary), p_expected_version, p_correlation_id);
  IF v_command.status = 'completed' THEN RETURN v_command.result; END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id=p_task_id AND t.project_id=p_project_id FOR UPDATE;
  SELECT * INTO v_run FROM task_runs r WHERE r.id=p_run_id FOR UPDATE;
  IF v_task.version <> p_expected_version OR v_task.status NOT IN ('implementing','revising') THEN
    RAISE EXCEPTION 'task cannot complete at expected version' USING ERRCODE='40001'; END IF;
  IF v_run.task_id<>p_task_id OR v_run.agent_id<>p_agent_id OR v_run.status<>'running'
     OR v_task.active_agent_id<>p_agent_id THEN RAISE EXCEPTION 'run completion validation failed' USING ERRCODE='55000'; END IF;
  PERFORM assert_workspace_fence(p_project_id,p_run_id,p_fencing_token);
  SELECT * INTO v_handoff FROM handoffs h WHERE h.target_run_id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'handoff not found' USING ERRCODE='23503'; END IF;
  UPDATE task_runs SET status='completed',finished_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE id=p_run_id;
  UPDATE handoffs SET result_summary=p_result_summary,checks_summary=p_checks_summary,completed_at=clock_timestamp() WHERE id=v_handoff.id;
  UPDATE tasks SET status='awaiting_review',active_agent_id=p_reviewer_agent_id,version=version+1,updated_at=clock_timestamp()
    WHERE id=p_task_id RETURNING * INTO v_task;
  v_event_type := CASE WHEN v_handoff.revision_number > 1 THEN 'revision.completed' ELSE 'implementation.completed' END;
  v_event := append_event(v_event_type,p_project_id,p_task_id,p_run_id,'agent',p_agent_id::text,v_command.id,p_correlation_id,
    'event:'||p_idempotency_key,'task',p_task_id,v_task.version,
    jsonb_build_object('handoff_id',v_handoff.id,'revision_number',v_handoff.revision_number,
      'result_summary',p_result_summary,'checks_summary',p_checks_summary));
  PERFORM release_workspace_lock(p_project_id,p_run_id,p_fencing_token);
  v_result:=jsonb_build_object('status','awaiting_review','command_id',v_command.id,'event_id',v_event.id,
    'event_type',v_event_type,'handoff_id',v_handoff.id,'run_id',p_run_id,'task_id',p_task_id,
    'task_version',v_task.version,'idempotency_key',p_idempotency_key);
  UPDATE commands SET status='completed',result=v_result,completed_at=clock_timestamp() WHERE id=v_command.id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION route_outbox_message(p_message_id bigint,p_dispatcher_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_message outbox_messages%ROWTYPE; v_event domain_events%ROWTYPE;
  v_job runtime_jobs%ROWTYPE; v_job_type text;
BEGIN
  SELECT * INTO v_message FROM outbox_messages o WHERE o.id=p_message_id FOR UPDATE;
  IF NOT FOUND OR v_message.status<>'in_flight' OR v_message.leased_by<>p_dispatcher_id
     OR v_message.leased_until<=clock_timestamp() THEN RAISE EXCEPTION 'outbox message is not actively leased' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_event FROM domain_events e WHERE e.id=v_message.event_id;
  v_job_type:=CASE WHEN v_event.event_type='implementation.requested' THEN 'start_implementation'
    WHEN v_event.event_type IN ('implementation.completed','revision.completed') THEN 'resume_codex' END;
  IF v_job_type IS NOT NULL THEN
    INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,run_id,payload)
    VALUES(v_event.id,v_job_type,v_event.project_id,v_event.task_id,v_event.run_id,
      jsonb_build_object('event_id',v_event.id,'event_type',v_event.event_type,'correlation_id',v_event.correlation_id,'event_payload',v_event.payload))
    ON CONFLICT(source_event_id,job_type) DO UPDATE SET source_event_id=EXCLUDED.source_event_id RETURNING * INTO v_job;
  END IF;
  PERFORM acknowledge_outbox(p_message_id,p_dispatcher_id);
  RETURN jsonb_build_object('message_id',p_message_id,'event_id',v_event.id,'event_type',v_event.event_type,
    'job_id',v_job.id,'job_type',v_job.job_type,'routed',v_job_type IS NOT NULL);
END; $$;

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
  IF NOT FOUND OR v_job.job_type<>'start_implementation' OR v_job.status<>'in_flight'
     OR v_job.leased_by<>p_supervisor_id OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'start job is not actively leased by supervisor' USING ERRCODE='55000'; END IF;
  IF v_job.result IS NOT NULL THEN RETURN v_job.result; END IF;
  SELECT * INTO v_event FROM domain_events e WHERE e.id=v_job.source_event_id AND e.event_type='implementation.requested';
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_event.task_id FOR UPDATE;
  IF v_task.status<>'implementation_requested' THEN RAISE EXCEPTION 'task cannot start implementation' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_handoff FROM handoffs h WHERE h.id=(v_event.payload->>'handoff_id')::uuid FOR UPDATE;
  IF v_handoff.to_agent_id<>v_task.active_agent_id THEN RAISE EXCEPTION 'handoff assignee mismatch' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM agent_sessions s WHERE s.id=p_session_id AND s.project_id=v_event.project_id
    AND s.agent_id=v_handoff.to_agent_id AND s.active) THEN
    RAISE EXCEPTION 'worker session is not active for handoff agent' USING ERRCODE='55000'; END IF;
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

ALTER FUNCTION submit_worker_completion(uuid,uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,text) SET search_path=control_plane,pg_temp;
ALTER FUNCTION finalize_worker_completion(uuid,bigint,text) SET search_path=control_plane,pg_temp;
ALTER FUNCTION request_revision(uuid,uuid,uuid,jsonb,jsonb,text,bigint,text) SET search_path=control_plane,pg_temp;
ALTER FUNCTION complete_implementation(uuid,uuid,uuid,uuid,uuid,bigint,jsonb,jsonb,text,bigint,text) SET search_path=control_plane,pg_temp;
ALTER FUNCTION route_outbox_message(bigint,text) SET search_path=control_plane,pg_temp;
ALTER FUNCTION start_implementation_job(bigint,uuid,text,interval) SET search_path=control_plane,pg_temp;

COMMIT;
