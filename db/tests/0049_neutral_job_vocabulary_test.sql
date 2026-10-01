-- Neutral job names (migrations 0073 and 0077, Stage 11.2 N1 and N6).
--
-- 0073 was the expand: both vocabularies, every reader accepting both. 0077 is
-- the contract: the old names are gone from the CHECK, the trigger and every
-- function, and the rows that had them were renamed. What is left to prove on
-- a migrated schema:
--
--   * the path of 0011 — chat turn, delegation, implementation, review turn, a
--     revision — runs end to end under the new names, each job checked the
--     moment the one writer routes it to carry a new name;
--   * no effective function, trigger or constraint names an old type — a
--     function 0077 missed would be exactly that;
--   * an old name cannot be written.
--
-- What 0077 does to a host that still has old-named rows is shown on a
-- database stopped at 0076, by
-- services/control-plane/test/job-vocabulary-contract.test.mjs.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane,public,extensions;

CREATE FUNCTION pg_temp.queued_before_update(p_route jsonb) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF p_route->>'job_type' NOT IN ('orchestrator_turn','resume_orchestrator','implementation_run') THEN
    RAISE EXCEPTION 'a job was routed under an old name: %', p_route;
  END IF;
END $f$;

-- No effective function, trigger or constraint names an old type.
DO $$
DECLARE v_left text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_left
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='control_plane' AND p.prokind='f'
    AND pg_get_functiondef(p.oid) ~ '''(codex_chat_turn|resume_codex|start_implementation)''';
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'functions still name an old job type: %', v_left; END IF;
  SELECT string_agg(tgname, ', ') INTO v_left FROM pg_trigger
    WHERE tgrelid='control_plane.runtime_jobs'::regclass AND NOT tgisinternal
      AND pg_get_triggerdef(oid) ~ '(codex_chat_turn|resume_codex|start_implementation)''';
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'triggers still name an old job type: %', v_left; END IF;
  SELECT string_agg(conname, ', ') INTO v_left FROM pg_constraint
    WHERE connamespace='control_plane'::regnamespace
      AND pg_get_constraintdef(oid) ~ '(codex_chat_turn|resume_codex|start_implementation)''';
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'constraints still name an old job type: %', v_left; END IF;
END $$;

DO $$
DECLARE
  v_user uuid; v_project uuid; v_codex_profile uuid; v_worker_profile uuid;
  v_codex uuid; v_worker uuid; v_orchestrator_assignment uuid; v_executor_assignment uuid;
  v_task uuid;
  v_event domain_events; v_message outbox_messages; v_route jsonb;
  v_chat_job runtime_jobs; v_executor_job runtime_jobs; v_resume_job runtime_jobs;
  v_context jsonb; v_delegate jsonb; v_duplicate jsonb; v_start jsonb; v_complete jsonb;
  v_revision jsonb; v_result jsonb; v_count bigint;
BEGIN
  INSERT INTO users(display_name) VALUES('Old Names Test') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Old Names Test','old-names-test','/srv/old-names-test')
    RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-test-model') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','openrouter','opencode-test-model') RETURNING id INTO v_worker_profile;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('old-names-codex','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('old-names-worker','implementer',v_worker_profile) RETURNING id INTO v_worker;
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
  PERFORM pg_temp.queued_before_update(v_route);
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
  PERFORM pg_temp.queued_before_update(v_route);
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
  PERFORM pg_temp.queued_before_update(v_route);
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

  IF v_chat_job.job_type<>'orchestrator_turn' OR v_executor_job.job_type<>'implementation_run' THEN
    RAISE EXCEPTION 'the jobs were not claimed under the new names: %, %', v_chat_job.job_type, v_executor_job.job_type;
  END IF;
  SELECT count(*) INTO v_count FROM task_runs r JOIN runtime_jobs j ON j.run_id=r.id
    WHERE j.id IN (v_chat_job.id,v_resume_job.id);
  IF v_count<>2 THEN RAISE EXCEPTION 'orchestrator turns did not become runs'; END IF;

  BEGIN
    UPDATE runtime_jobs SET job_type='codex_chat_turn' WHERE id=v_chat_job.id;
    RAISE EXCEPTION 'an old job type was written';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE 'the path ran under the new job names, and an old one cannot be written';
END;
$$;

ROLLBACK;
