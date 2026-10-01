\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

-- 0054: dispatch asks the host again, and a refusal leaves nothing behind.
--
-- The panel's warning is a statement about the moment the page was rendered. An
-- operator reads it, thinks, and presses a button some seconds later — and
-- `infra-cod runtime remove`, a revoked credential or a runtime that stopped
-- reporting fits comfortably into those seconds. So the question is asked again
-- where the work would be created.
--
-- What this file pins down:
--
--   * a runtime the snapshot calls uninstalled, or unauthenticated, refuses —
--     and the two produce different messages, because they send an operator to
--     different commands;
--   * a host that says nothing about a runtime refuses too: "cannot say" is not
--     "yes";
--   * a stale snapshot refuses, whatever it says;
--   * a ready host is not obstructed;
--   * and the refusal is transactional — no task row survives it.

DO $$
DECLARE
  v_snapshot jsonb;
  v_outcome text;
  v_message text;
BEGIN
  -- A host reporting both runtimes ready, observed now.
  v_snapshot := jsonb_build_object(
    'type','health.snapshot','status','healthy',
    'runtimes', jsonb_build_array(
      jsonb_build_object('runtime','codex','version','0.154.0','installed',true,
        'authenticated',true,'capability_verified',false,'ready',false),
      jsonb_build_object('runtime','opencode','version','1.2.3','installed',true,
        'authenticated',true,'capability_verified',false,'ready',false)));

  INSERT INTO runtime_health(singleton,status,snapshot,observed_at)
  VALUES (true,'healthy',v_snapshot,clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE SET
    status=EXCLUDED.status, snapshot=EXCLUDED.snapshot, observed_at=EXCLUDED.observed_at;

  -- Ready: no obstruction, including for a runtime named twice.
  PERFORM assert_runtimes_dispatchable(ARRAY['codex','opencode']);
  PERFORM assert_runtimes_dispatchable(ARRAY['codex','codex']);
  -- Nothing required is trivially satisfied; a task with no runtime selection is
  -- not a task this rule has an opinion about.
  PERFORM assert_runtimes_dispatchable(ARRAY[]::text[]);
  PERFORM assert_runtimes_dispatchable(NULL);

  -- Not provisioned.
  UPDATE runtime_health SET snapshot=jsonb_set(v_snapshot,'{runtimes,1,installed}','false')
  WHERE singleton=true;
  BEGIN
    PERFORM assert_runtimes_dispatchable(ARRAY['opencode']);
    v_outcome := 'ACCEPTED';
  EXCEPTION WHEN OTHERS THEN v_outcome := SQLERRM;
  END;
  IF v_outcome NOT LIKE '%opencode is not provisioned%' THEN
    RAISE EXCEPTION 'an uninstalled runtime was not refused by name (%)', v_outcome;
  END IF;
  -- The other runtime is unaffected: one broken runtime does not stop a project
  -- that does not use it.
  PERFORM assert_runtimes_dispatchable(ARRAY['codex']);

  -- Installed but holding no credential. A different sentence on purpose: the
  -- operator's next command is not the same one.
  UPDATE runtime_health SET snapshot=jsonb_set(v_snapshot,'{runtimes,0,authenticated}','false')
  WHERE singleton=true;
  BEGIN
    PERFORM assert_runtimes_dispatchable(ARRAY['codex']);
    v_outcome := 'ACCEPTED';
  EXCEPTION WHEN OTHERS THEN v_outcome := SQLERRM;
  END;
  IF v_outcome NOT LIKE '%codex holds no usable credential%' THEN
    RAISE EXCEPTION 'an unauthenticated runtime was not refused by name (%)', v_outcome;
  END IF;

  -- A runtime the host does not mention at all.
  UPDATE runtime_health SET snapshot=v_snapshot WHERE singleton=true;
  BEGIN
    PERFORM assert_runtimes_dispatchable(ARRAY['claude-code']);
    v_outcome := 'ACCEPTED';
  EXCEPTION WHEN OTHERS THEN v_outcome := SQLERRM;
  END;
  IF v_outcome NOT LIKE '%claude-code is not reported by this host%' THEN
    RAISE EXCEPTION 'an unreported runtime was treated as available (%)', v_outcome;
  END IF;

  -- Stale. The snapshot still says everything is fine; it is simply too old to
  -- be evidence of anything.
  UPDATE runtime_health SET observed_at=clock_timestamp()-interval '3 hours' WHERE singleton=true;
  BEGIN
    PERFORM assert_runtimes_dispatchable(ARRAY['codex']);
    v_outcome := 'ACCEPTED';
  EXCEPTION WHEN OTHERS THEN v_outcome := SQLERRM;
  END;
  IF v_outcome NOT LIKE '%snapshot is%old%' THEN
    RAISE EXCEPTION 'a stale snapshot was accepted as current (%)', v_outcome;
  END IF;

  -- No row at all — a host that has never reported.
  DELETE FROM runtime_health WHERE singleton=true;
  BEGIN
    PERFORM assert_runtimes_dispatchable(ARRAY['codex']);
    v_outcome := 'ACCEPTED';
  EXCEPTION WHEN OTHERS THEN v_outcome := SQLERRM;
  END;
  IF v_outcome NOT LIKE '%has not reported%' THEN
    RAISE EXCEPTION 'a host that never reported was treated as ready (%)', v_outcome;
  END IF;

  -- A row whose snapshot predates this release and carries no `runtimes` key.
  -- An old shape is not a permissive shape.
  INSERT INTO runtime_health(singleton,status,snapshot,observed_at)
  VALUES (true,'healthy',jsonb_build_object('type','health.snapshot','status','healthy'),clock_timestamp());
  BEGIN
    PERFORM assert_runtimes_dispatchable(ARRAY['codex']);
    v_outcome := 'ACCEPTED';
  EXCEPTION WHEN OTHERS THEN v_outcome := SQLERRM;
  END;
  IF v_outcome NOT LIKE '%has not reported%' THEN
    RAISE EXCEPTION 'a snapshot without runtime information was treated as ready (%)', v_outcome;
  END IF;

  RAISE NOTICE 'runtime dispatch readiness assertions passed';
END $$;

-- The refusal is transactional: the task, its executor rows and its snapshot go
-- together or not at all.
--
-- `capture_task_runtime_snapshot` is called by every creator after the task row
-- is inserted, so a refusal that did not roll back would leave a task nothing
-- will ever run, holding a workspace the operator cannot release.
DO $$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_connection uuid := gen_random_uuid();
  v_entry uuid := gen_random_uuid();
  v_project uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();
  v_outcome text;
  v_rows integer;
BEGIN
  -- Built here rather than found in the database. `db/tests/0009` depends on
  -- ambient `runtime_jobs` rows and fails on a clean install for exactly that
  -- reason; a test that quietly skips when the fixture is absent is worse still,
  -- because it reports success for a check it did not make.
  INSERT INTO users(id,display_name,role) VALUES (v_owner,'readiness fixture','owner');
  INSERT INTO provider_connections(id,operator_id,provider,auth_method,status,billing_boundary)
  VALUES (v_connection,v_owner,'codex','device_code','connected','');
  INSERT INTO provider_model_catalog(
    id,operator_id,connection_id,runtime_type,provider_id,model_id,
    discovery_source,status,last_verified_at,verification_id)
  VALUES (v_entry,v_owner,v_connection,'codex','openai','gpt-5',
    'codex_model_list','verified',clock_timestamp(),gen_random_uuid());
  INSERT INTO projects(id,owner_id,name,slug,workspace_path,status)
  VALUES (v_project,v_owner,'readiness fixture','readiness-fixture','/tmp/readiness-fixture','active');
  INSERT INTO project_runtime_defaults(project_id,orchestrator_entry_id,updated_by)
  VALUES (v_project,v_entry,'db-test');

  -- A host that reports nothing: every runtime this project could pick is
  -- unavailable, whichever one it is.
  DELETE FROM runtime_health WHERE singleton=true;

  INSERT INTO tasks(id,project_id,title,objective,status,created_by)
  VALUES (v_task,v_project,'readiness probe','probe','planning','db-test');

  BEGIN
    PERFORM capture_task_runtime_snapshot(v_task,v_project,NULL::uuid[]);
    v_outcome := 'ACCEPTED';
  EXCEPTION WHEN OTHERS THEN v_outcome := SQLERRM;
  END;

  IF v_outcome = 'ACCEPTED' THEN
    RAISE EXCEPTION 'a task was bound to runtimes on a host that reports none';
  END IF;

  SELECT count(*) INTO v_rows FROM task_runtime_snapshots WHERE task_id=v_task;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a refused dispatch still wrote a runtime snapshot';
  END IF;

  RAISE NOTICE 'refused dispatch left no runtime snapshot behind';
END $$;

ROLLBACK;
