-- A refusal says which refusal it is (migration 0067, WP-8a).
--
-- Pinned here: the vocabulary is closed and `refuse()` enforces it; the six
-- conditions that shared "active worker run validation failed" are six reasons
-- (defect 104); the workspace fence distinguishes "nobody holds it" from
-- "somebody else does"; and every reason a function names carries its SQLSTATE
-- unchanged, so a caller reading the old sentence is not broken by the new
-- detail.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

-- The reason of the last refusal a block provoked. PG_EXCEPTION_DETAIL is the
-- only place it travels, which is the point of the migration.
--
-- A call that does *not* refuse returns NULL, so every check below compares
-- with IS DISTINCT FROM. It used `<>`, and `NULL <> 'reason'` is NULL, so the
-- IF never fired: with assert_workspace_fence replaced by an empty function,
-- this whole file still passed. The same hole 0068 closed in a guard, in the
-- test that was meant to pin the guards.
CREATE FUNCTION pg_temp.reason_of(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_detail text;
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF v_detail IS NULL OR left(v_detail, 1) <> '{' THEN RETURN 'NO_DETAIL: ' || COALESCE(v_detail, SQLERRM); END IF;
  RETURN v_detail::jsonb->>'reason';
END $$;

DO $$
DECLARE
  v_user uuid; v_project uuid; v_codex_profile uuid; v_executor_profile uuid;
  v_codex uuid; v_worker uuid; v_other uuid; v_orchestrator uuid; v_executor_assignment uuid;
  v_session uuid; v_task uuid; v_request jsonb; v_message outbox_messages; v_job runtime_jobs;
  v_start jsonb; v_run uuid; v_token bigint; v_reason text; v_turn uuid;
BEGIN
  INSERT INTO users(display_name) VALUES('Failure reasons') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Failure reasons','failure-reasons','/srv/failure-reasons') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-reasons') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','opencode-reasons') RETURNING id INTO v_executor_profile;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('reasons-codex','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('reasons-worker','implementer',v_executor_profile) RETURNING id INTO v_worker;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('reasons-other','implementer',v_executor_profile) RETURNING id INTO v_other;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING id INTO v_orchestrator;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_executor_profile,'executor') RETURNING id INTO v_executor_assignment;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,native_session_id)
    VALUES(v_project,v_worker,v_executor_profile,'implementation','ses_reasons') RETURNING id INTO v_session;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by,acceptance_criteria)
    VALUES(v_project,'Failure reasons','test','ready',v_codex,v_orchestrator,'test','["done"]') RETURNING id INTO v_task;

  -- `refuse()` is the only way in, and it checks the vocabulary.
  IF pg_temp.reason_of($q$ SELECT refuse('run_not_running','x') $q$) IS DISTINCT FROM 'run_not_running' THEN
    RAISE EXCEPTION 'refuse did not carry its reason';
  END IF;
  IF pg_temp.reason_of($q$ SELECT refuse('a_reason_nobody_declared','x') $q$) IS DISTINCT FROM 'unknown_failure_reason' THEN
    RAISE EXCEPTION 'a reason outside the vocabulary was raised as if it were one';
  END IF;

  -- start_implementation_job: four conditions that shared one sentence.
  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]','[]',
    '/srv/failure-reasons','delegate:'||v_task,1,v_task::text);
  UPDATE handoffs SET executor_assignment_id=v_executor_assignment WHERE id=(v_request->>'handoff_id')::uuid;
  v_message:=claim_outbox_event((v_request->>'event_id')::uuid,'reasons-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'reasons-dispatcher');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','reasons-worker',interval '1 minute');

  IF pg_temp.reason_of(format($q$ SELECT start_implementation_job(%s,%L,%L) $q$,
      2147483647, v_session, 'reasons-worker')) IS DISTINCT FROM 'job_not_found' THEN
    RAISE EXCEPTION 'a job that does not exist was not reported as missing';
  END IF;
  IF pg_temp.reason_of(format($q$ SELECT start_implementation_job(%s,%L,%L) $q$,
      v_job.id, v_session, 'somebody-else')) IS DISTINCT FROM 'job_lease_held_by_another' THEN
    RAISE EXCEPTION 'another worker''s lease was not reported as such';
  END IF;
  UPDATE runtime_jobs SET leased_until=clock_timestamp()-interval '1 second' WHERE id=v_job.id;
  IF pg_temp.reason_of(format($q$ SELECT start_implementation_job(%s,%L,%L) $q$,
      v_job.id, v_session, 'reasons-worker')) IS DISTINCT FROM 'job_lease_expired' THEN
    RAISE EXCEPTION 'an expired lease was not reported as such';
  END IF;
  UPDATE runtime_jobs SET leased_until=clock_timestamp()+interval '5 minutes' WHERE id=v_job.id;
  UPDATE agent_sessions SET active=false WHERE id=v_session;
  IF pg_temp.reason_of(format($q$ SELECT start_implementation_job(%s,%L,%L) $q$,
      v_job.id, v_session, 'reasons-worker')) IS DISTINCT FROM 'worker_session_not_active' THEN
    RAISE EXCEPTION 'an inactive session was not reported as such';
  END IF;
  UPDATE agent_sessions SET active=true WHERE id=v_session;

  v_start:=start_implementation_job(v_job.id,v_session,'reasons-worker',interval '5 minutes');
  v_run:=(v_start->>'run_id')::uuid;
  v_token:=(v_start->>'fencing_token')::bigint;

  -- The fence: "nobody holds it" and "somebody else does" are different answers,
  -- and a worker acts on them differently.
  IF pg_temp.reason_of(format($q$ SELECT assert_workspace_fence(%L,%L,%s) $q$,
      v_project, v_run, v_token + 1)) IS DISTINCT FROM 'workspace_fencing_token_stale' THEN
    RAISE EXCEPTION 'a stale token was not reported as such';
  END IF;
  -- A turn, not a second implementation: a write-capable run without a fencing
  -- token is refused by the table itself, and a turn is what the next case needs
  -- anyway.
  INSERT INTO task_runs(task_id,session_id,agent_id,phase,status,write_capable)
    VALUES(v_task,v_session,v_worker,'orchestrator_turn','running',false) RETURNING id INTO v_turn;
  IF pg_temp.reason_of(format($q$ SELECT assert_workspace_fence(%L,%L,%s) $q$,
      v_project, v_turn, v_token)) IS DISTINCT FROM 'workspace_lock_owned_by_another_run' THEN
    RAISE EXCEPTION 'a lock held by another run was not reported as such';
  END IF;
  UPDATE workspace_locks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE project_id=v_project;
  IF pg_temp.reason_of(format($q$ SELECT assert_workspace_fence(%L,%L,%s) $q$,
      v_project, v_run, v_token)) IS DISTINCT FROM 'workspace_lease_expired' THEN
    RAISE EXCEPTION 'an expired lease was not reported as such';
  END IF;
  UPDATE workspace_locks SET lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE project_id=v_project;

  -- submit_worker_completion: the six of defect 104, each with its own reason.
  IF pg_temp.reason_of(format($q$ SELECT submit_worker_completion(%L,%L,%L,%L,%s,%L,'{}'::jsonb,'{}'::jsonb,NULL,%L) $q$,
      v_project, v_task, v_run, v_other, v_token, 'ses_reasons', 'idem-0001')) IS DISTINCT FROM 'run_agent_mismatch' THEN
    RAISE EXCEPTION 'a run belonging to another agent was not reported as such';
  END IF;
  IF pg_temp.reason_of(format($q$ SELECT submit_worker_completion(%L,%L,%L,%L,%s,%L,'{}'::jsonb,'{}'::jsonb,NULL,%L) $q$,
      v_project, v_task, v_turn, v_worker, v_token, 'ses_reasons', 'idem-0002')) IS DISTINCT FROM 'run_not_write_capable' THEN
    RAISE EXCEPTION 'a turn reporting an implementation was not reported as such';
  END IF;
  IF pg_temp.reason_of(format($q$ SELECT submit_worker_completion(%L,%L,%L,%L,%s,%L,'{}'::jsonb,'{}'::jsonb,NULL,%L) $q$,
      v_project, v_task, v_run, v_worker, v_token, '', 'idem-0003')) IS DISTINCT FROM 'native_session_id_missing' THEN
    RAISE EXCEPTION 'a completion without a native session was not reported as such';
  END IF;
  IF pg_temp.reason_of(format($q$ SELECT submit_worker_completion(%L,%L,%L,%L,%s,%L,'{}'::jsonb,'{}'::jsonb,NULL,%L) $q$,
      v_project, v_task, v_run, v_worker, v_token, 'ses_reasons', 'short')) IS DISTINCT FROM 'completion_idempotency_key_invalid' THEN
    RAISE EXCEPTION 'a short idempotency key was not reported as such';
  END IF;
  IF pg_temp.reason_of(format($q$ SELECT submit_worker_completion(%L,%L,%L,%L,%s,%L,'{}'::jsonb,'{}'::jsonb,NULL,%L) $q$,
      v_project, v_task, v_run, v_worker, v_token, 'ses_other', 'idem-0004')) IS DISTINCT FROM 'session_continuity_mismatch' THEN
    RAISE EXCEPTION 'a different native session was not reported as such';
  END IF;

  -- 0068: an absent argument is refused here, not by the table four statements
  -- later. Seen on the host on rc.36 — `jsonb_typeof(NULL) <> 'object'` is NULL,
  -- so the guard did not fire and the operator's journal got
  -- `null value in column "checks_summary" ... violates not-null constraint`.
  IF pg_temp.reason_of(format($q$ SELECT submit_worker_completion(%L,%L,%L,%L,%s,%L,'{}'::jsonb,NULL,NULL,%L) $q$,
      v_project, v_task, v_run, v_worker, v_token, 'ses_reasons', 'idem-null-1')) IS DISTINCT FROM 'completion_summary_not_object' THEN
    RAISE EXCEPTION 'an absent checks summary was not refused with its reason';
  END IF;
  IF pg_temp.reason_of(format($q$ SELECT submit_worker_completion(%L,%L,%L,%L,%s,%L,NULL,'{}'::jsonb,NULL,%L) $q$,
      v_project, v_task, v_run, v_worker, v_token, 'ses_reasons', 'idem-null-2')) IS DISTINCT FROM 'completion_summary_not_object' THEN
    RAISE EXCEPTION 'an absent result summary was not refused with its reason';
  END IF;
  -- The same hole, in the function a blocker goes through.
  IF pg_temp.reason_of(format($q$ SELECT submit_worker_interaction(%L,%L,%L,%L,%s,%L,'blocker',NULL,%L) $q$,
      v_project, v_task, v_run, v_worker, v_token, 'ses_reasons', 'idem-null-3')) IS DISTINCT FROM 'interaction_payload_invalid' THEN
    RAISE EXCEPTION 'an absent interaction payload was not refused with its reason';
  END IF;

  -- The accepted path still accepts, and the run that finished is then a
  -- different refusal from the agent that moved — the distinction defect 104
  -- could not make.
  PERFORM submit_worker_completion(v_project,v_task,v_run,v_worker,v_token,'ses_reasons',
    '{"summary":"done"}'::jsonb,'{"tests":"passed"}'::jsonb,NULL,'idem-accepted');
  UPDATE task_runs SET status='completed',finished_at=clock_timestamp() WHERE id=v_run;
  IF pg_temp.reason_of(format($q$ SELECT submit_worker_completion(%L,%L,%L,%L,%s,%L,'{}'::jsonb,'{}'::jsonb,NULL,%L) $q$,
      v_project, v_task, v_run, v_worker, v_token, 'ses_reasons', 'idem-0005')) IS DISTINCT FROM 'run_not_running' THEN
    RAISE EXCEPTION 'a finished run was not reported as finished';
  END IF;

  -- And the SQLSTATE a caller already branches on is unchanged.
  BEGIN
    PERFORM submit_worker_completion(v_project,v_task,v_run,v_worker,v_token,'ses_reasons',
      '{}'::jsonb,'{}'::jsonb,NULL,'short');
    RAISE EXCEPTION 'an invalid key was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  RAISE NOTICE 'every refusal carries its own reason, the vocabulary is closed, and the SQLSTATEs are unchanged';
END $$;

ROLLBACK;
