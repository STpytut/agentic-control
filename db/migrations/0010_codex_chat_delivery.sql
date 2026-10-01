BEGIN;

SET search_path TO control_plane, public;

ALTER TABLE runtime_jobs DROP CONSTRAINT runtime_jobs_job_type_check;
ALTER TABLE runtime_jobs ADD CONSTRAINT runtime_jobs_job_type_check
  CHECK (job_type IN ('start_implementation', 'resume_codex', 'codex_chat_turn'));

CREATE OR REPLACE FUNCTION route_outbox_message(p_message_id bigint,p_dispatcher_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_message outbox_messages%ROWTYPE; v_event domain_events%ROWTYPE;
  v_job runtime_jobs%ROWTYPE; v_job_type text;
BEGIN
  SELECT * INTO v_message FROM outbox_messages o WHERE o.id=p_message_id FOR UPDATE;
  IF NOT FOUND OR v_message.status<>'in_flight' OR v_message.leased_by<>p_dispatcher_id
     OR v_message.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'outbox message is not actively leased' USING ERRCODE='55000';
  END IF;

  SELECT * INTO v_event FROM domain_events e WHERE e.id=v_message.event_id;
  v_job_type:=CASE
    WHEN v_event.event_type='implementation.requested' THEN 'start_implementation'
    WHEN v_event.event_type IN ('implementation.completed','revision.completed') THEN 'resume_codex'
    WHEN v_event.event_type='chat.user_message' AND EXISTS(
      SELECT 1 FROM tasks t
      JOIN agents a ON a.id=t.active_agent_id AND a.enabled
      JOIN runtime_profiles rp ON rp.id=a.runtime_profile_id AND rp.enabled
      WHERE t.id=v_event.task_id AND rp.runtime_type='codex'
    ) THEN 'codex_chat_turn'
  END;

  IF v_job_type IS NOT NULL THEN
    INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,run_id,payload)
    VALUES(v_event.id,v_job_type,v_event.project_id,v_event.task_id,v_event.run_id,
      jsonb_build_object('event_id',v_event.id,'event_type',v_event.event_type,
        'correlation_id',v_event.correlation_id,'event_payload',v_event.payload))
    ON CONFLICT(source_event_id,job_type) DO UPDATE SET source_event_id=EXCLUDED.source_event_id
    RETURNING * INTO v_job;
  END IF;

  PERFORM acknowledge_outbox(p_message_id,p_dispatcher_id);
  RETURN jsonb_build_object('message_id',p_message_id,'event_id',v_event.id,
    'event_type',v_event.event_type,'job_id',v_job.id,'job_type',v_job.job_type,
    'routed',v_job_type IS NOT NULL);
END; $$;

CREATE OR REPLACE FUNCTION claim_codex_chat_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 1,
  p_lease interval DEFAULT interval '5 minutes'
)
RETURNS SETOF runtime_jobs
LANGUAGE sql
AS $$
  WITH candidates AS (
    SELECT j.id
    FROM runtime_jobs j
    WHERE j.job_type='codex_chat_turn'
      AND j.available_at<=clock_timestamp()
      AND (j.status='pending' OR (j.status='in_flight' AND j.leased_until<=clock_timestamp()))
      AND NOT EXISTS (
        SELECT 1 FROM runtime_jobs earlier
        WHERE earlier.job_type='codex_chat_turn'
          AND earlier.task_id=j.task_id
          AND earlier.id<j.id
          AND earlier.status IN ('pending','in_flight')
      )
    ORDER BY j.available_at,j.id
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(p_limit,0)
  )
  UPDATE runtime_jobs j
  SET status='in_flight',attempt_count=j.attempt_count+1,leased_by=p_worker_id,
      leased_until=clock_timestamp()+p_lease,last_error=NULL
  FROM candidates c WHERE j.id=c.id
  RETURNING j.*;
$$;

CREATE OR REPLACE FUNCTION codex_chat_job_context(p_job_id bigint,p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_context jsonb;
BEGIN
  SELECT jsonb_build_object(
    'job_id',j.id,'source_event_id',j.source_event_id,'project_id',j.project_id,
    'task_id',j.task_id,'content',j.payload#>>'{event_payload,content}',
    'correlation_id',j.payload->>'correlation_id','workspace_path',p.workspace_path,
    'agent_id',a.id,'agent_name',a.name,'runtime_profile_id',rp.id,'model',rp.model,
    'native_session_id',s.native_session_id
  ) INTO v_context
  FROM runtime_jobs j
  JOIN projects p ON p.id=j.project_id
  JOIN tasks t ON t.id=j.task_id
  JOIN agents a ON a.id=t.active_agent_id AND a.enabled
  JOIN runtime_profiles rp ON rp.id=a.runtime_profile_id AND rp.enabled AND rp.runtime_type='codex'
  LEFT JOIN agent_sessions s ON s.project_id=j.project_id AND s.agent_id=a.id
    AND s.purpose='task_chat:' || j.task_id::text AND s.active
  WHERE j.id=p_job_id AND j.job_type='codex_chat_turn' AND j.status='in_flight'
    AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp();

  IF v_context IS NULL THEN
    RAISE EXCEPTION 'Codex chat job % is not actively leased by worker %',p_job_id,p_worker_id
      USING ERRCODE='55000';
  END IF;
  RETURN v_context;
END; $$;

CREATE OR REPLACE FUNCTION bind_codex_chat_session(
  p_job_id bigint,p_worker_id text,p_native_session_id text
)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE; v_agent agents%ROWTYPE;
  v_session agent_sessions%ROWTYPE; v_purpose text;
BEGIN
  IF p_native_session_id IS NULL OR length(p_native_session_id)=0 THEN
    RAISE EXCEPTION 'native Codex session id is required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type<>'codex_chat_turn' OR v_job.status<>'in_flight'
     OR v_job.leased_by<>p_worker_id OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'Codex chat job is not actively leased' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_job.task_id;
  SELECT * INTO v_agent FROM agents a WHERE a.id=v_task.active_agent_id AND a.enabled;
  IF NOT FOUND OR NOT EXISTS(
    SELECT 1 FROM runtime_profiles rp WHERE rp.id=v_agent.runtime_profile_id
      AND rp.runtime_type='codex' AND rp.enabled
  ) THEN RAISE EXCEPTION 'active task agent is not an enabled Codex runtime' USING ERRCODE='55000'; END IF;

  v_purpose:='task_chat:' || v_job.task_id::text;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,native_session_id,purpose,
    status,active,last_resumed_at,metadata)
  VALUES(v_job.project_id,v_agent.id,v_agent.runtime_profile_id,p_native_session_id,v_purpose,
    'active',true,clock_timestamp(),jsonb_build_object('task_id',v_job.task_id))
  ON CONFLICT(project_id,agent_id,purpose) WHERE active DO UPDATE
  SET native_session_id=CASE
        WHEN agent_sessions.native_session_id IS NULL THEN EXCLUDED.native_session_id
        ELSE agent_sessions.native_session_id
      END,
      status='active',last_resumed_at=clock_timestamp(),updated_at=clock_timestamp(),
      version=agent_sessions.version+1
  RETURNING * INTO v_session;
  IF v_session.native_session_id<>p_native_session_id THEN
    RAISE EXCEPTION 'Codex session continuity validation failed' USING ERRCODE='55000';
  END IF;
  RETURN v_session.id;
END; $$;

CREATE OR REPLACE FUNCTION complete_codex_chat_job(
  p_job_id bigint,p_worker_id text,p_native_session_id text,p_turn_id text,p_content text
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE; v_agent agents%ROWTYPE;
  v_session_id uuid; v_event domain_events%ROWTYPE; v_result jsonb;
BEGIN
  IF p_turn_id IS NULL OR length(p_turn_id)=0 OR p_content IS NULL OR length(trim(p_content))=0 THEN
    RAISE EXCEPTION 'Codex turn id and response content are required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type<>'codex_chat_turn' OR v_job.status<>'in_flight'
     OR v_job.leased_by<>p_worker_id OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'Codex chat job is not actively leased' USING ERRCODE='55000';
  END IF;
  v_session_id:=bind_codex_chat_session(p_job_id,p_worker_id,p_native_session_id);
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_job.task_id FOR UPDATE;
  SELECT * INTO v_agent FROM agents a WHERE a.id=v_task.active_agent_id;
  UPDATE tasks SET version=version+1,updated_at=clock_timestamp()
    WHERE id=v_task.id RETURNING * INTO v_task;
  v_event:=append_event('chat.agent_message',v_job.project_id,v_job.task_id,NULL,
    'agent',v_agent.id::text,NULL,COALESCE(v_job.payload->>'correlation_id',v_job.task_id::text),
    'codex-chat-response:' || v_job.source_event_id,'task',v_job.task_id,v_task.version,
    jsonb_build_object('content',p_content,'turn_id',p_turn_id,
      'native_session_id',p_native_session_id,'session_id',v_session_id,'job_id',v_job.id));
  v_result:=jsonb_build_object('status','completed','event_id',v_event.id,'task_id',v_job.task_id,
    'task_version',v_task.version,'session_id',v_session_id,
    'native_session_id',p_native_session_id,'turn_id',p_turn_id);
  PERFORM acknowledge_runtime_job(p_job_id,p_worker_id,v_result);
  RETURN v_result;
END; $$;

COMMIT;
