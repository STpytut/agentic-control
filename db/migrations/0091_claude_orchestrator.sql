-- Claude Code as an orchestrator (Stage 11.6, sprint C K2; decision C2).
--
-- The registry (runtime-adapters.mjs) and the driver (drivers/claude.mjs)
-- declare a third runtime, `claude`, that plays the orchestrator only. The
-- database repeats the registry in CHECK constraints, in the functions that
-- validate a runtime or a provider, and in the role and capability mirror
-- (0074); runtime-registry-schema.test.mjs names each place, and this is that
-- list. The executor role stays refused for it by the mirror: runtime_roles
-- has no (claude, executor), and 0079's triggers refuse an assignment the
-- mirror does not allow.
--
-- Its access: one connection per operator, the operator's Claude
-- subscription, signed in on the host as the runtime's user (decision C3,
-- `infra-cod runtime login claude`). The panel registers it
-- (connect_claude_connection) once the host reports the runtime signed in, and
-- can disconnect it — which dispatch reads as revoked (0084). Its models are
-- Claude Code's own aliases, which the refresh worker writes and the
-- capability gate verifies one by one: the CLI has no command that lists them.

SET search_path TO control_plane, public, extensions;

-- The refusals of the functions redefined below, which said only a sentence
-- until now (the rule since 0067: every refusal names its reason). The
-- sentences are kept, so a caller matching on one still matches.
INSERT INTO failure_reasons(reason, code, note) VALUES
  ('runtime_activity_not_leased','lease_lost','the job reporting activity is not leased by the worker that reports it'),
  ('runtime_activity_invalid','invalid_argument','an activity event outside the normalised shape'),
  ('runtime_type_unknown','invalid_argument','a runtime this installation does not know'),
  ('operator_unavailable','permission_denied','not an enabled operator'),
  ('catalog_provider_unsupported','invalid_argument','the provider has no runtime model catalog'),
  ('provider_connection_not_connected','conflict','the provider connection is not connected')
ON CONFLICT (reason) DO NOTHING;

-- The runtime's name wherever a runtime is recorded.
ALTER TABLE runtime_profiles DROP CONSTRAINT runtime_profiles_runtime_type_check,
  ADD CONSTRAINT runtime_profiles_runtime_type_check CHECK (runtime_type IN ('codex','opencode','claude','antigravity'));
ALTER TABLE runtime_activity_events DROP CONSTRAINT runtime_activity_events_runtime_type_check,
  ADD CONSTRAINT runtime_activity_events_runtime_type_check CHECK (runtime_type IN ('codex','opencode','claude','antigravity'));
ALTER TABLE provider_model_catalog DROP CONSTRAINT provider_model_catalog_runtime_type_check,
  ADD CONSTRAINT provider_model_catalog_runtime_type_check CHECK (runtime_type IN ('codex','opencode','claude','antigravity'));
ALTER TABLE runtime_job_selections DROP CONSTRAINT runtime_job_selections_runtime_type_check,
  ADD CONSTRAINT runtime_job_selections_runtime_type_check CHECK (runtime_type IN ('codex','opencode','claude','antigravity'));

-- Its connection: the provider, its one gateway, and its one shape — the
-- subscription, signed in natively as claude-worker.
ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_provider_check,
  ADD CONSTRAINT provider_connections_provider_check CHECK (provider IN ('github','codex','opencode','claude'));
ALTER TABLE provider_login_sessions DROP CONSTRAINT provider_login_sessions_provider_check,
  ADD CONSTRAINT provider_login_sessions_provider_check CHECK (provider IN ('github','codex','opencode','claude'));
ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_access_gateway_check,
  ADD CONSTRAINT provider_connections_access_gateway_check CHECK (
    (connection_kind='scm' AND access_gateway IS NULL)
    OR (connection_kind='model_access' AND access_gateway IS NOT NULL
        AND access_gateway IN ('opencode_zen','opencode_go','openrouter','openai_chatgpt','claude_subscription')));
ALTER TABLE provider_model_catalog DROP CONSTRAINT provider_model_catalog_access_gateway_check,
  ADD CONSTRAINT provider_model_catalog_access_gateway_check CHECK (
    access_gateway IN ('opencode_zen','opencode_go','openrouter','openai_chatgpt','claude_subscription'));
ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_gateway_of_runtime,
  ADD CONSTRAINT provider_connections_gateway_of_runtime CHECK (
    (provider<>'codex' OR access_gateway='openai_chatgpt')
    AND (provider<>'opencode' OR access_gateway IN ('opencode_zen','opencode_go','openrouter'))
    AND (provider<>'claude' OR access_gateway='claude_subscription'));
ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_claude_shape CHECK (
  provider<>'claude' OR (auth_method='native' AND billing_boundary='subscription'
                         AND native_credential_reference='claude-home:claude-worker'));
ALTER TABLE provider_model_catalog DROP CONSTRAINT provider_model_catalog_discovery_source_check,
  ADD CONSTRAINT provider_model_catalog_discovery_source_check CHECK (
    discovery_source IN ('codex_model_list','opencode_provider_api','claude_aliases','manual'));

-- The mirror of the registry's roles and the driver's capabilities (0074).
INSERT INTO runtime_roles(runtime_type, role) VALUES ('claude','orchestrator');
INSERT INTO runtime_capabilities(runtime_type, capability)
SELECT 'claude', c FROM unnest(ARRAY['sessions.create','sessions.resume','run.read_only','stream.structured',
  'interrupt','tools.platform','events.raw','usage.report','gate.smoke']) c;

-- A Claude model's vendor is Anthropic, whatever alias names it.
CREATE OR REPLACE FUNCTION catalog_model_vendor(p_gateway text, p_runtime text, p_model_id text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_gateway='openrouter' AND position('/' in p_model_id)>1 THEN left(split_part(p_model_id,'/',1),64)
    WHEN p_runtime='codex' THEN 'openai'
    WHEN p_runtime='claude' THEN 'anthropic'
    ELSE '' END;
$function$;

-- The validators, each with the third name and nothing else changed.

CREATE OR REPLACE FUNCTION append_runtime_activity_event(p_job_id bigint, p_worker_id text, p_runtime_type text, p_event_type text, p_phase text, p_summary text, p_details jsonb DEFAULT '{}'::jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE; v_id bigint; v_sequence integer;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'in_flight' OR v_job.leased_by<>p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'runtime activity job is not actively leased' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','runtime_activity_not_leased')::text;
  END IF;
  IF p_runtime_type NOT IN ('codex','opencode','claude','antigravity') OR p_event_type !~ '^runtime[.][a-z0-9_.-]+$'
     OR length(trim(p_summary))<1 OR jsonb_typeof(p_details)<>'object' OR octet_length(p_details::text)>8192 THEN
    RAISE EXCEPTION 'invalid normalized runtime activity event' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','runtime_activity_invalid')::text;
  END IF;
  SELECT COALESCE(max(sequence),0)+1 INTO v_sequence FROM runtime_activity_events WHERE job_id=p_job_id;
  INSERT INTO runtime_activity_events(job_id,project_id,task_id,run_id,sequence,runtime_type,event_type,phase,summary,details)
  VALUES(v_job.id,v_job.project_id,v_job.task_id,v_job.run_id,v_sequence,p_runtime_type,p_event_type,
    left(p_phase,80),left(trim(p_summary),500),p_details) RETURNING id INTO v_id;
  RETURN v_id;
END; $function$;

CREATE OR REPLACE FUNCTION ensure_structural_runtime_profile(p_operator_id uuid, p_runtime_type text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_version text;
BEGIN
  IF p_runtime_type NOT IN ('codex','opencode','claude','antigravity') THEN
    RAISE EXCEPTION 'unknown runtime type %', p_runtime_type USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','runtime_type_unknown')::text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id=p_operator_id AND u.role='owner' AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'not an enabled operator' USING ERRCODE='42501', DETAIL=jsonb_build_object('reason','operator_unavailable')::text;
  END IF;

  SELECT rp.id INTO v_id FROM runtime_profiles rp
  WHERE rp.runtime_type=p_runtime_type AND rp.enabled AND rp.last_verified_at IS NOT NULL
  ORDER BY rp.last_verified_at DESC, rp.created_at, rp.id
  LIMIT 1;
  IF FOUND THEN RETURN v_id; END IF;

  -- The version the host reports for this runtime, so the row describes the
  -- installation rather than a guess. A host that has not reported says so.
  SELECT r.version INTO v_version
  FROM runtime_health h,
       LATERAL jsonb_to_recordset(h.snapshot->'runtimes') AS r(runtime text, version text)
  WHERE h.singleton=true AND r.runtime=p_runtime_type;

  INSERT INTO runtime_profiles(runtime_type, adapter_version, runtime_version,
                               provider_type, model, last_verified_at, enabled)
  VALUES (p_runtime_type, 'catalog', COALESCE(v_version,'unreported'),
          'catalog', 'selected per task', clock_timestamp(), true)
  RETURNING id INTO v_id;
  RETURN v_id;
END $function$;

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
  IF v_connection.provider NOT IN ('codex','opencode','claude') THEN
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
  -- OpenCode Free is Zen, whoever writes it without naming it.
  IF NEW.provider='opencode' AND NEW.access_gateway IS NULL AND NEW.billing_boundary='free' THEN
    NEW.access_gateway := 'opencode_zen';
  END IF;
  RETURN NEW;
END $function$;

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
       OR COALESCE(v_entry->>'runtime_type','') NOT IN ('codex','opencode','claude','antigravity')
       OR COALESCE(v_entry->>'discovery_source','') NOT IN ('codex_model_list','opencode_provider_api','claude_aliases')
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

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('claude_not_signed_in','conflict','the host does not report Claude Code signed in; run `infra-cod runtime login claude` on the host, then connect');

-- The Settings card's read: the connection, and what the host reports of the
-- runtime, so the card can say which step is missing.
CREATE FUNCTION get_operator_claude_connection(p_operator_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object(
    'connection',(SELECT jsonb_build_object('connection_id',c.id,'status',c.status,
        'last_verified_at',c.last_verified_at,'created_at',c.created_at,'updated_at',c.updated_at)
      FROM provider_connections c WHERE c.operator_id=p_operator_id AND c.provider='claude'
      ORDER BY c.created_at DESC LIMIT 1),
    'runtime',runtime_health_reading('claude'));
$$;

-- Registers, or re-registers, the operator's Claude subscription as a model
-- access connection, and asks for its catalog. Refused unless the host reports
-- the runtime installed and signed in now: the panel does not hold the login,
-- the host does.
CREATE FUNCTION connect_claude_connection(p_operator_id uuid, p_actor text, p_correlation_id text)
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
  v_health:=runtime_health_reading('claude');
  IF (v_health->>'known')::boolean IS NOT TRUE THEN
    PERFORM refuse('runtime_readiness_unknown', 'the host has not reported Claude Code recently');
  END IF;
  IF (v_health->>'installed')::boolean IS NOT TRUE THEN
    PERFORM refuse('runtime_not_provisioned', 'Claude Code is not installed on the host: infra-cod runtime install claude --version <exact>');
  END IF;
  IF (v_health->>'authenticated')::boolean IS NOT TRUE THEN
    PERFORM refuse('claude_not_signed_in', 'Claude Code is not signed in on the host: infra-cod runtime login claude');
  END IF;
  SELECT * INTO v_connection FROM provider_connections
  WHERE operator_id=p_operator_id AND access_gateway='claude_subscription' FOR UPDATE;
  IF FOUND THEN
    UPDATE provider_connections SET status='connected',broker_requested_action='',last_verified_at=clock_timestamp(),
      last_failure_code='',last_failure_message='',verified_via='broker',version=version+1,updated_at=clock_timestamp()
    WHERE id=v_connection.id RETURNING * INTO v_connection;
  ELSE
    INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,
      billing_boundary,native_credential_reference,account_label,last_verified_at)
    VALUES(p_operator_id,'claude','native','connected','claude_subscription',
      'subscription','claude-home:claude-worker','Claude subscription',clock_timestamp())
    RETURNING * INTO v_connection;
  END IF;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_actor,'provider_connection.connected','provider_connection',
    v_connection.id::text,'allowed',NULL,jsonb_build_object('provider','claude','runtime_version',v_health->>'version'),p_correlation_id);
  v_refresh:=request_catalog_refresh(v_connection.id, p_operator_id, 'connected');
  RETURN jsonb_build_object('connection_id',v_connection.id,'status',v_connection.status,'refresh',v_refresh);
END $$;

-- The connection off: dispatch then reads every model of it as revoked
-- (connection_revoked, 0084), and the card offers to connect again. The login
-- on the host stays; signing out there is the host's (`claude auth logout` as
-- the runtime user).
CREATE FUNCTION disconnect_claude_connection(p_operator_id uuid, p_connection_id uuid, p_actor text, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_connection provider_connections%ROWTYPE;
BEGIN
  SELECT * INTO v_connection FROM provider_connections
  WHERE id=p_connection_id AND operator_id=p_operator_id AND provider='claude' FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('provider_connection_unavailable', format('no Claude connection %s of this operator', p_connection_id));
  END IF;
  UPDATE provider_connections SET status='disconnected',version=version+1,updated_at=clock_timestamp()
  WHERE id=v_connection.id RETURNING * INTO v_connection;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_actor,'provider_connection.disconnected','provider_connection',
    v_connection.id::text,'allowed',NULL,jsonb_build_object('provider','claude'),p_correlation_id);
  RETURN jsonb_build_object('connection_id',v_connection.id,'status',v_connection.status);
END $$;

REVOKE EXECUTE ON FUNCTION get_operator_claude_connection(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION connect_claude_connection(uuid,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION disconnect_claude_connection(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_operator_claude_connection(uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION connect_claude_connection(uuid,text,text) TO infra_web;
GRANT EXECUTE ON FUNCTION disconnect_claude_connection(uuid,uuid,text,text) TO infra_web;
