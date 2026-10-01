\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_user uuid; v_project uuid; v_codex_profile uuid; v_executor_profile uuid;
  v_codex uuid; v_executor uuid; v_orchestrator_assignment uuid; v_executor_assignment uuid;
  v_source uuid; v_followup uuid:=gen_random_uuid(); v_other uuid:=gen_random_uuid();
  v_codex_session uuid; v_executor_session uuid; v_result jsonb; v_duplicate jsonb;
  v_event domain_events; v_message outbox_messages; v_route jsonb; v_job runtime_jobs;
  v_context jsonb; v_delegate jsonb; v_count bigint;
BEGIN
  INSERT INTO users(display_name) VALUES('Follow-up Task Test') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Follow-up Task Test','followup-task-test','/srv/followup-task-test')
    RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-followup-test') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','opencode-followup-test') RETURNING id INTO v_executor_profile;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('followup-codex','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('followup-executor','implementer',v_executor_profile) RETURNING id INTO v_executor;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING id INTO v_orchestrator_assignment;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_executor,v_executor_profile,'executor') RETURNING id INTO v_executor_assignment;
  INSERT INTO tasks(project_id,title,objective,constraints,acceptance_criteria,status,
    active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Approved source','Original work','["stay scoped"]','["quality accepted"]',
      'approved',v_codex,v_orchestrator_assignment,'test') RETURNING id INTO v_source;
  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority)
    VALUES(v_source,v_executor_assignment,100);
  -- 0063: a session belongs to the conversation, in a role (ADR-0014).
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,native_session_id,purpose,metadata,conversation_id,role)
    VALUES(v_project,v_codex,v_codex_profile,'codex-native-followup','task_chat:'||v_source::text,
      jsonb_build_object('task_id',v_source),(SELECT conversation_id FROM tasks WHERE id=v_source),'chat')
    RETURNING id INTO v_codex_session;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,native_session_id,purpose,metadata,conversation_id,role)
    VALUES(v_project,v_executor,v_executor_profile,'executor-native-followup','task_executor:'||v_source::text,
      jsonb_build_object('task_id',v_source),(SELECT conversation_id FROM tasks WHERE id=v_source),'executor')
    RETURNING id INTO v_executor_session;

  v_result:=create_followup_task(v_project,v_source,v_followup,'operator','Improve approved result',
    'Apply the prepared wording corrections','followup-test',1,'followup-correlation');
  v_duplicate:=create_followup_task(v_project,v_source,v_other,'operator','Improve approved result',
    'Apply the prepared wording corrections','followup-test',1,'followup-correlation-retry');
  IF v_result<>v_duplicate OR v_result->>'task_id'<>v_followup::text THEN
    RAISE EXCEPTION 'follow-up command is not idempotent: %, %',v_result,v_duplicate;
  END IF;
  IF (SELECT status FROM tasks WHERE id=v_source)<>'approved'
     OR (SELECT version FROM tasks WHERE id=v_source)<>1 THEN
    RAISE EXCEPTION 'source task terminal state was mutated';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM tasks WHERE id=v_followup AND status='planning'
      AND followup_of_task_id=v_source AND constraints='["stay scoped"]'::jsonb
      AND acceptance_criteria='["quality accepted"]'::jsonb) THEN
    RAISE EXCEPTION 'follow-up task did not inherit the source contract';
  END IF;
  SELECT count(*) INTO v_count FROM task_executor_assignments
    WHERE task_id=v_followup AND project_agent_assignment_id=v_executor_assignment AND enabled;
  IF v_count<>1 THEN RAISE EXCEPTION 'executor assignment was not copied'; END IF;
  -- 0063: continuity without copies. The follow-up joins the source's
  -- conversation, and the conversation's two sessions are the only rows that
  -- carry these native ids — the follow-up resumes them, it does not duplicate
  -- them (ADR-0014).
  IF (SELECT conversation_id FROM tasks WHERE id=v_followup)<>(SELECT conversation_id FROM tasks WHERE id=v_source) THEN
    RAISE EXCEPTION 'the follow-up did not join its source''s conversation';
  END IF;
  SELECT count(*) INTO v_count FROM agent_sessions
    WHERE project_id=v_project AND native_session_id IN('codex-native-followup','executor-native-followup');
  IF v_count<>2 THEN RAISE EXCEPTION 'native sessions were copied: % rows carry the two native ids',v_count; END IF;
  SELECT count(*) INTO v_count FROM audit_events
    WHERE project_id=v_project AND task_id=v_followup AND action='task.followup_created';
  IF v_count<>1 THEN RAISE EXCEPTION 'follow-up audit event is missing'; END IF;

  SELECT * INTO v_event FROM domain_events
    WHERE id=(v_result->>'event_id')::uuid AND event_type='chat.user_message';
  v_message:=claim_outbox_event(v_event.id,'followup-dispatcher',interval '1 minute');
  v_route:=route_outbox_message(v_message.id,'followup-dispatcher');
  SELECT * INTO v_job FROM claim_orchestrator_jobs('followup-codex-worker',1,interval '2 minutes');
  v_context:=orchestrator_job_context(v_job.id,'followup-codex-worker');
  IF v_context->>'native_session_id'<>'codex-native-followup'
     OR v_context->>'task_status'<>'planning'
     OR v_context->>'followup_of_task_id'<>v_source::text THEN
    RAISE EXCEPTION 'Codex follow-up session context is invalid: %',v_context;
  END IF;
  v_delegate:=invoke_delegate_task(v_job.id,'followup-codex-worker','followup-delegate',
    'Apply the prepared wording corrections','["preserve the accepted direction"]','["docs/spec-review.md"]');
  v_result:=complete_orchestrator_job(v_job.id,'followup-codex-worker','codex-native-followup',
    'followup-turn','Follow-up delegated.');

  v_message:=claim_outbox_event((v_delegate->>'event_id')::uuid,'followup-dispatcher',interval '1 minute');
  v_route:=route_outbox_message(v_message.id,'followup-dispatcher');
  SELECT * INTO v_job FROM claim_executor_jobs('followup-executor-worker',1,interval '2 minutes');
  v_context:=executor_job_context(v_job.id,'followup-executor-worker');
  IF v_context->>'native_session_id'<>'executor-native-followup' THEN
    RAISE EXCEPTION 'executor follow-up session context is invalid: %',v_context;
  END IF;

  BEGIN
    PERFORM create_followup_task(v_project,v_followup,gen_random_uuid(),'operator','Invalid follow-up',
      'This source is still active','followup-invalid',
      (SELECT version FROM tasks WHERE id=v_followup),'invalid-followup');
    RAISE EXCEPTION 'active task unexpectedly allowed a follow-up';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;

  RAISE NOTICE 'follow-up task assertions passed';
END;
$$;

ROLLBACK;
