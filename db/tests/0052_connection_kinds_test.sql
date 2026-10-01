-- SCM and model-access connections apart (migration 0082, Stage 11.4 A2; ADR-0018 §2).
--
-- A GitHub connection's id cannot be written where a model credential
-- belongs, and a model credential's id cannot be written where a repository
-- connection belongs — refused by the database, whichever function tries. Each
-- kind keeps its own shape.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE v_owner uuid; v_github uuid; v_codex uuid; v_kind text;
BEGIN
  INSERT INTO users(display_name) VALUES('Kinds Test') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,external_installation_id)
    VALUES(v_owner,'github','github_app','connected','4242') RETURNING id, connection_kind INTO v_github, v_kind;
  IF v_kind<>'scm' THEN RAISE EXCEPTION 'a GitHub connection is not scm: %', v_kind; END IF;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status)
    VALUES(v_owner,'codex','device_code','connected') RETURNING id, connection_kind INTO v_codex, v_kind;
  IF v_kind<>'model_access' THEN RAISE EXCEPTION 'a Codex connection is not model_access: %', v_kind; END IF;

  -- A model-access row with the GitHub connection: refused.
  BEGIN
    INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source)
      VALUES(v_owner,v_github,'codex','openai','kinds-model','codex_model_list');
    RAISE EXCEPTION 'a catalog entry was written against a GitHub connection';
  -- Since 0083 an entry takes its connection's gateway, which a GitHub
  -- connection has none of: refused as a null before the foreign key is asked.
  EXCEPTION WHEN foreign_key_violation OR not_null_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO catalog_refresh_jobs(operator_id,connection_id) VALUES(v_owner,v_github);
    RAISE EXCEPTION 'a catalog refresh was queued for a GitHub connection';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- … and with the Codex connection it is accepted.
  INSERT INTO catalog_refresh_jobs(operator_id,connection_id) VALUES(v_owner,v_codex);

  -- An SCM row with the model connection: refused.
  BEGIN
    INSERT INTO provider_installation_repositories(connection_id,github_repository_id,full_name,clone_url)
      VALUES(v_codex,1,'owner/repo','https://github.com/owner/repo.git');
    RAISE EXCEPTION 'a repository was recorded under a model credential';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  INSERT INTO provider_installation_repositories(connection_id,github_repository_id,full_name,clone_url)
    VALUES(v_github,1,'owner/repo','https://github.com/owner/repo.git');
  BEGIN
    INSERT INTO projects(owner_id,name,slug,workspace_path,provider_connection_id)
      VALUES(v_owner,'Kinds','kinds-test','/srv/kinds-test',v_codex);
    RAISE EXCEPTION 'a project was bound to a model credential as its repository connection';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- Each kind keeps its shape.
  BEGIN
    UPDATE provider_connections SET billing_boundary='free' WHERE id=v_github;
    RAISE EXCEPTION 'a GitHub connection took a billing boundary';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO provider_connections(operator_id,provider,auth_method,status,external_installation_id)
      VALUES(v_owner,'codex','github_app','connected','99');
    RAISE EXCEPTION 'a model connection was signed in as a GitHub App';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- The kind is derived, never written.
  BEGIN
    UPDATE provider_connections SET connection_kind='model_access' WHERE id=v_github;
    RAISE EXCEPTION 'a connection''s kind was written';
  EXCEPTION WHEN generated_always THEN NULL;
  END;

  RAISE NOTICE 'connection kinds are disjoint, and each kind keeps its shape';
END $$;

ROLLBACK;
