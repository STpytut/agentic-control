\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_user uuid; v_project uuid; v_codex_profile uuid; v_other_codex_profile uuid;
  v_worker_profile uuid; v_orchestrator uuid; v_worker uuid;
  v_orchestrator_assignment uuid; v_worker_assignment uuid; v_task uuid;
  v_event domain_events; v_message outbox_messages; v_route jsonb; v_job runtime_jobs;
  v_context jsonb; v_result jsonb; v_count bigint;
BEGIN
  INSERT INTO users(display_name) VALUES('Roster Test') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Roster Test','roster-test','/srv/roster-test') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','orchestrator-model-a') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','orchestrator-model-b') RETURNING id INTO v_other_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','test-provider','executor-model') RETURNING id INTO v_worker_profile;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('roster-test-orchestrator','architect',v_codex_profile) RETURNING id INTO v_orchestrator;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('roster-test-worker','implementer',v_worker_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_orchestrator,v_other_codex_profile,'orchestrator',true)
    RETURNING id INTO v_orchestrator_assignment;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_worker_profile,'executor') RETURNING id INTO v_worker_assignment;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Configurable agents','Keep orchestrator stable','planning',v_worker,
      v_orchestrator_assignment,'test') RETURNING id INTO v_task;
  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id)
    VALUES(v_task,v_worker_assignment);

  v_event:=append_event('chat.user_message',v_project,v_task,NULL,'user','test',NULL,v_task::text,
    'roster-chat:' || v_task,'task',v_task,1,jsonb_build_object('content','Use the configured model'));
  v_message:=claim_outbox_event(v_event.id,'roster-dispatcher',interval '1 minute');
  v_route:=route_outbox_message(v_message.id,'roster-dispatcher');
  IF v_route->>'job_type'<>'orchestrator_turn' THEN RAISE EXCEPTION 'configured orchestrator was not routed'; END IF;
  SELECT * INTO v_job FROM claim_orchestrator_jobs('roster-worker',1,interval '1 minute');
  v_context:=orchestrator_job_context(v_job.id,'roster-worker');
  IF v_context->>'model'<>'orchestrator-model-b' OR (v_context->>'agent_id')::uuid<>v_orchestrator THEN
    RAISE EXCEPTION 'chat used active executor instead of stable orchestrator: %',v_context;
  END IF;
  v_result:=complete_orchestrator_job(v_job.id,'roster-worker','roster-native-thread','roster-turn','Configured.');
  IF v_result->>'status'<>'completed' THEN RAISE EXCEPTION 'configured chat did not complete'; END IF;
  SELECT count(*) INTO v_count FROM agent_sessions
    WHERE project_id=v_project AND agent_id=v_orchestrator
      AND runtime_profile_id=v_other_codex_profile AND native_session_id='roster-native-thread';
  IF v_count<>1 THEN RAISE EXCEPTION 'selected orchestrator model was not persisted'; END IF;
  SELECT count(*) INTO v_count FROM task_executor_assignments
    WHERE task_id=v_task AND project_agent_assignment_id=v_worker_assignment;
  IF v_count<>1 THEN RAISE EXCEPTION 'task executor roster was not persisted'; END IF;

  RAISE NOTICE 'configurable agent roster assertions passed';
END;
$$;

ROLLBACK;
