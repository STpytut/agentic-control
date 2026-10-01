\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public;
DO $$
DECLARE
  v_user uuid;v_project uuid;v_runtime uuid;v_codex uuid;v_worker uuid;v_session uuid;
  v_task uuid;v_review_task uuid;v_request jsonb;v_msg outbox_messages;v_job runtime_jobs;
  v_start jsonb;v_report jsonb;v_result jsonb;v_count bigint;v_run uuid;
BEGIN
  INSERT INTO users(display_name) VALUES('Operator Actions Test') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Operator Actions Test','operator-actions-test','/srv/operator-actions-test') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','test','test') RETURNING id INTO v_runtime;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('operator-actions-codex','architect',v_runtime) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('operator-actions-worker','implementer',v_runtime) RETURNING id INTO v_worker;
  -- 0081: an agent may do what an enabled assignment of it permits.
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_runtime,'orchestrator',true),(v_project,v_worker,v_runtime,'executor',false);
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,native_session_id)
    VALUES(v_project,v_worker,v_runtime,'implementation','ses_operator_actions') RETURNING id INTO v_session;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,created_by,acceptance_criteria)
    VALUES(v_project,'Input flow','test','ready',v_codex,'test','["done"]') RETURNING id INTO v_task;

  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]','[]',
    '/srv/operator-actions-test','delegate:'||v_task,1,v_task::text);
  v_msg:=claim_outbox_event((v_request->>'event_id')::uuid,'dispatcher-operator-test',interval '1 minute');
  PERFORM route_outbox_message(v_msg.id,'dispatcher-operator-test');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','supervisor-operator-test',interval '1 minute');
  v_start:=start_implementation_job(v_job.id,v_session,'supervisor-operator-test',interval '1 minute');
  v_report:=submit_worker_interaction(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,
    (v_start->>'fencing_token')::bigint,'ses_operator_actions','input_request',
    '{"question":"Which region?"}','input:'||(v_start->>'run_id'));
  PERFORM finalize_worker_interaction((v_report->>'report_id')::uuid,v_job.id,'supervisor-operator-test');
  v_result:=resolve_worker_interaction((v_report->>'report_id')::uuid,'operator',
    '{"response":"Use eu-central-1"}',v_task::text);
  IF v_result->>'status'<>'resume_requested' THEN RAISE EXCEPTION 'interaction was not resumed'; END IF;
  SELECT count(*) INTO v_count FROM handoffs WHERE task_id=v_task;
  IF v_count<>2 THEN RAISE EXCEPTION 'resume handoff was not created'; END IF;
  IF (SELECT status FROM tasks WHERE id=v_task)<>'implementation_requested' THEN
    RAISE EXCEPTION 'task was not returned to the dispatcher'; END IF;

  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,created_by)
    VALUES(v_project,'Review flow','test','awaiting_review',v_codex,'test') RETURNING id INTO v_review_task;
  -- 0069: an approval is of something — the evidence of the task's latest
  -- implementation — and is refused without it (0045 pins that). The run and
  -- its evidence are written directly here; this test is about the operator's
  -- action, not about how evidence is taken.
  INSERT INTO task_runs(task_id,session_id,agent_id,phase,status,write_capable,workspace_fencing_token,finished_at)
    VALUES(v_review_task,v_session,v_worker,'implementation','completed',true,1,clock_timestamp()) RETURNING id INTO v_run;
  INSERT INTO review_evidence(project_id,task_id,run_id,fencing_token,base_commit_sha,head_commit_sha,
    worktree_digest,patch_digest,evidence_digest,algorithm,object_format,worktree_committed,changed_files,
    diffstat,diff,truncation,executor_reported_checks,platform_verified_checks,recorded_by)
  VALUES(v_project,v_review_task,v_run,1,repeat('a',40),repeat('b',40),'sha256:'||repeat('c',64),
    'sha256:'||repeat('d',64),review_evidence_digest(v_run,1,repeat('a',40),repeat('b',40),
      'sha256:'||repeat('c',64),'sha256:'||repeat('d',64)),
    '{"worktree":"infra-cod-worktree-v1","patch":"infra-cod-patch-v1"}','sha1',true,'[]','{}','','{}','{}','[]',
    'operator-actions-fixture');
  v_result:=approve_task_review(v_project,v_review_task,'operator','Reviewed and accepted',
    'approve:'||v_review_task,1,v_review_task::text);
  IF v_result->>'status'<>'approved' OR (SELECT status FROM tasks WHERE id=v_review_task)<>'approved' THEN
    RAISE EXCEPTION 'task review was not approved'; END IF;
  SELECT count(*) INTO v_count FROM audit_events
    WHERE project_id=v_project AND action IN ('worker_interaction.resolved','task.review_approved');
  IF v_count<>2 THEN RAISE EXCEPTION 'operator audit events are incomplete'; END IF;
  RAISE NOTICE 'operator workflow action assertions passed';
END $$;
ROLLBACK;
