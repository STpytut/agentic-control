\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_user uuid; v_project uuid; v_codex_profile uuid; v_worker_profile uuid;
  v_codex uuid; v_worker uuid; v_orchestrator_assignment uuid; v_executor_assignment uuid;
  v_task uuid; v_review_task uuid; v_failed_review_task uuid;
  v_event domain_events; v_message outbox_messages; v_route jsonb;
  v_chat_job runtime_jobs; v_executor_job runtime_jobs; v_resume_job runtime_jobs;
  v_context jsonb; v_delegate jsonb; v_duplicate jsonb; v_start jsonb; v_complete jsonb;
  v_revision jsonb; v_result jsonb; v_count bigint;
BEGIN
  INSERT INTO users(display_name) VALUES('Production Bridge Test') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Production Bridge Test','production-bridge-test','/srv/production-bridge-test')
    RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-test-model') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','openrouter','opencode-test-model') RETURNING id INTO v_worker_profile;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('production-bridge-codex','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('production-bridge-worker','implementer',v_worker_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true)
    RETURNING id INTO v_orchestrator_assignment;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_worker_profile,'executor') RETURNING id INTO v_executor_assignment;
  INSERT INTO tasks(project_id,title,objective,constraints,acceptance_criteria,status,
    active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Bridge task','Implement bridge fixture','["stay scoped"]',
      '["fixture passes"]','planning',v_codex,v_orchestrator_assignment,'test') RETURNING id INTO v_task;
  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority)
    VALUES(v_task,v_executor_assignment,10);

  v_event:=append_event('chat.user_message',v_project,v_task,NULL,'user','test',NULL,v_task::text,
    'bridge-chat:' || v_task,'task',v_task,1,jsonb_build_object('content','Please implement this task'));
  v_message:=claim_outbox_event(v_event.id,'bridge-dispatcher',interval '1 minute');
  v_route:=route_outbox_message(v_message.id,'bridge-dispatcher');
  SELECT * INTO v_chat_job FROM claim_orchestrator_jobs('bridge-codex-worker',1,interval '2 minutes');
  v_context:=orchestrator_job_context(v_chat_job.id,'bridge-codex-worker');
  IF v_context#>>'{executor,model}'<>'opencode-test-model' OR v_context->>'task_status'<>'planning' THEN
    RAISE EXCEPTION 'Codex tool context did not bind the selected executor: %',v_context;
  END IF;
  v_delegate:=invoke_delegate_task(v_chat_job.id,'bridge-codex-worker','call-delegate-1',
    'Implement bridge fixture','["make the fixture pass"]','["db/tests"]');
  v_duplicate:=invoke_delegate_task(v_chat_job.id,'bridge-codex-worker','call-delegate-1',
    'Implement bridge fixture','["make the fixture pass"]','["db/tests"]');
  IF v_delegate<>v_duplicate OR v_delegate->>'status'<>'accepted' THEN
    RAISE EXCEPTION 'delegate_task receipt is not idempotent: %, %',v_delegate,v_duplicate;
  END IF;
  SELECT count(*) INTO v_count FROM domain_events
    WHERE task_id=v_task AND event_type='task.ready';
  IF v_count<>1 THEN RAISE EXCEPTION 'web planning task was not promoted exactly once'; END IF;
  v_result:=complete_orchestrator_job(v_chat_job.id,'bridge-codex-worker',
    'bridge-codex-thread','bridge-delegate-turn','Delegation accepted.');

  v_message:=claim_outbox_event((v_delegate->>'event_id')::uuid,'bridge-dispatcher',interval '1 minute');
  v_route:=route_outbox_message(v_message.id,'bridge-dispatcher');
  SELECT * INTO v_executor_job FROM claim_executor_jobs('bridge-supervisor',1,interval '2 minutes');
  v_context:=executor_job_context(v_executor_job.id,'bridge-supervisor');
  IF v_context->>'model'<>'opencode-test-model' OR v_context->>'native_session_id' IS NOT NULL THEN
    RAISE EXCEPTION 'executor context is invalid: %',v_context;
  END IF;
  v_start:=start_implementation_job(v_executor_job.id,(v_context->>'session_id')::uuid,
    'bridge-supervisor',interval '2 minutes');
  v_complete:=complete_implementation(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,v_codex,
    (v_start->>'fencing_token')::bigint,'{"summary":"implemented"}','{"tests":"passed"}',
    'bridge-complete',(SELECT version FROM tasks WHERE id=v_task),v_task::text);
  PERFORM acknowledge_runtime_job(v_executor_job.id,'bridge-supervisor',v_complete);

  v_message:=claim_outbox_event((v_complete->>'event_id')::uuid,'bridge-dispatcher',interval '1 minute');
  v_route:=route_outbox_message(v_message.id,'bridge-dispatcher');
  IF v_route->>'job_type'<>'resume_orchestrator' THEN RAISE EXCEPTION 'completion did not route to Codex'; END IF;
  SELECT * INTO v_resume_job FROM claim_orchestrator_jobs('bridge-codex-worker',1,interval '2 minutes');
  IF v_resume_job.job_type<>'resume_orchestrator' THEN RAISE EXCEPTION 'Codex worker did not claim review job'; END IF;
  IF (SELECT status FROM tasks WHERE id=v_task)<>'reviewing' THEN
    RAISE EXCEPTION 'claimed Codex review did not enter reviewing state';
  END IF;
  v_context:=orchestrator_job_context(v_resume_job.id,'bridge-codex-worker');
  IF v_context->>'content' NOT LIKE 'A durable implementation.completed event%' THEN
    RAISE EXCEPTION 'review prompt is invalid: %',v_context->>'content';
  END IF;
  v_revision:=invoke_request_revision(v_resume_job.id,'bridge-codex-worker',
    'call-revision-1','["add the missing regression check"]');
  IF v_revision->>'status'<>'revision_requested' OR (v_revision->>'revision_number')::integer<>2 THEN
    RAISE EXCEPTION 'revision receipt is invalid: %',v_revision;
  END IF;
  v_result:=complete_orchestrator_job(v_resume_job.id,'bridge-codex-worker',
    'bridge-codex-thread','bridge-review-turn','Revision requested.');

  SELECT count(*) INTO v_count FROM runtime_jobs
    WHERE id IN (v_chat_job.id,v_executor_job.id,v_resume_job.id) AND status='completed';
  IF v_count<>3 THEN RAISE EXCEPTION 'bridge jobs were not durably completed'; END IF;
  SELECT count(*) INTO v_count FROM handoffs WHERE task_id=v_task AND revision_number IN (1,2);
  IF v_count<>2 THEN RAISE EXCEPTION 'initial and revision handoffs were not persisted'; END IF;
  SELECT count(*) INTO v_count FROM agent_sessions
    -- 0063: one chat and one executor session of the task's conversation.
    WHERE project_id=v_project AND active AND role IN ('chat','executor')
      AND conversation_id=(SELECT conversation_id FROM tasks WHERE id=v_task);
  IF v_count<>2 THEN RAISE EXCEPTION 'runtime session continuity rows are missing'; END IF;

  INSERT INTO tasks(project_id,title,objective,constraints,acceptance_criteria,status,
    active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Approval review task','Review without automatic revision','[]','["reviewed"]',
      'awaiting_review',v_codex,v_orchestrator_assignment,'test') RETURNING id INTO v_review_task;
  v_event:=append_event('implementation.completed',v_project,v_review_task,NULL,'agent',v_worker::text,
    NULL,v_review_task::text,'review-complete:'||v_review_task,'task',v_review_task,1,
    jsonb_build_object('result_summary',jsonb_build_object('summary','ready')));
  v_message:=claim_outbox_event(v_event.id,'bridge-dispatcher',interval '1 minute');
  v_route:=route_outbox_message(v_message.id,'bridge-dispatcher');
  SELECT * INTO v_resume_job FROM claim_orchestrator_jobs('bridge-review-worker',1,interval '2 minutes');
  IF (SELECT status FROM tasks WHERE id=v_review_task)<>'reviewing' THEN
    RAISE EXCEPTION 'operator review was exposed while Codex review was active';
  END IF;
  BEGIN
    PERFORM approve_task_review(v_project,v_review_task,'operator','stale approval',
      'stale-approval:'||v_review_task,(SELECT version FROM tasks WHERE id=v_review_task),v_review_task::text);
    RAISE EXCEPTION 'approval unexpectedly won during active Codex review';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;
  v_result:=complete_orchestrator_job(v_resume_job.id,'bridge-review-worker',
    'bridge-review-thread','bridge-approval-turn','Implementation is ready for operator approval.');
  IF (SELECT status FROM tasks WHERE id=v_review_task)<>'awaiting_review' THEN
    RAISE EXCEPTION 'Codex review without revision did not restore operator decision state';
  END IF;

  INSERT INTO tasks(project_id,title,objective,constraints,acceptance_criteria,status,
    active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Failed review task','Recover a failed automatic review','[]','["reviewed"]',
      'awaiting_review',v_codex,v_orchestrator_assignment,'test') RETURNING id INTO v_failed_review_task;
  v_event:=append_event('implementation.completed',v_project,v_failed_review_task,NULL,'agent',v_worker::text,
    NULL,v_failed_review_task::text,'review-retry-complete:'||v_failed_review_task,'task',v_failed_review_task,1,
    jsonb_build_object('result_summary',jsonb_build_object('summary','ready again')));
  v_message:=claim_outbox_event(v_event.id,'bridge-dispatcher',interval '1 minute');
  v_route:=route_outbox_message(v_message.id,'bridge-dispatcher');
  SELECT * INTO v_resume_job FROM claim_orchestrator_jobs('bridge-failing-review-worker',1,interval '2 minutes');
  PERFORM retry_runtime_job(v_resume_job.id,'bridge-failing-review-worker','simulated review failure',
    interval '1 second',1);
  IF (SELECT status FROM tasks WHERE id=v_failed_review_task)<>'reviewing'
     OR (SELECT status FROM runtime_jobs WHERE id=v_resume_job.id)<>'dead_letter' THEN
    RAISE EXCEPTION 'failed Codex review did not preserve the guarded reviewing incident state';
  END IF;
  v_result:=resolve_runtime_job_incident(v_resume_job.id,'operator','Reviewed the failed Codex run',
    'resolve-review:'||v_failed_review_task);
  IF (SELECT status FROM tasks WHERE id=v_failed_review_task)<>'awaiting_review' THEN
    RAISE EXCEPTION 'resolved Codex review incident did not restore operator decision state';
  END IF;

  RAISE NOTICE 'production orchestration bridge assertions passed';
END;
$$;

ROLLBACK;
