\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public;
DO $$
DECLARE v_user uuid;v_project uuid;v_runtime uuid;v_codex uuid;v_worker uuid;v_session uuid;v_task uuid;
 v_request jsonb;v_msg outbox_messages;v_job runtime_jobs;v_incident runtime_jobs;v_start jsonb;v_report jsonb;v_result jsonb;v_approval jsonb;v_count bigint;
 v_fingerprint text;
BEGIN
 INSERT INTO users(display_name) VALUES('Security Test') RETURNING id INTO v_user;
 INSERT INTO projects(owner_id,name,slug,workspace_path) VALUES(v_user,'Security Test','security-test','/srv/security-test') RETURNING id INTO v_project;
 INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model) VALUES('opencode','test','test','test','test') RETURNING id INTO v_runtime;
 INSERT INTO agents(name,role,runtime_profile_id) VALUES('security-codex','architect',v_runtime) RETURNING id INTO v_codex;
 INSERT INTO agents(name,role,runtime_profile_id) VALUES('security-worker','implementer',v_runtime) RETURNING id INTO v_worker;
 -- 0081: an agent may do what an enabled assignment of it permits.
 INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
   VALUES(v_project,v_codex,v_runtime,'orchestrator',true),(v_project,v_worker,v_runtime,'executor',false);
 INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,native_session_id) VALUES(v_project,v_worker,v_runtime,'implementation','ses_security') RETURNING id INTO v_session;
 INSERT INTO tasks(project_id,title,objective,status,active_agent_id,created_by) VALUES(v_project,'Security flow','test','ready',v_codex,'test') RETURNING id INTO v_task;

 v_fingerprint:=compute_action_fingerprint('publish','{"sha":"abc"}');
 v_approval:=request_approval(v_project,v_task,'publish',v_fingerprint,'{"sha":"abc"}','codex',interval '10 minutes',v_task::text);
 PERFORM decide_approval((v_approval->>'approval_id')::uuid,'user','approved','verified',v_task::text);
 BEGIN
  PERFORM consume_approval((v_approval->>'approval_id')::uuid,repeat('b',64),'codex',v_task::text);
  RAISE EXCEPTION 'wrong fingerprint consumed approval';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 v_result:=consume_approval((v_approval->>'approval_id')::uuid,v_fingerprint,'codex',v_task::text);
 IF v_result->>'status'<>'consumed' THEN RAISE EXCEPTION 'approval not consumed'; END IF;

 v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]','[]','/srv/security-test','delegate:'||v_task,1,v_task::text);
 v_msg:=claim_outbox_event((v_request->>'event_id')::uuid,'dispatcher-test',interval '1 minute'); PERFORM route_outbox_message(v_msg.id,'dispatcher-test');
 v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','supervisor-test',interval '1 minute');
 v_start:=start_implementation_job(v_job.id,v_session,'supervisor-test',interval '1 minute');
 v_report:=submit_worker_interaction(v_project,v_task,(v_start->>'run_id')::uuid,v_worker,(v_start->>'fencing_token')::bigint,
   'ses_security','blocker','{"reason":"dependency unavailable"}','blocker:'||(v_start->>'run_id'));
 v_result:=finalize_worker_interaction((v_report->>'report_id')::uuid,v_job.id,'supervisor-test');
 IF v_result->>'status'<>'needs_attention' THEN RAISE EXCEPTION 'blocker not finalized'; END IF;
 INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,run_id,status,attempt_count,last_error)
 VALUES(v_job.source_event_id,'resume_orchestrator',v_project,v_task,(v_start->>'run_id')::uuid,'dead_letter',5,'ambiguous runtime failure')
 RETURNING * INTO v_incident;
 v_result:=resolve_runtime_job_incident(v_incident.id,'operator','Verified the runtime state and reconciled the failed job',v_task::text);
 IF v_result->>'job_id'<>v_incident.id::text OR
    (SELECT resolved_at IS NULL FROM runtime_jobs WHERE id=v_incident.id) THEN
   RAISE EXCEPTION 'dead-letter incident was not resolved'; END IF;
 SELECT count(*) INTO v_count FROM audit_events
 WHERE project_id=v_project AND action='runtime_job.incident_resolved' AND target_id=v_incident.id::text;
 IF v_count<>1 THEN RAISE EXCEPTION 'incident resolution audit event missing'; END IF;
 SELECT count(*) INTO v_count FROM audit_events WHERE project_id=v_project;
 IF v_count<5 THEN RAISE EXCEPTION 'security audit trail incomplete: %',v_count; END IF;
 SELECT count(*) INTO v_count FROM workspace_locks WHERE project_id=v_project AND status='released';
 IF v_count<>1 THEN RAISE EXCEPTION 'blocked run lock not released'; END IF;
 RAISE NOTICE 'security, approval and worker interaction assertions passed';
END $$;
ROLLBACK;
