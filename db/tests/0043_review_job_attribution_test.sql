-- Who a waiting review turn belongs to (panel finding: a queued `resume_codex`
-- was shown as "OpenCode" with the executor's model).
--
-- route_outbox_message copies the source event's run_id into the job it creates,
-- and a review job is routed from implementation.completed — whose run is the
-- executor's implementation. So between routing and the claim that gives the job
-- its own review turn (0059), the job points at a run belonging to another agent
-- entirely. The panel read that run for the card's name and model.
--
-- Pinned here: that trap is real (a pending review job carries a write-capable
-- implementation run), and the rule the panel now uses to step around it holds —
-- an orchestrator job's run is its own only when it is not write-capable, and a
-- claim replaces it with a turn that never is.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE
  v_user uuid; v_project uuid; v_codex_profile uuid; v_executor_profile uuid;
  v_codex uuid; v_worker uuid; v_orchestrator_assignment uuid; v_executor_assignment uuid;
  v_session uuid; v_task uuid; v_request jsonb; v_message outbox_messages; v_job runtime_jobs;
  v_start jsonb; v_complete jsonb; v_route jsonb; v_review runtime_jobs; v_claimed runtime_jobs;
  v_run task_runs; v_name text; v_runtime text;
BEGIN
  INSERT INTO users(display_name) VALUES('Review attribution') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Review attribution','review-attribution','/srv/review-attribution') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-review-model') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','opencode-review-model') RETURNING id INTO v_executor_profile;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('orchestrator-codex-review','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('executor-opencode-review','implementer',v_executor_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING id INTO v_orchestrator_assignment;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_executor_profile,'executor') RETURNING id INTO v_executor_assignment;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,native_session_id)
    VALUES(v_project,v_worker,v_executor_profile,'implementation','ses_review_attribution') RETURNING id INTO v_session;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by,acceptance_criteria)
    VALUES(v_project,'Review attribution','test','ready',v_codex,v_orchestrator_assignment,'test','["done"]')
    RETURNING id INTO v_task;

  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]','[]',
    '/srv/review-attribution','delegate:'||v_task,1,v_task::text);
  UPDATE handoffs SET executor_assignment_id=v_executor_assignment WHERE id=(v_request->>'handoff_id')::uuid;
  v_message:=claim_outbox_event((v_request->>'event_id')::uuid,'attribution-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'attribution-dispatcher');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','attribution-worker',interval '1 minute');
  v_start:=start_implementation_job(v_job.id,v_session,'attribution-worker',interval '1 minute');
  v_complete:=complete_implementation(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,v_codex,
    (v_start->>'fencing_token')::bigint,'{"summary":"implemented"}','{"tests":"passed"}',
    'attribution-complete',(SELECT version FROM tasks WHERE id=v_task),v_task::text);
  PERFORM acknowledge_runtime_job(v_job.id,'attribution-worker',v_complete);

  v_message:=claim_outbox_event((v_complete->>'event_id')::uuid,'attribution-dispatcher',interval '1 minute');
  v_route:=route_outbox_message(v_message.id,'attribution-dispatcher');
  IF v_route->>'job_type'<>'resume_orchestrator' THEN
    RAISE EXCEPTION 'fixture: the completion routed to %, not a review job',v_route->>'job_type';
  END IF;
  SELECT * INTO v_review FROM runtime_jobs WHERE id=(v_route->>'job_id')::bigint;

  -- The trap, stated as a fact rather than trusted: while the review job waits,
  -- its run_id is the implementation it reviews, owned by the executor.
  IF v_review.status<>'pending' THEN RAISE EXCEPTION 'fixture: the review job is %',v_review.status; END IF;
  SELECT * INTO v_run FROM task_runs WHERE id=v_review.run_id;
  IF v_run.id IS NULL OR NOT v_run.write_capable OR v_run.agent_id<>v_worker THEN
    RAISE EXCEPTION 'a waiting review job no longer carries the executor''s implementation run: %',v_run;
  END IF;

  -- Reading that run for the card is how the executor's name and model reached a
  -- Codex review. The guard is `NOT write_capable`, and with it the waiting turn
  -- is attributed to the orchestrator it will run as.
  SELECT COALESCE(ra.name,oa.name),COALESCE(rrp.runtime_type,orp.runtime_type) INTO v_name,v_runtime
  FROM runtime_jobs j
  JOIN tasks t ON t.id=j.task_id
  JOIN project_agent_assignments opa ON opa.id=t.orchestrator_assignment_id
  JOIN agents oa ON oa.id=opa.agent_id
  JOIN runtime_profiles orp ON orp.id=opa.runtime_profile_id
  LEFT JOIN task_runs tr ON tr.id=j.run_id
    AND NOT (j.job_type IN ('orchestrator_turn','resume_orchestrator','orchestrator_turn','resume_orchestrator') AND tr.write_capable)
  LEFT JOIN agents ra ON ra.id=tr.agent_id
  LEFT JOIN agent_sessions rs ON rs.id=tr.session_id
  LEFT JOIN runtime_profiles rrp ON rrp.id=rs.runtime_profile_id
  WHERE j.id=v_review.id;
  IF v_name<>'orchestrator-codex-review' OR v_runtime<>'codex' THEN
    RAISE EXCEPTION 'a waiting review turn is attributed to % on %, not to the orchestrator',v_name,v_runtime;
  END IF;

  -- And once claimed the job owns a turn of its own, which is never write-capable,
  -- so the guard costs the claimed job nothing.
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('attribution-codex-worker',1,interval '2 minutes');
  IF v_claimed.id<>v_review.id THEN RAISE EXCEPTION 'fixture: claimed job % instead of the review job',v_claimed.id; END IF;
  SELECT * INTO v_run FROM task_runs WHERE id=v_claimed.run_id;
  IF v_run.phase<>'review_turn' OR v_run.write_capable OR v_run.agent_id<>v_codex THEN
    RAISE EXCEPTION 'the claimed review job does not own a Codex review turn: %',v_run;
  END IF;

  RAISE NOTICE 'a waiting review job carries the implementation''s run, and the panel''s guard attributes the turn to its orchestrator';
END $$;

ROLLBACK;
