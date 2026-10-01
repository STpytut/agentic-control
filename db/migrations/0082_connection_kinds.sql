-- SCM and model-access connections apart (Stage 11.4, sprint B A2; ADR-0018 §2).
--
-- `provider_connections` holds a GitHub App installation and the credentials a
-- runtime reaches models with, in one table, told apart only by `provider`.
-- Nothing stopped a GitHub connection's id from being written where a model
-- connection belongs — a catalog entry, a refresh, a verification — or the
-- other way round.
--
-- Each connection now has a kind, derived from its provider and never written:
-- `scm` for GitHub, `model_access` for every runtime's connection. Each kind
-- has its own CHECK. Every table that refers to a connection says which kind
-- it refers to, with a column that is a constant of its kind, and a foreign key
-- on (connection, kind) — so a connection of the other kind is refused by the
-- database, whatever function wrote the row. No writer changes: the kind
-- columns are generated.
--
--   model_access: provider_model_catalog, catalog_refresh_jobs,
--                 catalog_gate_allowlist, model_verification_receipts,
--                 provider_secret_enrollments
--   scm:          projects (provider_connection_id), provider_installation_repositories,
--                 github_clone_authorizations
--   by provider:  provider_login_sessions (GitHub OAuth and Codex device login)

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('connection_kind_mismatch','conflict','a GitHub connection is not a model credential, and a model credential is not a repository connection');

ALTER TABLE provider_connections ADD COLUMN connection_kind text
  GENERATED ALWAYS AS (CASE WHEN provider='github' THEN 'scm' ELSE 'model_access' END) STORED;
ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_id_kind_key UNIQUE (id, connection_kind);

-- The two kinds' shapes. An SCM connection is a GitHub App installation with no
-- billing; a model-access connection is signed in by a runtime's own method.
DO $$
DECLARE v_wrong text;
BEGIN
  SELECT string_agg(id::text||' ('||provider||', '||auth_method||')', ', ') INTO v_wrong
  FROM provider_connections
  WHERE (connection_kind='scm' AND (auth_method<>'github_app' OR billing_boundary<>''))
     OR (connection_kind='model_access' AND auth_method NOT IN ('device_code','api_key','native'));
  IF v_wrong IS NOT NULL THEN
    PERFORM refuse('connection_kind_mismatch', 'connections that fit neither kind: '||v_wrong);
  END IF;
END $$;
ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_scm_shape CHECK (
    connection_kind<>'scm' OR (auth_method='github_app' AND billing_boundary='')),
  ADD CONSTRAINT provider_connections_model_access_shape CHECK (
    connection_kind<>'model_access' OR auth_method IN ('device_code','api_key','native'));

-- Each referring table names the kind it refers to.
ALTER TABLE provider_model_catalog ADD COLUMN connection_kind text GENERATED ALWAYS AS ('model_access') STORED;
ALTER TABLE provider_model_catalog ADD CONSTRAINT provider_model_catalog_connection_kind_fkey
  FOREIGN KEY (connection_id, connection_kind) REFERENCES provider_connections(id, connection_kind);
ALTER TABLE catalog_refresh_jobs ADD COLUMN connection_kind text GENERATED ALWAYS AS ('model_access') STORED;
ALTER TABLE catalog_refresh_jobs ADD CONSTRAINT catalog_refresh_jobs_connection_kind_fkey
  FOREIGN KEY (connection_id, connection_kind) REFERENCES provider_connections(id, connection_kind);
ALTER TABLE catalog_gate_allowlist ADD COLUMN connection_kind text GENERATED ALWAYS AS ('model_access') STORED;
ALTER TABLE catalog_gate_allowlist ADD CONSTRAINT catalog_gate_allowlist_connection_kind_fkey
  FOREIGN KEY (connection_id, connection_kind) REFERENCES provider_connections(id, connection_kind);
ALTER TABLE model_verification_receipts ADD COLUMN connection_kind text GENERATED ALWAYS AS ('model_access') STORED;
ALTER TABLE model_verification_receipts ADD CONSTRAINT model_verification_receipts_connection_kind_fkey
  FOREIGN KEY (connection_id, connection_kind) REFERENCES provider_connections(id, connection_kind);
ALTER TABLE provider_secret_enrollments ADD COLUMN connection_kind text GENERATED ALWAYS AS ('model_access') STORED;
ALTER TABLE provider_secret_enrollments ADD CONSTRAINT provider_secret_enrollments_connection_kind_fkey
  FOREIGN KEY (connection_id, connection_kind) REFERENCES provider_connections(id, connection_kind);

ALTER TABLE projects ADD COLUMN provider_connection_kind text GENERATED ALWAYS AS ('scm') STORED;
ALTER TABLE projects ADD CONSTRAINT projects_provider_connection_kind_fkey
  FOREIGN KEY (provider_connection_id, provider_connection_kind) REFERENCES provider_connections(id, connection_kind);
ALTER TABLE provider_installation_repositories ADD COLUMN connection_kind text GENERATED ALWAYS AS ('scm') STORED;
ALTER TABLE provider_installation_repositories ADD CONSTRAINT provider_installation_repositories_connection_kind_fkey
  FOREIGN KEY (connection_id, connection_kind) REFERENCES provider_connections(id, connection_kind);
ALTER TABLE github_clone_authorizations ADD COLUMN connection_kind text GENERATED ALWAYS AS ('scm') STORED;
ALTER TABLE github_clone_authorizations ADD CONSTRAINT github_clone_authorizations_connection_kind_fkey
  FOREIGN KEY (connection_id, connection_kind) REFERENCES provider_connections(id, connection_kind);

ALTER TABLE provider_login_sessions ADD COLUMN connection_kind text
  GENERATED ALWAYS AS (CASE WHEN provider='github' THEN 'scm' ELSE 'model_access' END) STORED;
ALTER TABLE provider_login_sessions ADD CONSTRAINT provider_login_sessions_connection_kind_fkey
  FOREIGN KEY (connection_id, connection_kind) REFERENCES provider_connections(id, connection_kind);
