\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public;

DO $$
DECLARE
  v_user uuid;
  v_project uuid;
  v_runtime uuid;
  v_codex uuid;
  v_worker uuid;
  v_task uuid;
  v_run_1 uuid;
  v_run_2 uuid;
  v_command_1 commands;
  v_command_2 commands;
  v_event domain_events;
  v_token_1 bigint;
  v_token_2 bigint;
  v_message outbox_messages;
  v_count bigint;
BEGIN
  INSERT INTO users(display_name) VALUES ('Control Plane Test') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id, name, slug, workspace_path)
  VALUES (v_user, 'Test Project', 'control-plane-test', '/srv/control-plane-test')
  RETURNING id INTO v_project;

  INSERT INTO runtime_profiles(runtime_type, adapter_version, runtime_version, provider_type, model)
  VALUES ('codex', 'test', 'test', 'openai', 'test') RETURNING id INTO v_runtime;
  INSERT INTO agents(name, role, runtime_profile_id)
  VALUES ('test-codex', 'architect', v_runtime) RETURNING id INTO v_codex;
  INSERT INTO agents(name, role, runtime_profile_id)
  VALUES ('test-worker', 'implementer', v_runtime) RETURNING id INTO v_worker;
  INSERT INTO tasks(project_id, title, objective, status, active_agent_id, created_by)
  VALUES (v_project, 'Test durable handoff', 'Verify database invariants', 'implementation_requested', v_worker, 'test')
  RETURNING id INTO v_task;
  INSERT INTO task_runs(task_id, agent_id, phase, status, write_capable)
  VALUES (v_task, v_worker, 'implementation', 'queued', true) RETURNING id INTO v_run_1;
  INSERT INTO task_runs(task_id, agent_id, phase, status, write_capable)
  VALUES (v_task, v_codex, 'review', 'queued', true) RETURNING id INTO v_run_2;

  v_command_1 := submit_command(
    v_project, v_task, 'DelegateTask', 'agent', v_codex::text,
    'delegate:' || v_task || ':1', '{"revision": 1}'::jsonb, 1, v_task::text
  );
  v_command_2 := submit_command(
    v_project, v_task, 'DelegateTask', 'agent', v_codex::text,
    'delegate:' || v_task || ':1', '{"revision": 1}'::jsonb, 1, v_task::text
  );
  IF v_command_1.id <> v_command_2.id THEN
    RAISE EXCEPTION 'same idempotency key did not return the original command';
  END IF;

  BEGIN
    PERFORM submit_command(
      v_project, v_task, 'DelegateTask', 'agent', v_codex::text,
      'delegate:' || v_task || ':1', '{"revision": 2}'::jsonb, 1, v_task::text
    );
    RAISE EXCEPTION 'conflicting idempotency payload was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  v_event := append_event(
    'implementation.requested', v_project, v_task, NULL,
    'agent', v_codex::text, v_command_1.id, v_task::text,
    'event:delegate:' || v_task || ':1', 'task', v_task, 1,
    '{"revision": 1}'::jsonb
  );
  SELECT count(*) INTO v_count FROM outbox_messages WHERE event_id = v_event.id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'event did not create exactly one outbox message';
  END IF;

  v_token_1 := acquire_workspace_lock(v_project, v_run_1, 'implementation');
  IF v_token_1 <> 1 THEN
    RAISE EXCEPTION 'first fencing token was %, expected 1', v_token_1;
  END IF;
  IF acquire_workspace_lock(v_project, v_run_1, 'implementation retry') <> v_token_1 THEN
    RAISE EXCEPTION 'idempotent lock acquire changed the fencing token';
  END IF;

  BEGIN
    PERFORM acquire_workspace_lock(v_project, v_run_2, 'review');
    RAISE EXCEPTION 'concurrent writer acquired an active project lock';
  EXCEPTION WHEN lock_not_available THEN
    NULL;
  END;

  PERFORM assert_workspace_fence(v_project, v_run_1, v_token_1);
  PERFORM release_workspace_lock(v_project, v_run_1, v_token_1);
  v_token_2 := acquire_workspace_lock(v_project, v_run_2, 'review');
  IF v_token_2 <> v_token_1 + 1 THEN
    RAISE EXCEPTION 'fencing token was not monotonic: % -> %', v_token_1, v_token_2;
  END IF;

  BEGIN
    PERFORM assert_workspace_fence(v_project, v_run_1, v_token_1);
    RAISE EXCEPTION 'stale fencing token was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;

  SELECT * INTO v_message FROM claim_outbox('dispatcher-a', 1, interval '30 seconds');
  IF v_message.id IS NULL OR v_message.attempt_count <> 1 THEN
    RAISE EXCEPTION 'dispatcher did not claim the pending outbox message';
  END IF;
  SELECT count(*) INTO v_count FROM claim_outbox('dispatcher-b', 1, interval '30 seconds');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'a second dispatcher claimed an active outbox lease';
  END IF;
  PERFORM acknowledge_outbox(v_message.id, 'dispatcher-a');
  SELECT count(*) INTO v_count FROM outbox_messages WHERE id = v_message.id AND status = 'published';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'outbox acknowledgement did not persist';
  END IF;

  UPDATE task_runs SET status = 'completed', finished_at = clock_timestamp() WHERE id = v_run_1;
  BEGIN
    UPDATE task_runs SET status = 'running' WHERE id = v_run_1;
    RAISE EXCEPTION 'terminal run status regression was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;

  RAISE NOTICE 'control-plane integration assertions passed';
END;
$$;

ROLLBACK;
