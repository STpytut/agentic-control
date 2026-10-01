-- The database side of the layout move (migration 0065, WP-5c): live rows move
-- to the product's paths and account, history does not, and the functions that
-- write the Codex credential reference write the new one — as definers still.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

CREATE TEMP TABLE layout_fixture(operator uuid, project uuid, connection uuid, audit uuid) ON COMMIT DROP;
DO $$
DECLARE v_user uuid; v_project uuid; v_task uuid; v_connection uuid; v_audit uuid;
BEGIN
  INSERT INTO users(display_name) VALUES('Layout') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Layout','layout','/srv/infra-cod-handoff-poc/workspaces/layout-1') RETURNING id INTO v_project;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,native_credential_reference)
    VALUES(v_user,'codex','device_code','connected','codex-home:codex-poc') RETURNING id INTO v_connection;
  v_audit:=write_audit_event(v_project,NULL,NULL,'user','layout','test.recorded','project',v_project::text,'allowed',NULL,
    jsonb_build_object('workspace','/srv/infra-cod-handoff-poc/workspaces/layout-1'),'layout');
  INSERT INTO layout_fixture VALUES(v_user,v_project,v_connection,v_audit);
END $$;

-- The migration again, over legacy-shaped rows: it is idempotent by design.
\ir ../migrations/0065_layout_migration.sql

DO $$
DECLARE v_f layout_fixture; v_started jsonb;
BEGIN
  SELECT * INTO v_f FROM layout_fixture;
  IF (SELECT workspace_path FROM projects WHERE id=v_f.project) <> '/srv/infra-cod/workspaces/layout-1' THEN
    RAISE EXCEPTION 'the project still points at the legacy root: %', (SELECT workspace_path FROM projects WHERE id=v_f.project);
  END IF;
  IF (SELECT native_credential_reference FROM provider_connections WHERE id=v_f.connection) <> 'codex-home:codex-worker' THEN
    RAISE EXCEPTION 'the Codex credential reference still names codex-poc';
  END IF;
  IF (SELECT details->>'workspace' FROM audit_events WHERE id=v_f.audit) <> '/srv/infra-cod-handoff-poc/workspaces/layout-1' THEN
    RAISE EXCEPTION 'history was rewritten';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='control_plane'::regnamespace AND prosrc LIKE '%codex-poc%') THEN
    RAISE EXCEPTION 'a function still names codex-poc';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE proname='start_codex_device_login') THEN
    RAISE EXCEPTION 'start_codex_device_login lost SECURITY DEFINER in the rewrite';
  END IF;

  -- And the rewritten function writes the new reference.
  DELETE FROM provider_connections WHERE id=v_f.connection;
  v_started:=start_codex_device_login(v_f.operator,'layout',interval '10 minutes');
  IF (SELECT native_credential_reference FROM provider_connections WHERE operator_id=v_f.operator AND provider='codex')
     <> 'codex-home:codex-worker' THEN
    RAISE EXCEPTION 'start_codex_device_login writes %', (SELECT native_credential_reference FROM provider_connections WHERE operator_id=v_f.operator AND provider='codex');
  END IF;
  RAISE NOTICE 'live rows and the credential functions moved to the product layout; history did not';
END $$;

ROLLBACK;
