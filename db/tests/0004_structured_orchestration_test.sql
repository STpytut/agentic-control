\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public;

DO $$
DECLARE
  v_user uuid; v_project uuid; v_runtime uuid; v_codex uuid; v_worker uuid;
  v_session uuid; v_task uuid; v_request jsonb; v_message outbox_messages;
  v_job runtime_jobs; v_start jsonb; v_report jsonb; v_complete jsonb;
  v_revision jsonb; v_revision_request jsonb; v_event_type text; v_count bigint;
BEGIN
  INSERT INTO users(display_name) VALUES ('Structured Orchestration Test') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Structured Orchestration','structured-orchestration-test','/srv/structured-test') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','test','test') RETURNING id INTO v_runtime;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('structured-codex','architect',v_runtime) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('structured-worker','implementer',v_runtime) RETURNING id INTO v_worker;
  -- 0081: an agent may do what an enabled assignment of it permits.
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_runtime,'orchestrator',true),(v_project,v_worker,v_runtime,'executor',false);
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose)
    VALUES(v_project,v_worker,v_runtime,'implementation') RETURNING id INTO v_session;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,created_by)
    VALUES(v_project,'Two-cycle task','Verify structured tools','ready',v_codex,'test') RETURNING id INTO v_task;

  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]',
    '["output.txt"]','/srv/structured-test','delegate:'||v_task||':1',1,v_task::text);
  v_message:=claim_outbox_event((v_request->>'event_id')::uuid,'dispatcher-test',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'dispatcher-test');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','supervisor-test',interval '1 minute');
  v_start:=start_implementation_job(v_job.id,v_session,'supervisor-test',interval '1 minute');
  v_report:=submit_worker_completion(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,
    (v_start->>'fencing_token')::bigint,'ses_structured','{"changed_files":["output.txt"]}',
    '{"unit":"passed"}',NULL,'complete:'||(v_start->>'run_id'));
  v_complete:=finalize_worker_completion((v_report->>'report_id')::uuid,v_job.id,'supervisor-test');
  PERFORM acknowledge_runtime_job(v_job.id,'supervisor-test',v_complete);
  IF v_complete->>'event_type'<>'implementation.completed' THEN RAISE EXCEPTION 'first completion type mismatch'; END IF;
  SELECT count(*) INTO v_count FROM worker_completion_reports
    WHERE id=(v_report->>'report_id')::uuid AND status='accepted';
  IF v_count<>1 THEN RAISE EXCEPTION 'completion report was not accepted'; END IF;

  v_revision:=request_revision(v_project,v_task,v_codex,'["add revision proof"]','["done"]',
    'revision:'||v_task||':2',(v_complete->>'task_version')::bigint,v_task::text);
  IF v_revision->>'status'<>'revision_requested' OR (v_revision->>'revision_number')::integer<>2 THEN
    RAISE EXCEPTION 'revision receipt mismatch: %',v_revision; END IF;
  v_revision_request:=v_revision->'delegation';
  v_message:=claim_outbox_event((v_revision_request->>'event_id')::uuid,'dispatcher-test',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'dispatcher-test');
  v_job:=claim_runtime_job_for_event((v_revision_request->>'event_id')::uuid,'implementation_run','supervisor-test',interval '1 minute');
  v_start:=start_implementation_job(v_job.id,v_session,'supervisor-test',interval '1 minute');
  IF v_start->>'started_event_type'<>'revision.started' OR v_start->>'revision_number'<>'2' THEN
    RAISE EXCEPTION 'revision start semantics mismatch: %',v_start; END IF;
  v_report:=submit_worker_completion(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,
    (v_start->>'fencing_token')::bigint,'ses_structured','{"changed_files":["output.txt"]}',
    '{"revision":"passed"}',NULL,'complete:'||(v_start->>'run_id'));
  v_complete:=finalize_worker_completion((v_report->>'report_id')::uuid,v_job.id,'supervisor-test');
  IF v_complete->>'event_type'<>'revision.completed' THEN RAISE EXCEPTION 'revision completion type mismatch: %',v_complete; END IF;
  SELECT event_type INTO v_event_type FROM domain_events WHERE id=(v_complete->>'event_id')::uuid;
  IF v_event_type<>'revision.completed' THEN RAISE EXCEPTION 'revision event was not persisted'; END IF;
  SELECT count(DISTINCT native_session_id) INTO v_count FROM worker_completion_reports WHERE task_id=v_task;
  IF v_count<>1 THEN RAISE EXCEPTION 'worker native session was not preserved'; END IF;

  BEGIN
    PERFORM request_revision(v_project,v_task,v_codex,'["invalid"]','["changed"]',
      'revision-invalid:'||v_task,(v_complete->>'task_version')::bigint,v_task::text);
    RAISE EXCEPTION 'changed acceptance criteria were accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  RAISE NOTICE 'structured completion and revision assertions passed';
END;
$$;

ROLLBACK;
