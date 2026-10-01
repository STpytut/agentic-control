BEGIN;

SET search_path TO control_plane, public, extensions;

-- Codex account enrollment is driven by the app-server device-code flow on the
-- VPS. The database stores only short-lived presentation metadata (URL + user
-- code) and safe account metadata. ChatGPT access/refresh tokens stay in the
-- native credential store owned by the codex-poc OS user.

ALTER TABLE provider_connections
  ADD COLUMN broker_requested_action text NOT NULL DEFAULT ''
    CHECK (broker_requested_action IN ('','verify','disconnect'));

ALTER TABLE provider_login_sessions
  ADD COLUMN connection_id uuid REFERENCES provider_connections(id),
  ADD COLUMN device_verification_url text NOT NULL DEFAULT '',
  ADD COLUMN device_user_code text NOT NULL DEFAULT '',
  ADD COLUMN native_login_id text NOT NULL DEFAULT '',
  ADD COLUMN broker_leased_by text,
  ADD COLUMN broker_leased_until timestamptz,
  ADD CONSTRAINT provider_login_sessions_device_url_safe CHECK (
    device_verification_url = ''
    OR (device_verification_url ~ '^https://[^/@[:space:]]+(/[^@[:space:]]*)?$'
        AND device_verification_url !~ '@')
  ),
  ADD CONSTRAINT provider_login_sessions_device_code_bounded CHECK (
    device_user_code = '' OR device_user_code ~ '^[A-Za-z0-9-]{4,32}$'
  ),
  ADD CONSTRAINT provider_login_sessions_native_login_id_bounded CHECK (
    native_login_id = left(native_login_id,160)
  ),
  ADD CONSTRAINT provider_login_sessions_broker_lease_pair CHECK (
    broker_leased_by IS NULL = (broker_leased_until IS NULL)
  );

CREATE UNIQUE INDEX provider_connections_one_codex_per_operator
  ON provider_connections(operator_id, provider)
  WHERE provider='codex';

CREATE INDEX provider_login_sessions_codex_work
  ON provider_login_sessions(provider, status, broker_leased_until)
  WHERE provider='codex' AND status='pending';

CREATE OR REPLACE FUNCTION start_codex_device_login(
  p_operator_id uuid, p_correlation_id text, p_ttl interval DEFAULT interval '15 minutes'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_connection provider_connections%ROWTYPE;
  v_session_id uuid;
  v_state_digest text;
  v_created boolean := false;
BEGIN
  IF p_ttl <= interval '0 seconds' OR p_ttl > interval '30 minutes' THEN
    RAISE EXCEPTION 'invalid Codex login session lifetime' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_connection FROM provider_connections
  WHERE operator_id=p_operator_id AND provider='codex' FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO provider_connections(
      operator_id,provider,auth_method,status,native_credential_reference
    ) VALUES(
      p_operator_id,'codex','device_code','pending_finalize','codex-home:codex-poc'
    ) RETURNING * INTO v_connection;
    v_created := true;
  ELSE
    UPDATE provider_connections SET
      auth_method='device_code', status='pending_finalize',
      native_credential_reference='codex-home:codex-poc',
      broker_requested_action='', broker_leased_by=NULL, broker_leased_until=NULL,
      last_failure_code='', last_failure_message='',
      updated_at=clock_timestamp(), version=version+1
    WHERE id=v_connection.id RETURNING * INTO v_connection;
  END IF;

  UPDATE provider_login_sessions SET
    status='expired', failure_code='superseded',
    device_verification_url='', device_user_code='', native_login_id='',
    broker_leased_by=NULL, broker_leased_until=NULL
  WHERE operator_id=p_operator_id AND provider='codex' AND status='pending';

  v_state_digest := encode(digest(
    gen_random_uuid()::text || ':' || clock_timestamp()::text || ':' || p_operator_id::text,
    'sha256'
  ),'hex');
  INSERT INTO provider_login_sessions(
    operator_id,provider,state_digest,status,expires_at,connection_id
  ) VALUES(
    p_operator_id,'codex',v_state_digest,'pending',
    clock_timestamp()+p_ttl,v_connection.id
  ) RETURNING id INTO v_session_id;

  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,
    CASE WHEN v_created
      THEN 'provider.connection_started' ELSE 'provider.reconnect_started' END,
    'provider_connection',v_connection.id::text,'allowed',NULL,
    jsonb_build_object('provider','codex','auth_method','device_code'),
    COALESCE(p_correlation_id,v_session_id::text));
  RETURN jsonb_build_object(
    'session_id',v_session_id,'connection_id',v_connection.id,
    'status','pending','expires_at',clock_timestamp()+p_ttl
  );
END; $$;

CREATE OR REPLACE FUNCTION claim_codex_login_sessions(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '16 minutes'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
  UPDATE provider_login_sessions SET
    status='expired', failure_code='device_code_expired',
    device_verification_url='', device_user_code='', native_login_id='',
    broker_leased_by=NULL, broker_leased_until=NULL
  WHERE provider='codex' AND status='pending' AND expires_at<=clock_timestamp();

  UPDATE provider_connections c SET
    status='expired', last_failure_code='device_code_expired',
    last_failure_message='The Codex device authorization expired. Reconnect to try again.',
    updated_at=clock_timestamp(), version=version+1
  WHERE c.provider='codex' AND c.status='pending_finalize'
    AND EXISTS (
      SELECT 1 FROM provider_login_sessions s
      WHERE s.connection_id=c.id AND s.provider='codex'
        AND s.status='expired' AND s.failure_code='device_code_expired'
    )
    AND NOT EXISTS (
      SELECT 1 FROM provider_login_sessions s
      WHERE s.connection_id=c.id AND s.provider='codex' AND s.status='pending'
    );

  WITH candidates AS (
    SELECT s.id FROM provider_login_sessions s
    WHERE s.provider='codex' AND s.status='pending'
      AND s.expires_at>clock_timestamp()
      AND (s.broker_leased_until IS NULL OR s.broker_leased_until<=clock_timestamp())
    ORDER BY s.created_at
    FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE provider_login_sessions s SET
      broker_leased_by=p_worker_id,
      broker_leased_until=LEAST(s.expires_at,clock_timestamp()+p_lease)
    FROM candidates c WHERE s.id=c.id
    RETURNING s.*
  )
  SELECT jsonb_agg(jsonb_build_object(
    'session_id',id,'connection_id',connection_id,'operator_id',operator_id,
    'expires_at',expires_at
  )) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

CREATE OR REPLACE FUNCTION publish_codex_device_code(
  p_session_id uuid, p_worker_id text, p_native_login_id text,
  p_verification_url text, p_user_code text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v provider_login_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v FROM provider_login_sessions
  WHERE id=p_session_id AND provider='codex' AND status='pending'
    AND broker_leased_by=p_worker_id AND broker_leased_until>clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Codex login session lease is unavailable' USING ERRCODE='55000'; END IF;
  IF COALESCE(p_native_login_id,'')='' OR length(p_native_login_id)>160
     OR COALESCE(p_verification_url,'') !~ '^https://[^/@[:space:]]+(/[^@[:space:]]*)?$'
     OR p_verification_url ~ '@'
     OR COALESCE(p_user_code,'') !~ '^[A-Za-z0-9-]{4,32}$' THEN
    RAISE EXCEPTION 'invalid Codex device authorization response' USING ERRCODE='22023';
  END IF;
  UPDATE provider_login_sessions SET
    native_login_id=p_native_login_id,
    device_verification_url=p_verification_url,
    device_user_code=p_user_code
  WHERE id=p_session_id RETURNING * INTO v;
  RETURN jsonb_build_object(
    'session_id',v.id,'status',v.status,'verification_url',v.device_verification_url,
    'user_code',v.device_user_code,'expires_at',v.expires_at
  );
END; $$;

CREATE OR REPLACE FUNCTION complete_codex_device_login(
  p_session_id uuid, p_worker_id text, p_account_label text, p_plan_type text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_session provider_login_sessions%ROWTYPE;
  v_connection provider_connections%ROWTYPE;
  v_plan text;
BEGIN
  SELECT * INTO v_session FROM provider_login_sessions
  WHERE id=p_session_id AND provider='codex' AND status='pending'
    AND broker_leased_by=p_worker_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Codex login session is unavailable' USING ERRCODE='55000'; END IF;
  v_plan := left(COALESCE(NULLIF(p_plan_type,''),'unknown'),80);
  UPDATE provider_connections SET
    status='connected', account_label=left(COALESCE(p_account_label,''),160),
    installation_label='ChatGPT ' || v_plan,
    native_credential_reference='codex-home:codex-poc',
    permissions=jsonb_build_object(
      'credential_boundary','native_codex_home',
      'billing_boundary','chatgpt_subscription',
      'plan',v_plan
    ),
    last_verified_at=clock_timestamp(), verify_requested_at=NULL,
    last_failure_code='', last_failure_message='',
    broker_requested_action='', broker_leased_by=NULL, broker_leased_until=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=v_session.connection_id AND provider='codex'
  RETURNING * INTO v_connection;
  IF NOT FOUND THEN RAISE EXCEPTION 'Codex connection is unavailable' USING ERRCODE='55000'; END IF;
  UPDATE provider_login_sessions SET
    status='consumed', consumed_at=clock_timestamp(),
    device_verification_url='', device_user_code='', native_login_id='',
    broker_leased_by=NULL, broker_leased_until=NULL
  WHERE id=v_session.id;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,
    'provider.connection_completed','provider_connection',v_connection.id::text,
    'allowed',NULL,jsonb_build_object(
      'provider','codex','auth_method','device_code','plan',v_plan
    ),v_session.id::text);
  RETURN jsonb_build_object(
    'connection_id',v_connection.id,'status',v_connection.status,
    'account_label',v_connection.account_label,'plan',v_plan,
    'last_verified_at',v_connection.last_verified_at
  );
END; $$;

CREATE OR REPLACE FUNCTION fail_codex_device_login(
  p_session_id uuid, p_worker_id text, p_failure_code text, p_failure_message text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_session provider_login_sessions%ROWTYPE;
  v_status text;
BEGIN
  SELECT * INTO v_session FROM provider_login_sessions
  WHERE id=p_session_id AND provider='codex' AND status='pending'
    AND broker_leased_by=p_worker_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Codex login session is unavailable' USING ERRCODE='55000'; END IF;
  v_status := CASE WHEN p_failure_code IN ('device_code_expired','authorization_expired')
    THEN 'expired' ELSE 'action_required' END;
  UPDATE provider_login_sessions SET
    status=CASE WHEN v_status='expired' THEN 'expired' ELSE 'failed' END,
    failure_code=left(COALESCE(p_failure_code,'codex_login_failed'),80),
    device_verification_url='', device_user_code='', native_login_id='',
    broker_leased_by=NULL, broker_leased_until=NULL
  WHERE id=v_session.id;
  UPDATE provider_connections SET
    status=v_status,
    last_failure_code=left(COALESCE(p_failure_code,'codex_login_failed'),80),
    last_failure_message=left(COALESCE(regexp_replace(
      p_failure_message,'[[:cntrl:]]',' ','g'
    ),'Codex authorization failed.'),500),
    broker_requested_action='', broker_leased_by=NULL, broker_leased_until=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=v_session.connection_id;
  RETURN jsonb_build_object(
    'connection_id',v_session.connection_id,'status',v_status,
    'failure_code',left(COALESCE(p_failure_code,'codex_login_failed'),80)
  );
END; $$;

CREATE OR REPLACE FUNCTION request_codex_connection_action(
  p_connection_id uuid, p_operator_id uuid, p_action text, p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v provider_connections%ROWTYPE;
BEGIN
  IF p_action NOT IN ('verify','disconnect') THEN
    RAISE EXCEPTION 'invalid Codex connection action' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v FROM provider_connections
  WHERE id=p_connection_id AND operator_id=p_operator_id AND provider='codex'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Codex connection is unavailable' USING ERRCODE='55000'; END IF;
  IF p_action='verify' AND v.status='disconnected' THEN
    RAISE EXCEPTION 'Disconnected Codex connections cannot be verified' USING ERRCODE='55000';
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
    jsonb_build_object('provider','codex','action',p_action),
    COALESCE(p_correlation_id,v.id::text));
  RETURN jsonb_build_object(
    'connection_id',v.id,'status',v.status,'requested_action',p_action
  );
END; $$;

CREATE OR REPLACE FUNCTION claim_codex_connection_work(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '90 seconds'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
  WITH candidates AS (
    SELECT id FROM provider_connections
    WHERE provider='codex' AND broker_requested_action IN ('verify','disconnect')
      AND (broker_leased_until IS NULL OR broker_leased_until<=clock_timestamp())
    ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE provider_connections c SET
      broker_leased_by=p_worker_id, broker_leased_until=clock_timestamp()+p_lease
    FROM candidates x WHERE c.id=x.id RETURNING c.*
  )
  SELECT jsonb_agg(jsonb_build_object(
    'connection_id',id,'operator_id',operator_id,
    'work_kind',broker_requested_action,'current_status',status
  )) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

CREATE OR REPLACE FUNCTION complete_codex_connection_work(
  p_connection_id uuid, p_worker_id text, p_account_label text, p_plan_type text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v provider_connections%ROWTYPE; v_action text; v_plan text;
BEGIN
  SELECT * INTO v FROM provider_connections
  WHERE id=p_connection_id AND provider='codex'
    AND broker_leased_by=p_worker_id AND broker_requested_action<>''
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Codex connection work lease is unavailable' USING ERRCODE='55000'; END IF;
  v_action := v.broker_requested_action;
  v_plan := left(COALESCE(NULLIF(p_plan_type,''),'unknown'),80);
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
      installation_label='ChatGPT ' || v_plan,
      permissions=jsonb_build_object(
        'credential_boundary','native_codex_home',
        'billing_boundary','chatgpt_subscription',
        'plan',v_plan
      ),
      last_verified_at=clock_timestamp(), verify_requested_at=NULL,
      last_failure_code='', last_failure_message='',
      broker_requested_action='', broker_leased_by=NULL, broker_leased_until=NULL,
      updated_at=clock_timestamp(), version=version+1
    WHERE id=v.id RETURNING * INTO v;
  END IF;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,
    CASE WHEN v_action='disconnect' THEN 'provider.disconnected'
      ELSE 'provider.connection_verified' END,
    'provider_connection',v.id::text,'allowed',NULL,
    jsonb_build_object('provider','codex','action',v_action),v.id::text);
  RETURN jsonb_build_object(
    'connection_id',v.id,'status',v.status,'action',v_action,
    'last_verified_at',v.last_verified_at
  );
END; $$;

CREATE OR REPLACE FUNCTION fail_codex_connection_work(
  p_connection_id uuid, p_worker_id text, p_failure_code text, p_failure_message text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v provider_connections%ROWTYPE;
BEGIN
  SELECT * INTO v FROM provider_connections
  WHERE id=p_connection_id AND provider='codex'
    AND broker_leased_by=p_worker_id AND broker_requested_action<>''
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Codex connection work lease is unavailable' USING ERRCODE='55000'; END IF;
  UPDATE provider_connections SET
    status=CASE WHEN p_failure_code IN ('not_authenticated','authorization_expired')
      THEN 'expired' ELSE 'action_required' END,
    last_failure_code=left(COALESCE(p_failure_code,'codex_account_error'),80),
    last_failure_message=left(COALESCE(regexp_replace(
      p_failure_message,'[[:cntrl:]]',' ','g'
    ),'Codex account verification failed.'),500),
    broker_requested_action='', broker_leased_by=NULL, broker_leased_until=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=v.id RETURNING * INTO v;
  RETURN jsonb_build_object(
    'connection_id',v.id,'status',v.status,'failure_code',v.last_failure_code
  );
END; $$;

CREATE OR REPLACE FUNCTION get_operator_codex_connection(
  p_operator_id uuid
) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT jsonb_build_object(
      'connection_id',c.id,'status',c.status,
      'account_label',c.account_label,'plan_label',c.installation_label,
      'permissions',c.permissions,'last_verified_at',c.last_verified_at,
      'last_failure_code',c.last_failure_code,
      'last_failure_message',c.last_failure_message,
      'requested_action',c.broker_requested_action,
      'created_at',c.created_at,'updated_at',c.updated_at
    )
    FROM provider_connections c
    WHERE c.operator_id=p_operator_id AND c.provider='codex'
    LIMIT 1
  ),'null'::jsonb);
$$;

CREATE OR REPLACE FUNCTION get_operator_codex_login_status(
  p_operator_id uuid
) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT jsonb_build_object(
      'session_id',s.id,'connection_id',s.connection_id,'status',
        CASE WHEN s.status='pending' AND s.expires_at<=clock_timestamp()
          THEN 'expired' ELSE s.status END,
      'verification_url',CASE WHEN s.status='pending' AND s.expires_at>clock_timestamp()
        THEN s.device_verification_url ELSE '' END,
      'user_code',CASE WHEN s.status='pending' AND s.expires_at>clock_timestamp()
        THEN s.device_user_code ELSE '' END,
      'failure_code',s.failure_code,'expires_at',s.expires_at,
      'created_at',s.created_at
    )
    FROM provider_login_sessions s
    WHERE s.operator_id=p_operator_id AND s.provider='codex'
    ORDER BY s.created_at DESC LIMIT 1
  ),'null'::jsonb);
$$;

ALTER FUNCTION start_codex_device_login(uuid,text,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_codex_login_sessions(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION publish_codex_device_code(uuid,text,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION complete_codex_device_login(uuid,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION fail_codex_device_login(uuid,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION request_codex_connection_action(uuid,uuid,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_codex_connection_work(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION complete_codex_connection_work(uuid,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION fail_codex_connection_work(uuid,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION get_operator_codex_connection(uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION get_operator_codex_login_status(uuid)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
