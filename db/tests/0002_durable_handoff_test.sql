\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public;

DO $$
DECLARE
  v_user uuid;
  v_project uuid;
  v_codex_runtime uuid;
  v_worker_runtime uuid;
  v_codex uuid;
  v_worker uuid;
  v_session uuid;
  v_task uuid;
  v_request jsonb;
  v_repeat_request jsonb;
  v_start jsonb;
  v_complete jsonb;
  v_repeat_complete jsonb;
  v_count bigint;
BEGIN
  INSERT INTO users(display_name) VALUES ('Durable Handoff Test') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id, name, slug, workspace_path)
  VALUES (v_user, 'Durable Handoff Test', 'durable-handoff-test', '/srv/durable-handoff-test')
  RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type, adapter_version, runtime_version, provider_type, model)
  VALUES ('codex', 'test', 'test', 'openai', 'test') RETURNING id INTO v_codex_runtime;
  INSERT INTO runtime_profiles(runtime_type, adapter_version, runtime_version, provider_type, model)
  VALUES ('opencode', 'test', 'test', 'opencode-free', 'test') RETURNING id INTO v_worker_runtime;
  INSERT INTO agents(name, role, runtime_profile_id)
  VALUES ('durable-test-codex', 'architect', v_codex_runtime) RETURNING id INTO v_codex;
  INSERT INTO agents(name, role, runtime_profile_id)
  VALUES ('durable-test-worker', 'implementer', v_worker_runtime) RETURNING id INTO v_worker;
  -- 0081: an agent may do what an enabled assignment of it permits.
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_runtime,'orchestrator',true),(v_project,v_worker,v_worker_runtime,'executor',false);
  INSERT INTO agent_sessions(project_id, agent_id, runtime_profile_id, purpose)
  VALUES (v_project, v_worker, v_worker_runtime, 'implementation') RETURNING id INTO v_session;
  INSERT INTO tasks(project_id, title, objective, status, active_agent_id, created_by)
  VALUES (v_project, 'Test handoff', 'Exercise durable workflow', 'ready', v_codex, 'test')
  RETURNING id INTO v_task;

  v_request := request_implementation(
    v_project, v_task, v_codex, v_worker, 1, 'Implement test output',
    '[]'::jsonb, '[]'::jsonb, '["output exists"]'::jsonb,
    '["output.txt"]'::jsonb, '/srv/durable-handoff-test',
    'delegate:' || v_task || ':1', 1, v_task::text
  );
  v_repeat_request := request_implementation(
    v_project, v_task, v_codex, v_worker, 1, 'Implement test output',
    '[]'::jsonb, '[]'::jsonb, '["output exists"]'::jsonb,
    '["output.txt"]'::jsonb, '/srv/durable-handoff-test',
    'delegate:' || v_task || ':1', 1, v_task::text
  );
  IF v_request <> v_repeat_request THEN
    RAISE EXCEPTION 'repeated delegation did not return the stored receipt';
  END IF;

  PERFORM claim_outbox_event((v_request->>'event_id')::uuid, 'test-dispatcher', interval '1 minute');
  v_start := start_implementation(
    (v_request->>'event_id')::uuid, v_session, 'test-dispatcher', interval '1 minute'
  );
  IF v_start->>'status' <> 'running' OR (v_start->>'fencing_token')::bigint <> 1 THEN
    RAISE EXCEPTION 'implementation did not start with its first fence: %', v_start;
  END IF;

  v_complete := complete_implementation(
    v_project, v_task, (v_start->>'run_id')::uuid, v_worker, v_codex,
    (v_start->>'fencing_token')::bigint,
    '{"changed_files":["output.txt"]}'::jsonb, '{"test":"passed"}'::jsonb,
    'complete:' || (v_start->>'run_id'), (v_start->>'task_version')::bigint, v_task::text
  );
  v_repeat_complete := complete_implementation(
    v_project, v_task, (v_start->>'run_id')::uuid, v_worker, v_codex,
    (v_start->>'fencing_token')::bigint,
    '{"changed_files":["output.txt"]}'::jsonb, '{"test":"passed"}'::jsonb,
    'complete:' || (v_start->>'run_id'), (v_start->>'task_version')::bigint, v_task::text
  );
  IF v_complete <> v_repeat_complete THEN
    RAISE EXCEPTION 'repeated completion did not return the stored receipt';
  END IF;

  SELECT count(*) INTO v_count FROM domain_events WHERE task_id = v_task;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'expected three handoff events, found %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM tasks WHERE id = v_task AND status = 'awaiting_review' AND version = 4;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'task did not reach awaiting_review version 4';
  END IF;
  SELECT count(*) INTO v_count
  FROM workspace_locks
  WHERE project_id = v_project AND status = 'released' AND owner_run_id IS NULL AND fencing_token = 1;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'workspace lock was not safely released';
  END IF;

  RAISE NOTICE 'durable handoff integration assertions passed';
END;
$$;

ROLLBACK;
