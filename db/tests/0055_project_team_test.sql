-- The project's team, changed from the panel (migration 0089, sprint C U2).
--
-- What this file pins down:
--
--   * project_team shows the assignments with their models, the built-in
--     roles with their permissions and the capabilities those need, and the
--     models an operator may pick for each role — a model whose connection is
--     not connected, or that is not verified, is not offered and is counted
--     under its reason;
--   * add_project_executor makes an executor whose model is the new last
--     default, so the next task's snapshot binds the new executor to it;
--   * change_project_assignment_model changes one assignment's model in its
--     own position, for the orchestrator and for an executor, and refuses
--     another runtime's model with the way to do it;
--   * disable_project_executor takes an executor out with its default, the
--     others keeping their models; refused for the last executor and for one
--     an open task is bound to;
--   * every write checks the owner and the version, bumps the version, and is
--     audited; a card left open across another change is refused;
--   * one model cannot be the default of two executors — refused by name.
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
  v_owner uuid; v_stranger uuid; v_project uuid;
  v_codex_connection uuid; v_zen uuid; v_router uuid;
  v_codex_a uuid; v_codex_b uuid; v_free_a uuid; v_free_b uuid; v_router_a uuid; v_unverified uuid; v_off uuid;
  v_codex_profile uuid; v_opencode_profile uuid; v_codex uuid; v_worker uuid; v_orchestrator uuid; v_executor uuid;
BEGIN
  INSERT INTO users(display_name,role) VALUES('Team owner','owner') RETURNING id INTO v_owner;
  INSERT INTO users(display_name,role) VALUES('Team stranger','owner') RETURNING id INTO v_stranger;
  INSERT INTO projects(owner_id,name,slug,workspace_path,status)
    VALUES(v_owner,'Team','team-u2','/srv/infra-cod/workspaces/team-u2','active') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;

  INSERT INTO provider_connections(operator_id,provider,auth_method,status)
    VALUES(v_owner,'codex','device_code','connected') RETURNING id INTO v_codex_connection;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','native','connected','free','opencode-home:opencode-worker') RETURNING id INTO v_zen;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,access_gateway,native_credential_reference)
    VALUES(v_owner,'opencode','api_key','action_required','third_party_metered','openrouter','opencode-home:opencode-worker') RETURNING id INTO v_router;

  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,display_name,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_codex_connection,'codex','openai','team-codex-a','Codex A','codex_model_list','verified',clock_timestamp(),gen_random_uuid()) RETURNING id INTO v_codex_a;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,display_name,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_codex_connection,'codex','openai','team-codex-b','Codex B','codex_model_list','verified',clock_timestamp(),gen_random_uuid()) RETURNING id INTO v_codex_b;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,display_name,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_zen,'opencode','opencode','team-free-a','Free A','opencode_provider_api','verified',clock_timestamp(),gen_random_uuid()) RETURNING id INTO v_free_a;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,display_name,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_zen,'opencode','opencode','team-free-b','Free B','opencode_provider_api','verified',clock_timestamp(),gen_random_uuid()) RETURNING id INTO v_free_b;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,display_name,discovery_source,status)
    VALUES(v_owner,v_zen,'opencode','opencode','team-free-c','Free C','opencode_provider_api','discovered') RETURNING id INTO v_unverified;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,display_name,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_router,'opencode','openrouter','openai/team-router','Router A','opencode_provider_api','verified',clock_timestamp(),gen_random_uuid()) RETURNING id INTO v_router_a;

  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('codex','test','test','openai','team',clock_timestamp()) RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('opencode','test','test','opencode','team',clock_timestamp()) RETURNING id INTO v_opencode_profile;
  INSERT INTO agents(name,runtime_profile_id) VALUES('team-codex',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,runtime_profile_id) VALUES('team-worker',v_opencode_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,is_default,created_at)
    VALUES(v_project,v_codex,v_codex_profile,(SELECT id FROM role_definitions WHERE builtin_key='orchestrator'),true,clock_timestamp())
    RETURNING id INTO v_orchestrator;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,created_at)
    VALUES(v_project,v_worker,v_opencode_profile,(SELECT id FROM role_definitions WHERE builtin_key='executor'),clock_timestamp())
    RETURNING id INTO v_executor;
  INSERT INTO project_runtime_defaults(project_id,orchestrator_entry_id,updated_by) VALUES(v_project,v_codex_a,'db-test');
  INSERT INTO project_runtime_default_executors(project_id,catalog_entry_id,priority) VALUES(v_project,v_free_a,100);

  -- A host reporting both runtimes ready now: a snapshot asks (0054, 0088).
  INSERT INTO runtime_health(singleton,status,snapshot,observed_at) VALUES(true,'healthy',
    jsonb_build_object('type','health.snapshot','status','healthy','runtimes',jsonb_build_array(
      jsonb_build_object('runtime','codex','version','0.154.0','installed',true,'authenticated',true,'capability_verified',false,'ready',false),
      jsonb_build_object('runtime','opencode','version','1.2.3','installed',true,'authenticated',true,'capability_verified',false,'ready',false))),
    clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE SET status=EXCLUDED.status,snapshot=EXCLUDED.snapshot,observed_at=EXCLUDED.observed_at;

  INSERT INTO fx VALUES ('owner',v_owner),('stranger',v_stranger),('project',v_project),
    ('codex_a',v_codex_a),('codex_b',v_codex_b),('free_a',v_free_a),('free_b',v_free_b),('router_a',v_router_a),
    ('unverified',v_unverified),('orchestrator',v_orchestrator),('executor',v_executor);
END $$;

CREATE FUNCTION pg_temp.f(p_key text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM fx WHERE key=p_key $$;
CREATE FUNCTION pg_temp.v() RETURNS bigint LANGUAGE sql AS $$ SELECT version FROM project_runtime_defaults WHERE project_id=pg_temp.f('project') $$;
-- The executors' models in snapshot order, as the snapshot pairs them.
CREATE FUNCTION pg_temp.pairs() RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(a.name||'='||COALESCE(m.model_id,'-'), ',' ORDER BY e.ordinal)
  FROM project_executor_positions(pg_temp.f('project')) e
  JOIN project_agent_assignments pa ON pa.id=e.assignment_id JOIN agents a ON a.id=pa.agent_id
  LEFT JOIN project_default_executor_positions(pg_temp.f('project')) d ON d.ordinal=e.ordinal
  LEFT JOIN provider_model_catalog m ON m.id=d.catalog_entry_id $$;

DO $$
DECLARE v_team jsonb; v_reason text; v_result jsonb; v_new uuid; v_before bigint; v_task uuid; v_snapshot jsonb; v_names text;
BEGIN
  -- The read.
  v_team:=project_team(pg_temp.f('project'), pg_temp.f('owner'));
  IF (v_team->>'managed')::boolean IS NOT TRUE OR (v_team->>'version')::bigint<>1 THEN RAISE EXCEPTION 'team read: %', v_team; END IF;
  IF jsonb_array_length(v_team->'assignments')<>2 THEN RAISE EXCEPTION 'two assignments expected: %', v_team->'assignments'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_team->'roles') r WHERE r->>'key'='executor'
                 AND r->'permissions' ? 'implementation.execute' AND r->'capabilities' ? 'run.workspace_write') THEN
    RAISE EXCEPTION 'the Executor role does not show its permission and the capability it needs: %', v_team->'roles';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_team->'models') m WHERE m->>'entry_id' IN (pg_temp.f('unverified')::text, pg_temp.f('router_a')::text)) THEN
    RAISE EXCEPTION 'a model that cannot be picked was offered: %', v_team->'models';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_team->'held_back') h WHERE h->>'reason'='model_not_verified' AND (h->>'count')::int>=1)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_team->'held_back') h WHERE h->>'reason'='connection_not_connected' AND (h->>'count')::int>=1) THEN
    RAISE EXCEPTION 'the models held back are not counted under their reasons: %', v_team->'held_back';
  END IF;
  IF pg_temp.reason_of(format('SELECT project_team(%L,%L)', pg_temp.f('project'), pg_temp.f('stranger')))<>'project_unavailable' THEN
    RAISE EXCEPTION 'a stranger read the team';
  END IF;

  -- Add an executor: the new last one, on the new last default.
  v_result:=add_project_executor(pg_temp.f('project'), pg_temp.f('owner'), 1, pg_temp.f('free_b'), 'operator', 'c1');
  v_new:=(v_result->>'assignment_id')::uuid;
  IF (v_result->>'version')::bigint<>2 THEN RAISE EXCEPTION 'add did not bump the version: %', v_result; END IF;
  SELECT string_agg(m.model_id, ',' ORDER BY d.ordinal) INTO v_names
  FROM project_default_executor_positions(pg_temp.f('project')) d JOIN provider_model_catalog m ON m.id=d.catalog_entry_id;
  IF v_names<>'team-free-a,team-free-b' THEN RAISE EXCEPTION 'defaults after add: %', v_names; END IF;
  IF (SELECT assignment_id FROM project_executor_positions(pg_temp.f('project')) WHERE ordinal=2)<>v_new THEN
    RAISE EXCEPTION 'the new executor is not the last one';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_events WHERE action='project.team_changed' AND details->>'change'='executor_added') THEN
    RAISE EXCEPTION 'the addition was not audited';
  END IF;
  -- The same model twice, a stale card, a stranger, an unverified model.
  v_reason:=pg_temp.reason_of(format('SELECT add_project_executor(%L,%L,2,%L,''o'',''c'')', pg_temp.f('project'), pg_temp.f('owner'), pg_temp.f('free_a')));
  IF v_reason<>'team_model_in_use' THEN RAISE EXCEPTION 'a model already used was added again: %', v_reason; END IF;
  v_reason:=pg_temp.reason_of(format('SELECT add_project_executor(%L,%L,1,%L,''o'',''c'')', pg_temp.f('project'), pg_temp.f('owner'), pg_temp.f('free_b')));
  IF v_reason<>'runtime_defaults_version_stale' THEN RAISE EXCEPTION 'a stale card was applied: %', v_reason; END IF;
  v_reason:=pg_temp.reason_of(format('SELECT add_project_executor(%L,%L,2,%L,''o'',''c'')', pg_temp.f('project'), pg_temp.f('stranger'), pg_temp.f('free_b')));
  IF v_reason<>'project_unavailable' THEN RAISE EXCEPTION 'a stranger changed the team: %', v_reason; END IF;
  v_reason:=pg_temp.reason_of(format('SELECT add_project_executor(%L,%L,2,%L,''o'',''c'')', pg_temp.f('project'), pg_temp.f('owner'), pg_temp.f('unverified')));
  IF v_reason<>'catalog_entry_unavailable' THEN RAISE EXCEPTION 'an unverified model was added: %', v_reason; END IF;

  -- The next task binds each executor to its own model.
  v_task:=gen_random_uuid();
  INSERT INTO tasks(id,project_id,title,objective,status,created_by,orchestrator_assignment_id)
    VALUES(v_task,pg_temp.f('project'),'Team','t','planning','test',pg_temp.f('orchestrator'));
  v_snapshot:=capture_task_runtime_snapshot(v_task, pg_temp.f('project'));
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_snapshot->'executors') e
                 WHERE e->>'model_id'='team-free-b' AND e->'assignment_ids' ? v_new::text) THEN
    RAISE EXCEPTION 'the new executor is not bound to its model in the snapshot: %', v_snapshot->'executors';
  END IF;

  -- Change a model: the orchestrator's, then the first executor's, in place.
  PERFORM change_project_assignment_model(pg_temp.f('project'), pg_temp.f('owner'), 2, pg_temp.f('orchestrator'), pg_temp.f('codex_b'), 'o', 'c');
  IF (SELECT orchestrator_entry_id FROM project_runtime_defaults WHERE project_id=pg_temp.f('project'))<>pg_temp.f('codex_b') THEN
    RAISE EXCEPTION 'the orchestrator model did not change';
  END IF;
  v_reason:=pg_temp.reason_of(format('SELECT change_project_assignment_model(%L,%L,3,%L,%L,''o'',''c'')',
    pg_temp.f('project'), pg_temp.f('owner'), pg_temp.f('orchestrator'), pg_temp.f('free_a')));
  IF v_reason<>'runtime_default_not_assigned' THEN RAISE EXCEPTION 'another runtime''s model was accepted: %', v_reason; END IF;
  v_reason:=pg_temp.reason_of(format('SELECT change_project_assignment_model(%L,%L,3,%L,%L,''o'',''c'')',
    pg_temp.f('project'), pg_temp.f('owner'), pg_temp.f('executor'), pg_temp.f('free_b')));
  IF v_reason<>'team_model_in_use' THEN RAISE EXCEPTION 'an executor took another executor''s model: %', v_reason; END IF;

  -- Disable: the task above is open and bound to both executors.
  UPDATE tasks SET status='cancelled' WHERE id=v_task;
  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority,enabled)
    SELECT id, pg_temp.f('executor'), 100, true FROM tasks WHERE id=v_task ON CONFLICT DO NOTHING;
  v_task:=gen_random_uuid();
  INSERT INTO tasks(id,project_id,title,objective,status,created_by,orchestrator_assignment_id)
    VALUES(v_task,pg_temp.f('project'),'Open','t','planning','test',pg_temp.f('orchestrator'));
  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority,enabled) VALUES(v_task,pg_temp.f('executor'),100,true);
  v_reason:=pg_temp.reason_of(format('SELECT disable_project_executor(%L,%L,3,%L,''o'',''c'')', pg_temp.f('project'), pg_temp.f('owner'), pg_temp.f('executor')));
  IF v_reason<>'team_assignment_in_use' THEN RAISE EXCEPTION 'an executor bound to an open task was disabled: %', v_reason; END IF;
  UPDATE tasks SET status='cancelled' WHERE id=v_task;
  PERFORM disable_project_executor(pg_temp.f('project'), pg_temp.f('owner'), 3, pg_temp.f('executor'), 'o', 'c');
  -- The remaining executor keeps its own model, now in the first position.
  SELECT string_agg(m.model_id, ',' ORDER BY d.ordinal) INTO v_names
  FROM project_default_executor_positions(pg_temp.f('project')) d JOIN provider_model_catalog m ON m.id=d.catalog_entry_id;
  IF v_names<>'team-free-b' OR (SELECT assignment_id FROM project_executor_positions(pg_temp.f('project')) WHERE ordinal=1)<>v_new THEN
    RAISE EXCEPTION 'after disabling the first executor the second lost its model: %', v_names;
  END IF;
  v_reason:=pg_temp.reason_of(format('SELECT disable_project_executor(%L,%L,4,%L,''o'',''c'')', pg_temp.f('project'), pg_temp.f('owner'), v_new));
  IF v_reason<>'team_last_executor' THEN RAISE EXCEPTION 'the last executor was disabled: %', v_reason; END IF;
  v_reason:=pg_temp.reason_of(format('SELECT disable_project_executor(%L,%L,4,%L,''o'',''c'')', pg_temp.f('project'), pg_temp.f('owner'), pg_temp.f('orchestrator')));
  IF v_reason<>'team_assignment_unavailable' THEN RAISE EXCEPTION 'the orchestrator was disabled as an executor: %', v_reason; END IF;

  -- Privileges: the web tier calls the four, nobody else; the helpers are nobody's.
  IF NOT has_function_privilege('infra_web','project_team(uuid,uuid)','EXECUTE')
     OR has_function_privilege('infra_worker','add_project_executor(uuid,uuid,bigint,uuid,text,text,text)','EXECUTE')
     OR has_function_privilege('infra_web','lock_project_team(uuid,uuid,bigint)','EXECUTE') THEN
    RAISE EXCEPTION 'team function privileges are wrong';
  END IF;

  RAISE NOTICE 'the team is read, added to, changed and reduced from the panel, positions and all, by its owner at its version';
END $$;

ROLLBACK;
