\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public;

DO $$
DECLARE
  v_user uuid; v_project uuid; v_runtime uuid; v_agent uuid; v_assignment uuid; v_task uuid;
  v_event domain_events; v_message outbox_messages; v_route jsonb; v_job runtime_jobs;
  v_context jsonb; v_session uuid; v_result jsonb; v_count bigint;
BEGIN
  INSERT INTO users(display_name) VALUES ('Codex Chat Test') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Codex Chat Test','codex-chat-test','/srv/codex-chat-test') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','test-model') RETURNING id INTO v_runtime;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('codex-chat-test-agent','architect',v_runtime) RETURNING id INTO v_agent;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_agent,v_runtime,'orchestrator',true) RETURNING id INTO v_assignment;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Chat delivery','Test durable delivery','planning',v_agent,v_assignment,'test') RETURNING id INTO v_task;
  v_event:=append_event('chat.user_message',v_project,v_task,NULL,'user','test',NULL,v_task::text,
    'chat-test:' || v_task,'task',v_task,1,jsonb_build_object('content','Plan the next step'));
  v_message:=claim_outbox_event(v_event.id,'chat-dispatcher-test',interval '1 minute');
  v_route:=route_outbox_message(v_message.id,'chat-dispatcher-test');
  IF v_route->>'job_type'<>'orchestrator_turn' THEN
    RAISE EXCEPTION 'chat event was not routed: %',v_route;
  END IF;

  SELECT * INTO v_job FROM claim_orchestrator_jobs('chat-worker-test',1,interval '1 minute');
  v_context:=orchestrator_job_context(v_job.id,'chat-worker-test');
  IF v_context->>'content'<>'Plan the next step' OR v_context->>'model'<>'test-model' THEN
    RAISE EXCEPTION 'chat context is invalid: %',v_context;
  END IF;
  v_session:=bind_orchestrator_session(v_job.id,'chat-worker-test','native-thread-1');
  IF bind_orchestrator_session(v_job.id,'chat-worker-test','native-thread-1')<>v_session THEN
    RAISE EXCEPTION 'session binding is not stable';
  END IF;
  v_result:=complete_orchestrator_job(v_job.id,'chat-worker-test','native-thread-1','turn-1','Here is the plan.');
  IF v_result->>'status'<>'completed' THEN RAISE EXCEPTION 'chat job did not complete: %',v_result; END IF;
  SELECT count(*) INTO v_count FROM runtime_jobs WHERE id=v_job.id AND status='completed';
  IF v_count<>1 THEN RAISE EXCEPTION 'runtime job was not acknowledged'; END IF;
  SELECT count(*) INTO v_count FROM domain_events
    WHERE task_id=v_task AND event_type='chat.agent_message' AND payload->>'content'='Here is the plan.';
  IF v_count<>1 THEN RAISE EXCEPTION 'agent chat event was not appended'; END IF;
  SELECT count(*) INTO v_count FROM agent_sessions
    -- 0063: the session belongs to the task's conversation, in the chat role
    -- (ADR-0014); purpose is description only.
    WHERE id=v_session AND native_session_id='native-thread-1' AND role='chat'
      AND conversation_id=(SELECT conversation_id FROM tasks WHERE id=v_task);
  IF v_count<>1 THEN RAISE EXCEPTION 'native task chat session was not preserved'; END IF;

  RAISE NOTICE 'Codex chat delivery integration assertions passed';
END;
$$;

ROLLBACK;
