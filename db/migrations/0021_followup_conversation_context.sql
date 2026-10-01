BEGIN;
SET search_path TO control_plane,public,extensions;

CREATE OR REPLACE FUNCTION codex_chat_job_context(p_job_id bigint,p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_context jsonb;
BEGIN
  SELECT jsonb_build_object(
    'job_id',j.id,'job_type',j.job_type,'source_event_id',j.source_event_id,
    'project_id',j.project_id,'task_id',j.task_id,'task_status',t.status,
    'task_version',t.version,'task_title',t.title,'task_objective',t.objective,
    'task_constraints',t.constraints,'task_acceptance_criteria',t.acceptance_criteria,
    'followup_of_task_id',t.followup_of_task_id,
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

ALTER FUNCTION codex_chat_job_context(bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
