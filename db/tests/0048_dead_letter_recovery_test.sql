-- The way back from dead_letter (migration 0072, prework C2).
--
-- A job that died because its runtime was removed (the 3.8 path) is retried by
-- the operator, as the panel does it — as infra_web, through the two functions
-- it is granted and nothing else — and goes all the way to completed. On the
-- way: a retry while the runtime is still gone is refused by reason; the same
-- click twice is one answer and one job; the job's recorded selection is
-- reused when the host reports the same version and superseded when it does
-- not; a closed task, a busy workspace and a foreign owner are refused; and a
-- dismissal closes the job with the operator's reason.
--
-- And the mutation for the idempotency: with the lookup of the answer already
-- given switched off, the second click is no longer the same click.
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

-- As the panel: infra_web, and only for the one statement.
CREATE FUNCTION pg_temp.as_web(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  EXECUTE 'SET LOCAL ROLE infra_web';
  EXECUTE p_sql INTO v;
  EXECUTE 'RESET ROLE';
  RETURN v;
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'RESET ROLE';
  RAISE;
END $$;

CREATE FUNCTION pg_temp.web_reason(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN pg_temp.reason_of(format('SELECT pg_temp.as_web(%L)', p_sql));
END $$;

-- What the host reports, as the health snapshot writes it.
CREATE FUNCTION pg_temp.report(p_installed boolean, p_version text DEFAULT '1.18.31') RETURNS void LANGUAGE sql AS $$
  INSERT INTO runtime_health(singleton,status,snapshot,observed_at)
  VALUES(true,'healthy',jsonb_build_object('runtimes',jsonb_build_array(
    jsonb_build_object('runtime','codex','version','0.154.0','installed',true,'authenticated',true),
    jsonb_build_object('runtime','opencode','version',p_version,'installed',p_installed,'authenticated',p_installed))),
    clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE SET snapshot=EXCLUDED.snapshot,observed_at=EXCLUDED.observed_at;
$$;

CREATE FUNCTION pg_temp.launch(p_version text DEFAULT '1.18.31') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('runtime','opencode','adapter_version','opencode-1','runtime_version',p_version,
    'verified_runtime_version',p_version,'capability_verification','verified','executable','opencode',
    'surface','task','capabilities',jsonb_build_array('interrupt','session.resume','tools.worker_report'));
$$;

-- A delegated task whose implementation died because OpenCode was removed
-- under its launch: launched once (so its selection is recorded), then the
-- host reports the runtime gone and the worker reports the failure.
CREATE FUNCTION pg_temp.dead_letter(p_tag text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_user uuid; v_project uuid; v_codex_profile uuid; v_executor_profile uuid; v_codex uuid; v_worker uuid;
  v_orchestrator uuid; v_executor uuid; v_session uuid; v_task uuid; v_request jsonb; v_message outbox_messages;
  v_job runtime_jobs; v_start jsonb; v_attempt jsonb;
BEGIN
  PERFORM pg_temp.report(true);
  INSERT INTO users(display_name) VALUES('Dead '||p_tag) RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Dead '||p_tag,'dead-'||p_tag,'/srv/infra-cod/workspaces/dead-'||p_tag) RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-'||p_tag) RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','opencode-'||p_tag) RETURNING id INTO v_executor_profile;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('dead-codex-'||p_tag,'architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('dead-worker-'||p_tag,'implementer',v_executor_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING id INTO v_orchestrator;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_executor_profile,'executor') RETURNING id INTO v_executor;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,native_session_id)
    VALUES(v_project,v_worker,v_executor_profile,'implementation','ses_dead_'||p_tag) RETURNING id INTO v_session;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by,acceptance_criteria)
    VALUES(v_project,'Dead '||p_tag,'test','ready',v_codex,v_orchestrator,'test','["done"]') RETURNING id INTO v_task;
  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]','[]',
    '/srv/infra-cod/workspaces/dead-'||p_tag,'delegate:'||v_task,1,v_task::text);
  UPDATE handoffs SET executor_assignment_id=v_executor WHERE id=(v_request->>'handoff_id')::uuid;
  v_message:=claim_outbox_event((v_request->>'event_id')::uuid,'dead-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'dead-dispatcher');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','dead-supervisor',interval '1 minute');
  v_start:=start_implementation_job(v_job.id,v_session,'dead-supervisor',interval '1 minute');
  PERFORM issue_workspace_access_grant(v_job.id,'dead-supervisor');
  v_attempt:=record_runtime_dispatch(v_job.id,'dead-supervisor',pg_temp.launch());
  PERFORM finish_runtime_dispatch_attempt((v_attempt->>'attempt_id')::bigint,'dead-supervisor','{"status":"exited","exit_code":127}','');
  PERFORM pg_temp.report(false);
  IF retry_runtime_job(v_job.id,'dead-supervisor','OpenCode exited with code 127',interval '15 seconds',3) <> 'dead_letter' THEN
    RAISE EXCEPTION 'fixture: the job whose runtime was removed did not die';
  END IF;
  RETURN jsonb_build_object('project',v_project,'owner',v_user,'task',v_task,'job',v_job.id,'session',v_session,
    'worker',v_worker,'event',v_request->>'event_id','run',v_start->>'run_id',
    'selection',v_attempt->>'selection_id','attempt',(SELECT attempt_count FROM runtime_jobs WHERE id=v_job.id));
END $$;

CREATE FUNCTION pg_temp.retry_sql(f jsonb, p_note text DEFAULT 'Runtime restored; retrying',
  p_owner uuid DEFAULT NULL, p_attempt integer DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT retry_dead_letter_job(%s,%s,%L,%L,%L,%L)', f->>'job', COALESCE(p_attempt,(f->>'attempt')::integer),
    COALESCE(p_owner,(f->>'owner')::uuid), 'operator-'||(f->>'owner'), p_note, 'corr-'||(f->>'job'));
$$;
CREATE FUNCTION pg_temp.dismiss_sql(f jsonb, p_note text DEFAULT 'Superseded by a new task; closing') RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT dismiss_dead_letter_job(%s,%s,%L,%L,%L,%L)', f->>'job', (f->>'attempt')::integer,
    (f->>'owner')::uuid, 'operator-'||(f->>'owner'), p_note, 'corr-'||(f->>'job'));
$$;

-- ------------------------------------------------------------------ retry to completed
DO $$
DECLARE f jsonb; v_first jsonb; v_second jsonb; v_job runtime_jobs; v_start jsonb; v_attempt jsonb;
  v_report jsonb; v_complete jsonb; v_reason text;
BEGIN
  f:=pg_temp.dead_letter('complete');
  IF (SELECT failure_reason FROM runtime_jobs WHERE id=(f->>'job')::bigint) IS DISTINCT FROM 'runtime_not_provisioned' THEN
    RAISE EXCEPTION 'fixture: the dead letter does not say its runtime was removed';
  END IF;

  -- Still gone: there is nothing to retry into.
  v_reason:=pg_temp.web_reason(pg_temp.retry_sql(f));
  IF v_reason IS DISTINCT FROM 'runtime_not_provisioned' THEN
    RAISE EXCEPTION 'a retry while the runtime is still removed was %, not refused as runtime_not_provisioned', COALESCE(v_reason,'accepted');
  END IF;
  -- Someone else's job is not found, whoever asks.
  v_reason:=pg_temp.web_reason(pg_temp.retry_sql(f, p_owner => gen_random_uuid()));
  IF v_reason IS DISTINCT FROM 'dead_letter_not_found' THEN RAISE EXCEPTION 'a foreign owner got %', v_reason; END IF;
  v_reason:=pg_temp.web_reason(pg_temp.retry_sql(f, p_note => ' '));
  IF v_reason IS DISTINCT FROM 'dead_letter_note_invalid' THEN RAISE EXCEPTION 'a retry without a reason got %', v_reason; END IF;

  -- The runtime is back at the version the job recorded.
  PERFORM pg_temp.report(true);
  v_first:=pg_temp.as_web(pg_temp.retry_sql(f));
  v_second:=pg_temp.as_web(pg_temp.retry_sql(f));
  IF (v_first->>'repeat')::boolean OR NOT (v_second->>'repeat')::boolean
     OR v_first->>'recovery_id' IS DISTINCT FROM v_second->>'recovery_id' THEN
    RAISE EXCEPTION 'the same click twice was not one answer: % then %', v_first, v_second;
  END IF;
  IF (SELECT count(*) FROM runtime_jobs WHERE source_event_id=(f->>'event')::uuid) <> 1
     OR (SELECT count(*) FROM runtime_job_recoveries WHERE job_id=(f->>'job')::bigint) <> 1 THEN
    RAISE EXCEPTION 'a double click made a second job or a second recovery';
  END IF;
  IF (v_first->>'selection_superseded')::boolean OR v_first->>'selection_id' IS DISTINCT FROM f->>'selection' THEN
    RAISE EXCEPTION 'the same runtime version did not reuse the recorded selection: %', v_first;
  END IF;
  SELECT * INTO v_job FROM runtime_jobs WHERE id=(f->>'job')::bigint;
  IF v_job.status<>'pending' OR v_job.failure_reason IS NOT NULL OR v_job.run_id IS NOT NULL
     OR v_job.attempt_base<>v_job.attempt_count THEN
    RAISE EXCEPTION 'the retried job is not back in the queue, clean, with a fresh budget: %', to_jsonb(v_job);
  END IF;
  IF (SELECT status FROM tasks WHERE id=(f->>'task')::uuid) <> 'implementation_requested' THEN
    RAISE EXCEPTION 'the task is not waiting for its implementation again';
  END IF;
  IF (SELECT count(*) FROM runtime_jobs WHERE status='dead_letter' AND resolved_at IS NULL AND id=(f->>'job')::bigint) <> 0 THEN
    RAISE EXCEPTION 'the retried job still counts as a dead letter';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_events WHERE action='runtime_job.retried' AND target_id=f->>'job'
                 AND actor_id='operator-'||(f->>'owner')) THEN
    RAISE EXCEPTION 'the retry does not record who did it';
  END IF;

  -- And it runs to completed: a new run under a new lock, the same selection.
  v_job:=claim_runtime_job_for_event((f->>'event')::uuid,'implementation_run','dead-supervisor-2',interval '1 minute');
  v_start:=start_implementation_job(v_job.id,(f->>'session')::uuid,'dead-supervisor-2',interval '1 minute');
  IF v_start->>'run_id' = f->>'run' THEN RAISE EXCEPTION 'the retry was handed the dead run back'; END IF;
  PERFORM issue_workspace_access_grant(v_job.id,'dead-supervisor-2');
  v_attempt:=record_runtime_dispatch(v_job.id,'dead-supervisor-2',pg_temp.launch());
  IF NOT (v_attempt->>'selection_reused')::boolean OR v_attempt->>'selection_id' IS DISTINCT FROM f->>'selection' THEN
    RAISE EXCEPTION 'the retried launch did not run under the recorded selection: %', v_attempt;
  END IF;
  v_report:=submit_worker_completion((f->>'project')::uuid,(f->>'task')::uuid,(v_start->>'run_id')::uuid,(f->>'worker')::uuid,
    (v_start->>'fencing_token')::bigint,'ses_dead_complete','{"changed_files":[]}','{"unit":"passed"}',NULL,
    'complete:'||(v_start->>'run_id'));
  v_complete:=finalize_worker_completion((v_report->>'report_id')::uuid,v_job.id,'dead-supervisor-2');
  PERFORM acknowledge_runtime_job(v_job.id,'dead-supervisor-2',v_complete);
  IF (SELECT status FROM runtime_jobs WHERE id=v_job.id) <> 'completed'
     OR (SELECT status FROM tasks WHERE id=(f->>'task')::uuid) <> 'awaiting_review'
     OR (SELECT status FROM workspace_locks WHERE project_id=(f->>'project')::uuid) <> 'released' THEN
    RAISE EXCEPTION 'the retried job did not reach completed: job %, task %, lock %',
      (SELECT status FROM runtime_jobs WHERE id=v_job.id), (SELECT status FROM tasks WHERE id=(f->>'task')::uuid),
      (SELECT status FROM workspace_locks WHERE project_id=(f->>'project')::uuid);
  END IF;
  -- A late click on the old card still gets its answer, not a second retry.
  IF NOT (pg_temp.as_web(pg_temp.retry_sql(f))->>'repeat')::boolean THEN
    RAISE EXCEPTION 'a late click on the answered card was not a repeat';
  END IF;
  RAISE NOTICE 'a dead letter retried by the operator reaches completed, once, under its recorded selection';
END $$;

-- ------------------------------------------------------------------ a moved runtime
DO $$
DECLARE f jsonb; v jsonb; v_new runtime_job_selections;
BEGIN
  f:=pg_temp.dead_letter('moved');
  PERFORM pg_temp.report(true, '1.19.0');
  v:=pg_temp.as_web(pg_temp.retry_sql(f));
  IF NOT (v->>'selection_superseded')::boolean THEN RAISE EXCEPTION 'a moved runtime reused the old selection: %', v; END IF;
  SELECT * INTO v_new FROM runtime_job_selections WHERE id=(v->>'selection_id')::bigint;
  IF v_new.supersedes::text IS DISTINCT FROM f->>'selection' OR v_new.runtime_version<>'1.19.0'
     OR v_new.supersede_reason NOT LIKE '%1.19.0%' OR v_new.supersede_reason NOT LIKE '%1.18.31%' THEN
    RAISE EXCEPTION 'the superseding selection does not name what moved: %', to_jsonb(v_new);
  END IF;
  IF (SELECT runtime_version FROM runtime_job_selections WHERE id=(f->>'selection')::bigint) <> '1.18.31' THEN
    RAISE EXCEPTION 'the recorded selection was changed instead of superseded';
  END IF;
  RAISE NOTICE 'a retry onto a moved runtime supersedes the selection and names both versions';
END $$;

-- ------------------------------------------------------------------ refusals
DO $$
DECLARE f jsonb; g jsonb; v_reason text; v_run uuid;
BEGIN
  -- The task was closed meanwhile.
  f:=pg_temp.dead_letter('closed');
  PERFORM pg_temp.report(true);
  UPDATE tasks SET status='approved',version=version+1 WHERE id=(f->>'task')::uuid;
  v_reason:=pg_temp.web_reason(pg_temp.retry_sql(f));
  IF v_reason IS DISTINCT FROM 'dead_letter_task_closed' THEN RAISE EXCEPTION 'a closed task got %', COALESCE(v_reason,'retried'); END IF;

  -- Another run holds the workspace.
  g:=pg_temp.dead_letter('busy');
  PERFORM pg_temp.report(true);
  INSERT INTO task_runs(task_id,agent_id,phase,status,write_capable)
    VALUES((g->>'task')::uuid,(g->>'worker')::uuid,'implementation','starting',true) RETURNING id INTO v_run;
  PERFORM acquire_workspace_lock((g->>'project')::uuid,v_run,'implementation',interval '5 minutes');
  v_reason:=pg_temp.web_reason(pg_temp.retry_sql(g));
  IF v_reason IS DISTINCT FROM 'dead_letter_workspace_busy' THEN RAISE EXCEPTION 'a busy workspace got %', COALESCE(v_reason,'retried'); END IF;
  -- Nothing was changed by either refusal.
  IF (SELECT count(*) FROM runtime_job_recoveries WHERE job_id IN ((f->>'job')::bigint,(g->>'job')::bigint)) <> 0
     OR (SELECT count(*) FROM runtime_jobs WHERE id IN ((f->>'job')::bigint,(g->>'job')::bigint) AND status='dead_letter') <> 2 THEN
    RAISE EXCEPTION 'a refused retry left something behind';
  END IF;
  RAISE NOTICE 'a closed task and a busy workspace are refused by reason, and nothing changes';
END $$;

-- ------------------------------------------------------------------ dismiss
DO $$
DECLARE f jsonb; v jsonb; v_reason text;
BEGIN
  f:=pg_temp.dead_letter('dismiss');
  v_reason:=pg_temp.web_reason(pg_temp.dismiss_sql(f, 'no'));
  IF v_reason IS DISTINCT FROM 'dead_letter_note_invalid' THEN RAISE EXCEPTION 'a dismissal without a reason got %', v_reason; END IF;
  v:=pg_temp.as_web(pg_temp.dismiss_sql(f));
  IF (v->>'repeat')::boolean OR (SELECT resolved_at IS NULL FROM runtime_jobs WHERE id=(f->>'job')::bigint) THEN
    RAISE EXCEPTION 'the dismissal did not close the dead letter: %', v;
  END IF;
  IF NOT (pg_temp.as_web(pg_temp.dismiss_sql(f))->>'repeat')::boolean THEN RAISE EXCEPTION 'a second dismissal was not a repeat'; END IF;
  PERFORM pg_temp.report(true);
  v_reason:=pg_temp.web_reason(pg_temp.retry_sql(f));
  IF v_reason IS DISTINCT FROM 'dead_letter_already_handled' THEN RAISE EXCEPTION 'a retry after a dismissal got %', COALESCE(v_reason,'retried'); END IF;
  IF (SELECT recovered_from||'/'||note FROM runtime_job_recoveries WHERE job_id=(f->>'job')::bigint)
     IS DISTINCT FROM 'runtime_not_provisioned/Superseded by a new task; closing' THEN
    RAISE EXCEPTION 'the dismissal does not record what it answered and why';
  END IF;
  -- Recorded once: not edited afterwards.
  IF pg_temp.reason_of(format('UPDATE runtime_job_recoveries SET note=%L WHERE job_id=%s', 'rewritten', f->>'job'))
     IS DISTINCT FROM 'dead_letter_already_handled' THEN
    RAISE EXCEPTION 'a recovery record could be edited';
  END IF;
  RAISE NOTICE 'a dismissal closes the dead letter with the operator''s reason, once';
END $$;

-- ------------------------------------------------------------------ a turn
-- A Codex turn retried is a new attempt: a new run when it is claimed, the old
-- one left failed as the dead letter closed it.
DO $$
DECLARE f jsonb; v_event domain_events; v_job runtime_jobs; v_old uuid; v_claimed runtime_jobs; v jsonb;
BEGIN
  f:=pg_temp.dead_letter('turn');
  PERFORM pg_temp.report(true);
  UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp() WHERE id=(f->>'job')::bigint AND status='pending';
  UPDATE tasks SET version=version+1 WHERE id=(f->>'task')::uuid;
  v_event:=append_event('chat.user_message',(f->>'project')::uuid,(f->>'task')::uuid,NULL,'user','operator',NULL,
    'turn-'||(f->>'job'),'turn-'||(f->>'job'),'task',(f->>'task')::uuid,(SELECT version FROM tasks WHERE id=(f->>'task')::uuid),'{}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    VALUES(v_event.id,'orchestrator_turn',(f->>'project')::uuid,(f->>'task')::uuid,'{}') RETURNING * INTO v_job;
  v_job:=claim_runtime_job_for_event(v_event.id,'orchestrator_turn','turn-worker',interval '1 minute');
  v_old:=v_job.run_id;
  IF retry_runtime_job(v_job.id,'turn-worker','app-server exited',interval '0 seconds',1) <> 'dead_letter' THEN
    RAISE EXCEPTION 'fixture: the turn did not die';
  END IF;
  v:=pg_temp.as_web(format('SELECT retry_dead_letter_job(%s,%s,%L,%L,%L,%L)', v_job.id,
    (SELECT attempt_count FROM runtime_jobs WHERE id=v_job.id), f->>'owner', 'operator', 'Try the turn again', 'corr'));
  v_claimed:=claim_runtime_job_for_event(v_event.id,'orchestrator_turn','turn-worker-2',interval '1 minute');
  IF v_claimed.run_id IS NULL OR v_claimed.run_id=v_old
     OR (SELECT status||'/'||failure_code FROM task_runs WHERE id=v_old) <> 'failed/turn_dead_lettered' THEN
    RAISE EXCEPTION 'the retried turn is not a new run after the dead one: %', to_jsonb(v_claimed);
  END IF;
  RAISE NOTICE 'a retried Codex turn is a new run; the dead one stays failed';
END $$;

-- ------------------------------------------------------------------ mutation
-- Without the lookup of the answer already given, the second click is a
-- different answer: a refusal where the panel expected its own retry back.
DO $$
DECLARE f jsonb; v_reason text; v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
  WHERE p.proname='locked_dead_letter' AND p.pronamespace='control_plane'::regnamespace;
  IF position('IF o_recovery.id IS NOT NULL THEN' IN v_def) = 0 THEN
    RAISE EXCEPTION 'mutation: locked_dead_letter no longer has the lookup this removes';
  END IF;
  EXECUTE replace(v_def, 'IF o_recovery.id IS NOT NULL THEN', 'IF false THEN');
  f:=pg_temp.dead_letter('mutant');
  PERFORM pg_temp.report(true);
  PERFORM pg_temp.as_web(pg_temp.retry_sql(f));
  v_reason:=pg_temp.web_reason(pg_temp.retry_sql(f));
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'mutation survived: without the lookup the second click still got the same answer';
  END IF;
  EXECUTE v_def;
  RAISE NOTICE 'mutation: without the recorded answer a double click is refused instead of repeated (%)', v_reason;
END $$;

ROLLBACK;
