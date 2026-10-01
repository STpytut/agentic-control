-- Runtime job provenance (migration 0071, WP-9c).
--
--   * a job's selection is written once, on its first launch, and every retry
--     reuses it; an attempt is appended per launch;
--   * a launch for another runtime is refused; a runtime that moved between
--     attempts supersedes the selection, and the old one stays;
--   * nothing recorded changes, except an attempt's end, once;
--   * the Stop button's answer is the recorded driver's declaration;
--   * usage is attributed by what ran — shown on a task whose executor is not
--     the default one, where the job-type guess the panel used to make says
--     something else.
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

CREATE FUNCTION pg_temp.expect_reason(p_sql text, p_reason text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_reason text := pg_temp.reason_of(p_sql);
BEGIN
  IF v_reason IS DISTINCT FROM p_reason THEN
    RAISE EXCEPTION '%: expected %, got %', p_what, p_reason, COALESCE(v_reason, '<accepted>');
  END IF;
END $$;

-- What a launcher says, as provenance.mjs builds it.
CREATE FUNCTION pg_temp.launch(p_runtime text, p_version text DEFAULT '1.0.0',
  p_capabilities text[] DEFAULT ARRAY['events.raw','interrupt','sessions.create','sessions.resume']) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('runtime',p_runtime,'executable',p_runtime,'surface','task','adapter_version','1.0.0',
    'runtime_version',p_version,'verified_runtime_version','1.0.0',
    'capability_verification',CASE WHEN p_version='1.0.0' THEN 'verified' ELSE 'unverified' END,
    'capabilities',to_jsonb(p_capabilities),'model','model-x');
$$;

CREATE FUNCTION pg_temp.grant_for(p_job runtime_jobs, p_assignment uuid, p_mode text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO workspace_access_grants(token_sha256,project_id,job_id,run_id,assignment_id,mode,fencing_token,issued_to,expires_at)
  VALUES(digest(gen_random_uuid()::text,'sha256'),p_job.project_id,p_job.id,p_job.run_id,p_assignment,p_mode,
    CASE WHEN p_mode='read_write' THEN 1 END,'provenance-test',clock_timestamp()+interval '10 minutes');
$$;

DO $$
DECLARE
  v_user uuid; v_project uuid; v_codex_profile uuid; v_opencode_profile uuid; v_other_profile uuid;
  v_codex uuid; v_default_worker uuid; v_other_worker uuid;
  v_orchestrator uuid; v_default_executor uuid; v_other_executor uuid; v_task uuid;
  v_event domain_events; v_job runtime_jobs; v_claimed runtime_jobs; v_first jsonb; v_second jsonb; v_moved jsonb;
  v_selection runtime_job_selections; v_count integer; v_run uuid; v_impl runtime_jobs; v_usage jsonb; v_old jsonb;
BEGIN
  INSERT INTO users(display_name) VALUES('Provenance') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Provenance','provenance','/srv/infra-cod/workspaces/provenance') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-provenance') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','opencode-provenance') RETURNING id INTO v_opencode_profile;
  -- The executor this task selected is not the project's default one, and does
  -- not run on the runtime a start_implementation job used to be assumed to.
  -- 0074: a runtime is assigned the executor only when it plays it, so the
  -- second executor runtime is given the role and its core, as a migration
  -- registering a driver would.
  INSERT INTO runtime_roles(runtime_type,role) VALUES('antigravity','executor');
  INSERT INTO runtime_capabilities(runtime_type,capability)
    SELECT 'antigravity',capability FROM runtime_role_core WHERE role='executor';
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('antigravity','test','test','google','antigravity-provenance') RETURNING id INTO v_other_profile;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('prov-codex','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('prov-default-worker','implementer',v_opencode_profile) RETURNING id INTO v_default_worker;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('prov-other-worker','implementer',v_other_profile) RETURNING id INTO v_other_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING id INTO v_orchestrator;
  -- The project's default executor is its first (the roster's order; an
  -- executor assignment is never is_default).
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,created_at)
    VALUES(v_project,v_default_worker,v_opencode_profile,'executor',clock_timestamp()-interval '1 minute') RETURNING id INTO v_default_executor;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_other_worker,v_other_profile,'executor') RETURNING id INTO v_other_executor;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Provenance','test','planning',v_codex,v_orchestrator,'test') RETURNING id INTO v_task;

  -- ------------------------------------------------ a turn, and its retry
  v_event:=append_event('chat.user_message',v_project,v_task,NULL,'user','operator',NULL,'prov-1','prov-1',
    'task',v_task,1,'{"content":"hello"}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    VALUES(v_event.id,'orchestrator_turn',v_project,v_task,'{}') RETURNING * INTO v_job;
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('prov-worker',1,interval '5 minutes');
  PERFORM pg_temp.expect_reason(format($q$SELECT record_runtime_dispatch(%s,'prov-worker',%L::jsonb)$q$,
    v_claimed.id, pg_temp.launch('codex')), 'runtime_selection_no_grant', 'a launch with no grant');
  PERFORM pg_temp.grant_for(v_claimed, v_orchestrator, 'read_only');
  PERFORM pg_temp.expect_reason(format($q$SELECT record_runtime_dispatch(%s,'another-worker',%L::jsonb)$q$,
    v_claimed.id, pg_temp.launch('codex')), 'run_command_not_leased', 'a launch by a worker without the lease');
  PERFORM pg_temp.expect_reason(format($q$SELECT record_runtime_dispatch(%s,'prov-worker',%L::jsonb)$q$,
    v_claimed.id, pg_temp.launch('opencode')), 'runtime_selection_mismatch', 'a launch of a runtime the assignment did not select');
  PERFORM pg_temp.expect_reason(format($q$SELECT record_runtime_dispatch(%s,'prov-worker',%L::jsonb)$q$,
    v_claimed.id, pg_temp.launch('codex') - 'capabilities'), 'runtime_selection_invalid', 'a launch without its capabilities');

  v_first:=record_runtime_dispatch(v_claimed.id,'prov-worker',pg_temp.launch('codex'));
  SELECT * INTO v_selection FROM runtime_job_selections WHERE id=(v_first->>'selection_id')::bigint;
  IF v_selection.source<>'launch' OR v_selection.assignment_id<>v_orchestrator OR v_selection.access_mode<>'read_only'
     OR v_selection.runtime_type<>'codex' OR NOT ('interrupt'=ANY(v_selection.capabilities))
     OR (v_first->>'selection_reused')::boolean THEN
    RAISE EXCEPTION 'the first launch did not record the selection the database derives: %', to_jsonb(v_selection);
  END IF;
  PERFORM finish_runtime_dispatch_attempt((v_first->>'attempt_id')::bigint,'prov-worker','{"status":"failed"}','thread-1');

  -- The retry: a new attempt, a new run, the same selection.
  PERFORM retry_runtime_job(v_claimed.id,'prov-worker','test',interval '0 seconds',5);
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('prov-worker',1,interval '5 minutes');
  IF v_claimed.id<>v_job.id THEN RAISE EXCEPTION 'fixture: the retry was not reclaimed'; END IF;
  PERFORM pg_temp.grant_for(v_claimed, v_orchestrator, 'read_only');
  v_second:=record_runtime_dispatch(v_claimed.id,'prov-worker',pg_temp.launch('codex'));
  IF v_second->>'selection_id'<>v_first->>'selection_id' OR NOT (v_second->>'selection_reused')::boolean
     OR (v_second->>'attempt_number')::integer<>2 THEN
    RAISE EXCEPTION 'the retry did not reuse the selection: first %, second %', v_first, v_second;
  END IF;
  SELECT count(DISTINCT run_id) INTO v_count FROM runtime_dispatch_attempts WHERE job_id=v_job.id;
  IF v_count<>2 THEN RAISE EXCEPTION 'two attempts did not record their two runs (% runs)', v_count; END IF;

  -- The host's runtime moved before a third launch: superseded, and said why.
  v_moved:=record_runtime_dispatch(v_claimed.id,'prov-worker',pg_temp.launch('codex','1.0.1'));
  SELECT * INTO v_selection FROM runtime_job_selections WHERE id=(v_moved->>'selection_id')::bigint;
  IF v_selection.supersedes<>(v_first->>'selection_id')::bigint OR v_selection.supersede_reason NOT LIKE '%1.0.0 -> 1.0.1%'
     OR (SELECT count(*) FROM runtime_job_selections WHERE job_id=v_job.id)<>2 THEN
    RAISE EXCEPTION 'a moved runtime did not supersede the selection with its reason: %', to_jsonb(v_selection);
  END IF;
  IF (current_runtime_job_selection(v_job.id)).id<>v_selection.id THEN
    RAISE EXCEPTION 'the superseding selection is not the current one';
  END IF;

  -- Recorded is recorded.
  PERFORM pg_temp.expect_reason(format($q$UPDATE runtime_job_selections SET runtime_type='opencode' WHERE id=%s$q$,
    v_first->>'selection_id'), 'runtime_selection_changed', 'rewriting a selection');
  PERFORM pg_temp.expect_reason(format($q$DELETE FROM runtime_dispatch_attempts WHERE id=%s$q$,
    v_first->>'attempt_id'), 'runtime_dispatch_attempt_immutable', 'deleting an attempt');
  PERFORM pg_temp.expect_reason(format($q$UPDATE runtime_dispatch_attempts SET worker_id='x' WHERE id=%s$q$,
    v_second->>'attempt_id'), 'runtime_dispatch_attempt_immutable', 'rewriting an open attempt');
  PERFORM pg_temp.expect_reason(format($q$SELECT finish_runtime_dispatch_attempt(%s,'prov-worker','{"status":"other"}')$q$,
    v_first->>'attempt_id'), 'runtime_dispatch_attempt_immutable', 'a second result for a finished attempt');
  IF (finish_runtime_dispatch_attempt((v_first->>'attempt_id')::bigint,'prov-worker','{"status":"failed"}'))->>'repeat'<>'true' THEN
    RAISE EXCEPTION 'the same result twice is not a repeat';
  END IF;

  -- ------------------------------------------------ the Stop button's answer
  IF NOT runtime_job_can_interrupt(v_job.id) THEN
    RAISE EXCEPTION 'a job whose recorded driver declares interrupt is shown as not interruptible';
  END IF;
  PERFORM finish_runtime_dispatch_attempt((v_second->>'attempt_id')::bigint,'prov-worker','{"status":"completed"}');
  PERFORM finish_runtime_dispatch_attempt((v_moved->>'attempt_id')::bigint,'prov-worker','{"status":"completed"}');
  UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp(),leased_by=NULL,leased_until=NULL WHERE id=v_job.id;

  -- ------------------------------------ an executor that is not the default
  v_event:=append_event('implementation.requested',v_project,v_task,NULL,'agent',v_codex::text,NULL,'prov-2','prov-2',
    'task',v_task,2,'{}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    VALUES(v_event.id,'implementation_run',v_project,v_task,'{}') RETURNING * INTO v_impl;
  SELECT * INTO v_claimed FROM claim_executor_jobs('prov-supervisor',1,interval '5 minutes');
  IF v_claimed.id<>v_impl.id THEN RAISE EXCEPTION 'fixture: the implementation was not claimed'; END IF;
  INSERT INTO task_runs(task_id,agent_id,phase,status,write_capable,workspace_fencing_token)
    VALUES(v_task,v_other_worker,'implementation','running',true,1) RETURNING id INTO v_run;
  UPDATE runtime_jobs SET run_id=v_run WHERE id=v_impl.id RETURNING * INTO v_impl;
  PERFORM pg_temp.grant_for(v_impl, v_other_executor, 'read_write');
  PERFORM pg_temp.expect_reason(format($q$SELECT record_runtime_dispatch(%s,'prov-supervisor',%L::jsonb)$q$,
    v_impl.id, pg_temp.launch('opencode')), 'runtime_selection_mismatch', 'the default executor''s runtime for a task that selected another');
  v_first:=record_runtime_dispatch(v_impl.id,'prov-supervisor',pg_temp.launch('antigravity'));
  IF v_first->>'assignment_id'<>v_other_executor::text OR v_first->>'access_mode'<>'read_write' THEN
    RAISE EXCEPTION 'the implementation did not record the assignment and access it ran with: %', v_first;
  END IF;
  PERFORM append_runtime_activity_event(v_impl.id,'prov-supervisor','antigravity','runtime.turn.usage','running_turn',
    'step','{"tokens":{"input":100,"output":20,"total":120},"cost":0.5}');
  PERFORM append_runtime_activity_event(v_impl.id,'prov-supervisor','antigravity','runtime.turn.usage','running_turn',
    'step','{"tokens":{"input":50,"output":10,"total":60},"cost":0.25}');

  SELECT jsonb_object_agg(u->>'runtime_type', u) INTO v_usage FROM conversation_runtime_usage(v_project,v_task,v_user) u;
  IF v_usage->'antigravity'->>'attempts'<>'1' OR v_usage->'antigravity'->>'total_tokens'<>'180'
     OR v_usage ? 'opencode' OR v_usage->'codex'->>'attempts'<>'2' THEN
    RAISE EXCEPTION 'usage is not attributed by what ran: %', v_usage;
  END IF;
  IF (SELECT count(*) FROM conversation_runtime_usage(v_project,v_task,gen_random_uuid()))<>0 THEN
    RAISE EXCEPTION 'usage was returned to someone who does not own the project';
  END IF;

  -- What the panel used to compute for the same task: attempts by job type,
  -- which names OpenCode for work OpenCode never did.
  SELECT jsonb_object_agg(runtime_type, attempts) INTO v_old FROM (
    SELECT CASE WHEN j.job_type='implementation_run' THEN 'opencode' ELSE 'codex' END AS runtime_type,
      sum(j.attempt_count) AS attempts
    FROM runtime_jobs j WHERE j.task_id=v_task GROUP BY 1) guessed;
  IF NOT (v_old ? 'opencode') THEN
    RAISE EXCEPTION 'fixture: the job-type guess should have named opencode here: %', v_old;
  END IF;

  -- A driver that does not declare interrupt: no Stop, and the request refused.
  UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp(),leased_by=NULL,leased_until=NULL WHERE id=v_impl.id;
  v_event:=append_event('chat.user_message',v_project,v_task,NULL,'user','operator',NULL,'prov-3','prov-3',
    'task',v_task,3,'{"content":"again"}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    VALUES(v_event.id,'orchestrator_turn',v_project,v_task,'{}') RETURNING * INTO v_job;
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('prov-worker',1,interval '5 minutes');
  PERFORM pg_temp.grant_for(v_claimed, v_orchestrator, 'read_only');
  PERFORM record_runtime_dispatch(v_claimed.id,'prov-worker',pg_temp.launch('codex','1.0.0',ARRAY['events.raw','sessions.create']));
  IF runtime_job_can_interrupt(v_claimed.id) THEN
    RAISE EXCEPTION 'a job whose driver declares no interrupt is shown as interruptible';
  END IF;
  PERFORM pg_temp.expect_reason(format($q$SELECT request_runtime_interrupt(%L,%L,'operator','stop','c')$q$, v_project, v_task),
    'run_command_unsupported', 'an interrupt of a runtime that declares none');
  IF EXISTS (SELECT 1 FROM run_commands WHERE job_id=v_claimed.id) THEN
    RAISE EXCEPTION 'a refused interrupt left a command';
  END IF;

  RAISE NOTICE 'provenance: one selection per job reused by its retry, a moved runtime supersedes it, nothing recorded changes; the Stop answer is the recorded driver''s; usage follows what ran, on a task whose executor is not the default';
END $$;

ROLLBACK;
