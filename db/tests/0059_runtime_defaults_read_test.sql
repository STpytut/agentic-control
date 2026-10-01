-- Reading a project's runtime defaults survives a model that went away
-- (migration 0094): the settings page must load when the connection behind the
-- default model expires; saving such a model is still refused.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_owner uuid; v_connection uuid; v_orchestrator uuid; v_executor uuid; v_project uuid; v_defaults jsonb;
BEGIN
  INSERT INTO users(display_name,role) VALUES('Defaults owner','owner') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','api_key','connected','openrouter','third_party_metered','opencode-home:opencode-worker')
    RETURNING id INTO v_connection;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_connection,'opencode','openrouter','openai/defaults-orchestrator','opencode_provider_api','verified',clock_timestamp(),gen_random_uuid())
    RETURNING id INTO v_orchestrator;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_connection,'opencode','openrouter','openai/defaults-executor','opencode_provider_api','verified',clock_timestamp(),gen_random_uuid())
    RETURNING id INTO v_executor;
  INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch)
    VALUES(v_owner,'Defaults fixture','defaults-fixture','/fixture/workspaces/defaults-fixture','main')
    RETURNING id INTO v_project;
  INSERT INTO project_runtime_defaults(project_id,orchestrator_entry_id) VALUES(v_project,v_orchestrator);
  INSERT INTO project_runtime_default_executors(project_id,catalog_entry_id) VALUES(v_project,v_executor);

  v_defaults := get_project_runtime_defaults(v_project,v_owner);
  IF (v_defaults->'orchestrator'->>'available')<>'true' OR (v_defaults->'orchestrator'->>'model_id')<>'openai/defaults-orchestrator'
     OR (v_defaults->'executors'->0->>'available')<>'true' THEN
    RAISE EXCEPTION 'available defaults read wrongly: %', v_defaults;
  END IF;

  -- The connection expires: its catalog goes unavailable; the read still answers.
  UPDATE provider_connections SET status='expired' WHERE id=v_connection;
  v_defaults := get_project_runtime_defaults(v_project,v_owner);
  IF (v_defaults->'orchestrator'->>'available')<>'false'
     OR (v_defaults->'orchestrator'->>'reason')<>'catalog_entry_unavailable'
     OR (v_defaults->'orchestrator'->>'entry_id')<>v_orchestrator::text
     OR (v_defaults->'orchestrator'->>'model_id')<>'openai/defaults-orchestrator'
     OR (v_defaults->'executors'->0->>'available')<>'false' THEN
    RAISE EXCEPTION 'an unavailable default did not read as unavailable: %', v_defaults;
  END IF;

  -- Saving it is refused as before.
  BEGIN
    PERFORM resolve_catalog_snapshot_entry(v_orchestrator);
    RAISE EXCEPTION 'an unavailable entry resolved for selection';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  IF get_project_runtime_defaults(v_project,gen_random_uuid())<>'null'::jsonb THEN
    RAISE EXCEPTION 'a foreign owner read the defaults';
  END IF;
  RAISE NOTICE 'the defaults read describes an unavailable model instead of failing';
END $$;

ROLLBACK;
