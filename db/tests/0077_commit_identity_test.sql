-- Who an executor's commits are by (migration 0124): the GitHub App's bot for a
-- project published through the App once the broker has recorded it, the
-- platform otherwise — never nothing.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE
  v_owner uuid; v_connection uuid; v_app_project uuid; v_empty_project uuid;
  v_identity jsonb;
BEGIN
  DELETE FROM github_app_identity;
  INSERT INTO users(display_name) VALUES('Commit identity') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,external_installation_id,
    repository_selection,native_credential_reference)
  VALUES(v_owner,'github','github_app','connected','24681357','selected','github-app:24681357')
  RETURNING id INTO v_connection;
  INSERT INTO projects(id,owner_id,name,slug,workspace_path,repository_url,default_branch,status,settings,
    credential_mode,provider_connection_id,github_repository_id,repository_full_name)
  VALUES(gen_random_uuid(),v_owner,'Through the App','commit-identity-app','/srv/commit-identity-app',
    'https://github.com/owner/identity.git','main','active','{}',
    'github_app',v_connection,4242,'owner/identity')
  RETURNING id INTO v_app_project;
  INSERT INTO projects(id,owner_id,name,slug,workspace_path,default_branch,status,settings)
  VALUES(gen_random_uuid(),v_owner,'Empty','commit-identity-empty','/srv/commit-identity-empty','main','active','{}')
  RETURNING id INTO v_empty_project;

  -- Before the broker has asked GitHub: the platform, for every project.
  v_identity := commit_identity_for(v_app_project);
  IF v_identity->>'source' <> 'platform' OR v_identity->>'email' <> 'infra-cod@localhost' THEN
    RAISE EXCEPTION 'an unrecorded App must leave the platform identity, got %', v_identity;
  END IF;

  v_identity := record_github_app_identity('github-broker-test', 101, 'infra-cod', 308131237);
  IF v_identity->>'email' <> '308131237+infra-cod[bot]@users.noreply.github.com' THEN
    RAISE EXCEPTION 'recording must answer the bot, got %', v_identity;
  END IF;

  v_identity := commit_identity_for(v_app_project);
  IF v_identity->>'name' <> 'infra-cod[bot]' OR v_identity->>'source' <> 'github_app'
     OR v_identity->>'email' <> '308131237+infra-cod[bot]@users.noreply.github.com' THEN
    RAISE EXCEPTION 'a project through the App must commit as its bot, got %', v_identity;
  END IF;
  v_identity := commit_identity_for(v_empty_project);
  IF v_identity->>'source' <> 'platform' THEN
    RAISE EXCEPTION 'a project not through the App must commit as the platform, got %', v_identity;
  END IF;

  -- Recorded again with a new bot: one row, the new one.
  PERFORM record_github_app_identity('github-broker-test', 101, 'infra-cod', 999);
  IF (SELECT count(*) FROM github_app_identity) <> 1
     OR commit_identity_for(v_app_project)->>'email' <> '999+infra-cod[bot]@users.noreply.github.com' THEN
    RAISE EXCEPTION 'the identity must be one row, replaced';
  END IF;

  BEGIN
    PERFORM record_github_app_identity('github-broker-test', 101, 'Not A Slug', 1);
    RAISE EXCEPTION 'a slug outside GitHub''s spelling was recorded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

ROLLBACK;
