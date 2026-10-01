BEGIN;

SET search_path TO control_plane, public, extensions;

ALTER TABLE handoffs ADD COLUMN executor_assignment_id uuid
  REFERENCES project_agent_assignments(id);

UPDATE handoffs h SET executor_assignment_id=(
  SELECT pa.id
  FROM tasks t
  JOIN project_agent_assignments pa ON pa.project_id=t.project_id
    AND pa.agent_id=h.to_agent_id AND pa.assignment_role='executor'
  WHERE t.id=h.task_id
  ORDER BY pa.enabled DESC,pa.created_at,pa.id LIMIT 1
);

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
  )
  UPDATE runtime_jobs j
  SET status='in_flight',attempt_count=j.attempt_count+1,leased_by=p_worker_id,
      leased_until=clock_timestamp()+p_lease,last_error=NULL,
      activity_phase='starting_runtime',activity_detail='Preparing the Codex runtime',
      started_at=COALESCE(j.started_at,clock_timestamp()),heartbeat_at=clock_timestamp()
  FROM candidates c WHERE j.id=c.id RETURNING j.*;
$$;

CREATE OR REPLACE FUNCTION codex_chat_job_context(p_job_id bigint,p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_context jsonb;
BEGIN
  SELECT jsonb_build_object(
    'job_id',j.id,'job_type',j.job_type,'source_event_id',j.source_event_id,
    'project_id',j.project_id,'task_id',j.task_id,'task_status',t.status,
    'task_version',t.version,'task_title',t.title,'task_objective',t.objective,
    'task_constraints',t.constraints,'task_acceptance_criteria',t.acceptance_criteria,
    'content',CASE WHEN j.job_type='codex_chat_turn'
      THEN j.payload#>>'{event_payload,content}'
      ELSE concat(
        'A durable ',j.payload->>'event_type',' event is ready for review. ',
        'Inspect the implementation in the read-only workspace. ',
        'If changes are required, call platform.request_revision. ',
        'Otherwise summarize the review result for the operator.',E'\n',
        jsonb_pretty(j.payload->'event_payload')) END,
    'correlation_id',j.payload->>'correlation_id','workspace_path',p.workspace_path,
    'agent_id',a.id,'agent_name',a.name,'orchestrator_assignment_id',pa.id,
    'runtime_profile_id',rp.id,'runtime_type',rp.runtime_type,
    'provider_type',rp.provider_type,'model',rp.model,'native_session_id',s.native_session_id,
    'executor',(
      SELECT jsonb_build_object(
        'assignment_id',epa.id,'agent_id',ea.id,'agent_name',ea.name,
        'runtime_profile_id',erp.id,'runtime_type',erp.runtime_type,
        'provider_type',erp.provider_type,'model',erp.model,'priority',tea.priority)
      FROM task_executor_assignments tea
      JOIN project_agent_assignments epa ON epa.id=tea.project_agent_assignment_id
        AND epa.enabled AND epa.assignment_role='executor'
      JOIN agents ea ON ea.id=epa.agent_id AND ea.enabled
      JOIN runtime_profiles erp ON erp.id=epa.runtime_profile_id
        AND erp.enabled AND erp.runtime_type='opencode'
      WHERE tea.task_id=t.id AND tea.enabled
      ORDER BY tea.priority,tea.created_at LIMIT 1
    )
  ) INTO v_context
  FROM runtime_jobs j
  JOIN projects p ON p.id=j.project_id
  JOIN tasks t ON t.id=j.task_id
  JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
    AND pa.enabled AND pa.assignment_role='orchestrator'
  JOIN agents a ON a.id=pa.agent_id AND a.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    AND rp.enabled AND rp.runtime_type='codex'
  LEFT JOIN agent_sessions s ON s.project_id=j.project_id AND s.agent_id=a.id
    AND s.runtime_profile_id=rp.id AND s.purpose='task_chat:' || j.task_id::text AND s.active
  WHERE j.id=p_job_id AND j.job_type IN ('codex_chat_turn','resume_codex')
    AND j.status='in_flight' AND j.leased_by=p_worker_id
    AND j.leased_until>clock_timestamp();
  IF v_context IS NULL THEN
    RAISE EXCEPTION 'Codex orchestration job % is not actively leased by worker %',p_job_id,p_worker_id
      USING ERRCODE='55000';
  END IF;
  RETURN v_context;
END; $$;

CREATE OR REPLACE FUNCTION bind_codex_chat_session(
  p_job_id bigint,p_worker_id text,p_native_session_id text
)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE;
  v_assignment project_agent_assignments%ROWTYPE; v_session agent_sessions%ROWTYPE; v_purpose text;
BEGIN
  IF p_native_session_id IS NULL OR length(p_native_session_id)=0 THEN
    RAISE EXCEPTION 'native Codex session id is required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type NOT IN ('codex_chat_turn','resume_codex')
     OR v_job.status<>'in_flight' OR v_job.leased_by<>p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'Codex orchestration job is not actively leased' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_job.task_id;
  SELECT * INTO v_assignment FROM project_agent_assignments pa
  WHERE pa.id=v_task.orchestrator_assignment_id AND pa.enabled
    AND pa.assignment_role='orchestrator';
  IF NOT FOUND OR NOT EXISTS(
    SELECT 1 FROM agents a JOIN runtime_profiles rp ON rp.id=v_assignment.runtime_profile_id
    WHERE a.id=v_assignment.agent_id AND a.enabled AND rp.enabled AND rp.runtime_type='codex'
  ) THEN RAISE EXCEPTION 'task orchestrator is not an enabled Codex runtime' USING ERRCODE='55000'; END IF;
  v_purpose:='task_chat:' || v_job.task_id::text;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,native_session_id,purpose,
    status,active,last_resumed_at,metadata)
  VALUES(v_job.project_id,v_assignment.agent_id,v_assignment.runtime_profile_id,
    p_native_session_id,v_purpose,'active',true,clock_timestamp(),
    jsonb_build_object('task_id',v_job.task_id,'orchestrator_assignment_id',v_assignment.id))
  ON CONFLICT(project_id,agent_id,purpose) WHERE active DO UPDATE
  SET native_session_id=CASE WHEN agent_sessions.native_session_id IS NULL
        THEN EXCLUDED.native_session_id ELSE agent_sessions.native_session_id END,
      runtime_profile_id=EXCLUDED.runtime_profile_id,status='active',
      last_resumed_at=clock_timestamp(),updated_at=clock_timestamp(),
      version=agent_sessions.version+1
  RETURNING * INTO v_session;
  IF v_session.native_session_id<>p_native_session_id
     OR v_session.runtime_profile_id<>v_assignment.runtime_profile_id THEN
    RAISE EXCEPTION 'orchestrator session continuity validation failed' USING ERRCODE='55000';
  END IF;
  RETURN v_session.id;
END; $$;

CREATE OR REPLACE FUNCTION invoke_codex_delegate_task(
  p_job_id bigint,p_worker_id text,p_call_id text,p_objective text,
  p_instructions jsonb,p_relevant_paths jsonb
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE;
  v_orchestrator project_agent_assignments%ROWTYPE;
  v_executor project_agent_assignments%ROWTYPE; v_project projects%ROWTYPE;
  v_existing commands%ROWTYPE; v_key text; v_result jsonb;
BEGIN
  IF p_call_id IS NULL OR length(trim(p_call_id))<4 OR length(trim(p_objective))<4
     OR jsonb_typeof(p_instructions)<>'array' OR jsonb_typeof(p_relevant_paths)<>'array' THEN
    RAISE EXCEPTION 'invalid delegate_task arguments' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type<>'codex_chat_turn' OR v_job.status<>'in_flight'
     OR v_job.leased_by<>p_worker_id OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'delegate_task is not bound to an active Codex chat turn' USING ERRCODE='55000';
  END IF;
  v_key:='codex-tool:' || p_job_id || ':' || p_call_id;
  SELECT * INTO v_existing FROM commands c
    WHERE c.project_id=v_job.project_id AND c.idempotency_key=v_key;
  IF FOUND AND v_existing.status='completed' THEN RETURN v_existing.result; END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_job.task_id AND t.project_id=v_job.project_id FOR UPDATE;
  IF NOT FOUND OR v_task.status<>'ready' THEN
    RAISE EXCEPTION 'task is not ready for initial delegation' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_orchestrator FROM project_agent_assignments pa
    WHERE pa.id=v_task.orchestrator_assignment_id AND pa.enabled
      AND pa.assignment_role='orchestrator';
  SELECT pa.* INTO v_executor
  FROM task_executor_assignments tea
  JOIN project_agent_assignments pa ON pa.id=tea.project_agent_assignment_id
  JOIN agents a ON a.id=pa.agent_id AND a.enabled AND a.role='implementer'
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    AND rp.enabled AND rp.runtime_type='opencode'
  WHERE tea.task_id=v_task.id AND tea.enabled AND pa.enabled
    AND pa.project_id=v_task.project_id AND pa.assignment_role='executor'
  ORDER BY tea.priority,tea.created_at LIMIT 1;
  IF v_orchestrator.id IS NULL OR v_executor.id IS NULL THEN
    RAISE EXCEPTION 'task orchestration assignments are unavailable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_project FROM projects p WHERE p.id=v_task.project_id;
  v_result:=request_implementation(
    v_task.project_id,v_task.id,v_orchestrator.agent_id,v_executor.agent_id,1,
    p_objective,p_instructions,v_task.constraints,v_task.acceptance_criteria,
    p_relevant_paths,v_project.workspace_path,
    v_key,v_task.version,
    COALESCE(v_job.payload->>'correlation_id',v_task.id::text)
  );
  UPDATE handoffs SET executor_assignment_id=v_executor.id
    WHERE id=(v_result->>'handoff_id')::uuid AND executor_assignment_id IS NULL;
  RETURN v_result;
END; $$;

CREATE OR REPLACE FUNCTION invoke_codex_request_revision(
  p_job_id bigint,p_worker_id text,p_call_id text,p_changes_required jsonb
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE;
  v_orchestrator project_agent_assignments%ROWTYPE; v_handoff handoffs%ROWTYPE;
  v_existing commands%ROWTYPE; v_key text; v_result jsonb;
BEGIN
  IF p_call_id IS NULL OR length(trim(p_call_id))<4
     OR jsonb_typeof(p_changes_required)<>'array' OR jsonb_array_length(p_changes_required)=0 THEN
    RAISE EXCEPTION 'invalid request_revision arguments' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type<>'resume_codex' OR v_job.status<>'in_flight'
     OR v_job.leased_by<>p_worker_id OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'request_revision is not bound to an active Codex review turn' USING ERRCODE='55000';
  END IF;
  v_key:='codex-tool:' || p_job_id || ':' || p_call_id;
  SELECT * INTO v_existing FROM commands c
    WHERE c.project_id=v_job.project_id AND c.idempotency_key=v_key;
  IF FOUND AND v_existing.status='completed' THEN RETURN v_existing.result; END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_job.task_id AND t.project_id=v_job.project_id FOR UPDATE;
  SELECT * INTO v_orchestrator FROM project_agent_assignments pa
    WHERE pa.id=v_task.orchestrator_assignment_id AND pa.enabled
      AND pa.assignment_role='orchestrator';
  SELECT * INTO v_handoff FROM handoffs h WHERE h.task_id=v_task.id
    ORDER BY h.revision_number DESC LIMIT 1;
  IF v_orchestrator.id IS NULL OR v_handoff.id IS NULL OR v_handoff.executor_assignment_id IS NULL
     OR NOT EXISTS(
       SELECT 1 FROM task_executor_assignments tea
       JOIN project_agent_assignments pa ON pa.id=tea.project_agent_assignment_id
       JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
       WHERE tea.task_id=v_task.id AND tea.project_agent_assignment_id=v_handoff.executor_assignment_id
         AND tea.enabled AND pa.enabled AND pa.assignment_role='executor'
         AND rp.enabled AND rp.runtime_type='opencode'
     ) THEN
    RAISE EXCEPTION 'review context is unavailable' USING ERRCODE='55000';
  END IF;
  v_result:=request_revision(
    v_task.project_id,v_task.id,v_orchestrator.agent_id,p_changes_required,
    v_handoff.acceptance_criteria,v_key,
    v_task.version,COALESCE(v_job.payload->>'correlation_id',v_task.id::text)
  );
  UPDATE handoffs SET executor_assignment_id=v_handoff.executor_assignment_id
    WHERE id=(v_result#>>'{delegation,handoff_id}')::uuid AND executor_assignment_id IS NULL;
  RETURN v_result;
END; $$;

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
  UPDATE tasks SET version=version+1,updated_at=clock_timestamp()
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
    'task_version',v_task.version,'session_id',v_session_id,'native_session_id',p_native_session_id,
    'turn_id',p_turn_id,'source_job_type',v_job.job_type);
  PERFORM acknowledge_runtime_job(p_job_id,p_worker_id,v_result);
  RETURN v_result;
END; $$;

CREATE OR REPLACE FUNCTION claim_executor_jobs(
  p_worker_id text,p_limit integer DEFAULT 1,p_lease interval DEFAULT interval '5 minutes'
)
RETURNS SETOF runtime_jobs LANGUAGE sql AS $$
  WITH candidates AS (
    SELECT j.id FROM runtime_jobs j
    WHERE j.job_type='start_implementation' AND j.available_at<=clock_timestamp()
      AND (j.status='pending' OR (j.status='in_flight' AND j.leased_until<=clock_timestamp()))
    ORDER BY j.available_at,j.id FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  )
  UPDATE runtime_jobs j
  SET status='in_flight',attempt_count=j.attempt_count+1,leased_by=p_worker_id,
      leased_until=clock_timestamp()+p_lease,last_error=NULL,
      activity_phase='starting_runtime',activity_detail='Preparing the selected executor runtime',
      started_at=COALESCE(j.started_at,clock_timestamp()),heartbeat_at=clock_timestamp()
  FROM candidates c WHERE j.id=c.id RETURNING j.*;
$$;

CREATE OR REPLACE FUNCTION executor_job_context(p_job_id bigint,p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_context jsonb; v_session agent_sessions%ROWTYPE;
BEGIN
  SELECT s.* INTO v_session
  FROM runtime_jobs j
  JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
  JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
  JOIN project_agent_assignments pa ON pa.id=h.executor_assignment_id
    AND pa.project_id=j.project_id AND pa.agent_id=h.to_agent_id
    AND pa.assignment_role='executor' AND pa.enabled
  JOIN task_executor_assignments tea ON tea.task_id=j.task_id
    AND tea.project_agent_assignment_id=pa.id AND tea.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND rp.runtime_type='opencode'
  LEFT JOIN agent_sessions s ON s.project_id=j.project_id AND s.agent_id=pa.agent_id
    AND s.runtime_profile_id=rp.id AND s.purpose='task_executor:' || j.task_id::text AND s.active
  WHERE j.id=p_job_id AND j.job_type='start_implementation' AND j.status='in_flight'
    AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp();

  IF v_session.id IS NULL THEN
    INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,status,active,metadata)
    SELECT j.project_id,pa.agent_id,pa.runtime_profile_id,'task_executor:' || j.task_id::text,
      'active',true,jsonb_build_object('task_id',j.task_id,'executor_assignment_id',pa.id)
    FROM runtime_jobs j
    JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
    JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
    JOIN project_agent_assignments pa ON pa.id=h.executor_assignment_id
      AND pa.project_id=j.project_id AND pa.agent_id=h.to_agent_id
      AND pa.assignment_role='executor' AND pa.enabled
    JOIN task_executor_assignments tea ON tea.task_id=j.task_id
      AND tea.project_agent_assignment_id=pa.id AND tea.enabled
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND rp.runtime_type='opencode'
    WHERE j.id=p_job_id AND j.job_type='start_implementation' AND j.status='in_flight'
      AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp()
    ON CONFLICT(project_id,agent_id,purpose) WHERE active DO UPDATE
      SET runtime_profile_id=EXCLUDED.runtime_profile_id,updated_at=clock_timestamp(),
          version=agent_sessions.version+1
    RETURNING * INTO v_session;
  END IF;

  SELECT jsonb_build_object(
    'job_id',j.id,'project_id',j.project_id,'task_id',j.task_id,
    'source_event_id',j.source_event_id,'correlation_id',j.payload->>'correlation_id',
    'workspace_path',p.workspace_path,'handoff_id',h.id,'revision_number',h.revision_number,
    'objective',h.objective,'instructions',h.instructions,'constraints',h.constraints,
    'acceptance_criteria',h.acceptance_criteria,'relevant_paths',h.relevant_paths,
    'agent_id',a.id,'agent_name',a.name,'runtime_profile_id',rp.id,
    'runtime_type',rp.runtime_type,'provider_type',rp.provider_type,'model',rp.model,
    'session_id',v_session.id,'native_session_id',v_session.native_session_id
  ) INTO v_context
  FROM runtime_jobs j
  JOIN projects p ON p.id=j.project_id
  JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
  JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
  JOIN project_agent_assignments pa ON pa.id=h.executor_assignment_id
    AND pa.project_id=j.project_id AND pa.agent_id=h.to_agent_id
    AND pa.assignment_role='executor' AND pa.enabled
  JOIN task_executor_assignments tea ON tea.task_id=j.task_id
    AND tea.project_agent_assignment_id=pa.id AND tea.enabled
  JOIN agents a ON a.id=pa.agent_id AND a.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND rp.runtime_type='opencode'
  WHERE j.id=p_job_id AND j.job_type='start_implementation' AND j.status='in_flight'
    AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp();
  IF v_context IS NULL THEN
    RAISE EXCEPTION 'executor job % is not actively leased or assigned',p_job_id USING ERRCODE='55000';
  END IF;
  RETURN v_context;
END; $$;

ALTER FUNCTION claim_codex_chat_jobs(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION codex_chat_job_context(bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION bind_codex_chat_session(bigint,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION invoke_codex_delegate_task(bigint,text,text,text,jsonb,jsonb)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION invoke_codex_request_revision(bigint,text,text,jsonb)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION complete_codex_chat_job(bigint,text,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_executor_jobs(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION executor_job_context(bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
