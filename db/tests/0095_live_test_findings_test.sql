-- Migration 0156: a policy refusal is in the chat, and the broker may read
-- the project's earlier pull requests.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_owner uuid; v_project uuid; v_task uuid; v_event domain_events; v_job runtime_jobs; v_payload jsonb;
BEGIN
  IF NOT has_function_privilege('infra_worker','earlier_published_intents(uuid)','EXECUTE')
     OR has_function_privilege('infra_web','earlier_published_intents(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'earlier_published_intents grants are wrong';
  END IF;
  INSERT INTO users(display_name) VALUES('Policy owner') RETURNING id INTO v_owner;
  INSERT INTO projects(owner_id,name,slug,workspace_path) VALUES(v_owner,'Policy','policy-chat','/srv/infra-cod/workspaces/policy-chat') RETURNING id INTO v_project;
  INSERT INTO tasks(project_id,title,objective,status,created_by) VALUES(v_project,'Policy','test','implementing','test') RETURNING id INTO v_task;
  v_event := append_event('implementation.requested',v_project,v_task,NULL,'user','o',NULL,'pk','pk','task',v_task,1,'{}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status,leased_by,leased_until,payload)
    VALUES(v_event.id,'implementation_run',v_project,v_task,'in_flight','sup',clock_timestamp()+interval '5 minutes','{}') RETURNING * INTO v_job;
  PERFORM append_runtime_activity_event(v_job.id, 'sup', 'claude', 'runtime.policy.refused', 'running_turn',
    'Platform policy refused Bash: do not push', '{"tool":"Bash","reason":"The platform publishes the approved commit itself; do not push.","status":"refused"}');
  PERFORM append_runtime_activity_event(v_job.id, 'sup', 'claude', 'runtime.tool.updated', 'running_turn', 'Bash requested', '{"tool":"Bash"}');
  SELECT payload INTO v_payload FROM domain_events WHERE task_id = v_task AND event_type = 'run.policy_refused';
  IF v_payload->>'tool' <> 'Bash' OR v_payload->>'reason' !~ 'do not push' THEN RAISE EXCEPTION 'the refusal is not in the chat: %', v_payload; END IF;
  IF (SELECT count(*) FROM domain_events WHERE task_id = v_task AND event_type = 'run.policy_refused') <> 1 THEN
    RAISE EXCEPTION 'another activity event became a refusal';
  END IF;
  IF earlier_published_intents(gen_random_uuid()) <> '[]'::jsonb THEN RAISE EXCEPTION 'an unknown intent has earlier ones'; END IF;
  RAISE NOTICE 'live test findings assertions passed';
END $$;

ROLLBACK;
