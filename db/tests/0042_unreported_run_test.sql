-- An implementation that ends without its terminal report asks the operator
-- (migration 0066, panel finding P-3): the run fails as terminal_report_missing,
-- the lock is released at once, the task needs attention, and an answer typed
-- into the chat resumes the implementation.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE
  v_user uuid; v_project uuid; v_runtime uuid; v_codex uuid; v_worker uuid; v_assignment uuid;
  v_session uuid; v_task uuid; v_request jsonb; v_message outbox_messages;
  v_job runtime_jobs; v_start jsonb; v_result jsonb; v_answer jsonb; v_run task_runs;
BEGIN
  INSERT INTO users(display_name) VALUES('Unreported') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Unreported','unreported','/srv/unreported') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','test','test') RETURNING id INTO v_runtime;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('unreported-codex','architect',v_runtime) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('unreported-worker','implementer',v_runtime) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_runtime,'executor') RETURNING id INTO v_assignment;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,native_session_id)
    VALUES(v_project,v_worker,v_runtime,'implementation','ses_unreported') RETURNING id INTO v_session;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,created_by,acceptance_criteria)
    VALUES(v_project,'Unreported','test','ready',v_codex,'test','["done"]') RETURNING id INTO v_task;
  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]','[]',
    '/srv/unreported','delegate:'||v_task,1,v_task::text);
  UPDATE handoffs SET executor_assignment_id=v_assignment WHERE id=(v_request->>'handoff_id')::uuid;
  v_message:=claim_outbox_event((v_request->>'event_id')::uuid,'unreported-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'unreported-dispatcher');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','unreported-worker',interval '1 minute');
  v_start:=start_implementation_job(v_job.id,v_session,'unreported-worker',interval '1 minute');
  IF (SELECT status FROM workspace_locks WHERE project_id=v_project) <> 'held' THEN
    RAISE EXCEPTION 'fixture: the implementation does not hold the lock';
  END IF;

  -- Only the leasing worker may say so.
  BEGIN
    PERFORM finalize_unreported_run(v_job.id,'somebody-else','ses_unreported','x');
    RAISE EXCEPTION 'another worker finalized the run';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  v_result:=finalize_unreported_run(v_job.id,'unreported-worker','ses_unreported','two finalization turns produced no report');
  SELECT * INTO v_run FROM task_runs WHERE id=(v_start->>'run_id')::uuid;
  IF v_run.status<>'failed' OR v_run.failure_code<>'terminal_report_missing' THEN
    RAISE EXCEPTION 'the run is % / %, not failed as terminal_report_missing', v_run.status, v_run.failure_code;
  END IF;
  IF (SELECT status FROM workspace_locks WHERE project_id=v_project) <> 'released' THEN
    RAISE EXCEPTION 'the lock was not released at once: %', (SELECT status FROM workspace_locks WHERE project_id=v_project);
  END IF;
  IF (SELECT status FROM runtime_jobs WHERE id=v_job.id) <> 'completed' THEN
    RAISE EXCEPTION 'the job is %, not closed', (SELECT status FROM runtime_jobs WHERE id=v_job.id);
  END IF;
  IF (SELECT status FROM tasks WHERE id=v_task) <> 'needs_attention' THEN
    RAISE EXCEPTION 'the task does not need attention';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM domain_events WHERE task_id=v_task AND event_type='run.unreported') THEN
    RAISE EXCEPTION 'no run.unreported event';
  END IF;

  -- The operator's answer, typed into the chat, resumes the implementation.
  v_answer:=record_task_chat_message(v_project,v_task,'Report what you did and finish.','operator','unreported');
  IF v_answer->>'status' <> 'answered_input_request' THEN
    RAISE EXCEPTION 'the chat answer was not routed to the open question: %', v_answer;
  END IF;
  IF (SELECT count(*) FROM handoffs WHERE task_id=v_task) <> 2
     OR NOT (SELECT instructions::text LIKE '%Report what you did and finish.%' FROM handoffs WHERE task_id=v_task ORDER BY revision_number DESC LIMIT 1) THEN
    RAISE EXCEPTION 'the implementation was not resumed with the answer';
  END IF;
  RAISE NOTICE 'an unreported implementation releases the lock, asks the operator, and resumes on the answer';
END $$;

ROLLBACK;
