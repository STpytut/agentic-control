-- The host-shaped path, for the role equivalence test (sprint B, R2–R4).
--
-- Written only against functions and columns every schema since 0078 has, so
-- the same text runs on a database before the role migrations and after them.
-- It asserts nothing: the test compares what it leaves behind.
--
-- Its parameters are session settings, since psql does not substitute inside
-- a dollar-quoted block: eq.tag names the run; eq.orchestrator_runtime is
-- codex or opencode; eq.executors is how many OpenCode executors the project
-- has (1 or 2, the second at a lower priority); eq.revise is whether the
-- review asks for a revision, which runs a second implementation; eq.followup
-- is whether the finished task is continued by a follow-up whose first
-- message is routed and delegated.
SET search_path TO control_plane,public,extensions;

DO $scenario$
DECLARE
  v_tag text := current_setting('eq.tag'); v_runtime text := current_setting('eq.orchestrator_runtime');
  v_executors integer := current_setting('eq.executors')::integer; v_revise boolean := current_setting('eq.revise')::boolean;
  v_followup boolean := current_setting('eq.followup')::boolean; v_next uuid := gen_random_uuid();
  v_user uuid; v_project uuid; v_orch_profile uuid; v_exec_profile uuid; v_orch_agent uuid;
  v_exec_agent uuid; v_orchestrator uuid; v_executor uuid; v_task uuid; i integer;
  v_event domain_events; v_message outbox_messages; v_job runtime_jobs;
  v_context jsonb; v_delegate jsonb; v_start jsonb; v_complete jsonb; v_revision jsonb;
BEGIN
  INSERT INTO users(display_name) VALUES('Equivalence '||v_tag) RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Equivalence '||v_tag,'equivalence-'||v_tag,'/srv/equivalence-'||v_tag) RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES(v_runtime,'test','test','test','orchestrator-'||v_tag) RETURNING id INTO v_orch_profile;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('orchestrator-'||v_tag,'architect',v_orch_profile) RETURNING id INTO v_orch_agent;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_orch_agent,v_orch_profile,'orchestrator',true) RETURNING id INTO v_orchestrator;
  INSERT INTO tasks(project_id,title,objective,constraints,acceptance_criteria,status,
    active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Equivalence '||v_tag,'Implement the fixture','["stay scoped"]','["fixture passes"]',
      'planning',v_orch_agent,v_orchestrator,'test') RETURNING id INTO v_task;
  FOR i IN 1..v_executors LOOP
    INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
      VALUES('opencode','test','test','test','executor-'||v_tag||'-'||i) RETURNING id INTO v_exec_profile;
    INSERT INTO agents(name,role,runtime_profile_id)
      VALUES('executor-'||v_tag||'-'||i,'implementer',v_exec_profile) RETURNING id INTO v_exec_agent;
    INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
      VALUES(v_project,v_exec_agent,v_exec_profile,'executor') RETURNING id INTO v_executor;
    INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority)
      VALUES(v_task,v_executor,10*i);
  END LOOP;

  -- The user's message, routed and answered with a delegation.
  v_event:=append_event('chat.user_message',v_project,v_task,NULL,'user','test',NULL,v_task::text,
    'eq-chat:'||v_task,'task',v_task,1,jsonb_build_object('content','Please implement this task'));
  v_message:=claim_outbox_event(v_event.id,'eq-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'eq-dispatcher');
  SELECT * INTO v_job FROM claim_orchestrator_jobs('eq-orchestrator',1,interval '2 minutes');
  v_context:=orchestrator_job_context(v_job.id,'eq-orchestrator');
  v_delegate:=invoke_delegate_task(v_job.id,'eq-orchestrator','eq-delegate-'||v_tag,
    'Implement the fixture','["make it pass"]','["db/tests"]');
  PERFORM complete_orchestrator_job(v_job.id,'eq-orchestrator','eq-thread-'||v_tag,'eq-turn-1','Delegated.');

  -- The implementation, by whichever executor the platform selects.
  v_message:=claim_outbox_event((v_delegate->>'event_id')::uuid,'eq-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'eq-dispatcher');
  SELECT * INTO v_job FROM claim_executor_jobs('eq-supervisor',1,interval '2 minutes');
  v_context:=executor_job_context(v_job.id,'eq-supervisor');
  v_start:=start_implementation_job(v_job.id,(v_context->>'session_id')::uuid,'eq-supervisor',interval '2 minutes');
  v_complete:=complete_implementation(v_project,v_task,(v_start->>'run_id')::uuid,
    (v_context->>'agent_id')::uuid,v_orch_agent,
    (v_start->>'fencing_token')::bigint,'{"summary":"implemented"}','{"tests":"passed"}',
    'eq-complete-1-'||v_tag,(SELECT version FROM tasks WHERE id=v_task),v_task::text);
  PERFORM acknowledge_runtime_job(v_job.id,'eq-supervisor',v_complete);

  -- The review turn.
  v_message:=claim_outbox_event((v_complete->>'event_id')::uuid,'eq-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'eq-dispatcher');
  SELECT * INTO v_job FROM claim_orchestrator_jobs('eq-orchestrator',1,interval '2 minutes');
  v_context:=orchestrator_job_context(v_job.id,'eq-orchestrator');
  IF NOT v_revise THEN
    PERFORM complete_orchestrator_job(v_job.id,'eq-orchestrator','eq-thread-'||v_tag,'eq-turn-2','Looks right.');
    IF NOT v_followup THEN RETURN; END IF;
    -- The operator's approval needs evidence the scenario does not record;
    -- a finished task is what a follow-up continues.
    UPDATE tasks SET status='completed' WHERE id=v_task;
    PERFORM create_followup_task(v_project,v_task,v_next,'test','Follow-up '||v_tag,'Continue the fixture',
      'eq-followup-'||v_tag,(SELECT version FROM tasks WHERE id=v_task),v_task::text);
    -- As the panel sends a message: the task's version moves, and the event carries it.
    UPDATE tasks SET version=version+1, updated_at=clock_timestamp() WHERE id=v_next;
    v_event:=append_event('chat.user_message',v_project,v_next,NULL,'user','test',NULL,v_next::text,
      'eq-chat-followup:'||v_next,'task',v_next,(SELECT version FROM tasks WHERE id=v_next),
      jsonb_build_object('content','Continue it'));
    v_message:=claim_outbox_event(v_event.id,'eq-dispatcher',interval '1 minute');
    PERFORM route_outbox_message(v_message.id,'eq-dispatcher');
    SELECT * INTO v_job FROM claim_orchestrator_jobs('eq-orchestrator',1,interval '2 minutes');
    v_context:=orchestrator_job_context(v_job.id,'eq-orchestrator');
    v_delegate:=invoke_delegate_task(v_job.id,'eq-orchestrator','eq-delegate-followup-'||v_tag,
      'Continue the fixture','["keep it passing"]','["db/tests"]');
    PERFORM complete_orchestrator_job(v_job.id,'eq-orchestrator','eq-thread-'||v_tag,'eq-turn-3','Delegated again.');
    v_message:=claim_outbox_event((v_delegate->>'event_id')::uuid,'eq-dispatcher',interval '1 minute');
    PERFORM route_outbox_message(v_message.id,'eq-dispatcher');
    SELECT * INTO v_job FROM claim_executor_jobs('eq-supervisor',1,interval '2 minutes');
    v_context:=executor_job_context(v_job.id,'eq-supervisor');
    RETURN;
  END IF;
  v_revision:=invoke_request_revision(v_job.id,'eq-orchestrator','eq-revision-'||v_tag,'["add the regression check"]');
  PERFORM complete_orchestrator_job(v_job.id,'eq-orchestrator','eq-thread-'||v_tag,'eq-turn-2','Revision requested.');

  -- The revision's implementation and its review.
  v_message:=claim_outbox_event((v_revision#>>'{delegation,event_id}')::uuid,'eq-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'eq-dispatcher');
  SELECT * INTO v_job FROM claim_executor_jobs('eq-supervisor',1,interval '2 minutes');
  v_context:=executor_job_context(v_job.id,'eq-supervisor');
  v_start:=start_implementation_job(v_job.id,(v_context->>'session_id')::uuid,'eq-supervisor',interval '2 minutes');
  v_complete:=complete_implementation(v_project,v_task,(v_start->>'run_id')::uuid,
    (v_context->>'agent_id')::uuid,v_orch_agent,
    (v_start->>'fencing_token')::bigint,'{"summary":"revised"}','{"tests":"passed"}',
    'eq-complete-2-'||v_tag,(SELECT version FROM tasks WHERE id=v_task),v_task::text);
  PERFORM acknowledge_runtime_job(v_job.id,'eq-supervisor',v_complete);
  v_message:=claim_outbox_event((v_complete->>'event_id')::uuid,'eq-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'eq-dispatcher');
  SELECT * INTO v_job FROM claim_orchestrator_jobs('eq-orchestrator',1,interval '2 minutes');
  PERFORM complete_orchestrator_job(v_job.id,'eq-orchestrator','eq-thread-'||v_tag,'eq-turn-3','Now right.');
END $scenario$;
