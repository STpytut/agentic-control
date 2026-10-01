-- The model vendor, the access gateway and the billing, apart (Stage 11.4, sprint
-- B A3; ADR-0018 §1, §3, §4).
--
-- `billing_boundary` was three things at once. On a catalog entry it was a
-- vendor plan (`go`, `chatgpt_subscription`). On an OpenCode connection it was
-- the gateway itself — `free`, `go` and `external_api` are OpenCode Zen, OpenCode
-- Go and OpenRouter, and the workers chose the provider they sign in to by it.
-- The model's author lived only inside its id (`openai/gpt-6-luna`).
--
-- Now:
--   * `access_gateway` names the path and the party that bills it — on a
--     model-access connection (authoritative), on a catalog entry (the
--     connection's, copied by the writer) and on a key enrollment:
--     opencode_zen, opencode_go, openrouter, openai_chatgpt;
--   * `model_vendor` on a catalog entry: as the discoverer gives it, else read
--     off the id where the gateway's ids carry it (openrouter: `openai/…`), else
--     `openai` for Codex, else empty;
--   * `billing_boundary` means only how it is billed: free, subscription,
--     direct_metered, third_party_metered (OpenCode Go and a ChatGPT plan are
--     subscriptions; OpenRouter is third-party metered). "Go", "Plus",
--     "OpenRouter" stay display metadata.
--
-- One step, declared incompatible with the previous release (as 0073 and 0075
-- were): that release's workers choose a provider by the old boundary words, so
-- the coordinator stops them before this runs, and no contract half follows.
--
-- A verification stays bound to one gateway: a catalog entry belongs to one
-- connection, and a connection is one gateway (ADR-0018 §4).

SET search_path TO control_plane, public, extensions;

-- Refusals carried forward from before 0067 by the functions below gain a
-- DETAIL reason, with their sentence and ERRCODE unchanged.
INSERT INTO failure_reasons(reason, code, note) VALUES
  ('enrollment_not_leased','lease_lost','the key enrollment is not claimed by this worker, or its lease ran out'),
  ('enrollment_unavailable','conflict','the key enrollment is missing, finished or expired'),
  ('enrollment_secret_invalid','invalid_argument','the encrypted key envelope or its fingerprint is malformed'),
  ('provider_connection_unavailable','conflict','the connection is missing, or not the owner''s'),
  ('catalog_entry_unavailable','conflict','the catalog entry is not verified, or not available to this owner'),
  ('catalog_refresh_not_leased','lease_lost','the catalog refresh is not claimed by this worker, or its lease ran out'),
  ('catalog_entry_invalid','invalid_argument','a discovered catalog entry is not in the normalized shape');

-- Connections.
ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_billing_boundary_check;
ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_opencode_boundary;
ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_opencode_auth_boundary;
DROP INDEX provider_connections_one_opencode_free;
DROP INDEX provider_connections_one_opencode_go;
ALTER TABLE provider_connections ADD COLUMN access_gateway text;
UPDATE provider_connections SET
  access_gateway=CASE
    WHEN provider='codex' THEN 'openai_chatgpt'
    WHEN provider='opencode' AND billing_boundary='free' THEN 'opencode_zen'
    WHEN provider='opencode' AND billing_boundary='go' THEN 'opencode_go'
    WHEN provider='opencode' AND billing_boundary='external_api' THEN 'openrouter' END,
  billing_boundary=CASE
    WHEN provider='github' THEN ''
    WHEN provider='codex' THEN 'subscription'
    WHEN billing_boundary='go' THEN 'subscription'
    WHEN billing_boundary='external_api' THEN 'third_party_metered'
    ELSE billing_boundary END;
DO $$
DECLARE v_wrong text;
BEGIN
  SELECT string_agg(id::text||' ('||provider||')', ', ') INTO v_wrong
  FROM provider_connections WHERE connection_kind='model_access' AND access_gateway IS NULL;
  IF v_wrong IS NOT NULL THEN
    PERFORM refuse('connection_kind_mismatch', 'model connections with no gateway to name: '||v_wrong);
  END IF;
END $$;
ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_billing_boundary_check CHECK (
    billing_boundary IN ('','free','subscription','direct_metered','third_party_metered')),
  ADD CONSTRAINT provider_connections_access_gateway_check CHECK (
    (connection_kind='scm' AND access_gateway IS NULL)
    OR (connection_kind='model_access' AND access_gateway IS NOT NULL
        AND access_gateway IN ('opencode_zen','opencode_go','openrouter','openai_chatgpt'))),
  -- Which gateway each runtime reaches, and how each is signed in to.
  ADD CONSTRAINT provider_connections_gateway_of_runtime CHECK (
    (provider<>'codex' OR access_gateway='openai_chatgpt')
    AND (provider<>'opencode' OR access_gateway IN ('opencode_zen','opencode_go','openrouter'))),
  ADD CONSTRAINT provider_connections_gateway_auth CHECK (
    (access_gateway IS DISTINCT FROM 'opencode_zen' OR (auth_method='native' AND billing_boundary='free'))
    AND (access_gateway NOT IN ('opencode_go','openrouter') OR auth_method='api_key'));
-- One connection per operator and gateway.
CREATE UNIQUE INDEX provider_connections_one_per_gateway
  ON provider_connections(operator_id, access_gateway) WHERE access_gateway IS NOT NULL;

-- A Codex connection is written by the device login, which names no gateway:
-- there is only one it can be. Likewise OpenCode Free is Zen.
CREATE FUNCTION fill_connection_gateway() RETURNS trigger LANGUAGE plpgsql
SET search_path=control_plane,public,extensions,pg_temp AS $$
BEGIN
  IF NEW.provider='codex' THEN
    NEW.access_gateway := COALESCE(NEW.access_gateway,'openai_chatgpt');
    IF NEW.billing_boundary='' THEN NEW.billing_boundary := 'subscription'; END IF;
  END IF;
  -- OpenCode Free is Zen, whoever writes it without naming it.
  IF NEW.provider='opencode' AND NEW.access_gateway IS NULL AND NEW.billing_boundary='free' THEN
    NEW.access_gateway := 'opencode_zen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_connections_gateway BEFORE INSERT OR UPDATE OF provider, access_gateway, billing_boundary
  ON provider_connections FOR EACH ROW EXECUTE FUNCTION fill_connection_gateway();

-- Key enrollments name the gateway they sign in to.
ALTER TABLE provider_secret_enrollments ADD COLUMN access_gateway text;
UPDATE provider_secret_enrollments SET access_gateway=CASE billing_boundary
  WHEN 'go' THEN 'opencode_go' WHEN 'external_api' THEN 'openrouter' END;
ALTER TABLE provider_secret_enrollments ALTER COLUMN access_gateway SET NOT NULL;
ALTER TABLE provider_secret_enrollments ADD CONSTRAINT provider_secret_enrollments_access_gateway_check
  CHECK (access_gateway IN ('opencode_go','openrouter'));
ALTER TABLE provider_secret_enrollments DROP COLUMN billing_boundary;

-- Catalog entries: the vendor and the gateway beside the billing.
CREATE FUNCTION catalog_model_vendor(p_gateway text, p_runtime text, p_model_id text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_gateway='openrouter' AND position('/' in p_model_id)>1 THEN left(split_part(p_model_id,'/',1),64)
    WHEN p_runtime='codex' THEN 'openai'
    ELSE '' END;
$$;
ALTER TABLE provider_model_catalog DROP CONSTRAINT provider_model_catalog_billing_boundary_check;
ALTER TABLE provider_model_catalog
  ADD COLUMN access_gateway text,
  ADD COLUMN model_vendor text NOT NULL DEFAULT '' CHECK (length(model_vendor) <= 64);
UPDATE provider_model_catalog m SET
  access_gateway=c.access_gateway,
  model_vendor=catalog_model_vendor(c.access_gateway, m.runtime_type, m.model_id),
  billing_boundary=CASE m.billing_boundary
    WHEN 'go' THEN 'subscription' WHEN 'chatgpt_subscription' THEN 'subscription'
    WHEN 'external_api' THEN 'third_party_metered' ELSE m.billing_boundary END
FROM provider_connections c WHERE c.id=m.connection_id;
ALTER TABLE provider_model_catalog ALTER COLUMN access_gateway SET NOT NULL;
-- An entry's gateway is its connection's, whoever writes the entry: set here,
-- never taken from the writer. The vendor, when the writer names none, is read
-- off the id the same way the backfill read it.
CREATE FUNCTION fill_catalog_gateway() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=control_plane,public,extensions,pg_temp AS $$
BEGIN
  SELECT c.access_gateway INTO NEW.access_gateway FROM provider_connections c WHERE c.id=NEW.connection_id;
  IF COALESCE(NEW.model_vendor,'')='' THEN
    NEW.model_vendor := catalog_model_vendor(NEW.access_gateway, NEW.runtime_type, NEW.model_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_model_catalog_gateway BEFORE INSERT OR UPDATE OF connection_id, access_gateway, model_vendor
  ON provider_model_catalog FOR EACH ROW EXECUTE FUNCTION fill_catalog_gateway();
ALTER TABLE provider_model_catalog
  ADD CONSTRAINT provider_model_catalog_billing_boundary_check CHECK (
    billing_boundary IN ('','free','subscription','direct_metered','third_party_metered')),
  ADD CONSTRAINT provider_model_catalog_access_gateway_check CHECK (
    access_gateway IN ('opencode_zen','opencode_go','openrouter','openai_chatgpt'));

CREATE OR REPLACE FUNCTION start_opencode_enrollment(p_operator_id uuid, p_billing_boundary text, p_correlation_id text, p_ttl interval DEFAULT '00:15:00'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_connection provider_connections%ROWTYPE;
  v_enrollment provider_secret_enrollments%ROWTYPE;
  v_digest text;
  v_created boolean := false;
  -- The API-key gateway to enroll. The parameter keeps its name; a previous
  -- release's panel sends the old boundary word, which names the same gateway.
  v_gateway text := CASE p_billing_boundary WHEN 'go' THEN 'opencode_go' WHEN 'external_api' THEN 'openrouter'
                      ELSE p_billing_boundary END;
  v_billing text;
BEGIN
  IF v_gateway NOT IN ('opencode_go','openrouter')
     OR p_ttl <= interval '0 seconds' OR p_ttl > interval '30 minutes' THEN
    RAISE EXCEPTION 'invalid OpenCode enrollment parameters' USING ERRCODE='22023',
      DETAIL=jsonb_build_object('reason','connection_kind_mismatch')::text;
  END IF;
  v_billing := CASE v_gateway WHEN 'opencode_go' THEN 'subscription' ELSE 'third_party_metered' END;
  SELECT * INTO v_connection FROM provider_connections
  WHERE operator_id=p_operator_id AND provider='opencode' AND access_gateway=v_gateway
  ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,
      access_gateway,native_credential_reference)
    VALUES(p_operator_id,'opencode','api_key','pending_finalize',v_billing,v_gateway,
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
  INSERT INTO provider_secret_enrollments(operator_id,provider,access_gateway,connection_id,
    state_digest,expires_at)
  VALUES(p_operator_id,'opencode',v_gateway,v_connection.id,v_digest,clock_timestamp()+p_ttl)
  RETURNING * INTO v_enrollment;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,
    CASE WHEN v_created THEN 'provider.connection_started' ELSE 'provider.reconnect_started' END,
    'provider_connection',v_connection.id::text,'allowed',NULL,
    jsonb_build_object('provider','opencode','access_gateway',v_gateway,'billing_boundary',v_billing,'auth_method','api_key'),
    COALESCE(p_correlation_id,v_enrollment.id::text));
  RETURN jsonb_build_object(
    'enrollment_id',v_enrollment.id,'connection_id',v_connection.id,
    'access_gateway',v_gateway,'billing_boundary',v_billing,'status','pending',
    'expires_at',v_enrollment.expires_at
  );
END; $function$;

CREATE OR REPLACE FUNCTION claim_opencode_enrollments(p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT '00:01:30'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
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
    'lease_expires_at',broker_leased_until,
    
    'enrollment_id',id,'connection_id',connection_id,'operator_id',operator_id,
    'access_gateway',access_gateway,'key_fingerprint',key_fingerprint,
    'ciphertext',encode(secret_ciphertext,'base64'),'iv',encode(secret_iv,'base64'),
    'tag',encode(secret_auth_tag,'base64'),'key_wrap',encode(key_wrap_ciphertext,'base64'),
    'expires_at',expires_at)) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $function$;

CREATE OR REPLACE FUNCTION fail_opencode_enrollment(p_enrollment_id uuid, p_worker_id text, p_failure_code text, p_failure_message text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v provider_secret_enrollments%ROWTYPE;
  v_status text;
BEGIN
  SELECT * INTO v FROM provider_secret_enrollments
  WHERE id=p_enrollment_id AND provider='opencode' AND status='claimed'
    AND broker_leased_by=p_worker_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OpenCode enrollment lease is unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','enrollment_not_leased')::text; END IF;
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
    jsonb_build_object('provider','opencode','access_gateway',v.access_gateway,
      'failure_code',COALESCE(p_failure_code,'opencode_enrollment_failed')),v.id::text);
  RETURN jsonb_build_object('connection_id',v.connection_id,'status',v_status,
    'failure_code',left(COALESCE(p_failure_code,'opencode_enrollment_failed'),80));
END; $function$;

CREATE OR REPLACE FUNCTION store_opencode_enrollment_secret(p_enrollment_id uuid, p_operator_id uuid, p_ciphertext text, p_iv text, p_tag text, p_key_wrap text, p_key_fingerprint text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v provider_secret_enrollments%ROWTYPE;
BEGIN
  IF length(p_key_fingerprint) > 64 THEN
    RAISE EXCEPTION 'invalid OpenCode enrollment key fingerprint' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','enrollment_secret_invalid')::text;
  END IF;
  SELECT * INTO v FROM provider_secret_enrollments
  WHERE id=p_enrollment_id AND operator_id=p_operator_id AND provider='opencode'
    AND status='pending' AND expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OpenCode enrollment is unavailable or expired' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','enrollment_unavailable')::text;
  END IF;
  IF octet_length(decode(p_iv,'base64'))<>12 OR octet_length(decode(p_tag,'base64'))<>16
     OR length(p_ciphertext)<16 OR length(p_key_wrap)<16 THEN
    RAISE EXCEPTION 'invalid OpenCode enrollment secret envelope' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','enrollment_secret_invalid')::text;
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
    jsonb_build_object('provider','opencode','access_gateway',v.access_gateway,
      'key_fingerprint',v.key_fingerprint),v.id::text);
  RETURN jsonb_build_object('enrollment_id',v.id,'status','provisioned');
END; $function$;

CREATE OR REPLACE FUNCTION get_operator_opencode_enrollment_status(p_operator_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT COALESCE((
    SELECT jsonb_build_object(
      'enrollment_id',id,'connection_id',connection_id,'access_gateway',access_gateway,
      'status',CASE WHEN status IN ('pending','provisioned','claimed') AND expires_at<=clock_timestamp()
        THEN 'expired' ELSE status END,
      'failure_code',failure_code,'expires_at',expires_at,'created_at',created_at)
    FROM provider_secret_enrollments
    WHERE operator_id=p_operator_id AND provider='opencode'
    ORDER BY created_at DESC LIMIT 1),'null'::jsonb);
$function$;

CREATE OR REPLACE FUNCTION complete_opencode_enrollment(p_enrollment_id uuid, p_worker_id text, p_account_label text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v provider_secret_enrollments%ROWTYPE;
  v_connection provider_connections%ROWTYPE;
BEGIN
  SELECT * INTO v FROM provider_secret_enrollments
  WHERE id=p_enrollment_id AND provider='opencode' AND status='claimed'
    AND broker_leased_by=p_worker_id AND broker_leased_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OpenCode enrollment lease is unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','enrollment_not_leased')::text; END IF;
  UPDATE provider_connections SET
    status='connected', account_label=left(COALESCE(p_account_label,''),160),
    installation_label=CASE v.access_gateway WHEN 'opencode_go' THEN 'OpenCode Go' WHEN 'openrouter' THEN 'OpenRouter' ELSE 'OpenCode' END,
    native_credential_reference='opencode-home:opencode-worker',
    permissions=jsonb_build_object('credential_boundary','native_opencode_home',
      'access_gateway',v.access_gateway,'plan',CASE v.access_gateway WHEN 'opencode_go' THEN 'OpenCode Go' WHEN 'openrouter' THEN 'OpenRouter' ELSE 'OpenCode' END),
    last_verified_at=clock_timestamp(), verify_requested_at=NULL,
    last_failure_code='', last_failure_message='', broker_requested_action='',
    broker_leased_by=NULL, broker_leased_until=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=v.connection_id RETURNING * INTO v_connection;
  IF NOT FOUND THEN RAISE EXCEPTION 'OpenCode connection is unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','provider_connection_unavailable')::text; END IF;
  UPDATE provider_secret_enrollments SET
    status='completed', consumed_at=clock_timestamp(),
    secret_ciphertext=NULL, secret_iv=NULL, secret_auth_tag=NULL, key_wrap_ciphertext=NULL,
    broker_leased_by=NULL, broker_leased_until=NULL, updated_at=clock_timestamp()
  WHERE id=p_enrollment_id;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,'provider.connection_completed',
    'provider_connection',v_connection.id::text,'allowed',NULL,
    jsonb_build_object('provider','opencode','access_gateway',v.access_gateway),v.id::text);
  RETURN jsonb_build_object(
    'connection_id',v_connection.id,'status',v_connection.status,
    'access_gateway',v.access_gateway,'account_label',v_connection.account_label,
    'last_verified_at',v_connection.last_verified_at
  );
END; $function$;

CREATE OR REPLACE FUNCTION claim_opencode_connection_work(p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT '00:01:30'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_result jsonb;
BEGIN
  WITH candidates AS (
    SELECT id FROM provider_connections
    WHERE provider='opencode' AND access_gateway<>'opencode_zen'
      AND broker_requested_action IN ('verify','disconnect')
      AND (broker_leased_until IS NULL OR broker_leased_until<=clock_timestamp())
    ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE provider_connections c SET
      broker_leased_by=p_worker_id, broker_leased_until=clock_timestamp()+p_lease
    FROM candidates x WHERE c.id=x.id RETURNING c.*
  )
  SELECT jsonb_agg(jsonb_build_object(
    'lease_expires_at',broker_leased_until,
    
    'connection_id',id,'operator_id',operator_id,'work_kind',broker_requested_action,
    'current_status',status,'billing_boundary',billing_boundary,'access_gateway',access_gateway)) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $function$;

CREATE OR REPLACE FUNCTION get_operator_opencode_connections(p_operator_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_result jsonb;
BEGIN
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,access_gateway,
    account_label,installation_label,native_credential_reference,permissions,last_verified_at)
  SELECT p_operator_id,'opencode','native','connected','free','opencode_zen',
    'OpenCode Free','OpenCode Free','opencode-home:opencode-worker',
    jsonb_build_object('credential_boundary','native_opencode_home',
      'billing_boundary','free','plan','free'),clock_timestamp()
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_connections
    WHERE operator_id=p_operator_id AND provider='opencode' AND access_gateway='opencode_zen'
  );
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'connection_id',id,'status',status,'billing_boundary',billing_boundary,'access_gateway',access_gateway,
    'account_label',account_label,'installation_label',installation_label,
    'permissions',permissions,'auth_method',auth_method,
    'last_verified_at',last_verified_at,'verify_requested_at',verify_requested_at,
    'last_failure_code',last_failure_code,'last_failure_message',last_failure_message,
    'requested_action',broker_requested_action,'created_at',created_at,'updated_at',updated_at)
    ORDER BY (billing_boundary='free') DESC, created_at),'[]'::jsonb) INTO v_result
  FROM provider_connections WHERE operator_id=p_operator_id AND provider='opencode';
  RETURN v_result;
END; $function$;

CREATE OR REPLACE FUNCTION claim_catalog_refresh_work(p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT '00:02:00'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_result jsonb;
BEGIN
  UPDATE catalog_refresh_jobs SET
    status='failed', failure_code='refresh_lease_expired',
    failure_message='The catalog refresh lease expired before the worker claimed it.',
    leased_by=NULL, leased_until=NULL
  WHERE status='in_progress' AND leased_until<=clock_timestamp();

  WITH candidates AS (
    SELECT j.id FROM catalog_refresh_jobs j
    WHERE j.status='pending' AND (j.leased_until IS NULL OR j.leased_until<=clock_timestamp())
    ORDER BY j.created_at
    FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE catalog_refresh_jobs j SET
      status='in_progress', leased_by=p_worker_id, leased_until=clock_timestamp()+p_lease
    FROM candidates c WHERE j.id=c.id
    RETURNING j.*
  )
  SELECT jsonb_agg(jsonb_build_object(
    'lease_expires_at',leased_until,
    
    'refresh_id',id,'connection_id',connection_id,'operator_id',operator_id,
    'reason',reason,'leased_until',leased_until,
    'provider',(SELECT c.provider FROM provider_connections c WHERE c.id=connection_id),
    'billing_boundary',(SELECT c.billing_boundary FROM provider_connections c WHERE c.id=connection_id),
    'access_gateway',(SELECT c.access_gateway FROM provider_connections c WHERE c.id=connection_id),
    'permissions',(SELECT c.permissions FROM provider_connections c WHERE c.id=connection_id)
  )) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $function$;

CREATE OR REPLACE FUNCTION get_operator_catalog_refresh_status(p_operator_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'connection_id',c.id,'provider',c.provider,'billing_boundary',c.billing_boundary,'access_gateway',c.access_gateway,
    'status',c.status,
    'last_refresh_at',(
      SELECT j.completed_at FROM catalog_refresh_jobs j
      WHERE j.connection_id=c.id AND j.status='completed'
      ORDER BY j.completed_at DESC LIMIT 1
    ),
    'last_refresh_status',(
      SELECT CASE WHEN j.status='failed' THEN 'failed' ELSE 'completed' END
      FROM catalog_refresh_jobs j
      WHERE j.connection_id=c.id ORDER BY j.created_at DESC LIMIT 1
    ),
    'last_failure_code',(
      SELECT j.failure_code FROM catalog_refresh_jobs j
      WHERE j.connection_id=c.id ORDER BY j.created_at DESC LIMIT 1
    ),
    'catalog_entries',(
      SELECT count(*) FROM provider_model_catalog m WHERE m.connection_id=c.id
    ),
    'verified_entries',(
      SELECT count(*) FROM provider_model_catalog m
      WHERE m.connection_id=c.id AND m.status='verified'
    )
  ) ORDER BY c.provider,c.billing_boundary),'[]'::jsonb)
  FROM provider_connections c
  WHERE c.operator_id=p_operator_id;
$function$;

CREATE OR REPLACE FUNCTION get_operator_model_catalog(p_operator_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'entry_id',m.id,'connection_id',m.connection_id,
    'runtime_type',m.runtime_type,'provider_id',m.provider_id,'model_id',m.model_id,
    'display_name',m.display_name,'provider_badge',m.provider_badge,
    'plan_badge',m.plan_badge,'billing_boundary',m.billing_boundary,'access_gateway',m.access_gateway,'model_vendor',m.model_vendor,
    'reasoning_efforts',m.reasoning_efforts,'service_tiers',m.service_tiers,
    'capabilities',m.capabilities,'adapter_version',m.adapter_version,
    'runtime_version',m.runtime_version,'discovery_source',m.discovery_source,
    'status',m.status,'failure_code',m.failure_code,
    'failure_message',m.failure_message,
    'discovered_at',m.discovered_at,'last_verified_at',m.last_verified_at,
    'stale_at',m.stale_at,'last_seen_at',m.last_seen_at,
    'gate_requested_at',m.gate_requested_at,
    'allowlisted',EXISTS(
      SELECT 1 FROM catalog_gate_allowlist a
      WHERE a.operator_id=m.operator_id AND a.connection_id=m.connection_id
        AND a.provider_id=m.provider_id AND a.model_id=m.model_id
    ),
    'connection_status',c.status,'connection_provider',c.provider
  ) ORDER BY m.updated_at DESC),'[]'::jsonb)
  FROM provider_model_catalog m
  JOIN provider_connections c ON c.id=m.connection_id
  WHERE m.operator_id=p_operator_id;
$function$;

CREATE OR REPLACE FUNCTION get_operator_model_catalog_verified(p_operator_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'entry_id',m.id,'connection_id',m.connection_id,
    'runtime_type',m.runtime_type,'provider_id',m.provider_id,'model_id',m.model_id,
    'display_name',m.display_name,'provider_badge',m.provider_badge,
    'plan_badge',m.plan_badge,'billing_boundary',m.billing_boundary,'access_gateway',m.access_gateway,'model_vendor',m.model_vendor,
    'reasoning_efforts',m.reasoning_efforts,'service_tiers',m.service_tiers,
    'capabilities',m.capabilities,'adapter_version',m.adapter_version,
    'runtime_version',m.runtime_version,'last_verified_at',m.last_verified_at
  ) ORDER BY m.last_verified_at DESC,m.id),'[]'::jsonb)
  FROM provider_model_catalog m
  JOIN provider_connections c ON c.id=m.connection_id
  WHERE m.operator_id=p_operator_id AND m.status='verified' AND c.status='connected';
$function$;

CREATE OR REPLACE FUNCTION claim_catalog_verifications(p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT '00:10:00'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_result jsonb; v_op uuid;
BEGIN
  UPDATE provider_model_catalog SET
    status='discovered', verified_lease_until=NULL, verification_id=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE status='verifying' AND verified_lease_until<=clock_timestamp();

  -- Serialize claims per operator (deterministic order avoids deadlocks) so
  -- the remaining-slot computation below is consistent across transactions.
  FOR v_op IN
    SELECT DISTINCT m.operator_id
    FROM provider_model_catalog m
    JOIN provider_connections c ON c.id=m.connection_id
    WHERE m.status='discovered' AND c.status='connected'
      AND m.gate_requested_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM catalog_gate_allowlist a
        WHERE a.operator_id=m.operator_id AND a.connection_id=m.connection_id
          AND a.provider_id=m.provider_id AND a.model_id=m.model_id
      )
    ORDER BY m.operator_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('catalog-gate-quota:' || v_op::text, 0));
  END LOOP;

  WITH eligible AS (
    SELECT m.id, m.operator_id, m.gate_requested_at
    FROM provider_model_catalog m
    JOIN provider_connections c ON c.id=m.connection_id
    WHERE m.status='discovered' AND c.status='connected'
      AND m.gate_requested_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM catalog_gate_allowlist a
        WHERE a.operator_id=m.operator_id AND a.connection_id=m.connection_id
          AND a.provider_id=m.provider_id AND a.model_id=m.model_id
      )
  ), quotas AS (
    SELECT e.operator_id,
      GREATEST(0, 2 - (SELECT count(*) FROM provider_model_catalog m2
        WHERE m2.operator_id=e.operator_id AND m2.status='verifying')) AS remaining_concurrency,
      GREATEST(0, 20 - (SELECT count(*) FROM model_verification_receipts r
        WHERE r.operator_id=e.operator_id
          AND r.verified_at>clock_timestamp()-interval '24 hours')
        - (SELECT count(*) FROM provider_model_catalog m3
          WHERE m3.operator_id=e.operator_id AND m3.status='verifying')) AS remaining_daily
    FROM (SELECT DISTINCT operator_id FROM eligible) e
  ), ranked AS (
    SELECT e.id, row_number() OVER (
      PARTITION BY e.operator_id ORDER BY e.gate_requested_at, e.id
    ) AS rn
    FROM eligible e
  ), allowed AS (
    SELECT r.id FROM ranked r
    JOIN eligible e ON e.id=r.id
    JOIN quotas q ON q.operator_id=e.operator_id
    WHERE r.rn <= LEAST(q.remaining_concurrency, q.remaining_daily)
  ), candidates AS (
    SELECT a.id FROM allowed a
    ORDER BY (SELECT gate_requested_at FROM eligible e WHERE e.id=a.id), a.id
    FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE provider_model_catalog m SET
      status='verifying', verified_lease_until=clock_timestamp()+p_lease,
      verification_id=gen_random_uuid(),
      gate_requested_at=NULL,
      updated_at=clock_timestamp(), version=version+1
    FROM candidates c WHERE m.id=c.id
    RETURNING m.*
  )
  SELECT jsonb_agg(jsonb_build_object(
    'lease_expires_at',verified_lease_until,
    
    'entry_id',id,'connection_id',connection_id,'operator_id',operator_id,
    'runtime_type',runtime_type,'provider_id',provider_id,'model_id',model_id,
    'billing_boundary',billing_boundary,'access_gateway',access_gateway,'model_vendor',model_vendor,'reasoning_efforts',reasoning_efforts,
    'service_tiers',service_tiers,'adapter_version',adapter_version,
    'runtime_version',runtime_version,'verification_id',verification_id
  )) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $function$;

CREATE OR REPLACE FUNCTION resolve_catalog_snapshot_entry(p_entry_id uuid, p_reasoning_effort text DEFAULT ''::text, p_service_tier text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_entry provider_model_catalog%ROWTYPE; v_reasoning text; v_tier text;
BEGIN
  SELECT * INTO v_entry FROM provider_model_catalog m
  JOIN provider_connections c ON c.id=m.connection_id
  WHERE m.id=p_entry_id AND m.status='verified' AND c.status='connected';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalog entry is not available for selection' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','catalog_entry_unavailable')::text;
  END IF;
  v_reasoning := '';
  IF p_reasoning_effort <> '' THEN
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_entry.reasoning_efforts) e WHERE e = p_reasoning_effort
    ) THEN
      RAISE EXCEPTION 'reasoning effort is not supported by this model' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','runtime_defaults_invalid')::text;
    END IF;
    v_reasoning := p_reasoning_effort;
  END IF;
  v_tier := '';
  IF p_service_tier <> '' THEN
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_entry.service_tiers) e WHERE e = p_service_tier
    ) THEN
      RAISE EXCEPTION 'service tier is not supported by this model' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','runtime_defaults_invalid')::text;
    END IF;
    v_tier := p_service_tier;
  END IF;
  RETURN jsonb_build_object(
    'entry_id',v_entry.id,'connection_id',v_entry.connection_id,
    'runtime_type',v_entry.runtime_type,'provider_id',v_entry.provider_id,
    'model_id',v_entry.model_id,'display_name',v_entry.display_name,
    'provider_badge',v_entry.provider_badge,'plan_badge',v_entry.plan_badge,
    'billing_boundary',v_entry.billing_boundary,'access_gateway',v_entry.access_gateway,'model_vendor',v_entry.model_vendor,
    'reasoning_effort',v_reasoning,'service_tier',v_tier,
    'capabilities',v_entry.capabilities,
    'adapter_version',v_entry.adapter_version,'runtime_version',v_entry.runtime_version,
    'verification_id',v_entry.verification_id,'last_verified_at',v_entry.last_verified_at
  );
END; $function$;

CREATE OR REPLACE FUNCTION upsert_catalog_entries(p_refresh_id uuid, p_worker_id text, p_entries jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_job catalog_refresh_jobs%ROWTYPE;
  v_entry jsonb;
  v_connection provider_connections%ROWTYPE;
  v_created integer := 0;
  v_updated integer := 0;
  v_stale integer := 0;
  v_provider_id text;
  v_model_id text;
  v_created_id uuid;
  v_inserted boolean;
  v_stale_rows integer;
  v_seen_ids uuid[] := '{}'::uuid[];
BEGIN
  SELECT * INTO v_job FROM catalog_refresh_jobs
  WHERE id=p_refresh_id AND status='in_progress'
    AND leased_by=p_worker_id AND leased_until>clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog refresh lease is unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','catalog_refresh_not_leased')::text; END IF;
  SELECT * INTO v_connection FROM provider_connections WHERE id=v_job.connection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider connection is unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','provider_connection_unavailable')::text; END IF;
  IF jsonb_typeof(p_entries)<>'array' OR jsonb_array_length(p_entries)>500 THEN
    RAISE EXCEPTION 'catalog entry list is invalid' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','catalog_entry_invalid')::text;
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries) LOOP
    v_provider_id := COALESCE(v_entry->>'provider_id','');
    v_model_id := COALESCE(v_entry->>'model_id','');
    IF v_provider_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
       OR v_model_id !~ '^[A-Za-z0-9][A-Za-z0-9._/: -]{0,199}$'
       OR COALESCE(v_entry->>'runtime_type','') NOT IN ('codex','opencode','antigravity')
       OR COALESCE(v_entry->>'discovery_source','') NOT IN ('codex_model_list','opencode_provider_api')
       OR COALESCE(length(v_entry->>'display_name'),0)>200
       OR COALESCE(length(v_entry->>'provider_badge'),0)>64
       OR COALESCE(length(v_entry->>'plan_badge'),0)>64
       OR COALESCE(length(v_entry->>'model_vendor'),0)>64
       OR COALESCE(length(v_entry->>'adapter_version'),0)>64
       OR COALESCE(length(v_entry->>'runtime_version'),0)>64
       OR COALESCE(v_entry->>'billing_boundary','') NOT IN ('','free','subscription','direct_metered','third_party_metered')
       OR jsonb_typeof(COALESCE(v_entry->'reasoning_efforts','[]'::jsonb))<>'array'
       OR jsonb_array_length(COALESCE(v_entry->'reasoning_efforts','[]'::jsonb))>16
       OR jsonb_typeof(COALESCE(v_entry->'service_tiers','[]'::jsonb))<>'array'
       OR jsonb_array_length(COALESCE(v_entry->'service_tiers','[]'::jsonb))>16
       OR jsonb_typeof(COALESCE(v_entry->'capabilities','{}'::jsonb))<>'object'
       OR length(COALESCE(v_entry->'capabilities','{}'::jsonb)::text)>4096
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(v_entry) k
         WHERE k NOT IN (
           'runtime_type','provider_id','model_id','display_name','provider_badge',
           'plan_badge','billing_boundary','reasoning_efforts','service_tiers',
           'capabilities','adapter_version','runtime_version','discovery_source','model_vendor'
         )
       ) THEN
      RAISE EXCEPTION 'catalog entry is not normalized: %', left(v_model_id,80) USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','catalog_entry_invalid')::text;
    END IF;

    INSERT INTO provider_model_catalog(
      operator_id,connection_id,billing_boundary,access_gateway,model_vendor,runtime_type,provider_id,model_id,
      display_name,provider_badge,plan_badge,reasoning_efforts,service_tiers,
      capabilities,adapter_version,runtime_version,discovery_source,status
    ) VALUES(
      v_connection.operator_id,v_connection.id,
      COALESCE(v_entry->>'billing_boundary',''),
      -- The gateway is the connection's, never the worker's word for it.
      v_connection.access_gateway,
      COALESCE(NULLIF(v_entry->>'model_vendor',''),
        catalog_model_vendor(v_connection.access_gateway, v_entry->>'runtime_type', v_model_id)),
      v_entry->>'runtime_type',v_provider_id,v_model_id,
      left(COALESCE(v_entry->>'display_name',''),200),
      left(COALESCE(v_entry->>'provider_badge',''),64),
      left(COALESCE(v_entry->>'plan_badge',''),64),
      COALESCE(v_entry->'reasoning_efforts','[]'::jsonb),
      COALESCE(v_entry->'service_tiers','[]'::jsonb),
      COALESCE(v_entry->'capabilities','{}'::jsonb),
      left(COALESCE(v_entry->>'adapter_version',''),64),
      left(COALESCE(v_entry->>'runtime_version',''),64),
      v_entry->>'discovery_source','discovered'
    )
    ON CONFLICT (connection_id, provider_id, model_id, adapter_version, runtime_version)
    DO UPDATE SET
      display_name=EXCLUDED.display_name,
      billing_boundary=EXCLUDED.billing_boundary,
      access_gateway=EXCLUDED.access_gateway,
      model_vendor=EXCLUDED.model_vendor,
      provider_badge=EXCLUDED.provider_badge,
      plan_badge=EXCLUDED.plan_badge,
      reasoning_efforts=EXCLUDED.reasoning_efforts,
      service_tiers=EXCLUDED.service_tiers,
      capabilities=EXCLUDED.capabilities,
      discovery_source=EXCLUDED.discovery_source,
      status=CASE
        WHEN provider_model_catalog.status='unavailable' THEN 'discovered'
        WHEN provider_model_catalog.status='rejected' THEN 'rejected'
        WHEN provider_model_catalog.status='verifying'
             AND provider_model_catalog.verified_lease_until<=clock_timestamp()
          THEN 'discovered'
        ELSE provider_model_catalog.status END,
      last_seen_at=clock_timestamp(),
      updated_at=clock_timestamp(),
      version=provider_model_catalog.version+1
    RETURNING id, (xmax = 0) AS was_inserted
    INTO v_created_id, v_inserted;

    IF v_inserted THEN
      v_created := v_created + 1;
    ELSE
      v_updated := v_updated + 1;
    END IF;
    v_seen_ids := v_seen_ids || v_created_id;

    UPDATE provider_model_catalog SET
      status='stale', stale_at=clock_timestamp(),
      verification_id=NULL, verified_lease_until=NULL,
      updated_at=clock_timestamp(), version=version+1
    WHERE connection_id=v_connection.id AND provider_id=v_provider_id AND model_id=v_model_id
      AND (adapter_version<>COALESCE(v_entry->>'adapter_version','')
           OR runtime_version<>COALESCE(v_entry->>'runtime_version',''))
      AND status IN ('verified','discovered');
    GET DIAGNOSTICS v_stale_rows = ROW_COUNT;
    v_stale := v_stale + v_stale_rows;  END LOOP;

  UPDATE catalog_refresh_jobs SET entries_seen=jsonb_array_length(p_entries)
  WHERE id=v_job.id;
  RETURN jsonb_build_object(
    'refresh_id',v_job.id,'created',v_created,'updated',v_updated,
    'stale_marked',v_stale,'entries_seen',jsonb_array_length(p_entries),
    'seen_entry_ids',to_jsonb(v_seen_ids)
  );
END; $function$;

-- The triggers run whatever the writer's role; the vendor rule is read by the
-- worker's catalog writer.
REVOKE EXECUTE ON FUNCTION catalog_model_vendor(text,text,text), fill_catalog_gateway(), fill_connection_gateway() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog_model_vendor(text,text,text) TO infra_worker;
