BEGIN;
SET search_path TO control_plane,public,extensions;

CREATE OR REPLACE FUNCTION claim_codex_chat_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 1,
  p_lease interval DEFAULT interval '5 minutes'
)
RETURNS SETOF runtime_jobs
LANGUAGE sql
AS $$
  WITH candidates AS (
    SELECT j.id FROM runtime_jobs j
    WHERE j.job_type IN ('codex_chat_turn','resume_codex')
      AND j.available_at<=clock_timestamp()
      AND (j.status='pending' OR (j.status='in_flight' AND j.leased_until<=clock_timestamp()))
      AND NOT EXISTS (
        SELECT 1 FROM runtime_jobs earlier
        WHERE earlier.job_type IN ('codex_chat_turn','resume_codex')
          AND earlier.task_id=j.task_id AND earlier.id<j.id
          AND earlier.status IN ('pending','in_flight')
      )
    ORDER BY j.available_at,j.id FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE runtime_jobs j
    SET status='in_flight',attempt_count=j.attempt_count+1,leased_by=p_worker_id,
        leased_until=clock_timestamp()+p_lease,last_error=NULL,
        activity_phase='starting_runtime',activity_detail='Preparing the Codex runtime',
        started_at=COALESCE(j.started_at,clock_timestamp()),heartbeat_at=clock_timestamp()
    FROM candidates c WHERE j.id=c.id RETURNING j.*
  ), reviewing AS (
    UPDATE tasks t SET status='reviewing',version=t.version+1,updated_at=clock_timestamp()
    FROM claimed j
    WHERE j.job_type='resume_codex' AND t.id=j.task_id AND t.status='awaiting_review'
    RETURNING t.id
  )
  SELECT j.* FROM claimed j LEFT JOIN reviewing r ON r.id=j.task_id;
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

CREATE OR REPLACE FUNCTION complete_codex_chat_job(
  p_job_id bigint,p_worker_id text,p_native_session_id text,p_turn_id text,p_content text
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE;
  v_assignment project_agent_assignments%ROWTYPE; v_agent agents%ROWTYPE;
  v_profile runtime_profiles%ROWTYPE; v_session_id uuid;
  v_event domain_events%ROWTYPE; v_result jsonb;
BEGIN
  IF p_turn_id IS NULL OR length(p_turn_id)=0 OR p_content IS NULL OR length(trim(p_content))=0 THEN
    RAISE EXCEPTION 'orchestrator turn id and response content are required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type NOT IN ('codex_chat_turn','resume_codex')
     OR v_job.status<>'in_flight' OR v_job.leased_by<>p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'Codex orchestration job is not actively leased' USING ERRCODE='55000';
  END IF;
  v_session_id:=bind_codex_chat_session(p_job_id,p_worker_id,p_native_session_id);
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_job.task_id FOR UPDATE;
  SELECT * INTO v_assignment FROM project_agent_assignments pa WHERE pa.id=v_task.orchestrator_assignment_id;
  SELECT * INTO v_agent FROM agents a WHERE a.id=v_assignment.agent_id;
  SELECT * INTO v_profile FROM runtime_profiles rp WHERE rp.id=v_assignment.runtime_profile_id;
  UPDATE tasks SET
      status=CASE WHEN v_job.job_type='resume_codex' AND status='reviewing' THEN 'awaiting_review' ELSE status END,
      version=version+1,updated_at=clock_timestamp()
    WHERE id=v_task.id RETURNING * INTO v_task;
  v_event:=append_event('chat.agent_message',v_job.project_id,v_job.task_id,NULL,
    'agent',v_agent.id::text,NULL,COALESCE(v_job.payload->>'correlation_id',v_job.task_id::text),
    'orchestrator-chat-response:' || v_job.source_event_id,'task',v_job.task_id,v_task.version,
    jsonb_build_object('content',p_content,'turn_id',p_turn_id,'agent_name',v_agent.name,
      'runtime_type',v_profile.runtime_type,'provider_type',v_profile.provider_type,'model',v_profile.model,
      'orchestrator_assignment_id',v_assignment.id,'runtime_profile_id',v_assignment.runtime_profile_id,
      'native_session_id',p_native_session_id,'session_id',v_session_id,'job_id',v_job.id,
      'source_job_type',v_job.job_type));
  v_result:=jsonb_build_object('status','completed','event_id',v_event.id,'task_id',v_job.task_id,
    'task_version',v_task.version,'task_status',v_task.status,'session_id',v_session_id,
    'native_session_id',p_native_session_id,'turn_id',p_turn_id,'source_job_type',v_job.job_type);
  PERFORM acknowledge_runtime_job(p_job_id,p_worker_id,v_result);
  RETURN v_result;
END; $$;

CREATE OR REPLACE FUNCTION resolve_runtime_job_incident(
  p_job_id bigint,p_actor_id text,p_resolution text,p_correlation_id text
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v runtime_jobs%ROWTYPE; v_audit uuid; v_task tasks%ROWTYPE;
BEGIN
  SELECT * INTO v FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v.status<>'dead_letter' OR v.resolved_at IS NOT NULL OR length(trim(p_resolution))<8 THEN
    RAISE EXCEPTION 'dead-letter incident is not resolvable' USING ERRCODE='55000';
  END IF;
  UPDATE runtime_jobs SET resolved_at=clock_timestamp(),resolved_by=p_actor_id,resolution=p_resolution
    WHERE id=p_job_id RETURNING * INTO v;
  IF v.job_type='resume_codex' THEN
    UPDATE tasks SET status='awaiting_review',version=version+1,updated_at=clock_timestamp()
      WHERE id=v.task_id AND status='reviewing' RETURNING * INTO v_task;
  END IF;
  v_audit:=write_audit_event(v.project_id,v.task_id,v.run_id,'operator',p_actor_id,
    'runtime_job.incident_resolved','runtime_job',v.id::text,'allowed',NULL,
    jsonb_build_object('resolution',p_resolution,'task_status',v_task.status),p_correlation_id);
  RETURN jsonb_build_object('job_id',v.id,'resolved_at',v.resolved_at,'audit_event_id',v_audit,
    'task_status',v_task.status);
END; $$;

ALTER FUNCTION claim_codex_chat_jobs(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION request_revision(uuid,uuid,uuid,jsonb,jsonb,text,bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION complete_codex_chat_job(bigint,text,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION resolve_runtime_job_incident(bigint,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
