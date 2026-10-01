-- WP-3c: a refusal that will succeed later is deferred, not retried; an answer
-- typed into the chat reaches the run that asked (migration 0061).
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane,public,extensions;

CREATE TEMP SEQUENCE defer_event_version START 7000;

CREATE FUNCTION pg_temp.refusal(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_detail text;
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  RETURN COALESCE(NULLIF(v_detail,''),'sqlstate:'||SQLSTATE);
END $$;
CREATE FUNCTION pg_temp.expect_refusal(p_sql text, p_expected text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_got text;
BEGIN
  v_got:=pg_temp.refusal(p_sql);
  IF v_got IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION '%: expected refusal %, got %',p_what,p_expected,COALESCE(v_got,'success');
  END IF;
END $$;

-- Deferral gives the attempt back, closes the turn as cancelled, and can be done
-- any number of times without dead-lettering what a writer is merely delaying.
DO $$
DECLARE
  v_user uuid; v_project uuid; v_cp uuid; v_codex uuid; v_oa uuid; v_task uuid; v_event domain_events;
  v_job runtime_jobs; v_first uuid; v_run task_runs; v_result jsonb; i int;
BEGIN
  INSERT INTO users(display_name) VALUES('Defer') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path) VALUES(v_user,'Defer','defer','/srv/defer') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-defer') RETURNING id INTO v_cp;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('defer-codex','architect',v_cp) RETURNING id INTO v_codex;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_cp,'orchestrator',true) RETURNING id INTO v_oa;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Deferred','Wait for the writer','planning',v_codex,v_oa,'test') RETURNING id INTO v_task;
  v_event:=append_event('chat.user_message',v_project,v_task,NULL,'user','operator',NULL,'defer','defer-1',
    'task',v_task,nextval('defer_event_version'),'{}'::jsonb);
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status)
    VALUES(v_event.id,'orchestrator_turn',v_project,v_task,'pending');

  SELECT * INTO v_job FROM claim_orchestrator_jobs('defer-worker',1,interval '5 minutes');
  v_first:=v_job.run_id;
  v_result:=defer_runtime_job(v_job.id,'defer-worker','grant_writer_active',interval '1 second');
  SELECT * INTO v_job FROM runtime_jobs WHERE id=v_job.id;
  IF v_result->>'status'<>'deferred' OR v_job.status<>'pending' OR v_job.attempt_count<>0
     OR v_job.available_at<=clock_timestamp() OR v_job.leased_by IS NOT NULL
     OR v_job.last_error<>'deferred: grant_writer_active' THEN
    RAISE EXCEPTION 'a deferred job is not pending with its attempt given back: %',row_to_json(v_job);
  END IF;
  SELECT * INTO v_run FROM task_runs WHERE id=v_first;
  IF v_run.status<>'cancelled' OR v_run.failure_code<>'turn_deferred' OR v_run.finished_at IS NULL THEN
    RAISE EXCEPTION 'the deferred turn is % (%), not cancelled/turn_deferred',v_run.status,v_run.failure_code;
  END IF;

  -- The writer takes longer than any retry budget would allow.
  FOR i IN 1..8 LOOP
    UPDATE runtime_jobs SET available_at=clock_timestamp() WHERE id=v_job.id;
    SELECT * INTO v_job FROM claim_orchestrator_jobs('defer-worker',1,interval '5 minutes');
    IF v_job.id IS NULL THEN RAISE EXCEPTION 'the deferred job was not claimable again on round %',i; END IF;
    PERFORM defer_runtime_job(v_job.id,'defer-worker','grant_writer_active',interval '1 second');
  END LOOP;
  SELECT * INTO v_job FROM runtime_jobs WHERE id=v_job.id;
  IF v_job.status<>'pending' OR v_job.attempt_count<>0 THEN
    RAISE EXCEPTION 'nine deferrals spent the retry budget: status %, attempts %',v_job.status,v_job.attempt_count;
  END IF;
  IF (SELECT count(*) FROM task_runs WHERE task_id=v_task AND failure_code='turn_deferred')<>9 THEN
    RAISE EXCEPTION 'each deferred attempt did not close its own turn';
  END IF;

  -- What a deferral is not for.
  UPDATE runtime_jobs SET available_at=clock_timestamp() WHERE id=v_job.id;
  SELECT * INTO v_job FROM claim_orchestrator_jobs('defer-worker',1,interval '5 minutes');
  PERFORM pg_temp.expect_refusal(format('SELECT defer_runtime_job(%s,%L,%L)',v_job.id,'defer-worker','codex_turn_failed'),
    '{"reason": "defer_reason_not_transient"}','deferral for a reason that does not clear on its own');
  PERFORM pg_temp.expect_refusal(format('SELECT defer_runtime_job(%s,%L,%L)',v_job.id,'someone-else','grant_writer_active'),
    '{"reason": "defer_job_not_leased"}','deferral by a worker that does not lease the job');
  -- 0092 (sprint C K3): a host without memory for the run is a reason that
  -- clears on its own, and the panel says it is the reason.
  PERFORM defer_runtime_job(v_job.id,'defer-worker','runtime_capacity',interval '1 second');
  SELECT * INTO v_job FROM runtime_jobs WHERE id=v_job.id;
  IF v_job.status<>'pending' OR v_job.activity_detail NOT LIKE 'Waiting for memory on the host%' THEN
    RAISE EXCEPTION 'a turn deferred for memory is % saying %',v_job.status,v_job.activity_detail;
  END IF;
  UPDATE runtime_jobs SET available_at=clock_timestamp() WHERE id=v_job.id;
  SELECT * INTO v_job FROM claim_orchestrator_jobs('defer-worker',1,interval '5 minutes');
  PERFORM acknowledge_runtime_job(v_job.id,'defer-worker','{}'::jsonb);
  RAISE NOTICE 'a deferred turn gives its attempt back and ends cancelled, however often a writer delays it';
END $$;

-- An implementation is not deferrable: it has already taken the workspace lock.
-- And the chat reply routing, on a real input request from a real run.
DO $$
DECLARE
  v_user uuid; v_project uuid; v_runtime uuid; v_codex uuid; v_worker uuid; v_session uuid; v_task uuid;
  v_request jsonb; v_msg outbox_messages; v_job runtime_jobs; v_start jsonb; v_report jsonb;
  v_result jsonb; v_chat_events_before bigint; v_codex_jobs_before bigint; v_assignment uuid;
BEGIN
  INSERT INTO users(display_name) VALUES('Input Reply') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path) VALUES(v_user,'Input Reply','input-reply','/srv/input-reply') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','test','test') RETURNING id INTO v_runtime;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('input-reply-codex','architect',v_runtime) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('input-reply-worker','implementer',v_runtime) RETURNING id INTO v_worker;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,native_session_id)
    VALUES(v_project,v_worker,v_runtime,'implementation','ses_input_reply') RETURNING id INTO v_session;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,created_by,acceptance_criteria)
    VALUES(v_project,'Input flow','test','ready',v_codex,'test','["done"]') RETURNING id INTO v_task;

  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_runtime,'executor') RETURNING id INTO v_assignment;
  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]','[]',
    '/srv/input-reply','delegate:'||v_task,1,v_task::text);
  -- What the orchestrator's delegation writes after request_implementation (0014).
  UPDATE handoffs SET executor_assignment_id=v_assignment WHERE id=(v_request->>'handoff_id')::uuid;
  v_msg:=claim_outbox_event((v_request->>'event_id')::uuid,'dispatcher-input-reply',interval '1 minute');
  PERFORM route_outbox_message(v_msg.id,'dispatcher-input-reply');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','supervisor-input-reply',interval '1 minute');

  PERFORM pg_temp.expect_refusal(format('SELECT defer_runtime_job(%s,%L,%L)',v_job.id,'supervisor-input-reply','runtime_paused'),
    '{"reason": "defer_job_type"}','deferral of an implementation job');

  v_start:=start_implementation_job(v_job.id,v_session,'supervisor-input-reply',interval '1 minute');

  -- The executor worker's real sequence, which the supervisor now depends on:
  -- start_implementation_job, then a read_write grant bound to the fencing token
  -- that call returned — resolvable for exactly the run and token the launch
  -- request will carry.
  v_result:=issue_workspace_access_grant(v_job.id,'supervisor-input-reply');
  IF v_result->>'mode'<>'read_write' THEN
    RAISE EXCEPTION 'the executor path was not granted read_write: %',v_result;
  END IF;
  v_result:=resolve_workspace_access_grant(v_result->>'token',v_project);
  IF (v_result->>'run_id')::uuid<>(v_start->>'run_id')::uuid
     OR (v_result->>'fencing_token')::bigint<>(v_start->>'fencing_token')::bigint
     OR (v_result->>'assignment_id')::uuid<>v_assignment THEN
    RAISE EXCEPTION 'the executor grant does not match what the launch will carry: %',v_result;
  END IF;

  v_report:=submit_worker_interaction(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,
    (v_start->>'fencing_token')::bigint,'ses_input_reply','input_request',
    '{"question":"Which region?"}','input:'||(v_start->>'run_id'));
  PERFORM finalize_worker_interaction((v_report->>'report_id')::uuid,v_job.id,'supervisor-input-reply');
  IF (SELECT status FROM tasks WHERE id=v_task)<>'needs_attention' THEN
    RAISE EXCEPTION 'fixture: the task is not waiting for input';
  END IF;

  SELECT count(*) INTO v_chat_events_before FROM domain_events WHERE task_id=v_task AND event_type='chat.user_message';
  SELECT count(*) INTO v_codex_jobs_before FROM runtime_jobs WHERE task_id=v_task AND job_type='orchestrator_turn';

  -- The operator answers in the chat, not through the dedicated reply action.
  v_result:=record_task_chat_message(v_project,v_task,'Use eu-central-1','operator','input-reply');

  IF v_result->>'status'<>'answered_input_request' OR (v_result->>'report_id')::uuid<>(v_report->>'report_id')::uuid THEN
    RAISE EXCEPTION 'the chat message did not answer the open input request: %',v_result;
  END IF;
  IF (SELECT resolved_at FROM worker_interaction_reports WHERE id=(v_report->>'report_id')::uuid) IS NULL THEN
    RAISE EXCEPTION 'the input request is still open';
  END IF;
  IF (SELECT count(*) FROM domain_events WHERE task_id=v_task AND event_type='chat.user_message')<>v_chat_events_before THEN
    RAISE EXCEPTION 'the answer was also recorded as a message to the orchestrator';
  END IF;
  IF (SELECT count(*) FROM runtime_jobs WHERE task_id=v_task AND job_type='orchestrator_turn')<>v_codex_jobs_before THEN
    RAISE EXCEPTION 'the answer started an orchestrator turn';
  END IF;
  IF (SELECT status FROM tasks WHERE id=v_task)<>'implementation_requested'
     OR (SELECT count(*) FROM handoffs WHERE task_id=v_task)<>2 THEN
    RAISE EXCEPTION 'the asking run was not resumed with the answer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM handoffs WHERE task_id=v_task AND revision_number=2
                 AND instructions @> '[{"type":"operator_response","response":{"response":"Use eu-central-1"}}]') THEN
    RAISE EXCEPTION 'the resumed handoff does not carry the answer';
  END IF;
  IF (SELECT executor_assignment_id FROM handoffs WHERE task_id=v_task AND revision_number=2) IS DISTINCT FROM v_assignment THEN
    RAISE EXCEPTION 'the resumed handoff names no executor, so its launch cannot be validated';
  END IF;

  -- With no open request the message is a message, as before.
  v_result:=record_task_chat_message(v_project,v_task,'Anything else?','operator','input-reply-2');
  IF v_result->>'status' IS NULL OR v_result->>'status'='answered_input_request'
     OR (SELECT count(*) FROM domain_events WHERE task_id=v_task AND event_type='chat.user_message')<>v_chat_events_before+1 THEN
    RAISE EXCEPTION 'a message with no open request was not recorded as a chat message: %',v_result;
  END IF;
  RAISE NOTICE 'an answer typed into the chat resumes the run that asked, and starts no orchestrator turn';
END $$;

-- A blocker is not a question. "Missing dependency" is the orchestrator's to
-- re-plan, so a message on a blocked task stays a message to the orchestrator,
-- and the blocker stays open for the dedicated action.
DO $$
DECLARE
  v_user uuid; v_project uuid; v_runtime uuid; v_codex uuid; v_worker uuid; v_session uuid; v_task uuid;
  v_request jsonb; v_msg outbox_messages; v_job runtime_jobs; v_start jsonb; v_report jsonb; v_result jsonb;
BEGIN
  INSERT INTO users(display_name) VALUES('Blocker Reply') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path) VALUES(v_user,'Blocker Reply','blocker-reply','/srv/blocker-reply') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','test','test') RETURNING id INTO v_runtime;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('blocker-reply-codex','architect',v_runtime) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('blocker-reply-worker','implementer',v_runtime) RETURNING id INTO v_worker;
  -- 0081: an agent may do what an enabled assignment of it permits.
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_runtime,'orchestrator',true),(v_project,v_worker,v_runtime,'executor',false);
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,native_session_id)
    VALUES(v_project,v_worker,v_runtime,'implementation','ses_blocker_reply') RETURNING id INTO v_session;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,created_by,acceptance_criteria)
    VALUES(v_project,'Blocked flow','test','ready',v_codex,'test','["done"]') RETURNING id INTO v_task;
  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]','[]',
    '/srv/blocker-reply','delegate:'||v_task,1,v_task::text);
  v_msg:=claim_outbox_event((v_request->>'event_id')::uuid,'dispatcher-blocker-reply',interval '1 minute');
  PERFORM route_outbox_message(v_msg.id,'dispatcher-blocker-reply');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','supervisor-blocker-reply',interval '1 minute');
  v_start:=start_implementation_job(v_job.id,v_session,'supervisor-blocker-reply',interval '1 minute');
  v_report:=submit_worker_interaction(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,
    (v_start->>'fencing_token')::bigint,'ses_blocker_reply','blocker',
    '{"reason":"The build needs a dependency that is not installed"}','blocker:'||(v_start->>'run_id'));
  PERFORM finalize_worker_interaction((v_report->>'report_id')::uuid,v_job.id,'supervisor-blocker-reply');

  v_result:=record_task_chat_message(v_project,v_task,'Can we avoid that dependency?','operator','blocker-reply');
  IF v_result->>'status'='answered_input_request' THEN
    RAISE EXCEPTION 'a message on a blocked task was treated as an answer to a question';
  END IF;
  IF (SELECT resolved_at FROM worker_interaction_reports WHERE id=(v_report->>'report_id')::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'a chat message resolved a blocker';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM domain_events WHERE task_id=v_task AND event_type='chat.user_message') THEN
    RAISE EXCEPTION 'the message on a blocked task was not recorded for the orchestrator';
  END IF;
  RAISE NOTICE 'a message on a blocked task stays a message to the orchestrator';
END $$;

ROLLBACK;
