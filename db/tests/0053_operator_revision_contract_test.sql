-- An operator's revision enters the task contract (migration 0087, sprint C C0).
--
-- On rc.58 the operator asked, from the panel, for a second line in a file; the
-- executor added it; the review turn rejected it as not matching "the original
-- requirement". The review is told the task's objective and acceptance criteria,
-- and the operator's request was in neither.
--
-- What holds now:
--   * `request_revision` — the panel's path — records the operator's request on
--     the task, at the version the request gave it, and the event says so;
--   * a repeat of the same request (same idempotency key) records it once;
--   * the next review turn's context carries the list, next to the objective it
--     extends, which stays as it was;
--   * `invoke_request_revision` — the model's path — records nothing: the
--     orchestrator's revision is its reading of the contract, not a change to it;
--   * the shared body refuses a caller that does not say whose request it is;
--   * the shared body is the worker's, not the web tier's.
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
  v_user uuid; v_project uuid; v_codex_profile uuid; v_executor_profile uuid;
  v_codex uuid; v_worker uuid; v_orchestrator uuid; v_executor_assignment uuid;
  v_session uuid; v_task uuid; v_request jsonb; v_message outbox_messages; v_job runtime_jobs;
  v_start jsonb; v_report jsonb; v_final jsonb; v_review runtime_jobs;
  v_before bigint; v_revision jsonb; v_repeat jsonb; v_recorded jsonb; v_context jsonb;
  v_operator_changes jsonb := '["Add a second line to pipeline-check.md: проверено"]'::jsonb;
BEGIN
  INSERT INTO users(display_name) VALUES('Operator revision') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Operator revision','operator-revision','/srv/infra-cod/workspaces/operator-revision') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-revision') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','opencode-revision') RETURNING id INTO v_executor_profile;
  INSERT INTO agents(name,runtime_profile_id) VALUES('revision-codex',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,runtime_profile_id) VALUES('revision-worker',v_executor_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,is_default)
    VALUES(v_project,v_codex,v_codex_profile,(SELECT id FROM role_definitions WHERE builtin_key='orchestrator'),true)
    RETURNING id INTO v_orchestrator;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id)
    VALUES(v_project,v_worker,v_executor_profile,(SELECT id FROM role_definitions WHERE builtin_key='executor'))
    RETURNING id INTO v_executor_assignment;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,native_session_id)
    VALUES(v_project,v_worker,v_executor_profile,'implementation','ses_revision') RETURNING id INTO v_session;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by,acceptance_criteria)
    VALUES(v_project,'Operator revision','Add one line to pipeline-check.md','ready',v_codex,v_orchestrator,'test','["the line is committed"]')
    RETURNING id INTO v_task;
  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority) VALUES(v_task,v_executor_assignment,10);
  IF (SELECT operator_change_requests FROM tasks WHERE id=v_task) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'a new task starts with operator change requests';
  END IF;

  -- Revision 1: delegated, implemented, reported, finalized, awaiting review.
  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Add one line to pipeline-check.md','["Add exactly one line."]','[]',
    '["the line is committed"]','["pipeline-check.md"]','/srv/infra-cod/workspaces/operator-revision','delegate:'||v_task,1,v_task::text);
  UPDATE handoffs SET executor_assignment_id=v_executor_assignment WHERE id=(v_request->>'handoff_id')::uuid;
  v_message:=claim_outbox_event((v_request->>'event_id')::uuid,'revision-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'revision-dispatcher');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','revision-supervisor',interval '5 minutes');
  v_start:=start_implementation_job(v_job.id,v_session,'revision-supervisor',interval '5 minutes');
  v_report:=submit_worker_completion(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,(v_start->>'fencing_token')::bigint,
    'ses_revision','{"summary":"one line added"}'::jsonb,'{"tests":"n/a"}'::jsonb,NULL,'revision-complete-1');
  v_final:=finalize_worker_completion((v_report->>'report_id')::uuid,v_job.id,'revision-supervisor');
  PERFORM acknowledge_runtime_job(v_job.id,'revision-supervisor',v_final);
  -- The orchestrator's review turn runs and summarizes; the operator then reads
  -- it in the panel and asks for more — the order rc.58 happened in.
  v_message:=claim_outbox_event((v_final->>'event_id')::uuid,'revision-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'revision-dispatcher');
  SELECT * INTO v_review FROM claim_orchestrator_jobs('revision-codex-worker',1,interval '2 minutes');
  IF v_review.job_type IS DISTINCT FROM 'resume_orchestrator' THEN RAISE EXCEPTION 'fixture: no first review turn claimed'; END IF;
  IF orchestrator_job_context(v_review.id,'revision-codex-worker')->'task_operator_change_requests' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'a task nobody revised carries operator change requests';
  END IF;
  PERFORM complete_orchestrator_job(v_review.id,'revision-codex-worker','thread-revision','turn-1','The line is there.');

  -- --------------------------- the operator's request, as the panel sends it
  SELECT version INTO v_before FROM tasks WHERE id=v_task;
  v_revision:=request_revision(v_project,v_task,v_codex,v_operator_changes,'["the line is committed"]',
    'web-revision:'||v_task||':'||v_before,v_before,v_task::text);
  IF v_revision->>'status' IS DISTINCT FROM 'revision_requested' OR (v_revision->>'revision_number')::int <> 2 THEN
    RAISE EXCEPTION 'the panel''s revision was not requested: %', v_revision;
  END IF;
  SELECT operator_change_requests INTO v_recorded FROM tasks WHERE id=v_task;
  IF jsonb_array_length(v_recorded) <> 1
     OR v_recorded->0->'changes_required' <> v_operator_changes
     OR (v_recorded->0->>'revision_number')::int <> 2
     OR (v_recorded->0->>'command_id')::uuid <> (v_revision->>'command_id')::uuid
     OR v_recorded->0->>'requested_at' IS NULL THEN
    RAISE EXCEPTION 'the operator''s request was not recorded on the task: %', v_recorded;
  END IF;
  -- Versioned with the task: the request names the version its write gave the
  -- task — after the one the operator saw, not after the delegation that follows.
  IF (v_recorded->0->>'task_version')::bigint <> v_before + 1
     OR (v_recorded->0->>'task_version')::bigint > (SELECT version FROM tasks WHERE id=v_task) THEN
    RAISE EXCEPTION 'the request is not versioned with the task: saw %, recorded %, task is now %',
      v_before, v_recorded->0->>'task_version', (SELECT version FROM tasks WHERE id=v_task);
  END IF;
  -- The objective and the acceptance criteria are what they were: the request
  -- extends the contract and does not rewrite it.
  IF (SELECT objective FROM tasks WHERE id=v_task) <> 'Add one line to pipeline-check.md'
     OR (SELECT acceptance_criteria FROM tasks WHERE id=v_task) <> '["the line is committed"]'::jsonb THEN
    RAISE EXCEPTION 'the operator''s request rewrote the objective or the criteria';
  END IF;
  IF (SELECT payload->>'requested_by' FROM domain_events WHERE id=(v_revision->>'changes_event_id')::uuid) IS DISTINCT FROM 'operator' THEN
    RAISE EXCEPTION 'the changes.requested event does not say the operator asked';
  END IF;
  -- The executor still gets the request the way it always has.
  IF NOT (SELECT instructions FROM handoffs WHERE id=(v_revision#>>'{delegation,handoff_id}')::uuid) @> jsonb_build_array(jsonb_build_object('changes_required',v_operator_changes)) THEN
    RAISE EXCEPTION 'the revision handoff does not carry the operator''s changes';
  END IF;

  -- A repeat (the panel resending the same version) answers from the command
  -- and records nothing twice.
  v_repeat:=request_revision(v_project,v_task,v_codex,v_operator_changes,'["the line is committed"]',
    'web-revision:'||v_task||':'||v_before,v_before,v_task::text);
  IF v_repeat <> v_revision OR jsonb_array_length((SELECT operator_change_requests FROM tasks WHERE id=v_task)) <> 1 THEN
    RAISE EXCEPTION 'a repeated revision request was recorded twice';
  END IF;

  -- ---------------- revision 2: implemented, and the review turn sees the list
  v_message:=claim_outbox_event((v_revision#>>'{delegation,event_id}')::uuid,'revision-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'revision-dispatcher');
  SELECT * INTO v_job FROM claim_executor_jobs('revision-supervisor',1,interval '5 minutes');
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'fixture: the revision''s implementation job was not claimable'; END IF;
  v_start:=start_implementation_job(v_job.id,v_session,'revision-supervisor',interval '5 minutes');
  v_report:=submit_worker_completion(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,(v_start->>'fencing_token')::bigint,
    'ses_revision','{"summary":"second line added"}'::jsonb,'{"tests":"n/a"}'::jsonb,NULL,'revision-complete-2');
  v_final:=finalize_worker_completion((v_report->>'report_id')::uuid,v_job.id,'revision-supervisor');
  PERFORM acknowledge_runtime_job(v_job.id,'revision-supervisor',v_final);
  v_message:=claim_outbox_event((v_final->>'event_id')::uuid,'revision-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'revision-dispatcher');
  SELECT * INTO v_review FROM claim_orchestrator_jobs('revision-codex-worker',1,interval '2 minutes');
  IF v_review.job_type IS DISTINCT FROM 'resume_orchestrator' THEN RAISE EXCEPTION 'fixture: no second review turn claimed'; END IF;
  v_context:=orchestrator_job_context(v_review.id,'revision-codex-worker');
  IF v_context->'task_operator_change_requests' IS DISTINCT FROM v_recorded THEN
    RAISE EXCEPTION 'the review turn is not given the operator''s requests: %', v_context->'task_operator_change_requests';
  END IF;
  IF v_context->>'task_objective' <> 'Add one line to pipeline-check.md'
     OR v_context->'task_acceptance_criteria' <> '["the line is committed"]'::jsonb THEN
    RAISE EXCEPTION 'the review turn''s objective or criteria changed';
  END IF;

  -- --------------------------- the model's request, through its tool
  v_revision:=invoke_request_revision(v_review.id,'revision-codex-worker','call-revision-1','["also update the README"]');
  IF (v_revision->>'revision_number')::int <> 3 THEN
    RAISE EXCEPTION 'the model''s revision was not requested: %', v_revision;
  END IF;
  IF (SELECT operator_change_requests FROM tasks WHERE id=v_task) <> v_recorded THEN
    RAISE EXCEPTION 'the model''s revision rewrote the contract: %', (SELECT operator_change_requests FROM tasks WHERE id=v_task);
  END IF;
  IF (SELECT payload->>'requested_by' FROM domain_events WHERE id=(v_revision->>'changes_event_id')::uuid) IS DISTINCT FROM 'agent' THEN
    RAISE EXCEPTION 'the changes.requested event does not say the agent asked';
  END IF;

  -- ------------------------------------------- the shared body's boundaries
  IF pg_temp.reason_of(format($q$ SELECT request_revision_from(%L,%L,%L,'["x"]','["the line is committed"]','probe:'||%L,
      (SELECT version FROM tasks WHERE id=%L),%L,'panel') $q$, v_project,v_task,v_codex,v_task,v_task,v_task)) IS DISTINCT FROM 'revision_arguments_invalid' THEN
    RAISE EXCEPTION 'a request of unknown origin was accepted';
  END IF;
  IF has_function_privilege('infra_web','control_plane.request_revision_from(uuid,uuid,uuid,jsonb,jsonb,text,bigint,text,text)','EXECUTE')
     OR has_function_privilege('public','control_plane.request_revision_from(uuid,uuid,uuid,jsonb,jsonb,text,bigint,text,text)','EXECUTE')
     OR NOT has_function_privilege('infra_worker','control_plane.request_revision_from(uuid,uuid,uuid,jsonb,jsonb,text,bigint,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'request_revision_from is not the worker''s alone';
  END IF;
  IF NOT has_function_privilege('infra_web','control_plane.request_revision(uuid,uuid,uuid,jsonb,jsonb,text,bigint,text)','EXECUTE') THEN
    RAISE EXCEPTION 'the panel lost request_revision';
  END IF;

  RAISE NOTICE 'the operator''s revision is recorded on the task at its version, once, shown to the review turn beside the unchanged objective; the model''s is not';
END $$;

ROLLBACK;
