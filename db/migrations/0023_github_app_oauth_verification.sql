BEGIN;
SET search_path TO control_plane, public, extensions;

-- OAuth authorization codes are encrypted with AES-256-GCM by the web callback
-- before they cross the database boundary. Only ciphertext, IV and auth tag are
-- persisted; the dedicated encryption key is present in the web callback and
-- VPS broker environments, never in PostgreSQL.

CREATE TABLE github_oauth_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL DEFAULT 'github',
  state_digest text NOT NULL CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  installation_id text NOT NULL CHECK (installation_id ~ '^[0-9]+$'),
  setup_action text NOT NULL DEFAULT '',
  authorization_code_ciphertext bytea CHECK (octet_length(authorization_code_ciphertext) BETWEEN 8 AND 1024),
  authorization_code_iv bytea CHECK (octet_length(authorization_code_iv) = 12),
  authorization_code_tag bytea CHECK (octet_length(authorization_code_tag) = 16),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 8 AND 64),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','exchanging','completed','failed','expired')),
  exchanged_at timestamptz,
  consumed_at timestamptz,
  failure_code text NOT NULL DEFAULT '',
  failure_message text NOT NULL DEFAULT '',
  broker_leased_by text,
  broker_leased_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '10 minutes',
  CHECK (expires_at > created_at),
  CHECK (status <> 'completed' OR consumed_at IS NOT NULL),
  CHECK ((status IN ('pending','exchanging')) =
    (authorization_code_ciphertext IS NOT NULL AND authorization_code_iv IS NOT NULL AND authorization_code_tag IS NOT NULL))
);

CREATE INDEX github_oauth_codes_broker_work
  ON github_oauth_codes(status, broker_leased_until, created_at)
  WHERE status IN ('pending','exchanging');

CREATE INDEX github_oauth_codes_reconcile
  ON github_oauth_codes(status, expires_at)
  WHERE status IN ('pending','exchanging');

-- Durable fence that ties a clone to the connection version observed at claim
-- time. Disconnect cannot complete while a non-expired clone authorization is
-- active, so a successfully disconnected connection cannot race token use.
CREATE TABLE github_clone_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  connection_id uuid NOT NULL REFERENCES provider_connections(id),
  connection_version bigint NOT NULL,
  worker_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','consumed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '10 minutes'
);

CREATE INDEX github_clone_authorizations_connection_active
  ON github_clone_authorizations(connection_id) WHERE status='active';
CREATE UNIQUE INDEX github_clone_authorizations_project_one_active
  ON github_clone_authorizations(project_id) WHERE status='active';

CREATE OR REPLACE FUNCTION record_github_oauth_callback(
  p_operator_id uuid, p_state_digest text, p_installation_id text, p_setup_action text,
  p_authorization_code_ciphertext text, p_authorization_code_iv text, p_authorization_code_tag text,
  p_client_id text, p_ttl interval DEFAULT interval '10 minutes'
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  IF p_state_digest !~ '^[0-9a-f]{64}$' OR p_installation_id !~ '^[0-9]+$'
     OR length(trim(p_authorization_code_ciphertext))<8 OR length(p_client_id)<8 THEN
    RAISE EXCEPTION 'invalid github oauth callback parameters' USING ERRCODE='22023';
  END IF;
  INSERT INTO github_oauth_codes(operator_id, state_digest, installation_id, setup_action,
    authorization_code_ciphertext, authorization_code_iv, authorization_code_tag, client_id, expires_at)
  VALUES(p_operator_id, p_state_digest, p_installation_id, p_setup_action,
    decode(p_authorization_code_ciphertext,'base64'), decode(p_authorization_code_iv,'base64'),
    decode(p_authorization_code_tag,'base64'), p_client_id, clock_timestamp()+p_ttl)
  RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

-- Reclaim rows whose previous lease has expired and transition rows that have
-- exceeded their TTL into the expired state so the UI stops showing them as
-- pending.
CREATE OR REPLACE FUNCTION reconcile_github_oauth_codes()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_count integer := 0;
BEGIN
  UPDATE github_oauth_codes SET status='expired', updated_at=clock_timestamp(),
    broker_leased_by=NULL, broker_leased_until=NULL,
    authorization_code_ciphertext=NULL, authorization_code_iv=NULL,
    authorization_code_tag=NULL, failure_code='oauth_expired'
  WHERE status IN ('pending','exchanging') AND expires_at<=clock_timestamp();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;

CREATE OR REPLACE FUNCTION claim_github_oauth_pending(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '90 seconds'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM reconcile_github_oauth_codes();
  WITH candidates AS (
    SELECT c.id FROM github_oauth_codes c
    WHERE c.status IN ('pending','exchanging') AND c.expires_at>clock_timestamp()
      AND (c.broker_leased_until IS NULL OR c.broker_leased_until<=clock_timestamp())
    ORDER BY c.created_at FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE github_oauth_codes SET broker_leased_by=p_worker_id, broker_leased_until=clock_timestamp()+p_lease,
      updated_at=clock_timestamp()
    FROM candidates WHERE github_oauth_codes.id=candidates.id
    RETURNING github_oauth_codes.id, github_oauth_codes.operator_id, github_oauth_codes.installation_id,
      github_oauth_codes.state_digest, github_oauth_codes.setup_action, github_oauth_codes.client_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'code_id',c.id,'operator_id',c.operator_id,'installation_id',c.installation_id,
    'state_digest',c.state_digest,'setup_action',c.setup_action,'client_id',c.client_id)),'[]'::jsonb)
  INTO v_result FROM claimed c;
  RETURN v_result;
END; $$;

-- Atomically transition to 'exchanging' and return the encrypted envelope.
-- An expired lease can be reclaimed after a broker crash.
CREATE OR REPLACE FUNCTION begin_github_oauth_exchange(p_code_id uuid, p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_code github_oauth_codes%ROWTYPE;
BEGIN
  SELECT * INTO v_code FROM github_oauth_codes
  WHERE id=p_code_id AND broker_leased_by=p_worker_id AND broker_leased_until>clock_timestamp()
    AND status IN ('pending','exchanging') AND expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'oauth code is not claimable' USING ERRCODE='55000'; END IF;
  UPDATE github_oauth_codes SET status='exchanging', exchanged_at=clock_timestamp(),
    updated_at=clock_timestamp()
  WHERE id=p_code_id;
  RETURN jsonb_build_object(
    'ciphertext',encode(v_code.authorization_code_ciphertext,'base64'),
    'iv',encode(v_code.authorization_code_iv,'base64'),
    'tag',encode(v_code.authorization_code_tag,'base64'));
END; $$;

CREATE OR REPLACE FUNCTION complete_github_oauth_exchange(
  p_code_id uuid, p_worker_id text, p_connection_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  UPDATE github_oauth_codes SET status='completed', consumed_at=clock_timestamp(),
    authorization_code_ciphertext=NULL,
    authorization_code_iv=NULL, authorization_code_tag=NULL,
    broker_leased_by=NULL, broker_leased_until=NULL,
    updated_at=clock_timestamp()
  WHERE id=p_code_id AND broker_leased_by=p_worker_id AND status='exchanging';
  IF NOT FOUND THEN RAISE EXCEPTION 'oauth code is not exchanging' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('code_id',p_code_id,'status','completed','connection_id',p_connection_id);
END; $$;

CREATE OR REPLACE FUNCTION fail_github_oauth_exchange(
  p_code_id uuid, p_worker_id text, p_failure_code text, p_failure_message text
) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  UPDATE github_oauth_codes SET status='failed', exchanged_at=COALESCE(exchanged_at,clock_timestamp()),
    authorization_code_ciphertext=NULL,
    authorization_code_iv=NULL, authorization_code_tag=NULL,
    broker_leased_by=NULL, broker_leased_until=NULL,
    failure_code=left(COALESCE(p_failure_code,''),80),
    failure_message=left(COALESCE(regexp_replace(p_failure_message,'[[:cntrl:]]',' ','g'),''),500),
    updated_at=clock_timestamp()
  WHERE id=p_code_id AND broker_leased_by=p_worker_id AND status IN ('pending','exchanging');
  IF NOT FOUND THEN RAISE EXCEPTION 'oauth code is not claimable or exchanging' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('code_id',p_code_id,'status','failed');
END; $$;

CREATE OR REPLACE FUNCTION get_operator_github_oauth_status(p_operator_id uuid)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT COALESCE(jsonb_build_object(
    'code_id',id,'status',status,'installation_id',installation_id,'setup_action',setup_action,
    'failure_code',failure_code,'failure_message',failure_message,'created_at',created_at),
    'null'::jsonb)
  FROM github_oauth_codes WHERE operator_id=p_operator_id
  ORDER BY created_at DESC LIMIT 1;
$$;

ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS verified_via text NOT NULL DEFAULT 'broker';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='provider_connections_verified_via_check') THEN
    ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_verified_via_check
      CHECK (verified_via IN ('broker','oauth'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION create_pending_github_connection(
  p_operator_id uuid, p_installation_id text, p_setup_action text, p_correlation_id text,
  p_verified_via text DEFAULT 'broker'::text
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_existing provider_connections%ROWTYPE; v_id uuid; v_action text;
BEGIN
  IF p_installation_id !~ '^[0-9]+$' OR p_verified_via NOT IN ('broker','oauth') THEN
    RAISE EXCEPTION 'invalid github connection parameters' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_existing FROM provider_connections
  WHERE operator_id=p_operator_id AND provider='github' AND external_installation_id=p_installation_id
  FOR UPDATE;
  v_action := CASE WHEN v_existing.id IS NULL THEN 'provider.connection_created' ELSE 'provider.reconnect_started' END;
  IF v_existing.id IS NULL THEN
    INSERT INTO provider_connections(operator_id, provider, auth_method, status, external_installation_id,
      native_credential_reference, verified_via, version)
    VALUES(p_operator_id,'github','github_app','pending_finalize',p_installation_id,'github-app-private-key',p_verified_via,1)
    RETURNING id INTO v_id;
  ELSE
    UPDATE provider_connections SET status='pending_finalize', broker_leased_by=NULL, broker_leased_until=NULL,
      last_failure_code='', last_failure_message='', verify_requested_at=NULL, verified_via=p_verified_via,
      updated_at=clock_timestamp(), version=version+1
    WHERE id=v_existing.id RETURNING id INTO v_id;
  END IF;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,v_action,
    'provider_connection',v_id::text,'allowed',NULL,
    jsonb_build_object('provider','github','installation_id',p_installation_id,'setup_action',COALESCE(p_setup_action,''),'verified_via',p_verified_via),
    COALESCE(p_correlation_id,p_operator_id::text));
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION consume_session_and_record_github_oauth(
  p_operator_id uuid, p_state_digest text, p_installation_id text, p_setup_action text,
  p_authorization_code_ciphertext text, p_authorization_code_iv text, p_authorization_code_tag text,
  p_client_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_code_id uuid;
BEGIN
  PERFORM consume_provider_login_session(p_operator_id,'github',p_state_digest);
  v_code_id := record_github_oauth_callback(p_operator_id, p_state_digest, p_installation_id, p_setup_action,
    p_authorization_code_ciphertext, p_authorization_code_iv, p_authorization_code_tag, p_client_id);
  RETURN jsonb_build_object('code_id',v_code_id);
END; $$;

-- Persist the verified connection and consume/scrub the one-time code in one
-- transaction, avoiding a crash window with a connection but a non-terminal
-- OAuth row.
CREATE OR REPLACE FUNCTION complete_github_oauth_connection(
  p_code_id uuid, p_worker_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_connection_id uuid; v_code github_oauth_codes%ROWTYPE;
BEGIN
  SELECT * INTO v_code FROM github_oauth_codes
  WHERE id=p_code_id AND broker_leased_by=p_worker_id AND status='exchanging'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'oauth code is not exchanging' USING ERRCODE='55000'; END IF;
  v_connection_id := create_pending_github_connection(
    v_code.operator_id,v_code.installation_id,v_code.setup_action,v_code.state_digest,'oauth');
  PERFORM complete_github_oauth_exchange(p_code_id,p_worker_id,v_connection_id);
  RETURN jsonb_build_object('code_id',p_code_id,'status','completed','connection_id',v_connection_id);
END; $$;

-- Acquire a clone authorization under the projects-row lock. Returns the
-- connection version observed at acquisition time. The authorization remains
-- active until clone completion and temporarily fences disconnect.
CREATE OR REPLACE FUNCTION acquire_github_clone_authorization(
  p_project_id uuid, p_worker_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_project projects%ROWTYPE; v_connection provider_connections%ROWTYPE; v_auth github_clone_authorizations%ROWTYPE;
BEGIN
  SELECT * INTO v_project FROM projects WHERE id=p_project_id FOR UPDATE;
  IF NOT FOUND OR v_project.credential_mode<>'github_app' THEN
    RAISE EXCEPTION 'project is not a github_app clone target' USING ERRCODE='55000';
  END IF;
  UPDATE github_clone_authorizations SET status='revoked', revoked_at=clock_timestamp()
  WHERE project_id=p_project_id AND status='active' AND expires_at<=clock_timestamp();
  SELECT * INTO v_connection FROM provider_connections WHERE id=v_project.provider_connection_id;
  IF NOT FOUND OR v_connection.provider<>'github' OR v_connection.status<>'connected' THEN
    RAISE EXCEPTION 'GitHub connection is required to clone this private repository' USING ERRCODE='55000';
  END IF;
  INSERT INTO github_clone_authorizations(project_id, connection_id, connection_version, worker_id)
  VALUES(v_project.id, v_connection.id, v_connection.version, p_worker_id)
  RETURNING * INTO v_auth;
  RETURN jsonb_build_object(
    'authorization_id',v_auth.id,'project_id',v_project.id,'version',v_project.version,
    'provider_connection_id',v_project.provider_connection_id,
    'github_repository_id',v_project.github_repository_id,
    'connection_id',v_connection.id,'installation_id',v_connection.external_installation_id,
    'connection_version',v_connection.version);
END; $$;

CREATE OR REPLACE FUNCTION validate_github_clone_authorization(
  p_authorization_id uuid, p_worker_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_auth github_clone_authorizations%ROWTYPE; v_connection provider_connections%ROWTYPE;
BEGIN
  SELECT * INTO v_auth FROM github_clone_authorizations WHERE id=p_authorization_id FOR UPDATE;
  IF NOT FOUND OR v_auth.worker_id<>p_worker_id OR v_auth.status<>'active' OR v_auth.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'clone authorization is not active for worker' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_connection FROM provider_connections WHERE id=v_auth.connection_id FOR UPDATE;
  IF NOT FOUND OR v_connection.status<>'connected' OR v_connection.version<>v_auth.connection_version THEN
    UPDATE github_clone_authorizations SET status='revoked', revoked_at=clock_timestamp() WHERE id=p_authorization_id;
    RETURN jsonb_build_object('authorization_id',p_authorization_id,'status','revoked','reason','connection_changed');
  END IF;
  RETURN jsonb_build_object('authorization_id',p_authorization_id,'status','active');
END; $$;

CREATE OR REPLACE FUNCTION finalize_github_clone_authorization(
  p_authorization_id uuid, p_worker_id text, p_success boolean
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_auth github_clone_authorizations%ROWTYPE; v_fresh_version bigint;
BEGIN
  SELECT * INTO v_auth FROM github_clone_authorizations WHERE id=p_authorization_id FOR UPDATE;
  IF NOT FOUND OR v_auth.worker_id<>p_worker_id THEN
    RAISE EXCEPTION 'clone authorization is not active for worker' USING ERRCODE='55000';
  END IF;
  IF v_auth.status<>'active' THEN
    RETURN jsonb_build_object('authorization_id',p_authorization_id,'status',v_auth.status);
  END IF;
  SELECT version INTO v_fresh_version FROM provider_connections WHERE id=v_auth.connection_id;
  IF v_fresh_version IS DISTINCT FROM v_auth.connection_version THEN
    UPDATE github_clone_authorizations SET status='revoked', revoked_at=clock_timestamp()
    WHERE id=p_authorization_id;
    RETURN jsonb_build_object('authorization_id',p_authorization_id,'status','revoked','reason','connection_version_changed');
  END IF;
  IF p_success THEN
    UPDATE github_clone_authorizations SET status='consumed', consumed_at=clock_timestamp()
    WHERE id=p_authorization_id;
  ELSE
    UPDATE github_clone_authorizations SET status='revoked', revoked_at=clock_timestamp()
    WHERE id=p_authorization_id;
  END IF;
  RETURN jsonb_build_object('authorization_id',p_authorization_id,'status',CASE WHEN p_success THEN 'consumed' ELSE 'revoked' END);
END; $$;

CREATE OR REPLACE FUNCTION disconnect_github_connection(
  p_connection_id uuid, p_operator_id uuid, p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v provider_connections%ROWTYPE;
BEGIN
  SELECT * INTO v FROM provider_connections
  WHERE id=p_connection_id AND operator_id=p_operator_id AND provider='github' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GitHub connection is unavailable' USING ERRCODE='55000'; END IF;
  IF v.status='disconnected' THEN RETURN jsonb_build_object('connection_id',v.id,'status','disconnected'); END IF;
  UPDATE github_clone_authorizations SET status='revoked', revoked_at=clock_timestamp()
  WHERE connection_id=p_connection_id AND status='active' AND expires_at<=clock_timestamp();
  IF EXISTS(SELECT 1 FROM github_clone_authorizations
    WHERE connection_id=p_connection_id AND status='active') THEN
    RAISE EXCEPTION 'A GitHub clone is in progress; retry disconnect when it completes' USING ERRCODE='55000';
  END IF;
  UPDATE provider_connections SET status='disconnected', broker_leased_by=NULL, broker_leased_until=NULL,
    verify_requested_at=NULL, version=version+1, updated_at=clock_timestamp()
  WHERE id=p_connection_id RETURNING * INTO v;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,'provider.disconnected',
    'provider_connection',v.id::text,'allowed',NULL,
    jsonb_build_object('provider','github','installation_id',v.external_installation_id,'connection_version',v.version),
    COALESCE(p_correlation_id,v.id::text));
  RETURN jsonb_build_object('connection_id',v.id,'status',v.status,'connection_version',v.version);
END; $$;

DROP FUNCTION IF EXISTS create_pending_github_connection(uuid,text,text,text);

ALTER FUNCTION record_github_oauth_callback(uuid,text,text,text,text,text,text,text,interval) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION reconcile_github_oauth_codes() SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_github_oauth_pending(text,integer,interval) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION begin_github_oauth_exchange(uuid,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION complete_github_oauth_exchange(uuid,text,uuid) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION fail_github_oauth_exchange(uuid,text,text,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION get_operator_github_oauth_status(uuid) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION create_pending_github_connection(uuid,text,text,text,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION consume_session_and_record_github_oauth(uuid,text,text,text,text,text,text,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION complete_github_oauth_connection(uuid,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION acquire_github_clone_authorization(uuid,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION validate_github_clone_authorization(uuid,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION finalize_github_clone_authorization(uuid,text,boolean) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION disconnect_github_connection(uuid,uuid,text) SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
