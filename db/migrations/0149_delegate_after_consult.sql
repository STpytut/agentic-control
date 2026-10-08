-- An orchestrator may delegate in the turn that brings its analyst's answer (rc.139).
--
-- rc.136 taught the orchestrator to wait for an answer its plan depends on:
-- ask, end the turn, plan when the answer arrives. The answer arrives as a
-- resume_orchestrator turn, and invoke_delegate_task took only a conversation
-- turn, so the first orchestrator that waited planned, delegated, and was
-- refused ("not bound to an active Codex chat turn"). A turn brought by
-- consultation.answered or consultation.failed now delegates as a
-- conversation turn does; a review's resume still does not.

SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION invoke_delegate_task(p_job_id bigint, p_worker_id text, p_call_id text, p_objective text, p_instructions jsonb, p_relevant_paths jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE;
  v_orchestrator project_agent_assignments%ROWTYPE;
  v_executor project_agent_assignments%ROWTYPE; v_project projects%ROWTYPE;
  v_existing commands%ROWTYPE; v_ready_event domain_events%ROWTYPE;
  v_key text; v_result jsonb;
BEGIN
  IF p_call_id IS NULL OR length(trim(p_call_id))<4 OR length(trim(p_objective))<4
     OR jsonb_typeof(p_instructions)<>'array' OR jsonb_typeof(p_relevant_paths)<>'array' THEN
    RAISE EXCEPTION 'invalid delegate_task arguments' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','delegation_arguments_invalid')::text;
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  -- 0149: a turn that brings an analyst's answer may delegate too: the
  -- orchestrator waited for the answer to plan, and plans in that turn.
  IF NOT FOUND OR NOT (v_job.job_type = 'orchestrator_turn'
       OR (v_job.job_type = 'resume_orchestrator'
           AND v_job.payload->>'event_type' IN ('consultation.answered','consultation.failed')))
     OR v_job.status<>'in_flight'
     OR v_job.leased_by<>p_worker_id OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'delegate_task is not bound to an active Codex chat turn' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','orchestration_job_not_leased')::text;
  END IF;
  v_key:='codex-tool:' || p_job_id || ':' || p_call_id;
  SELECT * INTO v_existing FROM commands c
    WHERE c.project_id=v_job.project_id AND c.idempotency_key=v_key;
  IF FOUND AND v_existing.status='completed' THEN RETURN v_existing.result; END IF;

  SELECT * INTO v_task FROM tasks t
    WHERE t.id=v_job.task_id AND t.project_id=v_job.project_id FOR UPDATE;
  IF NOT FOUND OR v_task.status NOT IN ('planning','ready') THEN
    RAISE EXCEPTION 'task is not available for initial delegation' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','task_not_delegable')::text;
  END IF;
  SELECT * INTO v_orchestrator FROM project_agent_assignments pa
    WHERE pa.id=v_task.orchestrator_assignment_id AND pa.enabled
      AND role_holds(pa.role_definition_id,'conversation.hold');
  SELECT pa.* INTO v_executor
  FROM task_executor_assignments tea
  JOIN project_agent_assignments pa ON pa.id=tea.project_agent_assignment_id
  JOIN agents a ON a.id=pa.agent_id AND a.enabled AND agent_holds(a.id,'implementation.execute')
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    AND rp.enabled AND runtime_plays(rp.runtime_type,'executor')
  WHERE tea.task_id=v_task.id AND tea.enabled AND pa.enabled
    AND pa.project_id=v_task.project_id AND role_holds(pa.role_definition_id,'implementation.execute')
  ORDER BY tea.priority,tea.created_at LIMIT 1;
  IF v_orchestrator.id IS NULL OR v_executor.id IS NULL THEN
    RAISE EXCEPTION 'task orchestration assignments are unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','orchestrator_unavailable')::text;
  END IF;

  IF v_task.status='planning' THEN
    UPDATE tasks SET status='ready',version=version+1,updated_at=clock_timestamp()
      WHERE id=v_task.id RETURNING * INTO v_task;
    v_ready_event:=append_event(
      'task.ready',v_task.project_id,v_task.id,NULL,'agent',v_orchestrator.agent_id::text,
      NULL,COALESCE(v_job.payload->>'correlation_id',v_task.id::text),
      'task-ready:' || v_key,'task',v_task.id,v_task.version,
      jsonb_build_object('source_job_id',v_job.id,'executor_assignment_id',v_executor.id)
    );
  END IF;

  SELECT * INTO v_project FROM projects p WHERE p.id=v_task.project_id;
  v_result:=request_implementation(
    v_task.project_id,v_task.id,v_orchestrator.agent_id,v_executor.agent_id,1,
    p_objective,p_instructions,v_task.constraints,v_task.acceptance_criteria,
    p_relevant_paths,v_project.workspace_path,v_key,v_task.version,
    COALESCE(v_job.payload->>'correlation_id',v_task.id::text)
  );
  UPDATE handoffs SET executor_assignment_id=v_executor.id
    WHERE id=(v_result->>'handoff_id')::uuid AND executor_assignment_id IS NULL;
  RETURN v_result;
END; $function$;
