-- WP-3b: filesystem access follows an explicit grant (migration 0060).
--
-- What is pinned: the mode comes from what the run is, never from a caller; a
-- read-only grant is refused while another run writes, and stops resolving the
-- moment one starts; a read-write grant is bound to the lock and its fencing token
-- and stops resolving when either moves; a grant does not outlive its run, its
-- job's lease, its expiry or a newer grant; refusals say why in DETAIL; the token
-- is never stored; and nothing in a grant names an operating-system account.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane,public,extensions;

CREATE TEMP SEQUENCE grant_event_version START 5000;
CREATE TEMP TABLE grant_fixture(project_id uuid, orchestrator uuid, executor uuid, executor_assignment uuid,
  orchestrator_assignment uuid, task_id uuid) ON COMMIT DROP;

DO $$
DECLARE v_user uuid; v_project uuid; v_cp uuid; v_ep uuid; v_codex uuid; v_exec uuid; v_oa uuid; v_ea uuid; v_task uuid;
BEGIN
  INSERT INTO users(display_name) VALUES('Grants') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path) VALUES(v_user,'Grants','grants','/srv/grants') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-grants') RETURNING id INTO v_cp;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','opencode-grants') RETURNING id INTO v_ep;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('grants-codex','architect',v_cp) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('grants-exec','implementer',v_ep) RETURNING id INTO v_exec;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_cp,'orchestrator',true) RETURNING id INTO v_oa;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_exec,v_ep,'executor') RETURNING id INTO v_ea;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Granted task','Work','planning',v_codex,v_oa,'test') RETURNING id INTO v_task;
  INSERT INTO grant_fixture VALUES(v_project,v_codex,v_exec,v_ea,v_oa,v_task);
END $$;

-- The reason a refusal gives, or NULL if the call succeeded.
CREATE FUNCTION pg_temp.refusal(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_detail text;
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  RETURN COALESCE(NULLIF(v_detail,''),'sqlstate:'||SQLSTATE);
END $$;

-- Asserts that a call is refused for exactly p_expected, and when it is not, says
-- what happened instead. An earlier draft of this file reported every mismatch as
-- "was issued" — including a refusal for a different reason — and sent the
-- investigation after a hole in the migration that was a hole in the fixture.
CREATE FUNCTION pg_temp.expect_refusal(p_sql text, p_expected text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_got text;
BEGIN
  v_got:=pg_temp.refusal(p_sql);
  IF v_got IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION '%: expected refusal %, got %',p_what,p_expected,COALESCE(v_got,'success');
  END IF;
END $$;


-- A claimed Codex turn, the way the chat worker has one.
CREATE FUNCTION pg_temp.claimed_turn(p_key text) RETURNS runtime_jobs LANGUAGE plpgsql AS $$
DECLARE v_f grant_fixture; v_event domain_events; v_job runtime_jobs;
BEGIN
  SELECT * INTO v_f FROM grant_fixture;
  v_event:=append_event('chat.user_message',v_f.project_id,v_f.task_id,NULL,'user','operator',NULL,'grants',p_key,
    'task',v_f.task_id,nextval('grant_event_version'),'{}'::jsonb);
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status)
    VALUES(v_event.id,'orchestrator_turn',v_f.project_id,v_f.task_id,'pending');
  SELECT * INTO v_job FROM claim_orchestrator_jobs('grants-codex-worker',1,interval '10 minutes');
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'fixture: the turn was not claimed'; END IF;
  RETURN v_job;
END $$;

-- A writing run holding the lock, with its in-flight job and its handoff.
CREATE FUNCTION pg_temp.writing_run(p_key text) RETURNS runtime_jobs LANGUAGE plpgsql AS $$
DECLARE v_f grant_fixture; v_run uuid; v_event domain_events; v_job runtime_jobs; v_rev int;
BEGIN
  SELECT * INTO v_f FROM grant_fixture;
  INSERT INTO task_runs(task_id,agent_id,phase,status,write_capable)
    VALUES(v_f.task_id,v_f.executor,'implementation','starting',true) RETURNING id INTO v_run;
  PERFORM acquire_workspace_lock(v_f.project_id,v_run,'implementation',interval '30 minutes');
  UPDATE task_runs SET status='running' WHERE id=v_run;
  SELECT COALESCE(max(revision_number),0)+1 INTO v_rev FROM handoffs WHERE task_id=v_f.task_id;
  INSERT INTO handoffs(task_id,from_agent_id,to_agent_id,target_run_id,revision_number,objective,workspace_ref,executor_assignment_id)
    VALUES(v_f.task_id,v_f.orchestrator,v_f.executor,v_run,v_rev,'Implement','/srv/grants',v_f.executor_assignment);
  v_event:=append_event('implementation.requested',v_f.project_id,v_f.task_id,v_run,'system','grants',NULL,'grants',p_key,
    'task',v_f.task_id,nextval('grant_event_version'),'{}'::jsonb);
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,run_id,status,leased_by,leased_until,attempt_count)
    VALUES(v_event.id,'implementation_run',v_f.project_id,v_f.task_id,v_run,'in_flight','grants-exec-worker',
      clock_timestamp()+interval '10 minutes',1)
    RETURNING * INTO v_job;
  RETURN v_job;
END $$;

-- A turn gets read_only, resolves to its runtime type, and the token is neither
-- stored nor accompanied by an account name.
DO $$
DECLARE v_f grant_fixture; v_job runtime_jobs; v_grant jsonb; v_resolved jsonb; v_row workspace_access_grants;
BEGIN
  SELECT * INTO v_f FROM grant_fixture;
  v_job:=pg_temp.claimed_turn('grants-ro');
  v_grant:=issue_workspace_access_grant(v_job.id,'grants-codex-worker');
  IF v_grant->>'mode'<>'read_only' OR v_grant->>'token' !~ '^[0-9a-f]{64}$' OR (v_grant->>'run_id')::uuid<>v_job.run_id THEN
    RAISE EXCEPTION 'a turn was not granted read_only: %',v_grant;
  END IF;
  v_resolved:=resolve_workspace_access_grant(v_grant->>'token',v_f.project_id);
  IF v_resolved->>'mode'<>'read_only' OR v_resolved->>'runtime_type'<>'codex'
     OR (v_resolved->>'assignment_id')::uuid<>v_f.orchestrator_assignment OR v_resolved ? 'fencing_token' AND v_resolved->>'fencing_token' IS NOT NULL THEN
    RAISE EXCEPTION 'the read_only grant resolved wrongly: %',v_resolved;
  END IF;
  SELECT * INTO v_row FROM workspace_access_grants WHERE id=(v_grant->>'grant_id')::uuid;
  IF position(v_grant->>'token' in row_to_json(v_row)::text)>0 OR v_row.token_sha256<>digest(decode(v_grant->>'token','hex'),'sha256') THEN
    RAISE EXCEPTION 'the token is stored, or its hash is not';
  END IF;
  IF (SELECT string_agg(k,',') FROM jsonb_object_keys(v_resolved) k WHERE k ~* '(user|account|uid|home|path|owner)') IS NOT NULL THEN
    RAISE EXCEPTION 'a resolved grant names an account or a path: %',v_resolved;
  END IF;
  UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp(),leased_by=NULL,leased_until=NULL WHERE id=v_job.id;
  RAISE NOTICE 'a turn gets read_only, resolves to a runtime type, and its token is stored only as a hash';
END $$;

-- The mode is not the caller's to choose: the signature has no mode.
DO $$
BEGIN
  IF (SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='control_plane' AND p.proname='issue_workspace_access_grant')
     <>'p_job_id bigint, p_worker_id text, p_ttl interval' THEN
    RAISE EXCEPTION 'issue_workspace_access_grant takes something other than job, worker and lifetime';
  END IF;
  RAISE NOTICE 'the grant mode cannot be chosen by a caller';
END $$;

-- A writer: read_write, bound to the lock's fencing token. A read_only grant
-- issued earlier stops resolving the moment the writer holds the workspace.
DO $$
DECLARE v_f grant_fixture; v_turn runtime_jobs; v_ro jsonb; v_write runtime_jobs; v_rw jsonb; v_resolved jsonb;
BEGIN
  SELECT * INTO v_f FROM grant_fixture;
  v_turn:=pg_temp.claimed_turn('grants-ro-then-writer');
  v_ro:=issue_workspace_access_grant(v_turn.id,'grants-codex-worker');

  v_write:=pg_temp.writing_run('grants-rw');
  PERFORM pg_temp.expect_refusal(format('SELECT resolve_workspace_access_grant(%L,%L)',v_ro->>'token',v_f.project_id),'grant_writer_active','a read_only grant still resolved while a writer holds the workspace');
  PERFORM pg_temp.expect_refusal(format('SELECT issue_workspace_access_grant(%s,%L)',v_turn.id,'grants-codex-worker'),'grant_writer_active','a read_only grant was issued while a writer holds the workspace');

  v_rw:=issue_workspace_access_grant(v_write.id,'grants-exec-worker');
  v_resolved:=resolve_workspace_access_grant(v_rw->>'token',v_f.project_id);
  IF v_resolved->>'mode'<>'read_write' OR v_resolved->>'runtime_type'<>'opencode'
     OR (v_resolved->>'fencing_token')::bigint<>(SELECT fencing_token FROM workspace_locks WHERE project_id=v_f.project_id)
     OR (v_resolved->>'assignment_id')::uuid<>v_f.executor_assignment THEN
    RAISE EXCEPTION 'the read_write grant resolved wrongly: %',v_resolved;
  END IF;

  -- The fencing token moves: the lock is released and taken again by another run.
  PERFORM release_workspace_lock(v_f.project_id,v_write.run_id,(v_resolved->>'fencing_token')::bigint);
  PERFORM pg_temp.expect_refusal(format('SELECT resolve_workspace_access_grant(%L,%L)',v_rw->>'token',v_f.project_id),'grant_lock_not_held','a read_write grant resolved after its lock was released');
  -- The same run takes the lock again: held, same owner, new fencing token. Only
  -- the token tells this grant from the one the lock now justifies.
  PERFORM acquire_workspace_lock(v_f.project_id,v_write.run_id,'implementation',interval '30 minutes');
  v_rw:=issue_workspace_access_grant(v_write.id,'grants-exec-worker');
  PERFORM release_workspace_lock(v_f.project_id,v_write.run_id,
    (SELECT fencing_token FROM workspace_locks WHERE project_id=v_f.project_id));
  PERFORM acquire_workspace_lock(v_f.project_id,v_write.run_id,'implementation',interval '30 minutes');
  IF (SELECT status FROM workspace_locks WHERE project_id=v_f.project_id)<>'held' THEN
    RAISE EXCEPTION 'fixture: the run did not take the lock again';
  END IF;
  PERFORM pg_temp.expect_refusal(format('SELECT resolve_workspace_access_grant(%L,%L)',v_rw->>'token',v_f.project_id),'grant_lock_not_held','a read_write grant resolved under a newer fencing token');
  PERFORM release_workspace_lock(v_f.project_id,v_write.run_id,
    (SELECT fencing_token FROM workspace_locks WHERE project_id=v_f.project_id));
  RAISE NOTICE 'a writer gets read_write bound to the lock and its fencing token; read_only stops resolving while it writes';

  UPDATE task_runs SET status='completed',finished_at=clock_timestamp() WHERE id=v_write.run_id;
  UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp(),leased_by=NULL,leased_until=NULL
    WHERE id IN (v_write.id,v_turn.id);
END $$;

-- A writing run without the lock is refused read_write.
DO $$
DECLARE v_f grant_fixture; v_write runtime_jobs; v_fence bigint;
BEGIN
  SELECT * INTO v_f FROM grant_fixture;
  v_write:=pg_temp.writing_run('grants-no-lock');
  SELECT fencing_token INTO v_fence FROM workspace_locks WHERE project_id=v_f.project_id;
  PERFORM release_workspace_lock(v_f.project_id,v_write.run_id,v_fence);
  PERFORM pg_temp.expect_refusal(format('SELECT issue_workspace_access_grant(%s,%L)',v_write.id,'grants-exec-worker'),'grant_lock_not_held','read_write was issued to a run that does not hold the lock');
  -- The run holds the lock, but its own fencing token is stale: what a holder
  -- that missed a re-acquisition looks like, and exactly what fencing is for.
  PERFORM acquire_workspace_lock(v_f.project_id,v_write.run_id,'implementation',interval '30 minutes');
  UPDATE task_runs SET workspace_fencing_token=workspace_fencing_token-1 WHERE id=v_write.run_id;
  PERFORM pg_temp.expect_refusal(format('SELECT issue_workspace_access_grant(%s,%L)',v_write.id,'grants-exec-worker'),'grant_lock_not_held','read_write was issued to a holder with a stale fencing token');
  PERFORM release_workspace_lock(v_f.project_id,v_write.run_id,
    (SELECT fencing_token FROM workspace_locks WHERE project_id=v_f.project_id));
  UPDATE task_runs SET status='failed',finished_at=clock_timestamp() WHERE id=v_write.run_id;
  UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp(),leased_by=NULL,leased_until=NULL WHERE id=v_write.id;
  RAISE NOTICE 'read_write is refused without the lock, and to a holder with a stale fencing token';
END $$;

-- A grant does not outlive: its job's lease, its expiry, a newer grant, or its run.
DO $$
DECLARE v_f grant_fixture; v_job runtime_jobs; v_a jsonb; v_b jsonb; v_c jsonb; v_reason text;
BEGIN
  SELECT * INTO v_f FROM grant_fixture;
  v_job:=pg_temp.claimed_turn('grants-lifecycle');

  PERFORM pg_temp.expect_refusal(format('SELECT issue_workspace_access_grant(%s,%L)',v_job.id,'someone-else'),'grant_job_not_leased','a grant was issued to a worker that does not lease the job');

  -- The right worker, but its lease has run out: the job may already be someone
  -- else's, so nothing is issued on it.
  UPDATE runtime_jobs SET leased_until=clock_timestamp()-interval '1 second' WHERE id=v_job.id;
  PERFORM pg_temp.expect_refusal(format('SELECT issue_workspace_access_grant(%s,%L)',v_job.id,'grants-codex-worker'),
    'grant_job_not_leased','a grant issued on an expired lease');
  UPDATE runtime_jobs SET leased_until=clock_timestamp()+interval '10 minutes' WHERE id=v_job.id;

  v_a:=issue_workspace_access_grant(v_job.id,'grants-codex-worker');
  v_b:=issue_workspace_access_grant(v_job.id,'grants-codex-worker');
  PERFORM pg_temp.expect_refusal(format('SELECT resolve_workspace_access_grant(%L,%L)',v_a->>'token',v_f.project_id),
    'grant_revoked','an older grant after a newer one was issued');
  IF (SELECT revoke_reason FROM workspace_access_grants WHERE id=(v_a->>'grant_id')::uuid) IS DISTINCT FROM 'superseded' THEN
    RAISE EXCEPTION 'the older grant was not recorded as superseded';
  END IF;

  PERFORM pg_temp.expect_refusal(format('SELECT resolve_workspace_access_grant(%L,%L)',v_b->>'token',gen_random_uuid()),
    'grant_project_mismatch','a grant presented for another project');
  PERFORM pg_temp.expect_refusal(format('SELECT resolve_workspace_access_grant(%L,%L)',repeat('0',64),v_f.project_id),
    'grant_unknown','an unknown token');
  PERFORM pg_temp.expect_refusal(format('SELECT resolve_workspace_access_grant(%L,%L)','not-a-token',v_f.project_id),
    'grant_malformed','a malformed token');

  UPDATE workspace_access_grants SET issued_at=clock_timestamp()-interval '2 hours', expires_at=clock_timestamp()-interval '1 second'
    WHERE id=(v_b->>'grant_id')::uuid;
  PERFORM pg_temp.expect_refusal(format('SELECT resolve_workspace_access_grant(%L,%L)',v_b->>'token',v_f.project_id),'grant_expired','an expired grant resolved');

  v_c:=issue_workspace_access_grant(v_job.id,'grants-codex-worker');
  UPDATE runtime_jobs SET leased_until=clock_timestamp()-interval '1 second' WHERE id=v_job.id;
  PERFORM pg_temp.expect_refusal(format('SELECT resolve_workspace_access_grant(%L,%L)',v_c->>'token',v_f.project_id),'grant_job_not_leased','a grant resolved after its job''s lease ran out');
  UPDATE runtime_jobs SET leased_until=clock_timestamp()+interval '10 minutes' WHERE id=v_job.id;

  -- The run ends: the live grant is revoked in the same transaction, with why.
  PERFORM acknowledge_runtime_job(v_job.id,'grants-codex-worker','{}'::jsonb);
  SELECT revoke_reason INTO v_reason FROM workspace_access_grants WHERE id=(v_c->>'grant_id')::uuid;
  IF v_reason IS DISTINCT FROM 'run_completed' THEN
    RAISE EXCEPTION 'a grant outlived its run: revoke reason %',COALESCE(v_reason,'none');
  END IF;
  PERFORM pg_temp.expect_refusal(format('SELECT resolve_workspace_access_grant(%L,%L)',v_c->>'token',v_f.project_id),
    'grant_revoked','a grant presented after its run ended');
  RAISE NOTICE 'a grant ends with its lease, its expiry, a newer grant and its run — and says which';
END $$;

ROLLBACK;
