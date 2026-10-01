BEGIN;

SET search_path TO control_plane, public, extensions;

CREATE TABLE project_agent_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  runtime_profile_id uuid NOT NULL REFERENCES runtime_profiles(id),
  assignment_role text NOT NULL CHECK (assignment_role IN ('orchestrator','executor')),
  enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,agent_id,runtime_profile_id,assignment_role),
  CHECK (assignment_role='orchestrator' OR NOT is_default)
);

CREATE UNIQUE INDEX project_agent_assignments_default_orchestrator
  ON project_agent_assignments(project_id)
  WHERE assignment_role='orchestrator' AND enabled AND is_default;

CREATE OR REPLACE FUNCTION validate_project_agent_assignment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_agent_role text; v_agent_runtime text; v_profile_runtime text;
BEGIN
  SELECT a.role,base.runtime_type INTO v_agent_role,v_agent_runtime
  FROM agents a JOIN runtime_profiles base ON base.id=a.runtime_profile_id
  WHERE a.id=NEW.agent_id AND a.enabled;
  SELECT rp.runtime_type INTO v_profile_runtime FROM runtime_profiles rp
  WHERE rp.id=NEW.runtime_profile_id AND rp.enabled;
  IF v_agent_role IS NULL OR v_profile_runtime IS NULL OR v_agent_runtime<>v_profile_runtime THEN
    RAISE EXCEPTION 'agent assignment runtime is incompatible' USING ERRCODE='23514';
  END IF;
  IF NEW.assignment_role='orchestrator' AND v_agent_role NOT IN ('architect','reviewer') THEN
    RAISE EXCEPTION 'orchestrator assignment requires an architect or reviewer agent' USING ERRCODE='23514';
  END IF;
  IF NEW.assignment_role='executor' AND v_agent_role<>'implementer' THEN
    RAISE EXCEPTION 'executor assignment requires an implementer agent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER project_agent_assignment_guard
  BEFORE INSERT OR UPDATE OF agent_id,runtime_profile_id,assignment_role,enabled,is_default
  ON project_agent_assignments FOR EACH ROW
  EXECUTE FUNCTION validate_project_agent_assignment();

WITH selected AS (
  SELECT p.id AS project_id,c.agent_id,c.runtime_profile_id
  FROM projects p
  CROSS JOIN LATERAL (
    SELECT a.id AS agent_id,rp.id AS runtime_profile_id
    FROM agents a JOIN runtime_profiles rp ON rp.id=a.runtime_profile_id
    WHERE a.enabled AND rp.enabled AND a.role IN ('architect','reviewer')
      AND rp.runtime_type='codex'
    ORDER BY
      CASE WHEN EXISTS(SELECT 1 FROM tasks t WHERE t.project_id=p.id AND t.active_agent_id=a.id) THEN 0
           WHEN EXISTS(SELECT 1 FROM agent_sessions s WHERE s.project_id=p.id AND s.agent_id=a.id) THEN 1
           ELSE 2 END,
      a.created_at,a.id
    LIMIT 1
  ) c
)
INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
SELECT project_id,agent_id,runtime_profile_id,'orchestrator',true FROM selected;

WITH selected AS (
  SELECT p.id AS project_id,c.agent_id,c.runtime_profile_id
  FROM projects p
  CROSS JOIN LATERAL (
    SELECT a.id AS agent_id,rp.id AS runtime_profile_id
    FROM agents a JOIN runtime_profiles rp ON rp.id=a.runtime_profile_id
    WHERE a.enabled AND rp.enabled AND a.role='implementer'
    ORDER BY
      CASE WHEN EXISTS(
        SELECT 1 FROM tasks t JOIN handoffs h ON h.task_id=t.id
        WHERE t.project_id=p.id AND h.to_agent_id=a.id
      ) THEN 0
      WHEN EXISTS(SELECT 1 FROM agent_sessions s WHERE s.project_id=p.id AND s.agent_id=a.id) THEN 1
      ELSE 2 END,
      a.created_at,a.id
    LIMIT 1
  ) c
)
INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
SELECT project_id,agent_id,runtime_profile_id,'executor' FROM selected;

ALTER TABLE tasks ADD COLUMN orchestrator_assignment_id uuid
  REFERENCES project_agent_assignments(id);

UPDATE tasks t SET orchestrator_assignment_id=(
  SELECT pa.id FROM project_agent_assignments pa
  WHERE pa.project_id=t.project_id AND pa.assignment_role='orchestrator'
    AND pa.enabled AND pa.is_default
);

CREATE TABLE task_executor_assignments (
  task_id uuid NOT NULL REFERENCES tasks(id),
  project_agent_assignment_id uuid NOT NULL REFERENCES project_agent_assignments(id),
  priority integer NOT NULL DEFAULT 100 CHECK (priority>0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(task_id,project_agent_assignment_id)
);

CREATE OR REPLACE FUNCTION validate_task_executor_assignment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM tasks t JOIN project_agent_assignments pa
      ON pa.id=NEW.project_agent_assignment_id
    WHERE t.id=NEW.task_id AND pa.project_id=t.project_id
      AND pa.assignment_role='executor' AND pa.enabled
  ) THEN
    RAISE EXCEPTION 'task executor is not enabled for this project' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER task_executor_assignment_guard
  BEFORE INSERT OR UPDATE OF task_id,project_agent_assignment_id,enabled
  ON task_executor_assignments FOR EACH ROW
  EXECUTE FUNCTION validate_task_executor_assignment();

INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority)
SELECT t.id,pa.id,row_number() OVER(PARTITION BY t.id ORDER BY pa.created_at,pa.id)*100
FROM tasks t JOIN project_agent_assignments pa ON pa.project_id=t.project_id
WHERE pa.assignment_role='executor' AND pa.enabled;

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
      JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
        AND pa.enabled AND pa.assignment_role='orchestrator'
      JOIN agents a ON a.id=pa.agent_id AND a.enabled
      JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled
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

CREATE OR REPLACE FUNCTION codex_chat_job_context(p_job_id bigint,p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_context jsonb;
BEGIN
  SELECT jsonb_build_object(
    'job_id',j.id,'source_event_id',j.source_event_id,'project_id',j.project_id,
    'task_id',j.task_id,'content',j.payload#>>'{event_payload,content}',
    'correlation_id',j.payload->>'correlation_id','workspace_path',p.workspace_path,
    'agent_id',a.id,'agent_name',a.name,'runtime_profile_id',rp.id,
    'runtime_type',rp.runtime_type,'provider_type',rp.provider_type,'model',rp.model,
    'native_session_id',s.native_session_id
  ) INTO v_context
  FROM runtime_jobs j
  JOIN projects p ON p.id=j.project_id
  JOIN tasks t ON t.id=j.task_id
  JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
    AND pa.enabled AND pa.assignment_role='orchestrator'
  JOIN agents a ON a.id=pa.agent_id AND a.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND rp.runtime_type='codex'
  LEFT JOIN agent_sessions s ON s.project_id=j.project_id AND s.agent_id=a.id
    AND s.runtime_profile_id=rp.id AND s.purpose='task_chat:' || j.task_id::text AND s.active
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
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE;
  v_assignment project_agent_assignments%ROWTYPE; v_session agent_sessions%ROWTYPE; v_purpose text;
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

CREATE OR REPLACE FUNCTION complete_codex_chat_job(
  p_job_id bigint,p_worker_id text,p_native_session_id text,p_turn_id text,p_content text
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE;
  v_assignment project_agent_assignments%ROWTYPE; v_agent agents%ROWTYPE;
  v_profile runtime_profiles%ROWTYPE;
  v_session_id uuid; v_event domain_events%ROWTYPE; v_result jsonb;
BEGIN
  IF p_turn_id IS NULL OR length(p_turn_id)=0 OR p_content IS NULL OR length(trim(p_content))=0 THEN
    RAISE EXCEPTION 'orchestrator turn id and response content are required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type<>'codex_chat_turn' OR v_job.status<>'in_flight'
     OR v_job.leased_by<>p_worker_id OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'Codex chat job is not actively leased' USING ERRCODE='55000';
  END IF;
  v_session_id:=bind_codex_chat_session(p_job_id,p_worker_id,p_native_session_id);
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_job.task_id FOR UPDATE;
  SELECT * INTO v_assignment FROM project_agent_assignments pa
    WHERE pa.id=v_task.orchestrator_assignment_id;
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
      'native_session_id',p_native_session_id,'session_id',v_session_id,'job_id',v_job.id));
  v_result:=jsonb_build_object('status','completed','event_id',v_event.id,'task_id',v_job.task_id,
    'task_version',v_task.version,'session_id',v_session_id,
    'native_session_id',p_native_session_id,'turn_id',p_turn_id);
  PERFORM acknowledge_runtime_job(p_job_id,p_worker_id,v_result);
  RETURN v_result;
END; $$;

ALTER FUNCTION validate_project_agent_assignment()
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION validate_task_executor_assignment()
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION route_outbox_message(bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION codex_chat_job_context(bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION bind_codex_chat_session(bigint,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION complete_codex_chat_job(bigint,text,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
