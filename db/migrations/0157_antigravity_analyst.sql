-- Google Antigravity CLI (`agy`) as an analyst (rc.150).
--
-- The registry (runtime-adapters.mjs) and the driver (drivers/antigravity.mjs)
-- provision the fourth runtime the schema has accepted since 0001 and nothing
-- installed: `antigravity`, an analyst only. agy takes no MCP server, so the
-- platform's tools cannot reach it, and the orchestrator and executor roles
-- stay closed to it by the mirror (0074). What the database repeats of the
-- registry — the provider, its gateway and shape, the catalog's source, the
-- role and capability mirror, the validators — is each changed here, the list
-- runtime-registry-schema.test.mjs writes.
--
-- Its access: one connection per operator, the operator's Google account,
-- signed in on the host as antigravity-worker by the paste-code flow Claude
-- Code's sign-in made (0136). That flow becomes a runtime's: the sessions name
-- their runtime, a sign-in starts for any runtime whose driver declares
-- `account.login`, and Claude Code's functions keep their signatures as the
-- way to say "claude". Its models are what `agy models` lists, read by the
-- supervisor as the runtime's user and checked one by one by the model check
-- lane before any is offered.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('antigravity_not_signed_in','conflict','the host does not report Antigravity signed in; sign in with Google from the panel, then connect'),
  ('runtime_login_unsupported','invalid_argument','the runtime has no sign-in by a pasted code (its driver declares no account.login)')
ON CONFLICT (reason) DO NOTHING;

-- Its connection: the provider, its one gateway, and its one shape — the
-- Google account, signed in natively as antigravity-worker.
ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_provider_check,
  ADD CONSTRAINT provider_connections_provider_check CHECK (provider IN ('github','codex','opencode','claude','antigravity'));
ALTER TABLE provider_login_sessions DROP CONSTRAINT provider_login_sessions_provider_check,
  ADD CONSTRAINT provider_login_sessions_provider_check CHECK (provider IN ('github','codex','opencode','claude','antigravity'));
ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_access_gateway_check,
  ADD CONSTRAINT provider_connections_access_gateway_check CHECK (
    (connection_kind='scm' AND access_gateway IS NULL)
    OR (connection_kind='model_access' AND access_gateway IS NOT NULL
        AND access_gateway IN ('opencode_zen','opencode_go','openrouter','openai_chatgpt','claude_subscription','google_antigravity')));
ALTER TABLE provider_model_catalog DROP CONSTRAINT provider_model_catalog_access_gateway_check,
  ADD CONSTRAINT provider_model_catalog_access_gateway_check CHECK (
    access_gateway IN ('opencode_zen','opencode_go','openrouter','openai_chatgpt','claude_subscription','google_antigravity'));
ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_gateway_of_runtime,
  ADD CONSTRAINT provider_connections_gateway_of_runtime CHECK (
    (provider<>'codex' OR access_gateway='openai_chatgpt')
    AND (provider<>'opencode' OR access_gateway IN ('opencode_zen','opencode_go','openrouter'))
    AND (provider<>'claude' OR access_gateway='claude_subscription')
    AND (provider<>'antigravity' OR access_gateway='google_antigravity'));
ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_antigravity_shape CHECK (
  provider<>'antigravity' OR (auth_method='native' AND billing_boundary='subscription'
                              AND native_credential_reference='antigravity-home:antigravity-worker'));
ALTER TABLE provider_model_catalog DROP CONSTRAINT provider_model_catalog_discovery_source_check,
  ADD CONSTRAINT provider_model_catalog_discovery_source_check CHECK (
    discovery_source IN ('codex_model_list','opencode_provider_api','claude_aliases','anthropic_models','antigravity_models','manual'));

-- The mirror of the registry's role and the driver's capabilities (0074).
INSERT INTO runtime_roles(runtime_type, role) VALUES ('antigravity','analyst')
ON CONFLICT DO NOTHING;
INSERT INTO runtime_capabilities(runtime_type, capability)
SELECT 'antigravity', c FROM unnest(ARRAY['sessions.create','sessions.resume','run.read_only','stream.structured',
  'interrupt','events.raw','usage.report','gate.smoke','account.login','catalog.models']) c
ON CONFLICT DO NOTHING;

-- An Antigravity model's vendor is read from its id: agy lists Gemini beside
-- Claude and GPT models, and names each by its family.
CREATE OR REPLACE FUNCTION catalog_model_vendor(p_gateway text, p_runtime text, p_model_id text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_gateway='openrouter' AND position('/' in p_model_id)>1 THEN left(split_part(p_model_id,'/',1),64)
    WHEN p_runtime='codex' THEN 'openai'
    WHEN p_runtime='claude' THEN 'anthropic'
    WHEN p_runtime='antigravity' AND p_model_id ~ '^gemini' THEN 'google'
    WHEN p_runtime='antigravity' AND p_model_id ~ '^claude' THEN 'anthropic'
    WHEN p_runtime='antigravity' AND p_model_id ~ '^gpt' THEN 'openai'
    WHEN p_runtime='antigravity' THEN 'google'
    ELSE '' END;
$function$;

CREATE OR REPLACE FUNCTION fill_connection_gateway()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  IF NEW.provider='codex' THEN
    NEW.access_gateway := COALESCE(NEW.access_gateway,'openai_chatgpt');
    IF NEW.billing_boundary='' THEN NEW.billing_boundary := 'subscription'; END IF;
  END IF;
  -- Claude Code signs in with the operator's subscription (sprint C K2).
  IF NEW.provider='claude' THEN
    NEW.access_gateway := COALESCE(NEW.access_gateway,'claude_subscription');
    IF NEW.billing_boundary='' THEN NEW.billing_boundary := 'subscription'; END IF;
  END IF;
  -- Antigravity signs in with the operator's Google account (rc.150).
  IF NEW.provider='antigravity' THEN
    NEW.access_gateway := COALESCE(NEW.access_gateway,'google_antigravity');
    IF NEW.billing_boundary='' THEN NEW.billing_boundary := 'subscription'; END IF;
  END IF;
  -- OpenCode Free is Zen, whoever writes it without naming it.
  IF NEW.provider='opencode' AND NEW.access_gateway IS NULL AND NEW.billing_boundary='free' THEN
    NEW.access_gateway := 'opencode_zen';
  END IF;
  RETURN NEW;
END $function$;

-- 0091's, with the fourth provider: a catalog refresh runs through its connection.
CREATE OR REPLACE FUNCTION request_catalog_refresh(p_connection_id uuid, p_operator_id uuid, p_reason text DEFAULT 'manual'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_connection provider_connections%ROWTYPE; v_job catalog_refresh_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_connection FROM provider_connections
  WHERE id=p_connection_id AND operator_id=p_operator_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider connection is unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','provider_connection_unavailable')::text; END IF;
  IF v_connection.provider NOT IN ('codex','opencode','claude','antigravity') THEN
    RAISE EXCEPTION 'provider does not expose a runtime model catalog' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','catalog_provider_unsupported')::text;
  END IF;
  IF v_connection.status<>'connected' THEN
    RAISE EXCEPTION 'provider connection is not connected' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','provider_connection_not_connected')::text;
  END IF;
  SELECT * INTO v_job FROM catalog_refresh_jobs
  WHERE connection_id=v_connection.id AND status IN ('pending','in_progress')
  ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'refresh_id',v_job.id,'status',v_job.status,
      'connection_id',v_connection.id,'duplicate',true
    );
  END IF;
  INSERT INTO catalog_refresh_jobs(operator_id,connection_id,reason)
  VALUES(v_connection.operator_id,v_connection.id,left(COALESCE(NULLIF(p_reason,''),'manual'),200))
  RETURNING * INTO v_job;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,
    'catalog.refresh_requested','provider_connection',v_connection.id::text,
    'allowed',NULL,jsonb_build_object('provider',v_connection.provider,'reason',v_job.reason),
    COALESCE(v_job.id::text,v_connection.id::text));
  RETURN jsonb_build_object(
    'refresh_id',v_job.id,'status',v_job.status,
    'connection_id',v_connection.id,'duplicate',false
  );
END; $function$;

-- 0129's upsert, with the source `agy models` is recorded under.
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
  v_listed integer := 0;
  v_provider_id text;
  v_model_id text;
  v_runtime_version text;
  v_created_id uuid;
  v_inserted boolean;
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
       OR COALESCE(v_entry->>'runtime_type','') NOT IN ('codex','opencode','claude','antigravity')
       OR COALESCE(v_entry->>'discovery_source','') NOT IN ('codex_model_list','opencode_provider_api','claude_aliases','anthropic_models','antigravity_models')
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
    v_runtime_version := catalog_listing_version(v_entry->>'runtime_type', v_entry->>'runtime_version');

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
      v_runtime_version,
      v_entry->>'discovery_source','discovered'
    )
    ON CONFLICT (connection_id, provider_id, model_id) WHERE superseded_by IS NULL
    DO UPDATE SET
      display_name=EXCLUDED.display_name,
      billing_boundary=EXCLUDED.billing_boundary,
      access_gateway=EXCLUDED.access_gateway,
      model_vendor=EXCLUDED.model_vendor,
      provider_badge=EXCLUDED.provider_badge,
      plan_badge=EXCLUDED.plan_badge,
      reasoning_efforts=EXCLUDED.reasoning_efforts,
      reasoning_levels=EXCLUDED.reasoning_levels,
      default_reasoning_effort=EXCLUDED.default_reasoning_effort,
      service_tiers=EXCLUDED.service_tiers,
      capabilities=EXCLUDED.capabilities,
      adapter_version=EXCLUDED.adapter_version,
      runtime_version=EXCLUDED.runtime_version,
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

    INSERT INTO model_listings(entry_id, runtime_type, runtime_version)
    VALUES (v_created_id, v_entry->>'runtime_type', v_runtime_version)
    ON CONFLICT (entry_id, runtime_version) DO UPDATE SET last_seen_at=clock_timestamp()
    RETURNING (xmax = 0) INTO v_inserted;
    IF v_inserted THEN v_listed := v_listed + 1; END IF;
  END LOOP;

  UPDATE catalog_refresh_jobs SET entries_seen=jsonb_array_length(p_entries)
  WHERE id=v_job.id;
  RETURN jsonb_build_object(
    'refresh_id',v_job.id,'created',v_created,'updated',v_updated,
    'stale_marked',0,'listings_added',v_listed,'entries_seen',jsonb_array_length(p_entries),
    'seen_entry_ids',to_jsonb(v_seen_ids)
  );
END; $function$;


-- The connection, as Claude Code's (0091) -------------------------------------

CREATE FUNCTION get_operator_antigravity_connection(p_operator_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object(
    'connection',(SELECT jsonb_build_object('connection_id',c.id,'status',c.status,
        'last_verified_at',c.last_verified_at,'created_at',c.created_at,'updated_at',c.updated_at)
      FROM provider_connections c WHERE c.operator_id=p_operator_id AND c.provider='antigravity'
      ORDER BY c.created_at DESC LIMIT 1),
    'runtime',runtime_health_reading('antigravity'));
$$;

-- Registers, or re-registers, the operator's Google account as a model access
-- connection, and asks for its catalog. Refused unless the host reports the
-- runtime installed and signed in now: the panel does not hold the login, the
-- host does.
CREATE FUNCTION connect_antigravity_connection(p_operator_id uuid, p_actor text, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_health jsonb; v_connection provider_connections%ROWTYPE; v_refresh jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id=p_operator_id AND u.role='owner' AND u.disabled_at IS NULL) THEN
    PERFORM refuse('provider_connection_unavailable', 'not an enabled operator', '42501');
  END IF;
  v_health:=runtime_health_reading('antigravity');
  IF (v_health->>'known')::boolean IS NOT TRUE THEN
    PERFORM refuse('runtime_readiness_unknown', 'the host has not reported Antigravity recently');
  END IF;
  IF (v_health->>'installed')::boolean IS NOT TRUE THEN
    PERFORM refuse('runtime_not_provisioned', 'Antigravity is not installed on the host: infra-cod runtime install antigravity');
  END IF;
  IF (v_health->>'authenticated')::boolean IS NOT TRUE THEN
    PERFORM refuse('antigravity_not_signed_in', 'Antigravity is not signed in on the host: Sign in with Google in Settings → Connections');
  END IF;
  SELECT * INTO v_connection FROM provider_connections
  WHERE operator_id=p_operator_id AND access_gateway='google_antigravity' FOR UPDATE;
  IF FOUND THEN
    UPDATE provider_connections SET status='connected',broker_requested_action='',last_verified_at=clock_timestamp(),
      last_failure_code='',last_failure_message='',verified_via='broker',version=version+1,updated_at=clock_timestamp()
    WHERE id=v_connection.id RETURNING * INTO v_connection;
  ELSE
    INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,
      billing_boundary,native_credential_reference,account_label,last_verified_at)
    VALUES(p_operator_id,'antigravity','native','connected','google_antigravity',
      'subscription','antigravity-home:antigravity-worker','Google account (Antigravity)',clock_timestamp())
    RETURNING * INTO v_connection;
  END IF;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_actor,'provider_connection.connected','provider_connection',
    v_connection.id::text,'allowed',NULL,jsonb_build_object('provider','antigravity','runtime_version',v_health->>'version'),p_correlation_id);
  v_refresh:=request_catalog_refresh(v_connection.id, p_operator_id, 'connected');
  RETURN jsonb_build_object('connection_id',v_connection.id,'status',v_connection.status,'refresh',v_refresh);
END $$;

-- The connection off: dispatch then reads every model of it as revoked
-- (connection_revoked, 0084), and the card offers to connect again. The login
-- on the host stays.
CREATE FUNCTION disconnect_antigravity_connection(p_operator_id uuid, p_connection_id uuid, p_actor text, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_connection provider_connections%ROWTYPE;
BEGIN
  SELECT * INTO v_connection FROM provider_connections
  WHERE id=p_connection_id AND operator_id=p_operator_id AND provider='antigravity' FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('provider_connection_unavailable', format('no Antigravity connection %s of this operator', p_connection_id));
  END IF;
  UPDATE provider_connections SET status='disconnected',version=version+1,updated_at=clock_timestamp()
  WHERE id=v_connection.id RETURNING * INTO v_connection;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_actor,'provider_connection.disconnected','provider_connection',
    v_connection.id::text,'allowed',NULL,jsonb_build_object('provider','antigravity'),p_correlation_id);
  RETURN jsonb_build_object('connection_id',v_connection.id,'status',v_connection.status);
END $$;

REVOKE EXECUTE ON FUNCTION get_operator_antigravity_connection(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION connect_antigravity_connection(uuid,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION disconnect_antigravity_connection(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_operator_antigravity_connection(uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION connect_antigravity_connection(uuid,text,text) TO infra_web;
GRANT EXECUTE ON FUNCTION disconnect_antigravity_connection(uuid,uuid,text,text) TO infra_web;

-- The paste-code sign-in, a runtime's (0136 generalised) ------------------------

-- Each sign-in names the runtime it signs in; the rows from before are Claude
-- Code's, which is what the flow was for.
ALTER TABLE claude_login_sessions ADD COLUMN runtime_type text NOT NULL DEFAULT 'claude'
  CHECK (runtime_type IN ('codex','opencode','claude','antigravity'));
DROP INDEX IF EXISTS claude_login_sessions_open;
CREATE INDEX claude_login_sessions_open ON claude_login_sessions(operator_id, runtime_type, created_at)
  WHERE status IN ('requested','awaiting_code','verifying');

-- What the panel shows: never the code.
CREATE OR REPLACE FUNCTION claude_login_view(s claude_login_sessions) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id', s.id, 'runtime_type', s.runtime_type, 'status', s.status, 'authorize_url', s.authorize_url,
    'code_submitted', s.auth_code IS NOT NULL, 'failure', s.failure,
    'created_at', s.created_at, 'expires_at', s.expires_at)
$$;

-- A sign-in for a runtime whose driver signs in by a pasted code — decided by
-- the capability mirror, never by the runtime's name. One open sign-in per
-- runtime at a time: a new one replaces any still open.
CREATE FUNCTION start_runtime_login(p_owner_id uuid, p_runtime_type text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp AS $$
DECLARE v_session claude_login_sessions%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id=p_owner_id AND u.role='owner' AND u.disabled_at IS NULL) THEN
    PERFORM refuse('operator_unavailable', 'not an enabled operator', '42501');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM runtime_capabilities c WHERE c.runtime_type=p_runtime_type AND c.capability='account.login') THEN
    PERFORM refuse('runtime_login_unsupported', format('%s has no sign-in by a pasted code', COALESCE(p_runtime_type,'(no runtime)')), '22023');
  END IF;
  UPDATE claude_login_sessions SET status = 'cancelled', auth_code = NULL, updated_at = clock_timestamp()
  WHERE operator_id = p_owner_id AND runtime_type = p_runtime_type AND status IN ('requested','awaiting_code','verifying');
  INSERT INTO claude_login_sessions(operator_id, runtime_type) VALUES (p_owner_id, p_runtime_type) RETURNING * INTO v_session;
  PERFORM pg_notify('claude_login', v_session.id::text);
  RETURN claude_login_view(v_session);
END $$;

CREATE FUNCTION get_runtime_login(p_owner_id uuid, p_runtime_type text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp AS $$
DECLARE v_session claude_login_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_session FROM claude_login_sessions
  WHERE operator_id = p_owner_id AND runtime_type = p_runtime_type ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN claude_login_view(v_session);
END $$;

-- Claude Code's, as the panel calls them: the runtime login for 'claude'. The
-- operator check moved into start_runtime_login; 0136's start had none.
CREATE OR REPLACE FUNCTION start_claude_login(p_owner_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp AS $$
  SELECT start_runtime_login(p_owner_id, 'claude');
$$;

CREATE OR REPLACE FUNCTION get_claude_login(p_owner_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp AS $$
  SELECT get_runtime_login(p_owner_id, 'claude');
$$;

-- The code a runtime shows: Google's carry slashes (`4/0A…`); Claude's do not.
CREATE OR REPLACE FUNCTION submit_claude_login_code(p_owner_id uuid, p_session_id uuid, p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp AS $$
DECLARE v_session claude_login_sessions%ROWTYPE; v_code text := btrim(COALESCE(p_code, ''));
BEGIN
  SELECT * INTO v_session FROM claude_login_sessions
  WHERE id = p_session_id AND operator_id = p_owner_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM refuse('claude_login_unknown', 'no such sign-in', '42501'); END IF;
  IF v_session.status <> 'awaiting_code' OR v_session.expires_at <= clock_timestamp() THEN
    PERFORM refuse('claude_login_not_waiting', 'this sign-in is not waiting for a code; start it again');
  END IF;
  IF v_code !~ '^[A-Za-z0-9_#./~-]+$' OR char_length(v_code) NOT BETWEEN 8 AND 512 THEN
    PERFORM refuse('claude_login_code_invalid', 'paste the code the sign-in shows, as it is', '22023');
  END IF;
  UPDATE claude_login_sessions SET auth_code = v_code, updated_at = clock_timestamp()
  WHERE id = p_session_id RETURNING * INTO v_session;
  PERFORM pg_notify('claude_login', v_session.id::text);
  RETURN claude_login_view(v_session);
END $$;

-- The account worker's claim, now saying which runtime each sign-in is.
CREATE OR REPLACE FUNCTION claim_claude_logins(p_worker_id text, p_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  UPDATE claude_login_sessions SET status = 'expired', auth_code = NULL, leased_by = NULL, lease_until = NULL,
    failure = 'The sign-in link expired. Start it again.', updated_at = clock_timestamp()
  WHERE status IN ('requested','awaiting_code','verifying') AND expires_at <= clock_timestamp();
  WITH candidates AS (
    SELECT id FROM claude_login_sessions
    WHERE status = 'requested' AND (lease_until IS NULL OR lease_until <= clock_timestamp())
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit, 0)
  ), claimed AS (
    UPDATE claude_login_sessions s SET leased_by = p_worker_id, lease_until = s.expires_at,
      updated_at = clock_timestamp()
    FROM candidates c WHERE s.id = c.id RETURNING s.*
  )
  SELECT jsonb_agg(jsonb_build_object('id', id, 'runtime_type', runtime_type, 'expires_at', expires_at)) INTO v_result FROM claimed;
  RETURN COALESCE(v_result, '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION start_runtime_login(uuid,text), get_runtime_login(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_runtime_login(uuid,text), get_runtime_login(uuid,text) TO infra_web;
