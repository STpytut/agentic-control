-- The GitHub App from the panel (Stage 12 G1). Connecting GitHub was a page of
-- OPERATIONS.md: create an App by hand, copy its id, slug, client id and secret
-- into two env files, put its key on the host. GitHub's manifest flow does all
-- of that from a button: the panel posts a manifest, the owner presses Create
-- on GitHub, and GitHub answers with a one-hour code that converts into the
-- App's id, slug, client id, client secret and private key.
--
-- The code is a credential — its conversion hands out the key — so it crosses
-- the database as the OAuth codes do (0023): AES-256-GCM ciphertext, sealed by
-- the web callback with the key the web and the GitHub broker share. The broker
-- converts it, keeps the key and the client secret as files it alone reads, and
-- records here only what is public: the App's id, slug and client id. Nothing
-- secret is stored in this table once a row has left `pending`.
--
-- One App per installation of the panel, as before; env values, where an
-- operator set them by hand, still win (github-app-config.mjs).

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('github_app_manifest_state_invalid','invalid_argument','a manifest state is a 64-character hex digest'),
  ('github_app_operator_unknown','not_found','no operator with that id'),
  ('github_app_already_registered','conflict','this panel already has a GitHub App; replacing it is not offered'),
  ('github_app_manifest_state_spent','permission_denied','the manifest state is unknown, another operator''s, already used or expired'),
  ('github_app_manifest_not_converting','lease_lost','the manifest is not being converted by this worker')
ON CONFLICT (reason) DO NOTHING;

CREATE TABLE IF NOT EXISTS github_app_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES users(id),
  state_digest text NOT NULL UNIQUE CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  owner_kind text NOT NULL CHECK (owner_kind IN ('user','organization')),
  organization text CHECK (organization IS NULL OR organization ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN ('started','pending','converting','registered','failed','expired','superseded')),
  code_ciphertext bytea CHECK (octet_length(code_ciphertext) BETWEEN 8 AND 1024),
  code_iv bytea CHECK (octet_length(code_iv) = 12),
  code_tag bytea CHECK (octet_length(code_tag) = 16),
  app_id bigint CHECK (app_id > 0),
  slug text CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  client_id text CHECK (length(client_id) BETWEEN 8 AND 64),
  owner_login text,
  html_url text CHECK (html_url IS NULL OR html_url ~ '^https://github\.com/'),
  failure_code text NOT NULL DEFAULT '',
  failure_message text NOT NULL DEFAULT '',
  leased_by text,
  leased_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '1 hour',
  CHECK ((status IN ('pending','converting')) = (code_ciphertext IS NOT NULL AND code_iv IS NOT NULL AND code_tag IS NOT NULL)),
  CHECK ((status = 'registered') = (app_id IS NOT NULL AND slug IS NOT NULL AND client_id IS NOT NULL)),
  CHECK ((owner_kind = 'organization') = (organization IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS github_app_manifests_one_registered
  ON github_app_manifests((true)) WHERE status = 'registered';

-- The App the panel created, public fields only; null when there is none.
CREATE OR REPLACE FUNCTION github_app_registration() RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = control_plane, public, extensions
AS $$
  SELECT COALESCE((SELECT jsonb_build_object('app_id', app_id, 'slug', slug, 'client_id', client_id,
      'owner_login', owner_login, 'html_url', html_url, 'registered_at', updated_at)
    FROM github_app_manifests WHERE status = 'registered'), 'null'::jsonb);
$$;

CREATE OR REPLACE FUNCTION expire_github_app_manifests() RETURNS integer
LANGUAGE plpgsql
SET search_path = control_plane, public, extensions
AS $$
DECLARE v_count integer;
BEGIN
  UPDATE github_app_manifests SET status = 'expired', code_ciphertext = NULL, code_iv = NULL, code_tag = NULL,
    leased_by = NULL, leased_until = NULL, failure_code = 'manifest_expired', updated_at = clock_timestamp()
  WHERE status IN ('started','pending','converting') AND expires_at <= clock_timestamp();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;

-- The panel's button: a state for the manifest's round trip. Refused once an
-- App is registered — replacing one is a deliberate act this does not offer.
CREATE OR REPLACE FUNCTION start_github_app_manifest(
  p_operator_id uuid, p_state_digest text, p_organization text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = control_plane, public, extensions
AS $$
DECLARE v_id uuid; v_org text := NULLIF(trim(COALESCE(p_organization, '')), '');
BEGIN
  IF p_state_digest !~ '^[0-9a-f]{64}$' THEN
    PERFORM refuse('github_app_manifest_state_invalid', 'invalid github app manifest state', '22023');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_operator_id) THEN
    PERFORM refuse('github_app_operator_unknown', format('no operator %s', p_operator_id), '42501');
  END IF;
  IF EXISTS (SELECT 1 FROM github_app_manifests WHERE status = 'registered') THEN
    PERFORM refuse('github_app_already_registered', 'a GitHub App is already registered for this panel');
  END IF;
  PERFORM expire_github_app_manifests();
  UPDATE github_app_manifests SET status = 'superseded', updated_at = clock_timestamp()
  WHERE operator_id = p_operator_id AND status = 'started';
  INSERT INTO github_app_manifests(operator_id, state_digest, owner_kind, organization)
  VALUES (p_operator_id, p_state_digest, CASE WHEN v_org IS NULL THEN 'user' ELSE 'organization' END, v_org)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('manifest_id', v_id);
END; $$;

-- GitHub's redirect back: the one-time code, sealed. Only the operator who
-- started this state, only once, only within the hour.
CREATE OR REPLACE FUNCTION record_github_app_manifest_code(
  p_operator_id uuid, p_state_digest text, p_code_ciphertext text, p_code_iv text, p_code_tag text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = control_plane, public, extensions
AS $$
DECLARE v_row github_app_manifests%ROWTYPE;
BEGIN
  PERFORM expire_github_app_manifests();
  SELECT * INTO v_row FROM github_app_manifests
  WHERE state_digest = p_state_digest AND operator_id = p_operator_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.status <> 'started' THEN
    PERFORM refuse('github_app_manifest_state_spent', 'the GitHub App manifest state is unknown, used or expired', '42501');
  END IF;
  UPDATE github_app_manifests SET status = 'pending', code_ciphertext = decode(p_code_ciphertext, 'base64'),
    code_iv = decode(p_code_iv, 'base64'), code_tag = decode(p_code_tag, 'base64'), updated_at = clock_timestamp()
  WHERE id = v_row.id;
  PERFORM write_audit_event(NULL, NULL, NULL, 'operator', p_operator_id::text, 'provider.github_app_created',
    'github_app_manifest', v_row.id::text, 'allowed', NULL,
    jsonb_build_object('owner_kind', v_row.owner_kind, 'organization', v_row.organization), v_row.id::text);
  RETURN jsonb_build_object('manifest_id', v_row.id);
END; $$;

CREATE OR REPLACE FUNCTION get_github_app_manifest_status(p_operator_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = control_plane, public, extensions
AS $$
  SELECT COALESCE((SELECT jsonb_build_object('manifest_id', id, 'status', status, 'slug', slug,
      'owner_login', owner_login, 'failure_code', failure_code, 'failure_message', failure_message,
      'updated_at', updated_at)
    FROM github_app_manifests WHERE operator_id = p_operator_id AND status <> 'superseded'
    ORDER BY created_at DESC LIMIT 1), 'null'::jsonb);
$$;

-- The broker's side: claim a sealed code, then say what it became.
CREATE OR REPLACE FUNCTION claim_github_app_manifest(p_worker_id text, p_lease interval DEFAULT interval '90 seconds')
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = control_plane, public, extensions
AS $$
DECLARE v_row github_app_manifests%ROWTYPE;
BEGIN
  PERFORM expire_github_app_manifests();
  SELECT * INTO v_row FROM github_app_manifests
  WHERE status IN ('pending','converting') AND (leased_until IS NULL OR leased_until <= clock_timestamp())
  ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF v_row.id IS NULL THEN RETURN 'null'::jsonb; END IF;
  UPDATE github_app_manifests SET status = 'converting', leased_by = p_worker_id,
    leased_until = clock_timestamp() + p_lease, updated_at = clock_timestamp()
  WHERE id = v_row.id;
  RETURN jsonb_build_object('manifest_id', v_row.id, 'ciphertext', encode(v_row.code_ciphertext, 'base64'),
    'iv', encode(v_row.code_iv, 'base64'), 'tag', encode(v_row.code_tag, 'base64'));
END; $$;

CREATE OR REPLACE FUNCTION complete_github_app_manifest(
  p_manifest_id uuid, p_worker_id text, p_app_id bigint, p_slug text, p_client_id text,
  p_owner_login text, p_html_url text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = control_plane, public, extensions
AS $$
BEGIN
  UPDATE github_app_manifests SET status = 'registered', code_ciphertext = NULL, code_iv = NULL, code_tag = NULL,
    app_id = p_app_id, slug = p_slug, client_id = p_client_id, owner_login = left(p_owner_login, 100),
    html_url = p_html_url, leased_by = NULL, leased_until = NULL, updated_at = clock_timestamp()
  WHERE id = p_manifest_id AND status = 'converting' AND leased_by = p_worker_id;
  IF NOT FOUND THEN
    PERFORM refuse('github_app_manifest_not_converting', format('manifest %s is not converting under %s', p_manifest_id, p_worker_id));
  END IF;
  RETURN github_app_registration();
END; $$;

CREATE OR REPLACE FUNCTION fail_github_app_manifest(
  p_manifest_id uuid, p_worker_id text, p_code text, p_message text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = control_plane, public, extensions
AS $$
BEGIN
  UPDATE github_app_manifests SET status = 'failed', code_ciphertext = NULL, code_iv = NULL, code_tag = NULL,
    failure_code = left(COALESCE(p_code, 'github_error'), 64), failure_message = left(COALESCE(p_message, ''), 500),
    leased_by = NULL, leased_until = NULL, updated_at = clock_timestamp()
  WHERE id = p_manifest_id AND status = 'converting' AND leased_by = p_worker_id;
  RETURN jsonb_build_object('manifest_id', p_manifest_id, 'status', 'failed');
END; $$;

REVOKE EXECUTE ON FUNCTION github_app_registration() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION expire_github_app_manifests() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION start_github_app_manifest(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_github_app_manifest_code(uuid, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_github_app_manifest_status(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_github_app_manifest(text, interval) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION complete_github_app_manifest(uuid, text, bigint, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fail_github_app_manifest(uuid, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION start_github_app_manifest(uuid, text, text) TO infra_web;
GRANT EXECUTE ON FUNCTION record_github_app_manifest_code(uuid, text, text, text, text) TO infra_web;
GRANT EXECUTE ON FUNCTION get_github_app_manifest_status(uuid) TO infra_web;
-- The registration is public (it is on GitHub): the web reads it through a
-- definer so it needs no grant on the table.
ALTER FUNCTION github_app_registration() SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION github_app_registration() TO infra_web, infra_worker;
GRANT SELECT, INSERT, UPDATE ON github_app_manifests TO infra_worker;
GRANT EXECUTE ON FUNCTION claim_github_app_manifest(text, interval) TO infra_worker;
GRANT EXECUTE ON FUNCTION complete_github_app_manifest(uuid, text, bigint, text, text, text, text) TO infra_worker;
GRANT EXECUTE ON FUNCTION fail_github_app_manifest(uuid, text, text, text) TO infra_worker;
