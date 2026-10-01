-- A model's catalog row is the model, not the model at one runtime version
-- (Stage 12 W5-a, the expand step; docs/RUNTIMES_AND_MODELS_DESIGN.md §2.1, §5.1,
-- decision R1).
--
-- Since 0027 a row's identity was (connection, provider, model, adapter
-- version, runtime version): a refresh under a new runtime version inserted a
-- new row and marked the old one stale, and project defaults — which point at
-- row ids — were left on the stale row until someone verified and picked again
-- (0094 exists because the read had to survive that). Now the identity is
-- (connection, provider, model). The two versions stay on the row as "last seen
-- at", and which runtime versions list the model is its own fact, in
-- model_listings, one row per version with when it was first and last seen.
--
-- The rows already duplicated by version are collapsed into one per model:
-- the row project defaults point at, else the most recently verified, else the
-- newest. That row takes the state of the row the last refresh wrote (the
-- current one), so what is selectable now stays selectable; defaults and
-- verification receipts are repointed to it. The others are kept — audit and
-- receipts name them — as 'unavailable' with superseded_by naming the row that
-- replaced them, and are never deleted. The unique index on the new identity is
-- created last, after the collapse, and ignores superseded rows.
--
-- Also here, as columns the next packages fill: pinned_at (every model the
-- operator ever asked to verify through catalog_gate_allowlist was a statement
-- of intent, so each becomes a pin; the table itself stays until W5-b) and
-- resolved_model (what a Claude alias resolved to at its last passed check).
-- Checks per runtime version (model_checks), and with them last_check_id, are
-- W6; until then `status` means what it meant, and every reader of it is
-- unchanged. Nothing is marked stale any more: a verified model seen at a new
-- runtime version stays verified until W6 ties checks to the version — which is
-- what Codex and Claude rows, whose versions were never recorded, already did.
--
-- A dry run on a host is this file inside BEGIN … ROLLBACK: the NOTICE says what
-- the collapse would do.

SET search_path TO control_plane, public, extensions;

ALTER TABLE provider_model_catalog
  ADD COLUMN superseded_by uuid REFERENCES provider_model_catalog(id),
  ADD COLUMN pinned_at timestamptz,
  ADD COLUMN resolved_model text NOT NULL DEFAULT '' CHECK (length(resolved_model) <= 200),
  -- A superseded row is history: never selectable, never gated, never itself.
  ADD CONSTRAINT provider_model_catalog_superseded_check
    CHECK (superseded_by IS NULL OR (status = 'unavailable' AND superseded_by <> id));

-- Which runtime versions list a model. An empty version is one nobody
-- recorded: Codex and Claude rows written before this migration carry none, and
-- guessing which version listed them would be worse than saying so (a model
-- listed only by a version since rolled back would look listed by the active
-- one). Their next refresh records the version it read.
CREATE TABLE model_listings (
  entry_id uuid NOT NULL REFERENCES provider_model_catalog(id) ON DELETE CASCADE,
  runtime_type text NOT NULL CHECK (runtime_type IN ('codex','opencode','claude','antigravity')),
  runtime_version text NOT NULL CHECK (length(runtime_version) <= 64),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (entry_id, runtime_version),
  CHECK (last_seen_at >= first_seen_at)
);
CREATE INDEX model_listings_by_version ON model_listings(runtime_type, runtime_version);

REVOKE ALL ON model_listings FROM PUBLIC;
-- Written by upsert_catalog_entries, which the refresh worker calls as itself.
GRANT SELECT, INSERT, UPDATE ON model_listings TO infra_worker;

-- The runtime version a refresh read its list at. The worker says so for
-- OpenCode (its server reports it); Codex and Claude entries arrive without
-- one, and the list was read from the active runtime, so the version is what
-- the host last reported running — the supervisor's health reading, else the
-- daily watch's. Empty when neither knows.
CREATE FUNCTION catalog_listing_version(p_runtime text, p_reported text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_version text;
BEGIN
  IF COALESCE(p_reported,'') <> '' THEN RETURN left(p_reported, 64); END IF;
  v_version := runtime_health_reading(p_runtime)->>'version';
  IF COALESCE(v_version,'') = '' THEN
    SELECT w.active_version INTO v_version FROM runtime_watch_state w WHERE w.runtime_type = p_runtime;
  END IF;
  RETURN left(COALESCE(v_version,''), 64);
END $$;

REVOKE EXECUTE ON FUNCTION catalog_listing_version(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog_listing_version(text, text) TO infra_worker;

-- The collapse, the listings, the pins and the resolved aliases, from whatever
-- rows exist. Kept as a function so the DB test can run it over legacy-shaped
-- rows; running it again over collapsed rows changes nothing. Dropped in W5-b.
CREATE FUNCTION backfill_catalog_identity()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_groups integer; v_superseded integer; v_receipts integer; v_orchestrators integer;
  v_executors integer; v_merged integer; v_listings integer; v_pins integer; v_resolved integer;
BEGIN
  DROP TABLE IF EXISTS pg_temp.catalog_identity_plan;
  -- One row per member of a group of live rows sharing the new identity:
  -- which row keeps the identity, and which row's state is the current one.
  CREATE TEMP TABLE catalog_identity_plan ON COMMIT DROP AS
  WITH live AS (
    SELECT m.*,
      count(*) OVER same_model AS group_size,
      min(m.discovered_at) OVER same_model AS group_discovered_at,
      (EXISTS (SELECT 1 FROM project_runtime_defaults d WHERE d.orchestrator_entry_id = m.id)
        OR EXISTS (SELECT 1 FROM project_runtime_default_executors e WHERE e.catalog_entry_id = m.id)) AS in_defaults
    FROM provider_model_catalog m
    WHERE m.superseded_by IS NULL
    WINDOW same_model AS (PARTITION BY m.connection_id, m.provider_id, m.model_id)
  )
  SELECT l.id AS entry_id,
    first_value(l.id) OVER (PARTITION BY l.connection_id, l.provider_id, l.model_id
      ORDER BY l.in_defaults DESC, l.last_verified_at DESC NULLS LAST, l.created_at DESC, l.id DESC) AS keeper_id,
    -- The row the last refresh wrote. A refresh under a new version inserted a
    -- row and staled the old one without touching its last_seen_at, so the
    -- latest sighting is the state that holds now.
    first_value(l.id) OVER (PARTITION BY l.connection_id, l.provider_id, l.model_id
      ORDER BY l.last_seen_at DESC,
        CASE l.status WHEN 'verified' THEN 0 WHEN 'verifying' THEN 1 WHEN 'discovered' THEN 2
          WHEN 'rejected' THEN 3 WHEN 'stale' THEN 4 ELSE 5 END,
        l.updated_at DESC, l.id DESC) AS current_id,
    l.group_discovered_at
  FROM live l
  WHERE l.group_size > 1;
  SELECT count(DISTINCT keeper_id), count(*) FILTER (WHERE entry_id <> keeper_id)
    INTO v_groups, v_superseded FROM pg_temp.catalog_identity_plan;

  -- Every version a live row was seen at becomes a listing of the row that
  -- keeps the identity.
  INSERT INTO model_listings(entry_id, runtime_type, runtime_version, first_seen_at, last_seen_at)
  SELECT COALESCE(p.keeper_id, m.id), m.runtime_type, m.runtime_version,
    min(m.discovered_at), max(GREATEST(m.last_seen_at, m.discovered_at))
  FROM provider_model_catalog m
  LEFT JOIN pg_temp.catalog_identity_plan p ON p.entry_id = m.id
  WHERE m.superseded_by IS NULL
  GROUP BY 1, 2, 3
  ON CONFLICT (entry_id, runtime_version) DO UPDATE SET
    first_seen_at = LEAST(model_listings.first_seen_at, EXCLUDED.first_seen_at),
    last_seen_at = GREATEST(model_listings.last_seen_at, EXCLUDED.last_seen_at);
  GET DIAGNOSTICS v_listings = ROW_COUNT;

  UPDATE model_verification_receipts r SET catalog_entry_id = p.keeper_id
  FROM pg_temp.catalog_identity_plan p
  WHERE r.catalog_entry_id = p.entry_id AND p.entry_id <> p.keeper_id;
  GET DIAGNOSTICS v_receipts = ROW_COUNT;

  -- Repointing is not a change of the operator's choice — the same model on the
  -- same connection — so the defaults' version is not bumped.
  UPDATE project_runtime_defaults d SET orchestrator_entry_id = p.keeper_id
  FROM pg_temp.catalog_identity_plan p
  WHERE d.orchestrator_entry_id = p.entry_id AND p.entry_id <> p.keeper_id;
  GET DIAGNOSTICS v_orchestrators = ROW_COUNT;

  -- A project that named two rows of one model as executors names it once,
  -- at the better of the two priorities.
  WITH mapped AS (
    SELECT e.project_id, e.catalog_entry_id AS old_id,
      row_number() OVER (PARTITION BY e.project_id, COALESCE(p.keeper_id, e.catalog_entry_id)
        ORDER BY e.priority, (e.catalog_entry_id = COALESCE(p.keeper_id, e.catalog_entry_id)) DESC,
          e.catalog_entry_id) AS rn
    FROM project_runtime_default_executors e
    LEFT JOIN pg_temp.catalog_identity_plan p ON p.entry_id = e.catalog_entry_id
  )
  DELETE FROM project_runtime_default_executors x USING mapped m
  WHERE x.project_id = m.project_id AND x.catalog_entry_id = m.old_id AND m.rn > 1;
  GET DIAGNOSTICS v_merged = ROW_COUNT;
  UPDATE project_runtime_default_executors e SET catalog_entry_id = p.keeper_id
  FROM pg_temp.catalog_identity_plan p
  WHERE e.catalog_entry_id = p.entry_id AND p.entry_id <> p.keeper_id;
  GET DIAGNOSTICS v_executors = ROW_COUNT;

  -- The kept row takes the current row's state. A gate in flight on another
  -- row cannot complete on this one (its lease names the other row), so it is
  -- asked for again instead.
  UPDATE provider_model_catalog k SET
    status = CASE WHEN c.status = 'verifying' THEN 'discovered' ELSE c.status END,
    failure_code = c.failure_code, failure_message = c.failure_message,
    last_verified_at = c.last_verified_at, stale_at = c.stale_at,
    verification_id = CASE WHEN c.status = 'verifying' THEN NULL ELSE c.verification_id END,
    verified_lease_until = CASE WHEN c.status = 'verifying' THEN NULL ELSE c.verified_lease_until END,
    gate_requested_at = CASE WHEN c.status = 'verifying' THEN clock_timestamp()
      WHEN c.status IN ('discovered','verified','rejected') THEN c.gate_requested_at END,
    adapter_version = c.adapter_version, runtime_version = c.runtime_version,
    display_name = c.display_name, provider_badge = c.provider_badge, plan_badge = c.plan_badge,
    billing_boundary = c.billing_boundary, model_vendor = c.model_vendor,
    reasoning_efforts = c.reasoning_efforts, service_tiers = c.service_tiers,
    capabilities = c.capabilities, discovery_source = c.discovery_source,
    discovered_at = p.group_discovered_at, last_seen_at = c.last_seen_at,
    updated_at = clock_timestamp(), version = k.version + 1
  FROM pg_temp.catalog_identity_plan p
  JOIN provider_model_catalog c ON c.id = p.current_id
  WHERE k.id = p.entry_id AND p.entry_id = p.keeper_id AND p.keeper_id <> p.current_id;

  UPDATE provider_model_catalog m SET
    status = 'unavailable', superseded_by = p.keeper_id,
    verification_id = NULL, verified_lease_until = NULL, gate_requested_at = NULL,
    stale_at = COALESCE(m.stale_at, clock_timestamp()),
    updated_at = clock_timestamp(), version = m.version + 1
  FROM pg_temp.catalog_identity_plan p
  WHERE m.id = p.entry_id AND p.entry_id <> p.keeper_id;

  UPDATE provider_model_catalog m SET pinned_at = a.first_asked_at
  FROM (SELECT operator_id, connection_id, provider_id, model_id, min(created_at) AS first_asked_at
        FROM catalog_gate_allowlist GROUP BY 1, 2, 3, 4) a
  WHERE m.superseded_by IS NULL AND m.pinned_at IS NULL
    AND a.operator_id = m.operator_id AND a.connection_id = m.connection_id
    AND a.provider_id = m.provider_id AND a.model_id = m.model_id;
  GET DIAGNOSTICS v_pins = ROW_COUNT;

  UPDATE provider_model_catalog m SET resolved_model = r.resolved
  FROM (SELECT DISTINCT ON (r.catalog_entry_id) r.catalog_entry_id, left(c->>'detail', 200) AS resolved
        FROM model_verification_receipts r, jsonb_array_elements(r.smoke_checks) c
        WHERE r.result = 'passed' AND c->>'name' = 'resolved_model' AND c->>'ok' = 'true'
          AND COALESCE(c->>'detail','') <> ''
        ORDER BY r.catalog_entry_id, r.verified_at DESC) r
  WHERE m.id = r.catalog_entry_id AND m.superseded_by IS NULL AND m.resolved_model <> r.resolved;
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  RETURN jsonb_build_object('groups', v_groups, 'superseded', v_superseded,
    'receipts_repointed', v_receipts, 'orchestrator_defaults_repointed', v_orchestrators,
    'executor_defaults_repointed', v_executors, 'executor_defaults_merged', v_merged,
    'listings', v_listings, 'pins', v_pins, 'resolved_models', v_resolved);
END $$;

REVOKE EXECUTE ON FUNCTION backfill_catalog_identity() FROM PUBLIC;

-- The old identity goes first (the kept row takes the current row's versions,
-- which the superseded row still carries), the new one last.
DROP INDEX provider_model_catalog_identity_boundary;
DO $$ BEGIN RAISE NOTICE 'catalog identity backfill: %', backfill_catalog_identity(); END $$;
CREATE UNIQUE INDEX provider_model_catalog_identity
  ON provider_model_catalog(connection_id, provider_id, model_id)
  WHERE superseded_by IS NULL;

-- Until W6 replaces the allowlist with pins and the gate with checks, the two
-- new columns follow the old writers, so nothing asked for or learned between
-- this release and the next is missing from them.
CREATE FUNCTION pin_catalog_entry_on_allowlist()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  UPDATE provider_model_catalog SET pinned_at = NEW.created_at
  WHERE operator_id = NEW.operator_id AND connection_id = NEW.connection_id
    AND provider_id = NEW.provider_id AND model_id = NEW.model_id
    AND superseded_by IS NULL AND pinned_at IS NULL;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION pin_catalog_entry_on_allowlist() FROM PUBLIC;
CREATE TRIGGER catalog_gate_allowlist_pins
  AFTER INSERT ON catalog_gate_allowlist
  FOR EACH ROW EXECUTE FUNCTION pin_catalog_entry_on_allowlist();

CREATE FUNCTION record_resolved_model_from_receipt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_resolved text;
BEGIN
  SELECT left(c->>'detail', 200) INTO v_resolved
  FROM jsonb_array_elements(NEW.smoke_checks) c
  WHERE c->>'name' = 'resolved_model' AND c->>'ok' = 'true' AND COALESCE(c->>'detail','') <> ''
  LIMIT 1;
  IF v_resolved IS NOT NULL THEN
    UPDATE provider_model_catalog SET resolved_model = v_resolved
    WHERE id = NEW.catalog_entry_id AND resolved_model <> v_resolved;
  END IF;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION record_resolved_model_from_receipt() FROM PUBLIC;
CREATE TRIGGER model_verification_receipts_resolved_model
  AFTER INSERT ON model_verification_receipts
  FOR EACH ROW WHEN (NEW.result = 'passed')
  EXECUTE FUNCTION record_resolved_model_from_receipt();

-- 0091's function, same signature and result keys: the row is found by the
-- new identity and carries the version it was last seen at; the version read
-- is recorded as a listing; nothing is marked stale ('stale_marked' stays in the
-- result, always 0, for the callers that read it).
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

-- 0083's reads, same signatures and keys: a superseded row is history, not a
-- model of the connection, so neither the Settings list nor its counts show it.
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
  WHERE m.operator_id=p_operator_id AND m.superseded_by IS NULL;
$function$;

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
      SELECT count(*) FROM provider_model_catalog m
      WHERE m.connection_id=c.id AND m.superseded_by IS NULL
    ),
    'verified_entries',(
      SELECT count(*) FROM provider_model_catalog m
      WHERE m.connection_id=c.id AND m.status='verified'
    )
  ) ORDER BY c.provider,c.billing_boundary),'[]'::jsonb)
  FROM provider_connections c
  WHERE c.operator_id=p_operator_id;
$function$;
