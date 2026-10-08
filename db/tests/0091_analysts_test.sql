-- Migration 0147: analysts and consultations.
--
--   * the registry's mirror: Claude Code and OpenCode play the analyst, Codex
--     does not;
--   * the Team tab: an analyst is added on a verified model of a runtime that
--     plays it, named uniquely, edited and removed — each change checked for
--     the owner and the team version;
--   * platform.consult from an orchestrator's turn: by name, or the only one;
--     refused for a stranger's name, without a lease, past three open ones;
--     the same call asks once; consultation.requested becomes a
--     consultation_run job;
--   * the run: claimed, its context read under the lease, finished with an
--     answer (consultation.answered → resume_orchestrator) or a failure
--     (consultation.failed → resume_orchestrator; the job ends, not a dead letter);
--   * a consultation turn does not move the task to reviewing.
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
  v_owner uuid; v_project uuid; v_codex_connection uuid; v_zen uuid; v_claude_connection uuid;
  v_codex_a uuid; v_free_a uuid; v_free_b uuid; v_sonnet uuid;
  v_codex_profile uuid; v_opencode_profile uuid; v_codex uuid; v_worker uuid; v_orchestrator uuid; v_executor uuid;
  v_task uuid; v_event uuid; v_job bigint; v_result jsonb; v_analyst uuid; v_reason text; v_version bigint;
  v_consultation uuid; v_run_job runtime_jobs%ROWTYPE; v_context jsonb; v_message bigint; v_route jsonb;
BEGIN
  IF NOT runtime_plays('claude','analyst') OR NOT runtime_plays('opencode','analyst') OR runtime_plays('codex','analyst') THEN
    RAISE EXCEPTION 'the analyst mirror is wrong';
  END IF;
  IF NOT has_function_privilege('infra_web','add_project_analyst(uuid,uuid,bigint,uuid,text,text,text,text,text)','EXECUTE')
     OR has_function_privilege('infra_web','invoke_consult(bigint,text,text,text,text)','EXECUTE')
     OR has_function_privilege('infra_web','finish_consultation(bigint,text,jsonb)','EXECUTE')
     OR NOT has_function_privilege('infra_worker','finish_consultation(bigint,text,jsonb)','EXECUTE')
     OR has_table_privilege('infra_web','consultations','SELECT') THEN
    RAISE EXCEPTION 'analyst grants are wrong';
  END IF;

  INSERT INTO users(display_name,role) VALUES('Analyst owner','owner') RETURNING id INTO v_owner;
  INSERT INTO projects(owner_id,name,slug,workspace_path,status)
    VALUES(v_owner,'Analysts','analysts','/srv/infra-cod/workspaces/analysts','active') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status)
    VALUES(v_owner,'codex','device_code','connected') RETURNING id INTO v_codex_connection;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','native','connected','free','opencode-home:opencode-worker') RETURNING id INTO v_zen;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_codex_connection,'codex','openai','analyst-codex','codex_model_list','verified',clock_timestamp(),gen_random_uuid()) RETURNING id INTO v_codex_a;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_zen,'opencode','opencode','analyst-free-a','opencode_provider_api','verified',clock_timestamp(),gen_random_uuid()) RETURNING id INTO v_free_a;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_zen,'opencode','opencode','analyst-free-b','opencode_provider_api','verified',clock_timestamp(),gen_random_uuid()) RETURNING id INTO v_free_b;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('codex','test','test','openai','analysts',clock_timestamp()) RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('opencode','test','test','opencode','analysts',clock_timestamp()) RETURNING id INTO v_opencode_profile;
  INSERT INTO agents(name,runtime_profile_id) VALUES('analysts-codex',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,runtime_profile_id) VALUES('analysts-worker',v_opencode_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,is_default,created_at)
    VALUES(v_project,v_codex,v_codex_profile,(SELECT id FROM role_definitions WHERE builtin_key='orchestrator'),true,clock_timestamp())
    RETURNING id INTO v_orchestrator;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,created_at)
    VALUES(v_project,v_worker,v_opencode_profile,(SELECT id FROM role_definitions WHERE builtin_key='executor'),clock_timestamp())
    RETURNING id INTO v_executor;
  PERFORM set_project_runtime_defaults(v_project, v_owner, 1, v_codex_a, ARRAY[v_free_a], '', '', 'o', 'c', ARRAY['']);
  v_version := (SELECT version FROM project_runtime_defaults WHERE project_id=v_project);

  -- The Team tab.
  v_reason := pg_temp.reason_of(format($q$SELECT add_project_analyst(%L,%L,%s,%L,'Reader','','o','c')$q$, v_project, v_owner, v_version, v_codex_a));
  IF v_reason IS DISTINCT FROM 'runtime_cannot_play_role' THEN RAISE EXCEPTION 'Codex was made an analyst: %', v_reason; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT add_project_analyst(%L,%L,%s,%L,'  ','','o','c')$q$, v_project, v_owner, v_version, v_free_b));
  IF v_reason IS DISTINCT FROM 'analyst_invalid' THEN RAISE EXCEPTION 'a nameless analyst was added: %', v_reason; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT add_project_analyst(%L,%L,%s,%L,'Reader','','o','c')$q$, v_project, v_owner, v_version - 1, v_free_b));
  IF v_reason IS DISTINCT FROM 'runtime_defaults_version_stale' THEN RAISE EXCEPTION 'a stale version was taken: %', v_reason; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT add_project_analyst(%L,%L,%s,%L,'Reader','','o','c')$q$, v_project, gen_random_uuid(), v_version, v_free_b));
  IF v_reason IS DISTINCT FROM 'project_unavailable' THEN RAISE EXCEPTION 'a stranger added an analyst: %', v_reason; END IF;
  v_result := add_project_analyst(v_project, v_owner, v_version, v_free_b, 'Security reviewer', 'Look for injection.', 'o', 'c');
  v_analyst := (v_result->>'analyst_id')::uuid;
  v_version := (v_result->>'version')::bigint;
  v_reason := pg_temp.reason_of(format($q$SELECT add_project_analyst(%L,%L,%s,%L,'security REVIEWER','','o','c')$q$, v_project, v_owner, v_version, v_free_a));
  IF v_reason IS DISTINCT FROM 'analyst_invalid' THEN RAISE EXCEPTION 'two analysts share a name: %', v_reason; END IF;
  v_version := (update_project_analyst(v_project, v_owner, v_version, v_analyst, 'Security reviewer', 'Look for injection and secrets.', 'o', 'c')->>'version')::bigint;
  IF jsonb_array_length(project_analyst_list(v_project, v_owner)) <> 1
     OR project_analyst_list(v_project, v_owner)->0->>'instructions' <> 'Look for injection and secrets.'
     OR project_analyst_list(v_project, v_owner)->0->>'runtime_type' <> 'opencode'
     OR jsonb_array_length(project_analyst_list(v_project, gen_random_uuid())) <> 0 THEN
    RAISE EXCEPTION 'the analyst list: %', project_analyst_list(v_project, v_owner);
  END IF;

  -- An orchestrator's turn asks.
  INSERT INTO tasks(project_id,title,objective,status,created_by,orchestrator_assignment_id,active_agent_id)
    VALUES(v_project,'Consult','Find the bug.','planning','test',v_orchestrator,v_worker) RETURNING id INTO v_task;
  SET LOCAL session_replication_role = replica;
  INSERT INTO domain_events(event_type,project_id,task_id,conversation_id,conversation_sequence,actor_type,actor_id,correlation_id,aggregate_type,aggregate_id,aggregate_version,payload)
    VALUES('chat.user_message',v_project,v_task,(SELECT conversation_id FROM tasks WHERE id=v_task),9001,'user','test','consult-test','task',v_task,1,'{}') RETURNING id INTO v_event;
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status,leased_by,leased_until,payload)
    VALUES(v_event,'orchestrator_turn',v_project,v_task,'in_flight','turn-worker',clock_timestamp()+interval '5 minutes',
      '{"correlation_id":"consult-test"}') RETURNING id INTO v_job;
  SET LOCAL session_replication_role = origin;

  IF jsonb_array_length(orchestrator_analysts(v_job, 'turn-worker')) <> 1 THEN RAISE EXCEPTION 'the orchestrator is not told its analysts'; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT invoke_consult(%s,'other-worker','call-1','','Where is the timer reset?')$q$, v_job));
  IF v_reason IS DISTINCT FROM 'orchestration_job_not_leased' THEN RAISE EXCEPTION 'a worker without the lease asked: %', v_reason; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT invoke_consult(%s,'turn-worker','call-1','Nobody','Where is the timer reset?')$q$, v_job));
  IF v_reason IS DISTINCT FROM 'analyst_unavailable' THEN RAISE EXCEPTION 'an unknown analyst was asked: %', v_reason; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT invoke_consult(%s,'turn-worker','call-1','','short')$q$, v_job));
  IF v_reason IS DISTINCT FROM 'consultation_arguments_invalid' THEN RAISE EXCEPTION 'a too-short question was asked: %', v_reason; END IF;

  -- The only analyst, without a name; the same call again is the same consultation.
  v_result := invoke_consult(v_job, 'turn-worker', 'call-1', '', 'Where is the timer reset, and what calls it?');
  v_consultation := (v_result->>'consultation_id')::uuid;
  IF v_result->>'analyst' <> 'Security reviewer'
     OR (invoke_consult(v_job, 'turn-worker', 'call-1', '', 'Where is the timer reset, and what calls it?')->>'consultation_id')::uuid <> v_consultation
     OR (SELECT count(*) FROM consultations WHERE task_id=v_task) <> 1 THEN
    RAISE EXCEPTION 'consult: %', v_result;
  END IF;
  -- 0148: asked again from the same turn while the answer is on the way: the
  -- question already asked, not a second run.
  v_result := invoke_consult(v_job, 'turn-worker', 'call-2', 'security reviewer', 'Please return the requested trace now.');
  IF v_result->>'status' <> 'already_asked' OR (v_result->>'consultation_id')::uuid <> v_consultation
     OR (SELECT count(*) FROM consultations WHERE task_id=v_task) <> 1 THEN
    RAISE EXCEPTION 'a second ask from the same turn started another run: %', v_result;
  END IF;
  -- Three open at once for a task, from whichever turns asked.
  INSERT INTO consultations(project_id, task_id, analyst_id, question, requested_by_job, call_id)
  VALUES (v_project, v_task, v_analyst, 'An earlier turn''s question.', -1, 'x1'),
         (v_project, v_task, v_analyst, 'Another earlier turn''s question.', -2, 'x2');
  UPDATE consultations SET requested_by_job=-3 WHERE id=v_consultation;
  v_reason := pg_temp.reason_of(format($q$SELECT invoke_consult(%s,'turn-worker','call-4','','A fourth question while three wait.')$q$, v_job));
  IF v_reason IS DISTINCT FROM 'consultation_limit' THEN RAISE EXCEPTION 'a fourth open consultation was taken: %', v_reason; END IF;
  UPDATE consultations SET requested_by_job=v_job WHERE id=v_consultation;

  -- The event becomes a consultation_run job.
  SELECT o.id INTO v_message FROM outbox_messages o JOIN domain_events e ON e.id=o.event_id
  WHERE e.event_type='consultation.requested' AND e.payload->>'consultation_id'=v_consultation::text;
  UPDATE outbox_messages SET status='in_flight', leased_by='dispatcher-test', leased_until=clock_timestamp()+interval '1 minute' WHERE id=v_message;
  v_route := route_outbox_message(v_message, 'dispatcher-test');
  IF v_route->>'job_type' <> 'consultation_run' THEN RAISE EXCEPTION 'route: %', v_route; END IF;

  -- Claimed, read under its lease, answered.
  UPDATE runtime_jobs SET status='completed', completed_at=clock_timestamp(), leased_by=NULL, leased_until=NULL
  WHERE job_type='consultation_run' AND id<>(v_route->>'job_id')::bigint AND status IN ('pending','in_flight');
  SELECT * INTO v_run_job FROM claim_consultation_jobs('consult-worker');
  IF v_run_job.id <> (v_route->>'job_id')::bigint THEN RAISE EXCEPTION 'the consultation job was not claimed'; END IF;
  v_context := consultation_job_context(v_run_job.id, 'consult-worker');
  IF v_context->>'question' <> 'Where is the timer reset, and what calls it?' OR v_context->>'runtime_type' <> 'opencode'
     OR v_context->>'model' <> 'analyst-free-b' OR v_context->>'instructions' <> 'Look for injection and secrets.' THEN
    RAISE EXCEPTION 'context: %', v_context;
  END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT consultation_job_context(%s,'someone-else')$q$, v_run_job.id));
  IF v_reason IS DISTINCT FROM 'consultation_not_held' THEN RAISE EXCEPTION 'another worker read the context: %', v_reason; END IF;
  -- M7 (0151): the run's tokens, counted under its job, become the analyst's.
  -- As the supervisor writes it: an activity event under the leased job, which
  -- the usage trigger turns into the run's row.
  PERFORM append_runtime_activity_event(v_run_job.id, 'consult-worker', 'opencode', 'runtime.turn.usage', 'running',
    'tokens', '{"tokens":{"input":1000,"output":200}}'::jsonb);
  IF (SELECT total_tokens FROM run_usage WHERE job_id=v_run_job.id) IS DISTINCT FROM 1200 THEN
    RAISE EXCEPTION 'the analyst''s activity was not counted: %', (SELECT to_jsonb(u) FROM run_usage u WHERE job_id=v_run_job.id);
  END IF;
  IF (v_context->>'allow_subagents')::boolean IS DISTINCT FROM false OR (v_context->>'stop_requested')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'context lacks M7 fields: %', v_context;
  END IF;
  PERFORM finish_consultation(v_run_job.id, 'consult-worker',
    jsonb_build_object('status','answered','answer','src/timer.js:42 resets it; app.js:10 calls it.','model','analyst-free-b','snapshot_sha',repeat('a',40)));
  IF (SELECT analyst_id FROM run_usage WHERE job_id=v_run_job.id) IS DISTINCT FROM v_analyst
     OR (SELECT model FROM run_usage WHERE job_id=v_run_job.id) <> 'analyst-free-b' THEN
    RAISE EXCEPTION 'the run''s tokens were not named the analyst''s';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(get_task_usage(v_project, v_task, v_owner)->'members') m
                 WHERE m->>'role_key'='analyst' AND m->>'agent_name'='Security reviewer'
                   AND (m#>>'{usage,total_tokens}')::bigint = 1200) THEN
    RAISE EXCEPTION 'the chat''s usage does not list the analyst: %', get_task_usage(v_project, v_task, v_owner)->'members';
  END IF;
  IF (SELECT status FROM consultations WHERE id=v_consultation) <> 'answered'
     OR (SELECT status FROM runtime_jobs WHERE id=v_run_job.id) <> 'completed' THEN
    RAISE EXCEPTION 'the answer was not recorded';
  END IF;

  -- The answer becomes the orchestrator's next turn, which is not a review.
  SELECT o.id INTO v_message FROM outbox_messages o JOIN domain_events e ON e.id=o.event_id
  WHERE e.event_type='consultation.answered' AND e.payload->>'consultation_id'=v_consultation::text;
  UPDATE outbox_messages SET status='in_flight', leased_by='dispatcher-test', leased_until=clock_timestamp()+interval '1 minute' WHERE id=v_message;
  v_route := route_outbox_message(v_message, 'dispatcher-test');
  IF v_route->>'job_type' <> 'resume_orchestrator' THEN RAISE EXCEPTION 'answer route: %', v_route; END IF;
  UPDATE tasks SET status='awaiting_review' WHERE id=v_task;
  UPDATE runtime_jobs SET status='completed', completed_at=clock_timestamp(), leased_by=NULL, leased_until=NULL WHERE id=v_job;
  PERFORM claim_orchestrator_jobs('turn-worker-2', 5);
  IF (SELECT status FROM tasks WHERE id=v_task) <> 'awaiting_review' THEN
    RAISE EXCEPTION 'a consultation turn moved the task to %', (SELECT status FROM tasks WHERE id=v_task);
  END IF;

  -- A run with no answer is a failure the orchestrator is told of: an earlier
  -- turn's question, its job made here.
  SET LOCAL session_replication_role = replica;
  INSERT INTO domain_events(event_type,project_id,task_id,conversation_id,conversation_sequence,actor_type,actor_id,correlation_id,aggregate_type,aggregate_id,aggregate_version,payload)
    VALUES('consultation.requested',v_project,v_task,(SELECT conversation_id FROM tasks WHERE id=v_task),9100,'agent','orchestrator','consult-test',
      'consultation',(SELECT id FROM consultations WHERE call_id='x1'),1,
      jsonb_build_object('consultation_id',(SELECT id FROM consultations WHERE call_id='x1'))) RETURNING id INTO v_event;
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    VALUES(v_event,'consultation_run',v_project,v_task,
      jsonb_build_object('event_type','consultation.requested','event_payload',jsonb_build_object('consultation_id',(SELECT id FROM consultations WHERE call_id='x1'))));
  SET LOCAL session_replication_role = origin;
  SELECT * INTO v_run_job FROM claim_consultation_jobs('consult-worker');
  PERFORM finish_consultation(v_run_job.id, 'consult-worker', '{"status":"answered","answer":"   "}');
  IF (SELECT status FROM runtime_jobs WHERE id=v_run_job.id) <> 'completed'
     OR NOT EXISTS (SELECT 1 FROM consultations WHERE task_id=v_task AND status='failed')
     OR NOT EXISTS (SELECT 1 FROM domain_events WHERE task_id=v_task AND event_type='consultation.failed') THEN
    RAISE EXCEPTION 'an empty answer was not a failure';
  END IF;

  -- 0149: the turn that brings an answer may delegate; a review's resume may not.
  UPDATE tasks SET status='planning' WHERE id=v_task;
  SET LOCAL session_replication_role = replica;
  INSERT INTO domain_events(event_type,project_id,task_id,conversation_id,conversation_sequence,actor_type,actor_id,correlation_id,aggregate_type,aggregate_id,aggregate_version,payload)
    VALUES('consultation.answered',v_project,v_task,(SELECT conversation_id FROM tasks WHERE id=v_task),9200,'agent','analyst','consult-test','consultation',gen_random_uuid(),9,'{}') RETURNING id INTO v_event;
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status,leased_by,leased_until,payload)
    VALUES(v_event,'resume_orchestrator',v_project,v_task,'in_flight','answer-worker',clock_timestamp()+interval '5 minutes',
      '{"event_type":"consultation.answered","correlation_id":"consult-test"}') RETURNING id INTO v_job;
  SET LOCAL session_replication_role = origin;
  v_reason := pg_temp.reason_of(format($q$SELECT invoke_delegate_task(%s,'answer-worker','delegate-1','Add the reset button.','["do it"]','[]')$q$, v_job));
  IF v_reason IS NOT DISTINCT FROM 'orchestration_job_not_leased' THEN
    RAISE EXCEPTION 'a turn bringing an answer could not delegate';
  END IF;
  UPDATE runtime_jobs SET payload='{"event_type":"implementation.completed"}' WHERE id=v_job;
  v_reason := pg_temp.reason_of(format($q$SELECT invoke_delegate_task(%s,'answer-worker','delegate-2','Add the reset button.','["do it"]','[]')$q$, v_job));
  IF v_reason IS DISTINCT FROM 'orchestration_job_not_leased' THEN
    RAISE EXCEPTION 'a review''s resume delegated: %', v_reason;
  END IF;

  -- M7: subagents per member — an executor's and an analyst's, off by default.
  IF (project_member_subagents(v_project, v_owner)->>v_executor::text)::boolean IS DISTINCT FROM false
     OR (project_member_subagents(v_project, v_owner)->>v_analyst::text)::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'subagents are not off by default: %', project_member_subagents(v_project, v_owner);
  END IF;
  PERFORM set_project_member_subagents(v_project, v_owner, (SELECT version FROM project_runtime_defaults WHERE project_id=v_project), v_executor, true, 'o', 'c');
  PERFORM set_project_member_subagents(v_project, v_owner, (SELECT version FROM project_runtime_defaults WHERE project_id=v_project), v_analyst, true, 'o', 'c');
  IF (SELECT config->>'allow_subagents' FROM project_agent_assignments WHERE id=v_executor) <> 'true'
     OR NOT (SELECT allow_subagents FROM project_analysts WHERE id=v_analyst) THEN
    RAISE EXCEPTION 'subagents were not allowed';
  END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT set_project_member_subagents(%L,%L,%s,%L,true,'o','c')$q$, v_project, v_owner,
    (SELECT version FROM project_runtime_defaults WHERE project_id=v_project), v_orchestrator));
  IF v_reason IS DISTINCT FROM 'team_member_unavailable' THEN RAISE EXCEPTION 'the orchestrator got a subagent switch: %', v_reason; END IF;

  -- M7: the owner stops a question still being read; a finished one is refused.
  SELECT id INTO v_consultation FROM consultations WHERE task_id=v_task AND status='requested' LIMIT 1;
  PERFORM request_consultation_stop(v_project, v_owner, v_consultation, 'owner');
  IF (SELECT stop_requested_at FROM consultations WHERE id=v_consultation) IS NULL THEN RAISE EXCEPTION 'the stop was not recorded'; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT request_consultation_stop(%L,%L,%L,'owner')$q$, v_project, gen_random_uuid(), v_consultation));
  IF v_reason IS DISTINCT FROM 'consultation_not_running' THEN RAISE EXCEPTION 'a stranger stopped a question: %', v_reason; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT request_consultation_stop(%L,%L,%L,'owner')$q$, v_project, v_owner,
    (SELECT id FROM consultations WHERE task_id=v_task AND status='answered' LIMIT 1)));
  IF v_reason IS DISTINCT FROM 'consultation_not_running' THEN RAISE EXCEPTION 'an answered question was stopped: %', v_reason; END IF;

  -- Removing the analyst: it is no longer asked.
  v_version := (remove_project_analyst(v_project, v_owner, (SELECT version FROM project_runtime_defaults WHERE project_id=v_project), v_analyst, 'o', 'c')->>'version')::bigint;
  IF jsonb_array_length(project_analyst_list(v_project, v_owner)) <> 0 THEN RAISE EXCEPTION 'a removed analyst is listed'; END IF;
  RAISE NOTICE 'analyst assertions passed';
END $$;

ROLLBACK;
