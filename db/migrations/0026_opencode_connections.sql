BEGIN;

SET search_path TO control_plane, public, extensions;

-- OpenCode Free/Go connections.
--
-- Free is a builtin/native connection with no secret enrollment and is always
-- available. Go (and future external_api) enroll a short-lived encrypted API key
-- through provider_secret_enrollments. Plaintext API keys never enter
-- PostgreSQL: the browser encrypts the key into a hybrid envelope (AES-256-GCM
-- under an ephemeral key wrapped by the VPS broker's RSA-OAEP public key); the
-- broker decrypts only on the VPS, passes the key to the official OpenCode auth
-- flow via stdin, then destroys ciphertext and plaintext buffers.

ALTER TABLE provider_connections
  ADD COLUMN billing_boundary text NOT NULL DEFAULT ''
    CHECK (billing_boundary IN ('','free','go','external_api'));

ALTER TABLE provider_connections
  DROP CONSTRAINT provider_connections_auth_method_check,
  ADD CONSTRAINT provider_connections_auth_method_check
    CHECK (auth_method IN ('github_app','deploy_key','device_code','api_key','native'));

ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_opencode_boundary CHECK (
    (provider <> 'opencode') OR (billing_boundary IN ('free','go','external_api'))
  ),
  ADD CONSTRAINT provider_connections_opencode_auth_boundary CHECK (
    (provider <> 'opencode')
    OR (billing_boundary = 'free' AND auth_method = 'native')
    OR (billing_boundary IN ('go','external_api') AND auth_method = 'api_key')
  ),
  ADD CONSTRAINT provider_connections_opencode_reference CHECK (
    (provider <> 'opencode') OR (native_credential_reference = 'opencode-home:opencode-worker')
  );

CREATE UNIQUE INDEX provider_connections_one_opencode_free
  ON provider_connections(operator_id)
  WHERE provider='opencode' AND billing_boundary='free';
CREATE UNIQUE INDEX provider_connections_one_opencode_go
  ON provider_connections(operator_id)
  WHERE provider='opencode' AND billing_boundary='go';

CREATE TABLE provider_secret_enrollments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id           uuid NOT NULL REFERENCES users(id),
  provider              text NOT NULL CHECK (provider IN ('opencode')),
  billing_boundary      text NOT NULL CHECK (billing_boundary IN ('go','external_api')),
  connection_id         uuid NOT NULL REFERENCES provider_connections(id),
  status                text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','provisioned','claimed','completed','failed','expired','superseded')),
  state_digest          text NOT NULL CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  secret_ciphertext     bytea,
  secret_iv             bytea CHECK (secret_iv IS NULL OR octet_length(secret_iv) = 12),
  secret_auth_tag       bytea CHECK (secret_auth_tag IS NULL OR octet_length(secret_auth_tag) = 16),
  key_wrap_ciphertext   bytea,
  key_fingerprint       text NOT NULL DEFAULT '' CHECK (length(key_fingerprint) <= 64),
  expires_at            timestamptz NOT NULL DEFAULT clock_timestamp() + interval '15 minutes',
  consumed_at           timestamptz,
  failure_code          text NOT NULL DEFAULT '',
  failure_message       text NOT NULL DEFAULT '',
  broker_leased_by      text,
  broker_leased_until   timestamptz,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at),
  CHECK (status <> 'completed' OR consumed_at IS NOT NULL),
  CHECK (status NOT IN ('provisioned','claimed')
    OR (secret_ciphertext IS NOT NULL AND secret_iv IS NOT NULL
        AND secret_auth_tag IS NOT NULL AND key_wrap_ciphertext IS NOT NULL)),
  CHECK (status IN ('provisioned','claimed')
    OR (secret_ciphertext IS NULL AND secret_iv IS NULL
        AND secret_auth_tag IS NULL AND key_wrap_ciphertext IS NULL)),
  CHECK (status <> 'claimed' OR broker_leased_by IS NOT NULL),
  CHECK (broker_leased_by IS NULL = (broker_leased_until IS NULL)),
  CHECK (failure_message = left(failure_message, 500))
);

CREATE INDEX provider_secret_enrollments_work
  ON provider_secret_enrollments(provider, status, broker_leased_until)
  WHERE status IN ('pending','provisioned','claimed');
CREATE INDEX provider_secret_enrollments_expiry
  ON provider_secret_enrollments(status, expires_at)
  WHERE status IN ('pending','provisioned','claimed');

CREATE OR REPLACE FUNCTION start_opencode_enrollment(
  p_operator_id uuid, p_billing_boundary text, p_correlation_id text,
  p_ttl interval DEFAULT interval '15 minutes'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_connection provider_connections%ROWTYPE;
  v_enrollment provider_secret_enrollments%ROWTYPE;
  v_digest text;
  v_created boolean := false;
BEGIN
  IF p_billing_boundary NOT IN ('go','external_api')
     OR p_ttl <= interval '0 seconds' OR p_ttl > interval '30 minutes' THEN
    RAISE EXCEPTION 'invalid OpenCode enrollment parameters' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_connection FROM provider_connections
  WHERE operator_id=p_operator_id AND provider='opencode' AND billing_boundary=p_billing_boundary
  ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,
      native_credential_reference)
    VALUES(p_operator_id,'opencode','api_key','pending_finalize',p_billing_boundary,
      'opencode-home:opencode-worker')
    RETURNING * INTO v_connection;
    v_created := true;
  ELSE
    UPDATE provider_connections SET
      status='pending_finalize', broker_requested_action='',
      broker_leased_by=NULL, broker_leased_until=NULL,
      last_failure_code='', last_failure_message='',
      updated_at=clock_timestamp(), version=version+1
    WHERE id=v_connection.id RETURNING * INTO v_connection;
  END IF;
  UPDATE provider_secret_enrollments SET
    status='superseded', secret_ciphertext=NULL, secret_iv=NULL, secret_auth_tag=NULL,
    key_wrap_ciphertext=NULL, broker_leased_by=NULL, broker_leased_until=NULL,
    updated_at=clock_timestamp()
  WHERE operator_id=p_operator_id AND connection_id=v_connection.id
    AND status IN ('pending','provisioned','claimed');
  v_digest := encode(digest(
    gen_random_uuid()::text||':'||clock_timestamp()::text||':'||p_operator_id::text,
    'sha256'),'hex');
  INSERT INTO provider_secret_enrollments(operator_id,provider,billing_boundary,connection_id,
    state_digest,expires_at)
  VALUES(p_operator_id,'opencode',p_billing_boundary,v_connection.id,v_digest,clock_timestamp()+p_ttl)
  RETURNING * INTO v_enrollment;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,
    CASE WHEN v_created THEN 'provider.connection_started' ELSE 'provider.reconnect_started' END,
    'provider_connection',v_connection.id::text,'allowed',NULL,
    jsonb_build_object('provider','opencode','billing_boundary',p_billing_boundary,'auth_method','api_key'),
    COALESCE(p_correlation_id,v_enrollment.id::text));
  RETURN jsonb_build_object(
    'enrollment_id',v_enrollment.id,'connection_id',v_connection.id,
    'billing_boundary',p_billing_boundary,'status','pending',
    'expires_at',v_enrollment.expires_at
  );
END; $$;

CREATE OR REPLACE FUNCTION store_opencode_enrollment_secret(
  p_enrollment_id uuid, p_operator_id uuid, p_ciphertext text, p_iv text, p_tag text,
  p_key_wrap text, p_key_fingerprint text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v provider_secret_enrollments%ROWTYPE;
BEGIN
  IF length(p_key_fingerprint) > 64 THEN
    RAISE EXCEPTION 'invalid OpenCode enrollment key fingerprint' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v FROM provider_secret_enrollments
  WHERE id=p_enrollment_id AND operator_id=p_operator_id AND provider='opencode'
    AND status='pending' AND expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OpenCode enrollment is unavailable or expired' USING ERRCODE='55000';
  END IF;
  IF octet_length(decode(p_iv,'base64'))<>12 OR octet_length(decode(p_tag,'base64'))<>16
     OR length(p_ciphertext)<16 OR length(p_key_wrap)<16 THEN
    RAISE EXCEPTION 'invalid OpenCode enrollment secret envelope' USING ERRCODE='22023';
  END IF;
  UPDATE provider_secret_enrollments SET
    secret_ciphertext=decode(p_ciphertext,'base64'),
    secret_iv=decode(p_iv,'base64'),
    secret_auth_tag=decode(p_tag,'base64'),
    key_wrap_ciphertext=decode(p_key_wrap,'base64'),
    key_fingerprint=left(p_key_fingerprint,64),
    status='provisioned', updated_at=clock_timestamp()
  WHERE id=p_enrollment_id RETURNING * INTO v;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,'provider.secret_stored',
    'provider_secret_enrollment',v.id::text,'allowed',NULL,
    jsonb_build_object('provider','opencode','billing_boundary',v.billing_boundary,
      'key_fingerprint',v.key_fingerprint),v.id::text);
  RETURN jsonb_build_object('enrollment_id',v.id,'status','provisioned');
END; $$;

CREATE OR REPLACE FUNCTION expire_opencode_enrollments()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_count integer := 0;
BEGIN
  UPDATE provider_secret_enrollments SET
    status='expired', updated_at=clock_timestamp(),
    secret_ciphertext=NULL, secret_iv=NULL, secret_auth_tag=NULL, key_wrap_ciphertext=NULL,
    broker_leased_by=NULL, broker_leased_until=NULL, failure_code='enrollment_expired'
  WHERE provider='opencode' AND status IN ('pending','provisioned','claimed')
    AND expires_at<=clock_timestamp();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE provider_connections c SET
    status='expired', last_failure_code='enrollment_expired',
    last_failure_message='The OpenCode enrollment expired. Start a new enrollment to retry.',
    broker_leased_by=NULL, broker_leased_until=NULL, broker_requested_action='',
    updated_at=clock_timestamp(), version=version+1
  WHERE c.provider='opencode' AND c.status='pending_finalize'
    AND EXISTS (
      SELECT 1 FROM provider_secret_enrollments e
      WHERE e.connection_id=c.id AND e.status='expired' AND e.failure_code='enrollment_expired'
    )
    AND NOT EXISTS (
      SELECT 1 FROM provider_secret_enrollments e
      WHERE e.connection_id=c.id AND e.status IN ('pending','provisioned','claimed')
    );
  RETURN v_count;
END; $$;

CREATE OR REPLACE FUNCTION claim_opencode_enrollments(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '90 seconds'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM expire_opencode_enrollments();
  WITH candidates AS (
    SELECT e.id FROM provider_secret_enrollments e
    WHERE e.provider='opencode' AND e.status='provisioned' AND e.expires_at>clock_timestamp()
      AND (e.broker_leased_until IS NULL OR e.broker_leased_until<=clock_timestamp())
    ORDER BY e.created_at FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE provider_secret_enrollments e SET
      status='claimed', broker_leased_by=p_worker_id,
      broker_leased_until=LEAST(e.expires_at,clock_timestamp()+p_lease),
      updated_at=clock_timestamp()
    FROM candidates c WHERE e.id=c.id RETURNING e.*
  )
  SELECT jsonb_agg(jsonb_build_object(
    'enrollment_id',id,'connection_id',connection_id,'operator_id',operator_id,
    'billing_boundary',billing_boundary,'key_fingerprint',key_fingerprint,
    'ciphertext',encode(secret_ciphertext,'base64'),'iv',encode(secret_iv,'base64'),
    'tag',encode(secret_auth_tag,'base64'),'key_wrap',encode(key_wrap_ciphertext,'base64'),
    'expires_at',expires_at)) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

CREATE OR REPLACE FUNCTION complete_opencode_enrollment(
  p_enrollment_id uuid, p_worker_id text, p_account_label text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v provider_secret_enrollments%ROWTYPE;
  v_connection provider_connections%ROWTYPE;
BEGIN
  SELECT * INTO v FROM provider_secret_enrollments
  WHERE id=p_enrollment_id AND provider='opencode' AND status='claimed'
    AND broker_leased_by=p_worker_id AND broker_leased_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OpenCode enrollment lease is unavailable' USING ERRCODE='55000'; END IF;
  UPDATE provider_connections SET
    status='connected', account_label=left(COALESCE(p_account_label,''),160),
    installation_label='OpenCode ' || initcap(v.billing_boundary),
    native_credential_reference='opencode-home:opencode-worker',
    permissions=jsonb_build_object('credential_boundary','native_opencode_home',
      'billing_boundary',v.billing_boundary,'plan',v.billing_boundary),
    last_verified_at=clock_timestamp(), verify_requested_at=NULL,
    last_failure_code='', last_failure_message='', broker_requested_action='',
    broker_leased_by=NULL, broker_leased_until=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=v.connection_id RETURNING * INTO v_connection;
  IF NOT FOUND THEN RAISE EXCEPTION 'OpenCode connection is unavailable' USING ERRCODE='55000'; END IF;
  UPDATE provider_secret_enrollments SET
    status='completed', consumed_at=clock_timestamp(),
    secret_ciphertext=NULL, secret_iv=NULL, secret_auth_tag=NULL, key_wrap_ciphertext=NULL,
    broker_leased_by=NULL, broker_leased_until=NULL, updated_at=clock_timestamp()
  WHERE id=p_enrollment_id;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,'provider.connection_completed',
    'provider_connection',v_connection.id::text,'allowed',NULL,
    jsonb_build_object('provider','opencode','billing_boundary',v.billing_boundary),v.id::text);
  RETURN jsonb_build_object(
    'connection_id',v_connection.id,'status',v_connection.status,
    'billing_boundary',v.billing_boundary,'account_label',v_connection.account_label,
    'last_verified_at',v_connection.last_verified_at
  );
END; $$;

CREATE OR REPLACE FUNCTION fail_opencode_enrollment(
  p_enrollment_id uuid, p_worker_id text, p_failure_code text, p_failure_message text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v provider_secret_enrollments%ROWTYPE;
  v_status text;
BEGIN
  SELECT * INTO v FROM provider_secret_enrollments
  WHERE id=p_enrollment_id AND provider='opencode' AND status='claimed'
    AND broker_leased_by=p_worker_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OpenCode enrollment lease is unavailable' USING ERRCODE='55000'; END IF;
  v_status := CASE WHEN p_failure_code IN ('not_authenticated','authorization_expired','invalid_api_key','key_revoked')
    THEN 'expired' ELSE 'action_required' END;
  UPDATE provider_secret_enrollments SET
    status='failed', secret_ciphertext=NULL, secret_iv=NULL, secret_auth_tag=NULL,
    key_wrap_ciphertext=NULL, broker_leased_by=NULL, broker_leased_until=NULL,
    failure_code=left(COALESCE(p_failure_code,'opencode_enrollment_failed'),80),
    failure_message=left(COALESCE(regexp_replace(p_failure_message,'[[:cntrl:]]',' ','g'),''),500),
    updated_at=clock_timestamp()
  WHERE id=p_enrollment_id;
  UPDATE provider_connections SET
    status=v_status,
    last_failure_code=left(COALESCE(p_failure_code,'opencode_enrollment_failed'),80),
    last_failure_message=left(COALESCE(regexp_replace(p_failure_message,'[[:cntrl:]]',' ','g'),''),500),
    broker_requested_action='', broker_leased_by=NULL, broker_leased_until=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=v.connection_id;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,'provider.connection_verification_failed',
    'provider_connection',v.connection_id::text,'denied',NULL,
    jsonb_build_object('provider','opencode','billing_boundary',v.billing_boundary,
      'failure_code',COALESCE(p_failure_code,'opencode_enrollment_failed')),v.id::text);
  RETURN jsonb_build_object('connection_id',v.connection_id,'status',v_status,
    'failure_code',left(COALESCE(p_failure_code,'opencode_enrollment_failed'),80));
END; $$;

CREATE OR REPLACE FUNCTION request_opencode_connection_action(
  p_connection_id uuid, p_operator_id uuid, p_action text, p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v provider_connections%ROWTYPE;
BEGIN
  IF p_action NOT IN ('verify','disconnect') THEN
    RAISE EXCEPTION 'invalid OpenCode connection action' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v FROM provider_connections
  WHERE id=p_connection_id AND operator_id=p_operator_id AND provider='opencode' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OpenCode connection is unavailable' USING ERRCODE='55000'; END IF;
  IF v.billing_boundary='free' THEN
    RAISE EXCEPTION 'OpenCode Free has no account lifecycle' USING ERRCODE='55000';
  END IF;
  IF p_action='verify' AND v.status='disconnected' THEN
    RAISE EXCEPTION 'Disconnected OpenCode connections cannot be verified' USING ERRCODE='55000';
  END IF;
  UPDATE provider_connections SET
    broker_requested_action=p_action,
    verify_requested_at=CASE WHEN p_action='verify' THEN clock_timestamp() ELSE verify_requested_at END,
    broker_leased_by=NULL, broker_leased_until=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=v.id RETURNING * INTO v;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,
    CASE WHEN p_action='disconnect' THEN 'provider.disconnect_requested'
      ELSE 'provider.verify_requested' END,
    'provider_connection',v.id::text,'allowed',NULL,
    jsonb_build_object('provider','opencode','billing_boundary',v.billing_boundary,'action',p_action),
    COALESCE(p_correlation_id,v.id::text));
  RETURN jsonb_build_object('connection_id',v.id,'status',v.status,'requested_action',p_action);
END; $$;

CREATE OR REPLACE FUNCTION claim_opencode_connection_work(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '90 seconds'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
  WITH candidates AS (
    SELECT id FROM provider_connections
    WHERE provider='opencode' AND billing_boundary<>'free'
      AND broker_requested_action IN ('verify','disconnect')
      AND (broker_leased_until IS NULL OR broker_leased_until<=clock_timestamp())
    ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE provider_connections c SET
      broker_leased_by=p_worker_id, broker_leased_until=clock_timestamp()+p_lease
    FROM candidates x WHERE c.id=x.id RETURNING c.*
  )
  SELECT jsonb_agg(jsonb_build_object(
    'connection_id',id,'operator_id',operator_id,'work_kind',broker_requested_action,
    'current_status',status,'billing_boundary',billing_boundary)) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

CREATE OR REPLACE FUNCTION complete_opencode_connection_work(
  p_connection_id uuid, p_worker_id text, p_account_label text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v provider_connections%ROWTYPE;
  v_action text;
BEGIN
  SELECT * INTO v FROM provider_connections
  WHERE id=p_connection_id AND provider='opencode'
    AND broker_leased_by=p_worker_id AND broker_requested_action<>'' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OpenCode connection work lease is unavailable' USING ERRCODE='55000'; END IF;
  v_action := v.broker_requested_action;
  IF v_action='disconnect' THEN
    UPDATE provider_connections SET
      status='disconnected', account_label='', installation_label='',
      permissions='{}'::jsonb, last_verified_at=clock_timestamp(),
      broker_requested_action='', broker_leased_by=NULL, broker_leased_until=NULL,
      updated_at=clock_timestamp(), version=version+1
    WHERE id=v.id RETURNING * INTO v;
  ELSE
    UPDATE provider_connections SET
      status='connected', account_label=left(COALESCE(p_account_label,''),160),
      permissions=jsonb_build_object('credential_boundary','native_opencode_home',
        'billing_boundary',v.billing_boundary,'plan',v.billing_boundary),
      last_verified_at=clock_timestamp(), verify_requested_at=NULL,
      last_failure_code='', last_failure_message='', broker_requested_action='',
      broker_leased_by=NULL, broker_leased_until=NULL,
      updated_at=clock_timestamp(), version=version+1
    WHERE id=v.id RETURNING * INTO v;
  END IF;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,
    CASE WHEN v_action='disconnect' THEN 'provider.disconnected' ELSE 'provider.connection_verified' END,
    'provider_connection',v.id::text,'allowed',NULL,
    jsonb_build_object('provider','opencode','billing_boundary',v.billing_boundary,'action',v_action),v.id::text);
  RETURN jsonb_build_object('connection_id',v.id,'status',v.status,'action',v_action,
    'billing_boundary',v.billing_boundary,'last_verified_at',v.last_verified_at);
END; $$;

CREATE OR REPLACE FUNCTION fail_opencode_connection_work(
  p_connection_id uuid, p_worker_id text, p_failure_code text, p_failure_message text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v provider_connections%ROWTYPE;
BEGIN
  SELECT * INTO v FROM provider_connections
  WHERE id=p_connection_id AND provider='opencode'
    AND broker_leased_by=p_worker_id AND broker_requested_action<>'' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OpenCode connection work lease is unavailable' USING ERRCODE='55000'; END IF;
  UPDATE provider_connections SET
    status=CASE WHEN p_failure_code IN ('not_authenticated','authorization_expired','key_revoked')
      THEN 'expired' ELSE 'action_required' END,
    last_failure_code=left(COALESCE(p_failure_code,'opencode_account_error'),80),
    last_failure_message=left(COALESCE(regexp_replace(p_failure_message,'[[:cntrl:]]',' ','g'),''),500),
    broker_requested_action='', broker_leased_by=NULL, broker_leased_until=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=v.id RETURNING * INTO v;
  RETURN jsonb_build_object('connection_id',v.id,'status',v.status,'failure_code',v.last_failure_code);
END; $$;

CREATE OR REPLACE FUNCTION get_operator_opencode_connections(p_operator_id uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,
    account_label,installation_label,native_credential_reference,permissions,last_verified_at)
  SELECT p_operator_id,'opencode','native','connected','free',
    'OpenCode Free','OpenCode Free','opencode-home:opencode-worker',
    jsonb_build_object('credential_boundary','native_opencode_home',
      'billing_boundary','free','plan','free'),clock_timestamp()
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_connections
    WHERE operator_id=p_operator_id AND provider='opencode' AND billing_boundary='free'
  );
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'connection_id',id,'status',status,'billing_boundary',billing_boundary,
    'account_label',account_label,'installation_label',installation_label,
    'permissions',permissions,'auth_method',auth_method,
    'last_verified_at',last_verified_at,'verify_requested_at',verify_requested_at,
    'last_failure_code',last_failure_code,'last_failure_message',last_failure_message,
    'requested_action',broker_requested_action,'created_at',created_at,'updated_at',updated_at)
    ORDER BY (billing_boundary='free') DESC, created_at),'[]'::jsonb) INTO v_result
  FROM provider_connections WHERE operator_id=p_operator_id AND provider='opencode';
  RETURN v_result;
END; $$;

CREATE OR REPLACE FUNCTION get_operator_opencode_enrollment_status(p_operator_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT jsonb_build_object(
      'enrollment_id',id,'connection_id',connection_id,'billing_boundary',billing_boundary,
      'status',CASE WHEN status IN ('pending','provisioned','claimed') AND expires_at<=clock_timestamp()
        THEN 'expired' ELSE status END,
      'failure_code',failure_code,'expires_at',expires_at,'created_at',created_at)
    FROM provider_secret_enrollments
    WHERE operator_id=p_operator_id AND provider='opencode'
    ORDER BY created_at DESC LIMIT 1),'null'::jsonb);
$$;

ALTER FUNCTION start_opencode_enrollment(uuid,text,text,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION store_opencode_enrollment_secret(uuid,uuid,text,text,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION expire_opencode_enrollments()
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_opencode_enrollments(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION complete_opencode_enrollment(uuid,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION fail_opencode_enrollment(uuid,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION request_opencode_connection_action(uuid,uuid,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_opencode_connection_work(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION complete_opencode_connection_work(uuid,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION fail_opencode_connection_work(uuid,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION get_operator_opencode_connections(uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION get_operator_opencode_enrollment_status(uuid)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
