-- A reasoning level per team member (migration 0111).
--
-- What this file pins down:
--
--   * the runtime defaults keep a level for the orchestrator and for each
--     executor, by position; a level the model does not list is refused by
--     name (reasoning_effort_unsupported), '' is the runtime's default;
--   * a task's snapshot carries each member's level, and the executor's launch
--     reads it from there; a level the model stopped listing does not refuse
--     the task — the member runs at the default and the snapshot names the
--     level it dropped;
--   * the Team tab: adding an executor with a level; changing a model without
--     a level keeps the level when the new model lists it and resets it — and
--     says so — when it does not; a level alone, checked like the rest
--     (owner, version, the model's list); the tab's read of the levels;
--   * the level a launch sent is recorded on the job's selection beside the
--     model; a launch that sends none (the previous release) records none; a
--     retry with another level supersedes the selection and says why; a level
--     that is not a bounded token is refused.
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

CREATE TEMP TABLE fx(key text PRIMARY KEY, id uuid);

DO $$
DECLARE
  v_owner uuid; v_stranger uuid; v_project uuid; v_codex_connection uuid; v_zen uuid;
  v_codex_a uuid; v_codex_b uuid; v_free_a uuid; v_free_b uuid; v_free_c uuid;
  v_codex_profile uuid; v_opencode_profile uuid; v_codex uuid; v_worker uuid; v_orchestrator uuid; v_executor uuid;
BEGIN
  INSERT INTO users(display_name,role) VALUES('Levels owner','owner') RETURNING id INTO v_owner;
  INSERT INTO users(display_name,role) VALUES('Levels stranger','owner') RETURNING id INTO v_stranger;
  INSERT INTO projects(owner_id,name,slug,workspace_path,status)
    VALUES(v_owner,'Levels','levels','/srv/infra-cod/workspaces/levels','active') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status)
    VALUES(v_owner,'codex','device_code','connected') RETURNING id INTO v_codex_connection;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','native','connected','free','opencode-home:opencode-worker') RETURNING id INTO v_zen;

  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,status,last_verified_at,verification_id,reasoning_efforts)
    VALUES(v_owner,v_codex_connection,'codex','openai','levels-codex-a','codex_model_list','verified',clock_timestamp(),gen_random_uuid(),
      '[{"level":"low"},{"level":"medium","default":true},{"level":"high"}]') RETURNING id INTO v_codex_a;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,status,last_verified_at,verification_id,reasoning_efforts)
    VALUES(v_owner,v_codex_connection,'codex','openai','levels-codex-b','codex_model_list','verified',clock_timestamp(),gen_random_uuid(),
      '[{"level":"low"},{"level":"xhigh"}]') RETURNING id INTO v_codex_b;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,status,last_verified_at,verification_id,reasoning_efforts)
    VALUES(v_owner,v_zen,'opencode','opencode','levels-free-a','opencode_provider_api','verified',clock_timestamp(),gen_random_uuid(),'["high","max"]') RETURNING id INTO v_free_a;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_zen,'opencode','opencode','levels-free-b','opencode_provider_api','verified',clock_timestamp(),gen_random_uuid()) RETURNING id INTO v_free_b;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,status,last_verified_at,verification_id,reasoning_efforts)
    VALUES(v_owner,v_zen,'opencode','opencode','levels-free-c','opencode_provider_api','verified',clock_timestamp(),gen_random_uuid(),'["minimal","high"]') RETURNING id INTO v_free_c;

  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('codex','test','test','openai','levels',clock_timestamp()) RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('opencode','test','test','opencode','levels',clock_timestamp()) RETURNING id INTO v_opencode_profile;
  INSERT INTO agents(name,runtime_profile_id) VALUES('levels-codex',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,runtime_profile_id) VALUES('levels-worker',v_opencode_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,is_default,created_at)
    VALUES(v_project,v_codex,v_codex_profile,(SELECT id FROM role_definitions WHERE builtin_key='orchestrator'),true,clock_timestamp())
    RETURNING id INTO v_orchestrator;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,created_at)
    VALUES(v_project,v_worker,v_opencode_profile,(SELECT id FROM role_definitions WHERE builtin_key='executor'),clock_timestamp())
    RETURNING id INTO v_executor;

  INSERT INTO runtime_health(singleton,status,snapshot,observed_at) VALUES(true,'healthy',
    jsonb_build_object('type','health.snapshot','status','healthy','runtimes',jsonb_build_array(
      jsonb_build_object('runtime','codex','version','0.158.0','installed',true,'authenticated',true,'capability_verified',false,'ready',false),
      jsonb_build_object('runtime','opencode','version','1.18.32','installed',true,'authenticated',true,'capability_verified',false,'ready',false))),
    clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE SET status=EXCLUDED.status,snapshot=EXCLUDED.snapshot,observed_at=EXCLUDED.observed_at;

  INSERT INTO fx VALUES ('owner',v_owner),('stranger',v_stranger),('project',v_project),
    ('codex_a',v_codex_a),('codex_b',v_codex_b),('free_a',v_free_a),('free_b',v_free_b),('free_c',v_free_c),
    ('orchestrator',v_orchestrator),('executor',v_executor),('codex_agent',v_codex),('worker_agent',v_worker);
END $$;

CREATE FUNCTION pg_temp.f(p_key text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM fx WHERE key=p_key $$;
CREATE FUNCTION pg_temp.v() RETURNS bigint LANGUAGE sql AS $$ SELECT version FROM project_runtime_defaults WHERE project_id=pg_temp.f('project') $$;
CREATE FUNCTION pg_temp.task() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_task uuid := gen_random_uuid();
BEGIN
  INSERT INTO tasks(id,project_id,title,objective,status,created_by,orchestrator_assignment_id,active_agent_id)
    VALUES(v_task,pg_temp.f('project'),'Levels','t','planning','test',pg_temp.f('orchestrator'),pg_temp.f('worker_agent'));
  RETURN v_task;
END $$;

DO $$
DECLARE v_reason text; v_result jsonb; v_task uuid; v_snapshot jsonb; v_executor jsonb; v_defaults jsonb; v_read jsonb;
  v_new uuid; v_job bigint; v_level text;
BEGIN
  -- ------------------------------------------------ the runtime defaults
  v_reason:=pg_temp.reason_of(format($q$SELECT set_project_runtime_defaults(%L,%L,1,%L,ARRAY[%L]::uuid[],'medium','','o','c',ARRAY['ultra'])$q$,
    pg_temp.f('project'), pg_temp.f('owner'), pg_temp.f('codex_a'), pg_temp.f('free_a')));
  IF v_reason IS DISTINCT FROM 'reasoning_effort_unsupported' THEN RAISE EXCEPTION 'an executor level its model does not list was saved: %', v_reason; END IF;
  v_reason:=pg_temp.reason_of(format($q$SELECT set_project_runtime_defaults(%L,%L,1,%L,ARRAY[%L]::uuid[],'medium','','o','c',ARRAY['high','max'])$q$,
    pg_temp.f('project'), pg_temp.f('owner'), pg_temp.f('codex_a'), pg_temp.f('free_a')));
  IF v_reason IS DISTINCT FROM 'runtime_defaults_invalid' THEN RAISE EXCEPTION 'more levels than executors were accepted: %', v_reason; END IF;
  PERFORM set_project_runtime_defaults(pg_temp.f('project'), pg_temp.f('owner'), 1, pg_temp.f('codex_a'),
    ARRAY[pg_temp.f('free_a')], 'medium', '', 'o', 'c', ARRAY['max']);
  IF (SELECT reasoning_effort FROM project_runtime_default_executors WHERE project_id=pg_temp.f('project'))<>'max' THEN
    RAISE EXCEPTION 'the executor level was not saved';
  END IF;
  -- The previous release's nine arguments: every executor at the default.
  PERFORM set_project_runtime_defaults(pg_temp.f('project'), pg_temp.f('owner'), pg_temp.v(), pg_temp.f('codex_a'),
    ARRAY[pg_temp.f('free_a')], 'medium', '', 'o', 'c');
  IF (SELECT reasoning_effort FROM project_runtime_default_executors WHERE project_id=pg_temp.f('project'))<>'' THEN
    RAISE EXCEPTION 'the old call did not mean the runtime default';
  END IF;
  PERFORM set_project_runtime_defaults(pg_temp.f('project'), pg_temp.f('owner'), pg_temp.v(), pg_temp.f('codex_a'),
    ARRAY[pg_temp.f('free_a')], 'medium', '', 'o', 'c', ARRAY['max']);

  v_defaults:=get_project_runtime_defaults(pg_temp.f('project'), pg_temp.f('owner'));
  IF v_defaults->'orchestrator'->>'reasoning_effort'<>'medium' OR v_defaults->'executors'->0->>'reasoning_effort'<>'max'
     OR (v_defaults->'executors'->0->>'reasoning_supported')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'the defaults read does not carry each level: %', v_defaults;
  END IF;

  -- ------------------------------------------------ the snapshot and the launch
  v_task:=pg_temp.task();
  v_snapshot:=capture_task_runtime_snapshot(v_task, pg_temp.f('project'));
  IF v_snapshot->'orchestrator'->>'reasoning_effort'<>'medium' OR v_snapshot->'executors'->0->>'reasoning_effort'<>'max' THEN
    RAISE EXCEPTION 'the snapshot does not carry each member''s level: %', v_snapshot;
  END IF;
  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority,enabled)
    VALUES(v_task,pg_temp.f('executor'),100,true) ON CONFLICT DO NOTHING;
  WITH h AS (
    INSERT INTO handoffs(task_id,from_agent_id,to_agent_id,revision_number,objective,instructions,constraints,
      acceptance_criteria,relevant_paths,workspace_ref,executor_assignment_id)
    VALUES(v_task,pg_temp.f('codex_agent'),pg_temp.f('worker_agent'),1,'Levels','[]','[]','[]','[]',
      '/srv/infra-cod/workspaces/levels',pg_temp.f('executor'))
    RETURNING id
  ), e AS (
    INSERT INTO domain_events(event_type,project_id,task_id,actor_type,actor_id,correlation_id,aggregate_type,aggregate_id,aggregate_version,payload)
    SELECT 'implementation.requested',pg_temp.f('project'),v_task,'system','levels','levels-corr','task',v_task,1,
      jsonb_build_object('handoff_id',h.id) FROM h
    RETURNING id
  )
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
  SELECT id,'implementation_run',pg_temp.f('project'),v_task,'{}' FROM e RETURNING id INTO v_job;
  IF resolve_executor_launch_model(v_job)->>'reasoning_effort' IS DISTINCT FROM 'max' THEN
    RAISE EXCEPTION 'the executor launch does not read its level from the snapshot: %', resolve_executor_launch_model(v_job);
  END IF;

  -- The model stops listing the level: the next task runs at the default, and says what it dropped.
  UPDATE provider_model_catalog SET reasoning_efforts='["high"]' WHERE id=pg_temp.f('free_a');
  v_defaults:=get_project_runtime_defaults(pg_temp.f('project'), pg_temp.f('owner'));
  IF (v_defaults->'executors'->0->>'reasoning_supported')::boolean IS NOT FALSE
     OR (v_defaults->'executors'->0->>'available')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'a level no longer listed is not shown as such, or takes the model with it: %', v_defaults->'executors';
  END IF;
  v_snapshot:=capture_task_runtime_snapshot(pg_temp.task(), pg_temp.f('project'));
  v_executor:=v_snapshot->'executors'->0;
  IF v_executor->>'reasoning_effort'<>'' OR v_executor->>'reasoning_effort_dropped'<>'max' THEN
    RAISE EXCEPTION 'a level no longer listed was not dropped and named: %', v_executor;
  END IF;
  UPDATE provider_model_catalog SET reasoning_efforts='["high","max"]' WHERE id=pg_temp.f('free_a');

  -- ------------------------------------------------ the Team tab
  -- A model change without a level: kept where listed, reset and said where not.
  v_result:=change_project_assignment_model(pg_temp.f('project'), pg_temp.f('owner'), pg_temp.v(), pg_temp.f('orchestrator'),
    pg_temp.f('codex_b'), 'o', 'c');
  IF v_result->>'reasoning_effort_reset' IS DISTINCT FROM 'medium' OR v_result->>'reasoning_effort' IS NOT NULL
     OR (SELECT reasoning_effort FROM project_runtime_defaults WHERE project_id=pg_temp.f('project'))<>'' THEN
    RAISE EXCEPTION 'a level the new model does not list was not reset, or not reported: %', v_result;
  END IF;
  v_reason:=pg_temp.reason_of(format($q$SELECT change_project_assignment_model(%L,%L,%s,%L,%L,'o','c','medium')$q$,
    pg_temp.f('project'), pg_temp.f('owner'), pg_temp.v(), pg_temp.f('orchestrator'), pg_temp.f('codex_b')));
  IF v_reason IS DISTINCT FROM 'reasoning_effort_unsupported' THEN RAISE EXCEPTION 'an unlisted level came with a model: %', v_reason; END IF;
  v_result:=change_project_assignment_model(pg_temp.f('project'), pg_temp.f('owner'), pg_temp.v(), pg_temp.f('orchestrator'),
    pg_temp.f('codex_a'), 'o', 'c', 'high');
  IF v_result->>'reasoning_effort' IS DISTINCT FROM 'high' OR v_result->>'reasoning_effort_reset' IS NOT NULL THEN
    RAISE EXCEPTION 'a model with its level: %', v_result;
  END IF;
  -- An executor keeps a level the new model lists.
  v_result:=change_project_assignment_model(pg_temp.f('project'), pg_temp.f('owner'), pg_temp.v(), pg_temp.f('executor'),
    pg_temp.f('free_c'), 'o', 'c');
  IF v_result->>'reasoning_effort_reset' IS DISTINCT FROM 'max' THEN RAISE EXCEPTION 'executor reset not reported: %', v_result; END IF;
  PERFORM set_project_assignment_reasoning(pg_temp.f('project'), pg_temp.f('owner'), pg_temp.v(), pg_temp.f('executor'), 'high', 'o', 'c');
  v_result:=change_project_assignment_model(pg_temp.f('project'), pg_temp.f('owner'), pg_temp.v(), pg_temp.f('executor'),
    pg_temp.f('free_a'), 'o', 'c');
  IF v_result->>'reasoning_effort' IS DISTINCT FROM 'high' OR v_result->>'reasoning_effort_reset' IS NOT NULL
     OR (SELECT reasoning_effort FROM project_runtime_default_executors WHERE project_id=pg_temp.f('project') AND catalog_entry_id=pg_temp.f('free_a'))<>'high' THEN
    RAISE EXCEPTION 'a level the new model lists was not kept: %', v_result;
  END IF;

  -- The level alone.
  v_reason:=pg_temp.reason_of(format($q$SELECT set_project_assignment_reasoning(%L,%L,%s,%L,'minimal','o','c')$q$,
    pg_temp.f('project'), pg_temp.f('owner'), pg_temp.v(), pg_temp.f('executor')));
  IF v_reason IS DISTINCT FROM 'reasoning_effort_unsupported' THEN RAISE EXCEPTION 'an unlisted level alone: %', v_reason; END IF;
  v_reason:=pg_temp.reason_of(format($q$SELECT set_project_assignment_reasoning(%L,%L,1,%L,'max','o','c')$q$,
    pg_temp.f('project'), pg_temp.f('owner'), pg_temp.f('executor')));
  IF v_reason IS DISTINCT FROM 'runtime_defaults_version_stale' THEN RAISE EXCEPTION 'a stale card set a level: %', v_reason; END IF;
  v_reason:=pg_temp.reason_of(format($q$SELECT set_project_assignment_reasoning(%L,%L,%s,%L,'max','o','c')$q$,
    pg_temp.f('project'), pg_temp.f('stranger'), pg_temp.v(), pg_temp.f('executor')));
  IF v_reason IS DISTINCT FROM 'project_unavailable' THEN RAISE EXCEPTION 'a stranger set a level: %', v_reason; END IF;
  v_result:=set_project_assignment_reasoning(pg_temp.f('project'), pg_temp.f('owner'), pg_temp.v(), pg_temp.f('executor'), '', 'o', 'c');
  IF v_result->>'reasoning_effort' IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM audit_events WHERE action='project.team_changed' AND details->>'change'='reasoning_changed') THEN
    RAISE EXCEPTION 'the default was not set, or not audited: %', v_result;
  END IF;

  -- Adding an executor with its level.
  v_reason:=pg_temp.reason_of(format($q$SELECT add_project_executor(%L,%L,%s,%L,'o','c','high')$q$,
    pg_temp.f('project'), pg_temp.f('owner'), pg_temp.v(), pg_temp.f('free_b')));
  IF v_reason IS DISTINCT FROM 'reasoning_effort_unsupported' THEN RAISE EXCEPTION 'a level added with a model that lists none: %', v_reason; END IF;
  v_result:=add_project_executor(pg_temp.f('project'), pg_temp.f('owner'), pg_temp.v(), pg_temp.f('free_c'), 'o', 'c', 'minimal');
  v_new:=(v_result->>'assignment_id')::uuid;
  IF v_result->>'reasoning_effort' IS DISTINCT FROM 'minimal' THEN RAISE EXCEPTION 'the new executor''s level: %', v_result; END IF;

  -- The tab's read.
  v_read:=project_team_reasoning(pg_temp.f('project'), pg_temp.f('owner'));
  SELECT a->>'reasoning_effort' INTO v_level FROM jsonb_array_elements(v_read->'assignments') a WHERE a->>'assignment_id'=v_new::text;
  IF v_level IS DISTINCT FROM 'minimal'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_read->'assignments') a
                    WHERE a->>'assignment_id'=pg_temp.f('orchestrator')::text AND a->>'reasoning_effort'='high')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_read->'models') m
                    WHERE m->>'entry_id'=pg_temp.f('codex_a')::text AND m->>'default'='medium' AND jsonb_array_length(m->'levels')=3)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_read->'models') m WHERE m->>'entry_id'=pg_temp.f('free_b')::text) THEN
    RAISE EXCEPTION 'the tab''s read of the levels: %', v_read;
  END IF;
  IF pg_temp.reason_of(format('SELECT project_team_reasoning(%L,%L)', pg_temp.f('project'), pg_temp.f('stranger')))<>'project_unavailable' THEN
    RAISE EXCEPTION 'a stranger read the levels';
  END IF;

  IF NOT has_function_privilege('infra_web','set_project_assignment_reasoning(uuid,uuid,bigint,uuid,text,text,text)','EXECUTE')
     OR has_function_privilege('infra_web','assert_reasoning_effort(uuid,text)','EXECUTE')
     OR has_function_privilege('infra_worker','reasoning_effort_supported(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'reasoning function privileges are wrong';
  END IF;

  RAISE NOTICE 'each member''s level is saved, validated, snapshotted, launched, kept or reset with its model, and set alone';
END $$;

-- ------------------------------------------------ the launch's record
CREATE FUNCTION pg_temp.launch(p_level text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('runtime','codex','executable','codex','surface','project','adapter_version','1.0.0',
    'runtime_version','0.158.0','verified_runtime_version','0.154.0','capability_verification','unverified',
    'capabilities',jsonb_build_array('events.raw','interrupt','sessions.create'),'model','levels-codex-a')
    || CASE WHEN p_level IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reasoning_effort',p_level) END;
$$;
CREATE FUNCTION pg_temp.grant_for(p_job runtime_jobs, p_assignment uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO workspace_access_grants(token_sha256,project_id,job_id,run_id,assignment_id,mode,fencing_token,issued_to,expires_at)
  VALUES(digest(gen_random_uuid()::text,'sha256'),p_job.project_id,p_job.id,p_job.run_id,p_assignment,'read_only',
    NULL,'levels-test',clock_timestamp()+interval '10 minutes');
$$;

DO $$
DECLARE v_task uuid; v_event domain_events; v_job runtime_jobs; v_claimed runtime_jobs; v_first jsonb; v_second jsonb;
  v_selection runtime_job_selections; v_reason text;
BEGIN
  v_task:=pg_temp.task();
  v_event:=append_event('chat.user_message',pg_temp.f('project'),v_task,NULL,'user','operator',NULL,'levels-1','levels-1',
    'task',v_task,1,'{"content":"hello"}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    VALUES(v_event.id,'orchestrator_turn',pg_temp.f('project'),v_task,'{}') RETURNING * INTO v_job;
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('levels-worker',1,interval '5 minutes');
  IF v_claimed.id IS DISTINCT FROM v_job.id THEN RAISE EXCEPTION 'fixture: the turn was not claimed'; END IF;
  PERFORM pg_temp.grant_for(v_claimed, pg_temp.f('orchestrator'));

  v_reason:=pg_temp.reason_of(format($q$SELECT record_runtime_dispatch(%s,'levels-worker',%L::jsonb)$q$,
    v_claimed.id, pg_temp.launch('high --yolo')));
  IF v_reason IS DISTINCT FROM 'runtime_selection_invalid' THEN RAISE EXCEPTION 'a level that is not a token was recorded: %', v_reason; END IF;

  -- The previous release sends none, and none is recorded.
  v_first:=record_runtime_dispatch(v_claimed.id,'levels-worker',pg_temp.launch(NULL));
  SELECT * INTO v_selection FROM runtime_job_selections WHERE id=(v_first->>'selection_id')::bigint;
  IF v_selection.reasoning_effort IS NOT NULL OR v_selection.model<>'levels-codex-a' THEN
    RAISE EXCEPTION 'a launch without a level recorded one: %', to_jsonb(v_selection);
  END IF;
  -- This release sends the snapshot's: another selection, and why.
  v_second:=record_runtime_dispatch(v_claimed.id,'levels-worker',pg_temp.launch('high'));
  SELECT * INTO v_selection FROM runtime_job_selections WHERE id=(v_second->>'selection_id')::bigint;
  IF v_selection.reasoning_effort IS DISTINCT FROM 'high' OR v_selection.supersedes IS DISTINCT FROM (v_first->>'selection_id')::bigint
     OR v_selection.supersede_reason NOT LIKE '%reasoning level default -> high%' OR v_second->>'reasoning_effort'<>'high' THEN
    RAISE EXCEPTION 'the level was not recorded beside the model, superseding the first: %', to_jsonb(v_selection);
  END IF;
  -- The same level again reuses it.
  IF NOT (record_runtime_dispatch(v_claimed.id,'levels-worker',pg_temp.launch('high'))->>'selection_reused')::boolean THEN
    RAISE EXCEPTION 'the same level did not reuse the selection';
  END IF;

  RAISE NOTICE 'the level a launch sent is recorded beside its model';
END $$;

ROLLBACK;
