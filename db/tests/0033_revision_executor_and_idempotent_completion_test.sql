\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public;

-- 0058: the two things the first end-to-end task on the host broke on.
--
-- 1. A revision must name the same executor the previous one did.
--
-- `request_revision` inherits six fields from the previous handoff and used to
-- leave the seventh — `executor_assignment_id` — null. The orchestrator's own
-- path filled it in afterwards from outside, so the gap was invisible until the
-- operator pressed "Request changes" in the panel, which calls `request_revision`
-- directly. The handoff then named no executor, no snapshot entry matched it,
-- and the launch was refused as a snapshot mismatch until the job dead-lettered.
--
-- On the host: revisions 1-3, requested by Codex, ran; revision 4, requested by
-- the operator, dead-lettered after three attempts.
--
-- 2. A worker must be able to learn that its completion was already accepted.
--
-- The liveness check ran before the idempotency branch. Accepting a completion
-- moves the run to `completed`, so the repeat failed liveness and never reached
-- the branch written for exactly this case — and the message it got back,
-- "active worker run validation failed", does not say "already accepted", so the
-- model tried again. Five times on the host, about two and a half minutes of
-- turns, after the work was in the table.

DO $$
DECLARE
  v_user uuid; v_project uuid; v_runtime uuid; v_codex uuid; v_worker uuid;
  v_session uuid; v_task uuid; v_request jsonb; v_message outbox_messages;
  v_job runtime_jobs; v_start jsonb; v_report jsonb; v_complete jsonb;
  v_revision jsonb; v_assignment uuid; v_inherited uuid; v_repeat jsonb;
  v_state text;
BEGIN
  INSERT INTO users(display_name) VALUES ('Revision Executor Test') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Revision Executor','revision-executor-test','/srv/revision-test') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','test','test') RETURNING id INTO v_runtime;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('revision-codex','architect',v_runtime) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('revision-worker','implementer',v_runtime) RETURNING id INTO v_worker;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose)
    VALUES(v_project,v_worker,v_runtime,'implementation') RETURNING id INTO v_session;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,created_by)
    VALUES(v_project,'Revision inheritance','Verify the revision carries its executor','ready',v_codex,'test')
    RETURNING id INTO v_task;

  -- The assignment the first handoff names, and that every revision of this task
  -- has to keep naming.
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,enabled)
    VALUES(v_project,v_worker,v_runtime,'executor',true) RETURNING id INTO v_assignment;
  -- 0081: the reviewer reviews because an assignment of it holds review.perform.
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_runtime,'orchestrator',true);

  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]',
    '["output.txt"]','/srv/revision-test','delegate:'||v_task||':1',1,v_task::text);
  UPDATE handoffs SET executor_assignment_id=v_assignment WHERE id=(v_request->>'handoff_id')::uuid;

  v_message:=claim_outbox_event((v_request->>'event_id')::uuid,'dispatcher-test',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'dispatcher-test');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','supervisor-test',interval '1 minute');
  v_start:=start_implementation_job(v_job.id,v_session,'supervisor-test',interval '1 minute');
  v_report:=submit_worker_completion(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,
    (v_start->>'fencing_token')::bigint,'ses_revision','{"changed_files":["output.txt"]}',
    '{"unit":"passed"}',NULL,'complete:'||(v_start->>'run_id'));

  -- The repeat, before anything finalises it: the same key and the same payload
  -- answer from the stored report rather than inserting a second one.
  v_repeat:=submit_worker_completion(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,
    (v_start->>'fencing_token')::bigint,'ses_revision','{"changed_files":["output.txt"]}',
    '{"unit":"passed"}',NULL,'complete:'||(v_start->>'run_id'));
  IF v_repeat->>'report_id'<>v_report->>'report_id' THEN
    RAISE EXCEPTION 'a repeated completion created a second report'; END IF;

  -- The same key with a different payload is still a conflict, not a repeat.
  BEGIN
    PERFORM submit_worker_completion(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,
      (v_start->>'fencing_token')::bigint,'ses_revision','{"changed_files":["other.txt"]}',
      '{"unit":"passed"}',NULL,'complete:'||(v_start->>'run_id'));
    RAISE EXCEPTION 'a reused key with a different payload was accepted';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL;
  END;

  v_complete:=finalize_worker_completion((v_report->>'report_id')::uuid,v_job.id,'supervisor-test');
  PERFORM acknowledge_runtime_job(v_job.id,'supervisor-test',v_complete);

  -- The run is no longer running and the task is awaiting review. This is the
  -- state that used to make the repeat impossible, and it is the state every
  -- repeat actually arrives in.
  SELECT status INTO v_state FROM task_runs WHERE id=(v_start->>'run_id')::uuid;
  IF v_state='running' THEN RAISE EXCEPTION 'the run was still running; the test proves nothing'; END IF;

  v_repeat:=submit_worker_completion(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,
    (v_start->>'fencing_token')::bigint,'ses_revision','{"changed_files":["output.txt"]}',
    '{"unit":"passed"}',NULL,'complete:'||(v_start->>'run_id'));
  IF v_repeat->>'report_id'<>v_report->>'report_id' OR (v_repeat->>'repeat')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'an accepted completion could not be repeated after the run closed: %',v_repeat;
  END IF;

  -- The revision, requested the way the panel requests it: `request_revision`
  -- directly, with nothing filling the executor in afterwards.
  v_revision:=request_revision(v_project,v_task,v_codex,'["carry the executor"]','["done"]',
    'revision:'||v_task||':2',(v_complete->>'task_version')::bigint,v_task::text);

  SELECT executor_assignment_id INTO v_inherited FROM handoffs
  WHERE id=(v_revision#>>'{delegation,handoff_id}')::uuid;
  IF v_inherited IS DISTINCT FROM v_assignment THEN
    RAISE EXCEPTION 'the revision handoff names % rather than the previous executor %',
      COALESCE(v_inherited::text,'nobody'), v_assignment;
  END IF;

  RAISE NOTICE 'revision executor inheritance and idempotent completion assertions passed';
END;
$$;

ROLLBACK;
