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
  v_session uuid;
  v_task uuid;
  v_request jsonb;
  v_message outbox_messages;
  v_route jsonb;
  v_job runtime_jobs;
  v_start jsonb;
  v_complete jsonb;
  v_resume_job runtime_jobs;
  v_reconciled jsonb;
  v_count bigint;
BEGIN
  INSERT INTO users(display_name) VALUES ('Dispatcher Test') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id, name, slug, workspace_path)
  VALUES (v_user, 'Dispatcher Test', 'dispatcher-test', '/srv/dispatcher-test')
  RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type, adapter_version, runtime_version, provider_type, model)
  VALUES ('opencode', 'test', 'test', 'test', 'test') RETURNING id INTO v_runtime;
  INSERT INTO agents(name, role, runtime_profile_id)
  VALUES ('dispatcher-test-codex', 'architect', v_runtime) RETURNING id INTO v_codex;
  INSERT INTO agents(name, role, runtime_profile_id)
  VALUES ('dispatcher-test-worker', 'implementer', v_runtime) RETURNING id INTO v_worker;
  -- 0081: an agent may do what an enabled assignment of it permits.
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_runtime,'orchestrator',true),(v_project,v_worker,v_runtime,'executor',false);
  INSERT INTO agent_sessions(project_id, agent_id, runtime_profile_id, purpose)
  VALUES (v_project, v_worker, v_runtime, 'implementation') RETURNING id INTO v_session;
  INSERT INTO tasks(project_id, title, objective, status, active_agent_id, created_by)
  VALUES (v_project, 'Dispatcher flow', 'Test routing', 'ready', v_codex, 'test')
  RETURNING id INTO v_task;

  v_request := request_implementation(
    v_project, v_task, v_codex, v_worker, 1, 'Implement', '[]', '[]', '["done"]',
    '["output.txt"]', '/srv/dispatcher-test', 'delegate:' || v_task || ':1', 1, v_task::text
  );
  v_message := claim_outbox_event((v_request->>'event_id')::uuid, 'dispatcher-test', interval '1 minute');
  v_route := route_outbox_message(v_message.id, 'dispatcher-test');
  IF v_route->>'job_type' <> 'implementation_run' THEN
    RAISE EXCEPTION 'request event was not routed to a start job: %', v_route;
  END IF;

  v_job := claim_runtime_job_for_event(
    (v_request->>'event_id')::uuid, 'implementation_run', 'supervisor-test', interval '1 minute'
  );
  v_start := start_implementation_job(v_job.id, v_session, 'supervisor-test', interval '1 minute');
  IF start_implementation_job(v_job.id, v_session, 'supervisor-test', interval '1 minute') <> v_start THEN
    RAISE EXCEPTION 'repeated start did not return its stored receipt';
  END IF;
  PERFORM heartbeat_runtime_job(v_job.id, 'supervisor-test', interval '2 minutes');
  PERFORM heartbeat_workspace_lock(
    v_project, (v_start->>'run_id')::uuid, (v_start->>'fencing_token')::bigint, interval '2 minutes'
  );

  v_complete := complete_implementation(
    v_project, v_task, (v_start->>'run_id')::uuid, v_worker, v_codex,
    (v_start->>'fencing_token')::bigint, '{"files":["output.txt"]}', '{"test":"passed"}',
    'complete:' || (v_start->>'run_id'), (v_start->>'task_version')::bigint, v_task::text
  );
  PERFORM acknowledge_runtime_job(v_job.id, 'supervisor-test', v_complete);

  SELECT * INTO v_message FROM claim_outbox_event(
    (v_start->>'started_event_id')::uuid, 'dispatcher-test', interval '1 minute'
  );
  v_route := route_outbox_message(v_message.id, 'dispatcher-test');
  IF (v_route->>'routed')::boolean THEN
    RAISE EXCEPTION 'implementation.started unexpectedly created a runtime job';
  END IF;
  SELECT * INTO v_message FROM claim_outbox_event(
    (v_complete->>'event_id')::uuid, 'dispatcher-test', interval '1 minute'
  );
  v_route := route_outbox_message(v_message.id, 'dispatcher-test');
  IF v_route->>'job_type' <> 'resume_orchestrator' THEN
    RAISE EXCEPTION 'completion event was not routed to resume_orchestrator';
  END IF;
  v_resume_job := claim_runtime_job_for_event(
    (v_complete->>'event_id')::uuid, 'resume_orchestrator', 'supervisor-test', interval '1 minute'
  );
  PERFORM acknowledge_runtime_job(v_resume_job.id, 'supervisor-test', '{"turn":"resumed"}');

  SELECT count(*) INTO v_count FROM runtime_jobs
  WHERE task_id = v_task AND status = 'completed';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected two completed runtime jobs, found %', v_count;
  END IF;

  -- A second workflow is intentionally abandoned after its lease expires.
  UPDATE tasks SET status = 'ready', active_agent_id = v_codex, version = version + 1 WHERE id = v_task;
  v_request := request_implementation(
    v_project, v_task, v_codex, v_worker, 2, 'Implement revision', '[]', '[]', '["done"]',
    '["output.txt"]', '/srv/dispatcher-test', 'delegate:' || v_task || ':2', 5, v_task::text
  );
  v_message := claim_outbox_event((v_request->>'event_id')::uuid, 'dispatcher-test', interval '1 minute');
  v_route := route_outbox_message(v_message.id, 'dispatcher-test');
  v_job := claim_runtime_job_for_event(
    (v_request->>'event_id')::uuid, 'implementation_run', 'supervisor-test', interval '1 minute'
  );
  v_start := start_implementation_job(v_job.id, v_session, 'supervisor-test', interval '1 minute');
  UPDATE workspace_locks SET lease_expires_at = clock_timestamp() - interval '1 second'
  WHERE project_id = v_project;

  SELECT * INTO v_reconciled FROM reconcile_expired_workspace_locks('reconciler-test', 1);
  IF v_reconciled->>'status' <> 'reconciliation_required' THEN
    RAISE EXCEPTION 'expired lock was not reconciled: %', v_reconciled;
  END IF;
  SELECT count(*) INTO v_count FROM tasks
  WHERE id = v_task AND status = 'needs_attention';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expired workflow was not marked needs_attention';
  END IF;
  SELECT count(*) INTO v_count FROM runtime_jobs
  WHERE id = v_job.id AND status = 'dead_letter';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'ambiguous runtime job was not dead-lettered';
  END IF;

  RAISE NOTICE 'dispatcher and reconciler integration assertions passed';
END;
$$;

ROLLBACK;
