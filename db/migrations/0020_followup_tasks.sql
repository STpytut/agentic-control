BEGIN;
SET search_path TO control_plane,public,extensions;

ALTER TABLE tasks ADD COLUMN followup_of_task_id uuid REFERENCES tasks(id);
ALTER TABLE tasks ADD CONSTRAINT tasks_followup_not_self
  CHECK (followup_of_task_id IS NULL OR followup_of_task_id<>id);
CREATE INDEX tasks_followup_lineage ON tasks(followup_of_task_id)
  WHERE followup_of_task_id IS NOT NULL;

CREATE OR REPLACE FUNCTION create_followup_task(
  p_project_id uuid,
  p_source_task_id uuid,
  p_new_task_id uuid,
  p_actor_id text,
  p_title text,
  p_objective text,
  p_idempotency_key text,
  p_expected_version bigint,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_command commands%ROWTYPE;
  v_source tasks%ROWTYPE;
  v_created tasks%ROWTYPE;
  v_event domain_events%ROWTYPE;
  v_audit uuid;
  v_executor_count integer;
  v_session_count integer;
  v_result jsonb;
BEGIN
  IF p_new_task_id IS NULL OR length(trim(p_actor_id))=0
     OR length(trim(p_title))<2 OR length(p_title)>120
     OR length(trim(p_objective))<2 OR length(p_objective)>12000 THEN
    RAISE EXCEPTION 'invalid follow-up task arguments' USING ERRCODE='22023';
  END IF;

  v_command:=submit_command(
    p_project_id,p_source_task_id,'CreateFollowupTask','user',p_actor_id,
    p_idempotency_key,
    jsonb_build_object('source_task_id',p_source_task_id,'title',p_title,'objective',p_objective),
    p_expected_version,p_correlation_id
  );
  IF v_command.status='completed' THEN RETURN v_command.result; END IF;

  SELECT * INTO v_source FROM tasks t
  WHERE t.id=p_source_task_id AND t.project_id=p_project_id FOR UPDATE;
  IF NOT FOUND OR v_source.version<>p_expected_version
     OR v_source.status NOT IN ('approved','completed','deployed') THEN
    RAISE EXCEPTION 'source task is not terminal at the expected version' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM project_agent_assignments pa
    JOIN agents a ON a.id=pa.agent_id AND a.enabled
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled
    WHERE pa.id=v_source.orchestrator_assignment_id AND pa.project_id=p_project_id
      AND pa.enabled AND pa.assignment_role='orchestrator' AND rp.runtime_type='codex'
  ) THEN
    RAISE EXCEPTION 'source task orchestrator is unavailable' USING ERRCODE='55000';
  END IF;

  INSERT INTO tasks(
    id,project_id,title,objective,constraints,acceptance_criteria,status,
    active_agent_id,orchestrator_assignment_id,created_by,followup_of_task_id
  ) VALUES (
    p_new_task_id,p_project_id,trim(p_title),trim(p_objective),
    v_source.constraints,v_source.acceptance_criteria,'planning',
    v_source.active_agent_id,v_source.orchestrator_assignment_id,p_actor_id,p_source_task_id
  ) RETURNING * INTO v_created;

  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority,enabled)
  SELECT v_created.id,tea.project_agent_assignment_id,tea.priority,tea.enabled
  FROM task_executor_assignments tea
  JOIN project_agent_assignments pa ON pa.id=tea.project_agent_assignment_id
    AND pa.project_id=p_project_id AND pa.enabled AND pa.assignment_role='executor'
  WHERE tea.task_id=p_source_task_id AND tea.enabled;
  GET DIAGNOSTICS v_executor_count=ROW_COUNT;

  INSERT INTO agent_sessions(
    project_id,agent_id,runtime_profile_id,native_session_id,purpose,status,
    active,last_resumed_at,metadata
  )
  SELECT s.project_id,s.agent_id,s.runtime_profile_id,s.native_session_id,
    CASE
      WHEN s.purpose='task_chat:'||p_source_task_id::text THEN 'task_chat:'||v_created.id::text
      ELSE 'task_executor:'||v_created.id::text
    END,
    'active',true,s.last_resumed_at,
    s.metadata||jsonb_build_object('task_id',v_created.id,'followup_of_task_id',p_source_task_id,
      'continued_from_session_id',s.id)
  FROM agent_sessions s
  WHERE s.project_id=p_project_id AND s.active AND s.native_session_id IS NOT NULL
    AND s.purpose IN ('task_chat:'||p_source_task_id::text,'task_executor:'||p_source_task_id::text)
  ON CONFLICT(project_id,agent_id,purpose) WHERE active DO NOTHING;
  GET DIAGNOSTICS v_session_count=ROW_COUNT;

  v_event:=append_event(
    'chat.user_message',p_project_id,v_created.id,NULL,'user',p_actor_id,
    v_command.id,p_correlation_id,'followup-message:'||p_idempotency_key,
    'task',v_created.id,v_created.version,
    jsonb_build_object(
      'content',v_created.objective,'title',v_created.title,
      'followup_of_task_id',p_source_task_id,
      'orchestrator_assignment_id',v_created.orchestrator_assignment_id,
      'executor_assignment_ids',COALESCE((
        SELECT jsonb_agg(tea.project_agent_assignment_id ORDER BY tea.priority,tea.created_at)
        FROM task_executor_assignments tea WHERE tea.task_id=v_created.id AND tea.enabled
      ),'[]'::jsonb),
      'continued_session_count',v_session_count
    )
  );
  v_audit:=write_audit_event(
    p_project_id,v_created.id,NULL,'operator',p_actor_id,'task.followup_created',
    'task',v_created.id::text,'allowed',NULL,
    jsonb_build_object('source_task_id',p_source_task_id,'source_status',v_source.status,
      'source_version',v_source.version,'executor_count',v_executor_count,
      'continued_session_count',v_session_count,'command_id',v_command.id),p_correlation_id
  );
  v_result:=jsonb_build_object(
    'status','planning','project_id',p_project_id,'task_id',v_created.id,
    'task_version',v_created.version,'followup_of_task_id',p_source_task_id,
    'event_id',v_event.id,'audit_event_id',v_audit,
    'executor_count',v_executor_count,'continued_session_count',v_session_count
  );
  UPDATE commands SET status='completed',result=v_result,completed_at=clock_timestamp()
    WHERE id=v_command.id;
  RETURN v_result;
END;
$$;

ALTER FUNCTION create_followup_task(uuid,uuid,uuid,text,text,text,text,bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
