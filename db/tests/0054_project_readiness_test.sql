-- Project readiness and the send path name one reason (migration 0088, sprint C U1).
--
-- The panel shows an assignment's four prerequisites — runtime installed,
-- runtime authenticated, model verified, connection connected — and the
-- database refuses to create a task, or to start a turn, when one is missing.
-- What this file pins down:
--
--   * a ready project is untouched: every state is ready, a task is created
--     with a catalog snapshot, a message on it starts a turn;
--   * for each failing prerequisite, the reason project_readiness names for the
--     orchestrator is the reason create_task_with_executors and
--     record_task_chat_message refuse with, and the panel's fix is attached;
--   * the reading is the launch's: runtime_undispatchable_reason and
--     connection_revoked answer the same as the readiness states;
--   * an executor that is not ready is shown on its own row, blocks the task
--     that would bind it, and does not stop the conversation of a task that
--     already exists (its delegation is where it is asked again);
--   * a project without catalog defaults is not asked about a model it has not
--     chosen;
--   * the owner is checked.
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

-- The message the operator reads, for the checks that it carries the fix.
CREATE FUNCTION pg_temp.message_of(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END $$;

CREATE TEMP TABLE fixture(key text PRIMARY KEY, id uuid);

DO $$
DECLARE
  v_owner uuid; v_stranger uuid; v_project uuid;
  v_codex_connection uuid; v_opencode_connection uuid;
  v_codex_entry uuid; v_opencode_entry uuid;
  v_codex_profile uuid; v_opencode_profile uuid;
  v_codex uuid; v_worker uuid; v_orchestrator uuid; v_executor uuid;
  v_snapshot jsonb;
BEGIN
  INSERT INTO users(display_name,role) VALUES('Readiness owner','owner') RETURNING id INTO v_owner;
  INSERT INTO users(display_name) VALUES('Readiness stranger') RETURNING id INTO v_stranger;
  INSERT INTO projects(owner_id,name,slug,workspace_path,status)
    VALUES(v_owner,'Readiness','readiness','/srv/infra-cod/workspaces/readiness','active') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;

  INSERT INTO provider_connections(operator_id,provider,auth_method,status)
    VALUES(v_owner,'codex','device_code','connected') RETURNING id INTO v_codex_connection;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','native','connected','free','opencode-home:opencode-worker') RETURNING id INTO v_opencode_connection;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,
    discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_codex_connection,'codex','openai','gpt-5-readiness','codex_model_list','verified',clock_timestamp(),gen_random_uuid())
    RETURNING id INTO v_codex_entry;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,
    discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_opencode_connection,'opencode','opencode','free-readiness','opencode_provider_api','verified',clock_timestamp(),gen_random_uuid())
    RETURNING id INTO v_opencode_entry;

  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('codex','test','test','openai','gpt-5-readiness',clock_timestamp()) RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('opencode','test','test','opencode','free-readiness',clock_timestamp()) RETURNING id INTO v_opencode_profile;
  INSERT INTO agents(name,runtime_profile_id) VALUES('readiness-codex',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,runtime_profile_id) VALUES('readiness-worker',v_opencode_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,is_default)
    VALUES(v_project,v_codex,v_codex_profile,(SELECT id FROM role_definitions WHERE builtin_key='orchestrator'),true)
    RETURNING id INTO v_orchestrator;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id)
    VALUES(v_project,v_worker,v_opencode_profile,(SELECT id FROM role_definitions WHERE builtin_key='executor'))
    RETURNING id INTO v_executor;

  INSERT INTO project_runtime_defaults(project_id,orchestrator_entry_id,updated_by) VALUES(v_project,v_codex_entry,'db-test');
  INSERT INTO project_runtime_default_executors(project_id,catalog_entry_id,priority) VALUES(v_project,v_opencode_entry,100);

  -- A host reporting both runtimes installed and signed in, observed now.
  v_snapshot := jsonb_build_object('type','health.snapshot','status','healthy',
    'runtimes', jsonb_build_array(
      jsonb_build_object('runtime','codex','version','0.154.0','installed',true,'authenticated',true,'capability_verified',false,'ready',false),
      jsonb_build_object('runtime','opencode','version','1.2.3','installed',true,'authenticated',true,'capability_verified',false,'ready',false)));
  INSERT INTO runtime_health(singleton,status,snapshot,observed_at) VALUES(true,'healthy',v_snapshot,clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE SET status=EXCLUDED.status,snapshot=EXCLUDED.snapshot,observed_at=EXCLUDED.observed_at;

  INSERT INTO fixture(key,id) VALUES
    ('owner',v_owner),('stranger',v_stranger),('project',v_project),
    ('codex_connection',v_codex_connection),('opencode_connection',v_opencode_connection),
    ('codex_entry',v_codex_entry),('opencode_entry',v_opencode_entry),
    ('orchestrator',v_orchestrator),('executor',v_executor);
END $$;

-- The fixture's healthy reading, kept for the resets between cases.
CREATE TEMP TABLE healthy AS SELECT snapshot FROM runtime_health WHERE singleton;

-- The assignment's row of project_readiness by role.
CREATE FUNCTION pg_temp.readiness_of(p_role text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT item FROM jsonb_array_elements(
    project_readiness((SELECT id FROM fixture WHERE key='project'),(SELECT id FROM fixture WHERE key='owner'))->'assignments') item
  WHERE item->>'role'=p_role;
$$;

CREATE FUNCTION pg_temp.create_task_sql(p_task uuid) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT create_task_with_executors(%L::uuid,%L::uuid,%L,%L,%L,%L,%L::uuid,%L::jsonb,true)',
    (SELECT id FROM fixture WHERE key='project'), p_task, 'Readiness task', 'Probe readiness', 'db-test', 'readiness',
    (SELECT id FROM fixture WHERE key='orchestrator'),
    jsonb_build_array((SELECT id FROM fixture WHERE key='executor')::text));
$$;

CREATE FUNCTION pg_temp.chat_sql(p_task uuid) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT record_task_chat_message(%L::uuid,%L::uuid,%L,%L,%L)',
    (SELECT id FROM fixture WHERE key='project'), p_task, 'Continue the conversation', 'db-test', 'readiness');
$$;

-- ------------------------------------------------------- a ready project ----
DO $$
DECLARE v_readiness jsonb; v_row jsonb; v_task uuid := gen_random_uuid(); v_created jsonb; v_turn jsonb; v_state text;
BEGIN
  v_readiness := project_readiness((SELECT id FROM fixture WHERE key='project'),(SELECT id FROM fixture WHERE key='owner'));
  IF NOT (v_readiness->>'ready')::boolean OR jsonb_array_length(v_readiness->'assignments') <> 2
     OR NOT (v_readiness->>'has_defaults')::boolean OR v_readiness->>'observed_at' IS NULL THEN
    RAISE EXCEPTION 'a ready project is not reported ready: %', v_readiness;
  END IF;
  FOR v_row IN SELECT item FROM jsonb_array_elements(v_readiness->'assignments') item LOOP
    FOREACH v_state IN ARRAY ARRAY['runtime_installed','runtime_authenticated','model_verified','connection_connected'] LOOP
      IF v_row->>v_state IS DISTINCT FROM 'ready' THEN
        RAISE EXCEPTION '% of the % is % on a ready project', v_state, v_row->>'role', v_row->>v_state;
      END IF;
    END LOOP;
    IF NOT (v_row->>'ready')::boolean OR jsonb_typeof(v_row->'blocked_by') <> 'null' THEN
      RAISE EXCEPTION 'a ready assignment is blocked: %', v_row;
    END IF;
  END LOOP;
  -- The orchestrator's row is first and names what it would run.
  v_row := v_readiness->'assignments'->0;
  IF v_row->>'role' <> 'orchestrator' OR v_row->>'runtime' <> 'codex' OR v_row->>'model_id' <> 'gpt-5-readiness'
     OR v_row->>'runtime_version' <> '0.154.0' OR (v_row->>'assignment_id')::uuid <> (SELECT id FROM fixture WHERE key='orchestrator')
     OR (v_row->>'connection_id')::uuid <> (SELECT id FROM fixture WHERE key='codex_connection') THEN
    RAISE EXCEPTION 'the orchestrator row does not name its selection: %', v_row;
  END IF;
  v_row := v_readiness->'assignments'->1;
  IF v_row->>'role' <> 'executor' OR v_row->>'runtime' <> 'opencode' OR v_row->>'model_id' <> 'free-readiness' THEN
    RAISE EXCEPTION 'the executor row does not name its selection: %', v_row;
  END IF;

  -- Untouched: the task is created with its catalog snapshot, and a message on
  -- it starts a turn.
  EXECUTE pg_temp.create_task_sql(v_task) INTO v_created;
  IF v_created->>'snapshot_source' <> 'catalog' OR (v_created->>'task_id')::uuid <> v_task THEN
    RAISE EXCEPTION 'a ready project could not create a task: %', v_created;
  END IF;
  EXECUTE pg_temp.chat_sql(v_task) INTO v_turn;
  IF v_turn IS NULL OR (v_turn->>'version')::bigint < 2 THEN
    RAISE EXCEPTION 'a ready project could not start a turn: %', v_turn;
  END IF;
  INSERT INTO fixture(key,id) VALUES('task',v_task);
  RAISE NOTICE 'a ready project is reported ready and is untouched';
END $$;

-- ------------------------------------- each prerequisite, the same reason ----
--
-- One block per prerequisite: break it, read the orchestrator's row, ask the
-- two send paths, compare. Then put it back, so each case is about one thing.
CREATE FUNCTION pg_temp.expect_blocked(p_case text, p_reason text, p_prerequisite text, p_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_row jsonb; v_create text; v_chat text; v_message text; v_probe uuid := gen_random_uuid(); v_rows integer;
BEGIN
  v_row := pg_temp.readiness_of('orchestrator');
  IF (v_row->>'ready')::boolean OR v_row->'blocked_by'->>'reason' IS DISTINCT FROM p_reason
     OR v_row->'blocked_by'->>'prerequisite' IS DISTINCT FROM p_prerequisite
     OR v_row->>p_prerequisite IS DISTINCT FROM p_state THEN
    RAISE EXCEPTION '%: readiness does not name % on %: %', p_case, p_reason, p_prerequisite, v_row;
  END IF;
  IF length(COALESCE(v_row->'blocked_by'->>'action','')) < 10 OR length(COALESCE(v_row->'blocked_by'->>'message','')) < 10
     OR v_row->'blocked_by'->>'note' IS DISTINCT FROM (SELECT note FROM failure_reasons WHERE reason=p_reason) THEN
    RAISE EXCEPTION '%: the blocker carries no fix: %', p_case, v_row->'blocked_by';
  END IF;
  -- Whether the project as a whole may send follows the orchestrator.
  IF (project_readiness((SELECT id FROM fixture WHERE key='project'),(SELECT id FROM fixture WHERE key='owner'))->>'ready')::boolean THEN
    RAISE EXCEPTION '%: the project is ready with its orchestrator blocked', p_case;
  END IF;

  v_create := pg_temp.reason_of(pg_temp.create_task_sql(v_probe));
  IF v_create IS DISTINCT FROM p_reason THEN
    RAISE EXCEPTION '%: create_task refused with % where readiness said %', p_case, v_create, p_reason;
  END IF;
  SELECT count(*) INTO v_rows FROM tasks WHERE id=v_probe;
  IF v_rows <> 0 THEN RAISE EXCEPTION '%: a refused task was written', p_case; END IF;

  v_chat := pg_temp.reason_of(pg_temp.chat_sql((SELECT id FROM fixture WHERE key='task')));
  IF v_chat IS DISTINCT FROM p_reason THEN
    RAISE EXCEPTION '%: chat_message refused with % where readiness said %', p_case, v_chat, p_reason;
  END IF;
  -- The sentence the composer shows carries the same fix the panel showed.
  v_message := pg_temp.message_of(pg_temp.chat_sql((SELECT id FROM fixture WHERE key='task')));
  IF position(v_row->'blocked_by'->>'action' IN v_message) = 0 THEN
    RAISE EXCEPTION '%: the refusal does not carry the fix: % / %', p_case, v_message, v_row->'blocked_by'->>'action';
  END IF;
END $$;

DO $$
DECLARE v_task uuid := (SELECT id FROM fixture WHERE key='task'); v_entry uuid := (SELECT id FROM fixture WHERE key='codex_entry');
  v_connection uuid := (SELECT id FROM fixture WHERE key='codex_connection'); v_turn jsonb;
BEGIN
  -- Not installed. The launch reads the same.
  UPDATE runtime_health SET snapshot=jsonb_set((SELECT snapshot FROM healthy),'{runtimes,0,installed}','false') WHERE singleton;
  PERFORM pg_temp.expect_blocked('uninstalled','runtime_not_provisioned','runtime_installed','missing');
  IF runtime_undispatchable_reason('codex') IS DISTINCT FROM 'runtime_not_provisioned' THEN
    RAISE EXCEPTION 'the launch reads an uninstalled runtime differently: %', runtime_undispatchable_reason('codex');
  END IF;

  -- Installed, no credential.
  UPDATE runtime_health SET snapshot=jsonb_set((SELECT snapshot FROM healthy),'{runtimes,0,authenticated}','false') WHERE singleton;
  PERFORM pg_temp.expect_blocked('signed out','runtime_not_authenticated','runtime_authenticated','missing');
  IF runtime_undispatchable_reason('codex') IS DISTINCT FROM 'runtime_not_authenticated' THEN
    RAISE EXCEPTION 'the launch reads a signed-out runtime differently: %', runtime_undispatchable_reason('codex');
  END IF;
  IF pg_temp.readiness_of('orchestrator')->>'runtime_installed' <> 'ready' THEN
    RAISE EXCEPTION 'a signed-out runtime was shown as uninstalled';
  END IF;

  -- Stale: the report says everything is fine and is too old to be evidence.
  -- Both runtime states are unknown, the first is the blocker, and a launch —
  -- which leaves "cannot say" to the launch (0072) — reads NULL.
  UPDATE runtime_health SET snapshot=(SELECT snapshot FROM healthy), observed_at=clock_timestamp()-interval '3 hours' WHERE singleton;
  PERFORM pg_temp.expect_blocked('stale','runtime_readiness_unknown','runtime_installed','unknown');
  IF pg_temp.readiness_of('orchestrator')->>'runtime_authenticated' <> 'unknown' THEN
    RAISE EXCEPTION 'a stale report claimed to know the credential state';
  END IF;
  IF runtime_undispatchable_reason('codex') IS NOT NULL THEN
    RAISE EXCEPTION 'a stale report refused a launch';
  END IF;
  -- The model and the connection are still read: only the host is silent.
  IF pg_temp.readiness_of('orchestrator')->>'model_verified' <> 'ready' OR pg_temp.readiness_of('orchestrator')->>'connection_connected' <> 'ready' THEN
    RAISE EXCEPTION 'a stale host report hid the model and connection states';
  END IF;

  -- Never reported.
  DELETE FROM runtime_health WHERE singleton;
  PERFORM pg_temp.expect_blocked('unreported','runtime_readiness_unknown','runtime_installed','unknown');
  INSERT INTO runtime_health(singleton,status,snapshot,observed_at) VALUES(true,'healthy',(SELECT snapshot FROM healthy),clock_timestamp());

  -- A runtime the report could not read.
  UPDATE runtime_health SET snapshot=jsonb_set((SELECT snapshot FROM healthy),'{runtimes,0,unreadable}','"EACCES"') WHERE singleton;
  PERFORM pg_temp.expect_blocked('unreadable','runtime_readiness_unknown','runtime_installed','unknown');
  UPDATE runtime_health SET snapshot=(SELECT snapshot FROM healthy), observed_at=clock_timestamp() WHERE singleton;

  -- The model lost its verification (the gate rejected it on a refresh).
  UPDATE provider_model_catalog SET status='rejected', failure_code='gate_failed', verification_id=NULL, verified_lease_until=NULL WHERE id=v_entry;
  PERFORM pg_temp.expect_blocked('unverified model','model_not_verified','model_verified','missing');
  UPDATE provider_model_catalog SET status='verified', failure_code='', verification_id=gen_random_uuid() WHERE id=v_entry;

  -- The connection expired. Its entries go to `unavailable` with it (0027's
  -- trigger), and the first fix named is still the connection: what a launch
  -- of the same selection would refuse with.
  UPDATE provider_connections SET status='expired' WHERE id=v_connection;
  PERFORM pg_temp.expect_blocked('expired connection','model_access_revoked','connection_connected','missing');
  IF NOT connection_revoked(v_connection) THEN RAISE EXCEPTION 'the launch reads an expired connection as live'; END IF;
  IF pg_temp.readiness_of('orchestrator')->>'model_verified' <> 'missing' THEN
    RAISE EXCEPTION 'an entry of an expired connection was shown as verified';
  END IF;
  UPDATE provider_connections SET status='connected' WHERE id=v_connection;
  UPDATE provider_model_catalog SET status='verified', stale_at=NULL, verification_id=gen_random_uuid() WHERE id=v_entry;

  -- The operator asked for a disconnect the broker has not done yet: decided
  -- when they asked (0084).
  UPDATE provider_connections SET broker_requested_action='disconnect' WHERE id=v_connection;
  PERFORM pg_temp.expect_blocked('pending disconnect','model_access_revoked','connection_connected','missing');
  IF NOT connection_revoked(v_connection) THEN RAISE EXCEPTION 'the launch reads a pending disconnect as live'; END IF;
  UPDATE provider_connections SET broker_requested_action='' WHERE id=v_connection;
  IF connection_revoked(v_connection) THEN RAISE EXCEPTION 'a connected connection reads as revoked'; END IF;

  -- The order is the operator's: with everything broken, the first fix named
  -- is the runtime, not the connection — and the connection's state is still
  -- on the row.
  UPDATE runtime_health SET snapshot=jsonb_set((SELECT snapshot FROM healthy),'{runtimes,0,installed}','false') WHERE singleton;
  UPDATE provider_connections SET status='expired' WHERE id=v_connection;
  PERFORM pg_temp.expect_blocked('everything','runtime_not_provisioned','runtime_installed','missing');
  IF pg_temp.readiness_of('orchestrator')->>'connection_connected' <> 'missing' THEN
    RAISE EXCEPTION 'the connection state was hidden behind the runtime''s';
  END IF;
  UPDATE runtime_health SET snapshot=(SELECT snapshot FROM healthy) WHERE singleton;
  UPDATE provider_connections SET status='connected' WHERE id=v_connection;
  UPDATE provider_model_catalog SET status='verified', stale_at=NULL, verification_id=gen_random_uuid() WHERE id=v_entry;

  -- Back to ready: the conversation continues.
  EXECUTE pg_temp.chat_sql(v_task) INTO v_turn;
  IF v_turn IS NULL THEN RAISE EXCEPTION 'a repaired project could not start a turn'; END IF;
  RAISE NOTICE 'each failing prerequisite is named the same by readiness, task creation and the chat';
END $$;

-- ------------------------------------------------- an executor not ready ----
DO $$
DECLARE v_row jsonb; v_probe uuid := gen_random_uuid(); v_reason text; v_turn jsonb;
BEGIN
  UPDATE runtime_health SET snapshot=jsonb_set((SELECT snapshot FROM healthy),'{runtimes,1,authenticated}','false') WHERE singleton;
  v_row := pg_temp.readiness_of('executor');
  IF (v_row->>'ready')::boolean OR v_row->'blocked_by'->>'reason' <> 'runtime_not_authenticated' THEN
    RAISE EXCEPTION 'a signed-out executor is not shown on its row: %', v_row;
  END IF;
  -- The orchestrator's row, and the project's send state, are its own.
  IF NOT (pg_temp.readiness_of('orchestrator')->>'ready')::boolean
     OR NOT (project_readiness((SELECT id FROM fixture WHERE key='project'),(SELECT id FROM fixture WHERE key='owner'))->>'ready')::boolean THEN
    RAISE EXCEPTION 'an executor''s state was charged to the orchestrator';
  END IF;
  -- A task that would bind it is refused with its reason.
  v_reason := pg_temp.reason_of(pg_temp.create_task_sql(v_probe));
  IF v_reason IS DISTINCT FROM 'runtime_not_authenticated' THEN
    RAISE EXCEPTION 'a task binding a signed-out executor was not refused by reason: %', v_reason;
  END IF;
  -- The conversation of a task that exists goes on: the executor is asked again
  -- at its delegation, and the panel says so on the task before then.
  EXECUTE pg_temp.chat_sql((SELECT id FROM fixture WHERE key='task')) INTO v_turn;
  IF v_turn IS NULL THEN RAISE EXCEPTION 'an executor''s state stopped the orchestrator''s conversation'; END IF;
  UPDATE runtime_health SET snapshot=(SELECT snapshot FROM healthy) WHERE singleton;
  RAISE NOTICE 'an executor that is not ready is shown on its row and blocks only the task that binds it';
END $$;

-- ------------------------------------------------- no defaults, and owner ----
DO $$
DECLARE v_row jsonb; v_readiness jsonb; v_reason text;
BEGIN
  -- A project without catalog defaults names no model to ask about: the runtime
  -- states are read and shown, the model and connection are unknown, and
  -- nothing blocks — capture_task_runtime_snapshot skips such a project, and a
  -- task without a catalog snapshot is not asked at the chat either.
  DELETE FROM project_runtime_default_executors WHERE project_id=(SELECT id FROM fixture WHERE key='project');
  DELETE FROM project_runtime_defaults WHERE project_id=(SELECT id FROM fixture WHERE key='project');
  v_readiness := project_readiness((SELECT id FROM fixture WHERE key='project'),(SELECT id FROM fixture WHERE key='owner'));
  v_row := v_readiness->'assignments'->0;
  IF (v_readiness->>'has_defaults')::boolean OR NOT (v_row->>'ready')::boolean
     OR v_row->>'runtime_installed' <> 'ready' OR v_row->>'model_verified' <> 'unknown' OR v_row->>'connection_connected' <> 'unknown' THEN
    RAISE EXCEPTION 'a project without defaults was read wrongly: %', v_readiness;
  END IF;
  UPDATE runtime_health SET snapshot=jsonb_set((SELECT snapshot FROM healthy),'{runtimes,0,installed}','false') WHERE singleton;
  v_row := pg_temp.readiness_of('orchestrator');
  IF NOT (v_row->>'ready')::boolean OR v_row->>'runtime_installed' <> 'missing' THEN
    RAISE EXCEPTION 'a project without defaults was blocked, or its runtime state hidden: %', v_row;
  END IF;
  DELETE FROM task_runtime_snapshots WHERE task_id=(SELECT id FROM fixture WHERE key='task');
  IF pg_temp.reason_of(pg_temp.chat_sql((SELECT id FROM fixture WHERE key='task'))) IS NOT NULL THEN
    RAISE EXCEPTION 'a task without a catalog snapshot was asked about its runtime';
  END IF;
  UPDATE runtime_health SET snapshot=(SELECT snapshot FROM healthy) WHERE singleton;

  -- Another operator's project is unavailable, not readable.
  v_reason := pg_temp.reason_of(format('SELECT project_readiness(%L::uuid,%L::uuid)',
    (SELECT id FROM fixture WHERE key='project'),(SELECT id FROM fixture WHERE key='stranger')));
  IF v_reason IS DISTINCT FROM 'project_unavailable' THEN
    RAISE EXCEPTION 'a stranger read a project''s readiness: %', v_reason;
  END IF;
  RAISE NOTICE 'a project without defaults is not asked about a model, and the owner is checked';
END $$;

ROLLBACK;
