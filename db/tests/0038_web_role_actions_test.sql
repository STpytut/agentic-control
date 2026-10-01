-- The panel's writes, performed as the panel's role (migration 0062).
--
-- "Request changes" and answering an implementation's question both run as
-- infra_web, which has no DML. Both functions had lost SECURITY DEFINER to a
-- CREATE OR REPLACE — 0058 and 0061 — and every test called them as the
-- superuser, so nothing noticed. This file calls them the way the panel does.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

CREATE TEMP TABLE web_fixture(key text PRIMARY KEY, value text NOT NULL);
GRANT SELECT ON web_fixture TO infra_web;

-- Two tasks in the states the two buttons act on: one waiting on an answer, one
-- awaiting review. Built as the owner, through the real functions.
DO $$
DECLARE
  v_user uuid; v_project uuid; v_runtime uuid; v_codex uuid; v_worker uuid; v_assignment uuid;
  v_session uuid; v_task uuid; v_review_task uuid; v_request jsonb; v_message outbox_messages;
  v_job runtime_jobs; v_start jsonb; v_report jsonb; v_complete jsonb;
BEGIN
  INSERT INTO users(display_name) VALUES('Web Role Actions') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Web Role Actions','web-role-actions','/srv/web-role-actions') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','test','test') RETURNING id INTO v_runtime;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('web-role-codex','architect',v_runtime) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('web-role-worker','implementer',v_runtime) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_runtime,'executor') RETURNING id INTO v_assignment;
  -- 0081: the reviewer reviews because an assignment of it holds review.perform.
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_runtime,'orchestrator',true);
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,native_session_id)
    VALUES(v_project,v_worker,v_runtime,'implementation','ses_web_role') RETURNING id INTO v_session;

  -- A question from a running implementation.
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,created_by,acceptance_criteria)
    VALUES(v_project,'Question','test','ready',v_codex,'test','["done"]') RETURNING id INTO v_task;
  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]','[]',
    '/srv/web-role-actions','delegate:'||v_task,1,v_task::text);
  UPDATE handoffs SET executor_assignment_id=v_assignment WHERE id=(v_request->>'handoff_id')::uuid;
  v_message:=claim_outbox_event((v_request->>'event_id')::uuid,'web-role-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'web-role-dispatcher');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','web-role-supervisor',interval '1 minute');
  v_start:=start_implementation_job(v_job.id,v_session,'web-role-supervisor',interval '1 minute');
  v_report:=submit_worker_interaction(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,
    (v_start->>'fencing_token')::bigint,'ses_web_role','input_request','{"question":"Which region?"}',
    'input:'||(v_start->>'run_id'));
  PERFORM finalize_worker_interaction((v_report->>'report_id')::uuid,v_job.id,'web-role-supervisor');
  INSERT INTO web_fixture VALUES ('report_id',v_report->>'report_id'), ('question_task',v_task::text);

  -- A completed implementation awaiting review.
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,created_by,acceptance_criteria)
    VALUES(v_project,'Review','test','ready',v_codex,'test','["done"]') RETURNING id INTO v_review_task;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,native_session_id)
    VALUES(v_project,v_worker,v_runtime,'implementation-2','ses_web_role_review') RETURNING id INTO v_session;
  v_request:=request_implementation(v_project,v_review_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]',
    '["output.txt"]','/srv/web-role-actions','delegate:'||v_review_task,1,v_review_task::text);
  UPDATE handoffs SET executor_assignment_id=v_assignment WHERE id=(v_request->>'handoff_id')::uuid;
  v_message:=claim_outbox_event((v_request->>'event_id')::uuid,'web-role-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'web-role-dispatcher');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','web-role-supervisor',interval '1 minute');
  v_start:=start_implementation_job(v_job.id,v_session,'web-role-supervisor',interval '1 minute');
  v_report:=submit_worker_completion(v_project,v_review_task,(v_start->>'run_id')::uuid,v_worker,
    (v_start->>'fencing_token')::bigint,'ses_web_role_review','{"changed_files":["output.txt"]}',
    '{"unit":"passed"}',NULL,'complete:'||(v_start->>'run_id'));
  v_complete:=finalize_worker_completion((v_report->>'report_id')::uuid,v_job.id,'web-role-supervisor');
  PERFORM acknowledge_runtime_job(v_job.id,'web-role-supervisor',v_complete);
  INSERT INTO web_fixture VALUES ('project',v_project::text), ('review_task',v_review_task::text),
    ('reviewer',v_codex::text), ('review_version',v_complete->>'task_version');
END $$;

SELECT value AS report_id FROM web_fixture WHERE key='report_id' \gset
SELECT value AS project FROM web_fixture WHERE key='project' \gset
SELECT value AS review_task FROM web_fixture WHERE key='review_task' \gset
SELECT value AS reviewer FROM web_fixture WHERE key='reviewer' \gset
SELECT value AS review_version FROM web_fixture WHERE key='review_version' \gset

-- The panel's two calls, as the panel. Before 0062 the first write inside either
-- failed with "permission denied"; ON_ERROR_STOP turns that into this file failing.
SET ROLE infra_web;
SELECT resolve_worker_interaction(:'report_id'::uuid,'operator','{"response":"Use eu-central-1"}'::jsonb,'web-role-actions') IS NOT NULL AS answered;
SELECT request_revision(:'project'::uuid,:'review_task'::uuid,:'reviewer'::uuid,'["as the panel asks"]'::jsonb,
  '["done"]'::jsonb,'web-role-revision',:'review_version'::bigint,'web-role-actions') IS NOT NULL AS revision_requested;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT resolved_at FROM worker_interaction_reports
      WHERE id=(SELECT value FROM web_fixture WHERE key='report_id')::uuid) IS NULL THEN
    RAISE EXCEPTION 'the web role answered, but the question is still open';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM handoffs WHERE task_id=(SELECT value FROM web_fixture WHERE key='review_task')::uuid
                 AND revision_number=2) THEN
    RAISE EXCEPTION 'the web role requested changes, but no revision was created';
  END IF;
  PERFORM assert_web_functions_run_as_definer();
  RAISE NOTICE 'the panel can answer a question and request changes as its own role, and every web function runs as its owner';
END $$;

ROLLBACK;
