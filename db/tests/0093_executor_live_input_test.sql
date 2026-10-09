-- Migration 0154: the owner's message to an executor while it works, and a
-- pull request review's tokens in its chat's usage.
--
--   * refused with no executor working, for a runtime without input.steer, for
--     an empty message or a stranger;
--   * a Claude Code executor's running run takes it as a `steer` command, the
--     chat shows it asked, then delivered or not from the command's outcome;
--   * a review's tokens become a usage row of its chat.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

CREATE FUNCTION pg_temp.reason_of(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_detail text;
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF v_detail IS NULL OR left(v_detail, 1) <> '{' THEN RETURN 'NO_DETAIL: ' || SQLERRM; END IF;
  RETURN v_detail::jsonb->>'reason';
END $$;

DO $$
DECLARE
  v_owner uuid; v_project uuid; v_claude uuid; v_opencode uuid; v_agent uuid; v_oc_agent uuid; v_task uuid;
  v_session uuid; v_run uuid; v_event domain_events; v_job runtime_jobs; v_result jsonb; v_reason text; v_command jsonb;
  v_claimed jsonb; v_events text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM runtime_capabilities WHERE runtime_type = 'claude' AND capability = 'input.steer')
     OR EXISTS (SELECT 1 FROM runtime_capabilities WHERE runtime_type <> 'claude' AND capability = 'input.steer') THEN
    RAISE EXCEPTION 'input.steer is not Claude Code''s alone';
  END IF;
  IF NOT has_function_privilege('infra_web','request_executor_message(uuid,uuid,uuid,text,text,text)','EXECUTE')
     OR has_function_privilege('infra_web','steerable_executor_run(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'live input grants are wrong';
  END IF;

  INSERT INTO users(display_name) VALUES('Steer owner') RETURNING id INTO v_owner;
  INSERT INTO projects(owner_id,name,slug,workspace_path) VALUES(v_owner,'Steer','steer-live','/srv/infra-cod/workspaces/steer-live') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('claude','test','test','anthropic','steer-claude') RETURNING id INTO v_claude;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode','steer-oc') RETURNING id INTO v_opencode;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('steer-claude','implementer',v_claude) RETURNING id INTO v_agent;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('steer-oc','implementer',v_opencode) RETURNING id INTO v_oc_agent;
  INSERT INTO tasks(project_id,title,objective,status,created_by) VALUES(v_project,'Steer','test','implementing','test') RETURNING id INTO v_task;

  -- Nothing running: refused.
  v_reason := pg_temp.reason_of(format($q$SELECT request_executor_message(%L,%L,%L,'hi','steer-key-0001','o')$q$, v_project, v_task, v_owner));
  IF v_reason IS DISTINCT FROM 'executor_not_steerable' THEN RAISE EXCEPTION 'a message with no executor working: %', v_reason; END IF;

  -- An OpenCode executor working: refused, it has no input.steer.
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose) VALUES(v_project,v_oc_agent,v_opencode,'implementation') RETURNING id INTO v_session;
  INSERT INTO task_runs(task_id,agent_id,session_id,phase,status,write_capable,workspace_fencing_token)
    VALUES(v_task,v_oc_agent,v_session,'implementation','running',true,1) RETURNING id INTO v_run;
  v_event := append_event('implementation.requested',v_project,v_task,NULL,'user','o',NULL,'k1','k1','task',v_task,1,'{}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,run_id,status,leased_by,leased_until,payload)
    VALUES(v_event.id,'implementation_run',v_project,v_task,v_run,'in_flight','sup',clock_timestamp()+interval '5 minutes','{}') RETURNING * INTO v_job;
  v_reason := pg_temp.reason_of(format($q$SELECT request_executor_message(%L,%L,%L,'hi','steer-key-0002','o')$q$, v_project, v_task, v_owner));
  IF v_reason IS DISTINCT FROM 'executor_not_steerable' THEN RAISE EXCEPTION 'an OpenCode run took a message: %', v_reason; END IF;
  IF task_steer_target(v_project, v_task, v_owner) IS NOT NULL THEN RAISE EXCEPTION 'the panel offers a message to OpenCode'; END IF;

  -- A Claude Code executor working: taken, in the chat.
  UPDATE runtime_jobs SET status='completed', completed_at=clock_timestamp(), leased_by=NULL, leased_until=NULL WHERE id=v_job.id;
  UPDATE task_runs SET status='completed', finished_at=clock_timestamp() WHERE id=v_run;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose) VALUES(v_project,v_agent,v_claude,'implementation') RETURNING id INTO v_session;
  INSERT INTO task_runs(task_id,agent_id,session_id,phase,status,write_capable,workspace_fencing_token)
    VALUES(v_task,v_agent,v_session,'implementation','running',true,1) RETURNING id INTO v_run;
  v_event := append_event('implementation.requested',v_project,v_task,NULL,'user','o',NULL,'k2','k2','task',v_task,2,'{}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,run_id,status,leased_by,leased_until,payload)
    VALUES(v_event.id,'implementation_run',v_project,v_task,v_run,'in_flight','sup',clock_timestamp()+interval '5 minutes','{}') RETURNING * INTO v_job;
  IF task_steer_target(v_project, v_task, v_owner)->>'runtime_type' <> 'claude' THEN RAISE EXCEPTION 'the panel does not offer a message to Claude Code'; END IF;
  IF task_steer_target(v_project, v_task, gen_random_uuid()) IS NOT NULL THEN RAISE EXCEPTION 'a stranger sees the executor'; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT request_executor_message(%L,%L,%L,'  ','steer-key-0003','o')$q$, v_project, v_task, v_owner));
  IF v_reason IS DISTINCT FROM 'executor_message_invalid' THEN RAISE EXCEPTION 'an empty message: %', v_reason; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT request_executor_message(%L,%L,%L,'hi','steer-key-0004','o')$q$, v_project, v_task, gen_random_uuid()));
  IF v_reason IS DISTINCT FROM 'project_unavailable' THEN RAISE EXCEPTION 'a stranger wrote to the executor: %', v_reason; END IF;
  v_command := request_executor_message(v_project, v_task, v_owner, 'Use the existing helper', 'steer-key-0005', 'owner');
  IF (request_executor_message(v_project, v_task, v_owner, 'Use the existing helper', 'steer-key-0005', 'owner')->>'command_id') <> v_command->>'command_id' THEN
    RAISE EXCEPTION 'the same click made a second command';
  END IF;
  v_command := v_command || jsonb_build_object('second', request_executor_message(v_project, v_task, v_owner, 'And keep it short', 'steer-key-0006', 'owner'));

  -- Delivered, and the second not: the chat says each.
  v_claimed := claim_run_command(v_job.id, 'sup');
  PERFORM acknowledge_run_command((v_claimed->>'command_id')::bigint, 'sup', '{"written":true}');
  v_claimed := claim_run_command(v_job.id, 'sup');
  PERFORM finish_run_command((v_claimed->>'command_id')::bigint, 'sup', 'failed', 'run_command_delivery_failed',
    '{"error":"the executor had already finished its turn"}');
  SELECT array_agg(event_type ORDER BY conversation_sequence) INTO v_events FROM domain_events WHERE task_id = v_task AND event_type LIKE 'run.steer%';
  IF v_events <> ARRAY['run.steer_requested','run.steer_requested','run.steer_delivered','run.steer_failed'] THEN
    RAISE EXCEPTION 'chat events: %', v_events;
  END IF;
  IF (SELECT payload->>'reason' FROM domain_events WHERE task_id = v_task AND event_type = 'run.steer_failed') <> 'the executor had already finished its turn' THEN
    RAISE EXCEPTION 'the failure does not say why';
  END IF;
  IF (SELECT payload->>'text' FROM domain_events WHERE task_id = v_task AND event_type = 'run.steer_requested' ORDER BY conversation_sequence LIMIT 1) <> 'Use the existing helper' THEN
    RAISE EXCEPTION 'the chat does not show the message';
  END IF;
  RAISE NOTICE 'live input assertions passed';
END $$;

ROLLBACK;
