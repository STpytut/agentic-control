-- The operator closes a task (migration 0090).
--
-- What this file pins down:
--
--   * close_task makes an open task 'cancelled' at the version the panel
--     showed, bumps the version, says so in the conversation and the audit;
--   * its queued jobs end with task_closed and, with its earlier dead letters,
--     are marked handled;
--   * refused, by reason, for a stranger, a stale version, a task already
--     ended, and a task whose work is running — a job in flight or a run open.
--     (That a cancelled task no longer holds its executor is 0055's.)
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
  v_owner uuid; v_stranger uuid; v_project uuid; v_profile uuid; v_agent uuid; v_orchestrator uuid;
  v_executor uuid; v_task uuid; v_busy uuid; v_done uuid; v_event domain_events%ROWTYPE;
  v_pending bigint; v_old bigint; v_flight bigint; v_result jsonb; v_reason text;
BEGIN
  INSERT INTO users(display_name,role) VALUES('Close owner','owner') RETURNING id INTO v_owner;
  INSERT INTO users(display_name,role) VALUES('Close stranger','owner') RETURNING id INTO v_stranger;
  INSERT INTO projects(owner_id,name,slug,workspace_path,status)
    VALUES(v_owner,'Close','close-task','/srv/infra-cod/workspaces/close-task','active') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('opencode','test','test','opencode','close',clock_timestamp()) RETURNING id INTO v_profile;
  INSERT INTO agents(name,runtime_profile_id) VALUES('close-agent',v_profile) RETURNING id INTO v_agent;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,is_default,created_at)
    VALUES(v_project,v_agent,v_profile,(SELECT id FROM role_definitions WHERE builtin_key='orchestrator'),true,clock_timestamp())
    RETURNING id INTO v_orchestrator;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,created_at)
    VALUES(v_project,v_agent,v_profile,(SELECT id FROM role_definitions WHERE builtin_key='executor'),clock_timestamp())
    RETURNING id INTO v_executor;

  -- A stale conversation: bound to the first executor, a turn queued, an
  -- earlier turn dead-lettered.
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Stale','t','planning',v_agent,v_orchestrator,'test') RETURNING id INTO v_task;
  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority,enabled) VALUES(v_task,v_executor,100,true);
  v_event:=append_event('chat.user_message',v_project,v_task,NULL,'user','test',NULL,v_task::text,
    'close-1:'||v_task,'task',v_task,1,'{"content":"one"}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status,completed_at,failure_reason,last_error)
    VALUES(v_event.id,'orchestrator_turn',v_project,v_task,'dead_letter',clock_timestamp(),'model_access_revoked','gone')
    RETURNING id INTO v_old;
  v_event:=append_event('chat.user_message',v_project,v_task,NULL,'user','test',NULL,v_task::text,
    'close-2:'||v_task,'run',gen_random_uuid(),1,'{"content":"two"}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id)
    VALUES(v_event.id,'orchestrator_turn',v_project,v_task) RETURNING id INTO v_pending;

  v_reason:=pg_temp.reason_of(format('SELECT close_task(%L,%L,%L,1,''o'',''c'')', v_project, v_task, v_stranger));
  IF v_reason<>'task_unavailable' THEN RAISE EXCEPTION 'a stranger closed the task: %', v_reason; END IF;
  v_reason:=pg_temp.reason_of(format('SELECT close_task(%L,%L,%L,7,''o'',''c'')', v_project, v_task, v_owner));
  IF v_reason<>'task_version_stale' THEN RAISE EXCEPTION 'a stale card closed the task: %', v_reason; END IF;
  v_reason:=pg_temp.reason_of(format('SELECT close_task(%L,%L,%L,1,''o'',''c'')', gen_random_uuid(), v_task, v_owner));
  IF v_reason<>'task_unavailable' THEN RAISE EXCEPTION 'the task was closed through another project: %', v_reason; END IF;

  v_result:=close_task(v_project, v_task, v_owner, (SELECT version FROM tasks WHERE id=v_task), 'operator', 'c-close');
  IF v_result->>'status'<>'cancelled' OR (v_result->>'jobs_ended')::int<>1 OR (v_result->>'dead_letters_handled')::int<>2 THEN
    RAISE EXCEPTION 'close result: %', v_result;
  END IF;
  IF (SELECT status FROM tasks WHERE id=v_task)<>'cancelled' THEN RAISE EXCEPTION 'the task is not cancelled'; END IF;
  IF (SELECT failure_reason FROM runtime_jobs WHERE id=v_pending) IS DISTINCT FROM 'task_closed'
     OR EXISTS (SELECT 1 FROM runtime_jobs WHERE task_id=v_task AND (status IN ('pending','in_flight') OR resolved_at IS NULL)) THEN
    RAISE EXCEPTION 'the queued turn was not ended, or a dead letter was left open';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM domain_events WHERE task_id=v_task AND event_type='task.cancelled' AND payload ? 'message')
     OR NOT EXISTS (SELECT 1 FROM audit_events WHERE task_id=v_task AND action='task.closed') THEN
    RAISE EXCEPTION 'the close is not in the conversation or the audit';
  END IF;
  v_reason:=pg_temp.reason_of(format('SELECT close_task(%L,%L,%L,%s,''o'',''c'')', v_project, v_task, v_owner,
    (SELECT version FROM tasks WHERE id=v_task)));
  IF v_reason<>'task_already_closed' THEN RAISE EXCEPTION 'a closed task was closed again: %', v_reason; END IF;
  v_reason:=pg_temp.reason_of(format('SELECT retry_dead_letter_job(%s,%s,%L,''o'',''again'',''c'')',
    v_old, (SELECT attempt_count FROM runtime_jobs WHERE id=v_old), v_owner));
  IF v_reason IS NULL THEN RAISE EXCEPTION 'a dead letter of a closed task was retried'; END IF;

  -- Work running is not taken from under the worker.
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Busy','t','planning',v_agent,v_orchestrator,'test') RETURNING id INTO v_busy;
  v_event:=append_event('chat.user_message',v_project,v_busy,NULL,'user','test',NULL,v_busy::text,
    'close-3:'||v_busy,'task',v_busy,1,'{"content":"three"}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status,leased_by,leased_until)
    VALUES(v_event.id,'orchestrator_turn',v_project,v_busy,'in_flight','close-test',clock_timestamp()+interval '5 minutes')
    RETURNING id INTO v_flight;
  v_reason:=pg_temp.reason_of(format('SELECT close_task(%L,%L,%L,%s,''o'',''c'')', v_project, v_busy, v_owner,
    (SELECT version FROM tasks WHERE id=v_busy)));
  IF v_reason<>'task_work_in_flight' THEN RAISE EXCEPTION 'a task with a job in flight was closed: %', v_reason; END IF;
  IF (SELECT status FROM runtime_jobs WHERE id=v_flight)<>'in_flight' THEN RAISE EXCEPTION 'the refused close touched the job'; END IF;

  -- An approved task is done, not abandoned.
  INSERT INTO tasks(project_id,title,objective,status,created_by,orchestrator_assignment_id)
    VALUES(v_project,'Done','t','approved','test',v_orchestrator) RETURNING id INTO v_done;
  v_reason:=pg_temp.reason_of(format('SELECT close_task(%L,%L,%L,1,''o'',''c'')', v_project, v_done, v_owner));
  IF v_reason<>'task_already_closed' THEN RAISE EXCEPTION 'an approved task was closed: %', v_reason; END IF;

  -- Privileges: the web tier calls it.
  IF NOT has_function_privilege('infra_web','close_task(uuid,uuid,uuid,bigint,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'infra_web cannot close a task';
  END IF;

  RAISE NOTICE 'the operator closes an abandoned task, its queued work with it, and never one whose work runs';
END $$;

ROLLBACK;
