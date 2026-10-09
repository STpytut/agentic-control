-- Migration 0155: a run stopped at its token limit ends and asks the owner,
-- with the lock released and nothing left to retry.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_owner uuid; v_project uuid; v_profile uuid; v_agent uuid; v_task uuid; v_session uuid; v_run uuid;
  v_event domain_events; v_job runtime_jobs; v_result jsonb; v_question text;
BEGIN
  IF NOT has_function_privilege('infra_worker','finalize_over_limit_run(bigint,text,text,text)','EXECUTE')
     OR has_function_privilege('infra_web','finalize_over_limit_run(bigint,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'finalize_over_limit_run grants are wrong';
  END IF;
  INSERT INTO users(display_name) VALUES('Limit owner') RETURNING id INTO v_owner;
  INSERT INTO projects(owner_id,name,slug,workspace_path) VALUES(v_owner,'Limit','limit-stop','/srv/infra-cod/workspaces/limit-stop') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('claude','test','test','anthropic','limit-claude') RETURNING id INTO v_profile;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('limit-claude','implementer',v_profile) RETURNING id INTO v_agent;
  INSERT INTO tasks(project_id,title,objective,status,created_by) VALUES(v_project,'Limit','test','implementing','test') RETURNING id INTO v_task;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose) VALUES(v_project,v_agent,v_profile,'implementation') RETURNING id INTO v_session;
  INSERT INTO task_runs(task_id,agent_id,session_id,phase,status,write_capable,workspace_fencing_token)
    VALUES(v_task,v_agent,v_session,'implementation','running',true,1) RETURNING id INTO v_run;
  UPDATE workspace_locks SET status='held', owner_run_id=v_run, fencing_token=1, lease_expires_at=clock_timestamp()+interval '5 minutes'
  WHERE project_id=v_project;
  v_event := append_event('implementation.requested',v_project,v_task,NULL,'user','o',NULL,'lk','lk','task',v_task,1,'{}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,run_id,status,leased_by,leased_until,payload)
    VALUES(v_event.id,'implementation_run',v_project,v_task,v_run,'in_flight','exec',clock_timestamp()+interval '5 minutes','{}') RETURNING * INTO v_job;

  v_result := finalize_over_limit_run(v_job.id, 'exec', 'ses-1',
    'the run used 23,516 tokens, past this member''s limit of 20,000 per run, and was stopped');
  IF v_result->>'status' <> 'over_token_limit' THEN RAISE EXCEPTION 'result: %', v_result; END IF;
  IF (SELECT status FROM runtime_jobs WHERE id = v_job.id) <> 'completed' THEN RAISE EXCEPTION 'the job is left to retry'; END IF;
  IF (SELECT status || ':' || failure_code FROM task_runs WHERE id = v_run) <> 'failed:token_limit' THEN RAISE EXCEPTION 'the run is not ended at its limit'; END IF;
  IF (SELECT status FROM tasks WHERE id = v_task) <> 'needs_attention' THEN RAISE EXCEPTION 'the task does not need attention'; END IF;
  IF (SELECT status FROM workspace_locks WHERE project_id = v_project) = 'held' THEN RAISE EXCEPTION 'the workspace is still held'; END IF;
  SELECT payload->>'question' INTO v_question FROM domain_events WHERE task_id = v_task AND event_type = 'run.unreported';
  IF v_question !~ 'stopped at its token limit: the run used 23,516 tokens' OR v_question !~ 'Team page' THEN
    RAISE EXCEPTION 'the owner is not told what happened: %', v_question;
  END IF;
  IF (SELECT native_session_id FROM agent_sessions WHERE id = v_session) <> 'ses-1' THEN RAISE EXCEPTION 'the session to resume is lost'; END IF;
  RAISE NOTICE 'run limit stop assertions passed';
END $$;

ROLLBACK;
