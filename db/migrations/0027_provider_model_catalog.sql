BEGIN;

SET search_path TO control_plane, public, extensions;

-- Dynamic provider model catalog (7.1D.1).
--
-- Model availability is a refreshed cache derived from live provider
-- responses, never a hardcoded list. Discovery stores only normalized,
-- bounded metadata: canonical provider/model ids, display metadata, badges,
-- reasoning efforts, service tiers, runtime capabilities and adapter/runtime
-- versions. Raw provider responses are never persisted (all columns are
-- bounded by CHECK constraints; capabilities are capped by jsonb size).
--
-- Rows are owner-scoped through their provider connection. A row's identity
-- boundary is (connection, provider_id, model_id, adapter_version,
-- runtime_version): adapter/runtime version drift creates a new row and
-- downgrades the previous verification to 'stale' instead of rewriting it.
--
-- Statuses: discovered (seen live, not gated), verifying (capability gate in
-- progress), verified (gate passed; the only selectable status), rejected
-- (gate failed with bounded failure metadata), stale (version drift /
-- refresh superseded), unavailable (connection revoked/disconnected or the
-- provider no longer lists the model).
--
-- Refresh work is claimed through catalog_refresh_jobs (one active job per
-- connection, FOR UPDATE SKIP LOCKED, lease + idempotent completion). The
-- capability gate claims individual entries through
-- claim_catalog_verifications and records append-only verification receipts
-- in model_verification_receipts.

CREATE TABLE provider_model_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES users(id),
  connection_id uuid NOT NULL REFERENCES provider_connections(id),
  billing_boundary text NOT NULL DEFAULT ''
    CHECK (billing_boundary IN ('','free','go','external_api','chatgpt_subscription')),
  runtime_type text NOT NULL
    CHECK (runtime_type IN ('codex','opencode','antigravity')),
  provider_id text NOT NULL CHECK (provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  model_id text NOT NULL CHECK (model_id ~ '^[A-Za-z0-9][A-Za-z0-9._/: -]{0,199}$'),
  display_name text NOT NULL DEFAULT '' CHECK (length(display_name) <= 200),
  provider_badge text NOT NULL DEFAULT '' CHECK (length(provider_badge) <= 64),
  plan_badge text NOT NULL DEFAULT '' CHECK (length(plan_badge) <= 64),
  reasoning_efforts jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(reasoning_efforts) = 'array' AND jsonb_array_length(reasoning_efforts) <= 16),
  service_tiers jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(service_tiers) = 'array' AND jsonb_array_length(service_tiers) <= 16),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(capabilities) = 'object' AND length(capabilities::text) <= 4096),
  adapter_version text NOT NULL DEFAULT '' CHECK (length(adapter_version) <= 64),
  runtime_version text NOT NULL DEFAULT '' CHECK (length(runtime_version) <= 64),
  discovery_source text NOT NULL
    CHECK (discovery_source IN ('codex_model_list','opencode_provider_api','manual')),
  status text NOT NULL DEFAULT 'discovered'
    CHECK (status IN ('discovered','verifying','verified','rejected','stale','unavailable')),
  failure_code text NOT NULL DEFAULT '' CHECK (length(failure_code) <= 80),
  failure_message text NOT NULL DEFAULT '' CHECK (length(failure_message) <= 500),
  discovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_verified_at timestamptz,
  stale_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  verified_lease_until timestamptz,
  verification_id uuid,
  gate_requested_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (failure_message = left(failure_message, 500)),
  CHECK (status <> 'verified' OR (last_verified_at IS NOT NULL AND verification_id IS NOT NULL)),
  CHECK (status <> 'rejected' OR failure_code <> ''),
  CHECK (verified_lease_until IS NULL OR status IN ('verifying','verified')),
  CHECK (verification_id IS NULL OR status IN ('verifying','verified')),
  CHECK (gate_requested_at IS NULL OR status IN ('discovered','verified','rejected'))
);

CREATE UNIQUE INDEX provider_model_catalog_identity_boundary
  ON provider_model_catalog(connection_id, provider_id, model_id, adapter_version, runtime_version);

CREATE INDEX provider_model_catalog_operator_status
  ON provider_model_catalog(operator_id, status, updated_at);

CREATE INDEX provider_model_catalog_verification_work
  ON provider_model_catalog(status, verified_lease_until)
  WHERE status = 'verifying';

CREATE TABLE catalog_refresh_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES users(id),
  connection_id uuid NOT NULL REFERENCES provider_connections(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','failed')),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 200),
  failure_code text NOT NULL DEFAULT '' CHECK (length(failure_code) <= 80),
  failure_message text NOT NULL DEFAULT '' CHECK (length(failure_message) <= 500),
  leased_by text,
  leased_until timestamptz,
  entries_seen integer NOT NULL DEFAULT 0 CHECK (entries_seen >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK (leased_by IS NULL = (leased_until IS NULL)),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);

CREATE UNIQUE INDEX catalog_refresh_jobs_one_active_per_connection
  ON catalog_refresh_jobs(connection_id)
  WHERE status IN ('pending','in_progress');

CREATE INDEX catalog_refresh_jobs_work
  ON catalog_refresh_jobs(status, leased_until, created_at)
  WHERE status IN ('pending','in_progress');

CREATE TABLE model_verification_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_entry_id uuid NOT NULL REFERENCES provider_model_catalog(id),
  operator_id uuid NOT NULL REFERENCES users(id),
  connection_id uuid NOT NULL REFERENCES provider_connections(id),
  runtime_type text NOT NULL,
  provider_id text NOT NULL CHECK (provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  model_id text NOT NULL CHECK (model_id ~ '^[A-Za-z0-9][A-Za-z0-9._/: -]{0,199}$'),
  adapter_version text NOT NULL DEFAULT '' CHECK (length(adapter_version) <= 64),
  runtime_version text NOT NULL DEFAULT '' CHECK (length(runtime_version) <= 64),
  result text NOT NULL CHECK (result IN ('passed','failed')),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(capabilities) = 'object' AND length(capabilities::text) <= 4096),
  smoke_checks jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(smoke_checks) = 'array' AND jsonb_array_length(smoke_checks) <= 32),
  failure_code text NOT NULL DEFAULT '' CHECK (length(failure_code) <= 80),
  failure_message text NOT NULL DEFAULT '' CHECK (length(failure_message) <= 500),
  verification_id uuid,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX model_verification_receipts_entry
  ON model_verification_receipts(catalog_entry_id, verified_at);

-- Curated gate allowlist: a model becomes eligible for the capability gate
-- only when the operator explicitly requests verification AND the model is on
-- this allowlist. Discovery never auto-initiates a smoke run, so provider
-- limits cannot be consumed silently.
CREATE TABLE catalog_gate_allowlist (
  operator_id uuid NOT NULL REFERENCES users(id),
  connection_id uuid NOT NULL REFERENCES provider_connections(id),
  provider_id text NOT NULL CHECK (provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  model_id text NOT NULL CHECK (model_id ~ '^[A-Za-z0-9][A-Za-z0-9._/: -]{0,199}$'),
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operator_id, connection_id, provider_id, model_id)
);

-- Owner-scoped gate request. Idempotent; sets gate_requested_at so the gate
-- worker may claim the entry. Requires the entry to be in the curated
-- allowlist. Returns the entry status and whether a gate run is now pending.
CREATE OR REPLACE FUNCTION request_catalog_verification(
  p_entry_id uuid, p_operator_id uuid, p_actor text DEFAULT '',
  p_correlation_id text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_entry provider_model_catalog%ROWTYPE; v_allowlisted boolean;
BEGIN
  SELECT * INTO v_entry FROM provider_model_catalog
  WHERE id=p_entry_id AND operator_id=p_operator_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog entry is unavailable' USING ERRCODE='55000'; END IF;
  IF v_entry.status IN ('stale','unavailable') THEN
    RAISE EXCEPTION 'catalog entry is stale or unavailable; refresh discovery first' USING ERRCODE='55000';
  END IF;
  IF v_entry.status IN ('verifying','verified') AND v_entry.gate_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('entry_id',v_entry.id,'status',v_entry.status,
      'pending',false,'reason','already_requested');
  END IF;
  SELECT EXISTS(
    SELECT 1 FROM catalog_gate_allowlist a
    WHERE a.operator_id=v_entry.operator_id AND a.connection_id=v_entry.connection_id
      AND a.provider_id=v_entry.provider_id AND a.model_id=v_entry.model_id
  ) INTO v_allowlisted;
  IF NOT v_allowlisted THEN
    RAISE EXCEPTION 'catalog entry is not on the verified allowlist' USING ERRCODE='55000';
  END IF;
  UPDATE provider_model_catalog SET
    gate_requested_at=clock_timestamp(),
    status=CASE WHEN status='rejected' THEN 'discovered' ELSE status END,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=v_entry.id RETURNING * INTO v_entry;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',COALESCE(NULLIF(p_actor,''),p_operator_id::text),
    'catalog.gate_requested','provider_model_catalog',v_entry.id::text,
    'allowed',NULL,jsonb_build_object(
      'provider_id',v_entry.provider_id,'model_id',v_entry.model_id),
    COALESCE(NULLIF(p_correlation_id,''),v_entry.id::text));
  RETURN jsonb_build_object('entry_id',v_entry.id,'status',v_entry.status,
    'pending',v_entry.status IN ('discovered','rejected'),
    'gate_requested_at',v_entry.gate_requested_at);
END; $$;

-- Bounded per-operator gate concurrency and total-run limits, so a worker
-- restart or repeated requests cannot exhaust provider limits. The check is
-- serialized per operator with a transaction-scoped advisory lock: two
-- parallel claims for the same operator can never both observe the same
-- in-flight count and exceed the limit. The daily budget subtracts both
-- completed receipts and in-flight (verifying) reservations.
CREATE OR REPLACE FUNCTION gate_quota_available(
  p_operator_id uuid, p_concurrency_limit integer DEFAULT 2, p_total_limit integer DEFAULT 20
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_in_flight integer; v_total integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog-gate-quota:' || p_operator_id::text, 0));
  SELECT count(*) INTO v_in_flight FROM provider_model_catalog m
  WHERE m.operator_id=p_operator_id AND m.status='verifying';
  SELECT count(*) INTO v_total FROM model_verification_receipts r
  WHERE r.operator_id=p_operator_id
    AND r.verified_at>clock_timestamp()-interval '24 hours';
  RETURN v_in_flight < GREATEST(p_concurrency_limit,1)
    AND v_in_flight + v_total < GREATEST(p_total_limit,1);
END; $$;

CREATE OR REPLACE FUNCTION mark_catalog_unavailable_on_connection_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('disconnected','expired') AND OLD.status <> NEW.status THEN
    UPDATE provider_model_catalog SET
      status='unavailable', stale_at=clock_timestamp(),
      verification_id=NULL, verified_lease_until=NULL,
      updated_at=clock_timestamp(), version=version+1
    WHERE connection_id=NEW.id AND status IN ('discovered','verifying','verified','stale');
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER provider_connections_catalog_availability
  BEFORE UPDATE OF status ON provider_connections
  FOR EACH ROW EXECUTE FUNCTION mark_catalog_unavailable_on_connection_change();

-- Queue a catalog refresh for an owned connection. Idempotent: an active
-- pending/in_progress job is returned instead of creating a duplicate.
CREATE OR REPLACE FUNCTION request_catalog_refresh(
  p_connection_id uuid, p_operator_id uuid, p_reason text DEFAULT 'manual'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_connection provider_connections%ROWTYPE; v_job catalog_refresh_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_connection FROM provider_connections
  WHERE id=p_connection_id AND operator_id=p_operator_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider connection is unavailable' USING ERRCODE='55000'; END IF;
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
END; $$;

-- Periodic scheduler: queue refresh jobs for connections whose catalog was
-- never refreshed or has not been refreshed within p_max_age, and for
-- connections that carry stale entries. Returns the number of jobs queued.
CREATE OR REPLACE FUNCTION request_catalog_refreshes_due(
  p_max_age interval DEFAULT interval '24 hours'
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_count integer;
BEGIN
  WITH eligible AS (
    SELECT c.id, c.operator_id,
      CASE WHEN EXISTS (
        SELECT 1 FROM provider_model_catalog m
        WHERE m.connection_id=c.id AND m.status='stale'
      ) THEN 'stale_entries' ELSE 'age' END AS reason
    FROM provider_connections c
    WHERE c.status='connected'
      AND NOT EXISTS (
        SELECT 1 FROM provider_model_catalog m
        WHERE m.connection_id=c.id AND m.discovery_source='manual'
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM catalog_refresh_jobs j
          WHERE j.connection_id=c.id AND j.status='completed'
        )
        OR NOT EXISTS (
          SELECT 1 FROM catalog_refresh_jobs j
          WHERE j.connection_id=c.id AND j.status='completed'
            AND j.completed_at > clock_timestamp()-p_max_age
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM catalog_refresh_jobs j
        WHERE j.connection_id=c.id AND j.status IN ('pending','in_progress')
      )
  ), inserted AS (
    INSERT INTO catalog_refresh_jobs(operator_id,connection_id,reason)
    SELECT operator_id,id,
      CASE WHEN reason='stale_entries' THEN 'periodic_stale' ELSE 'periodic_age' END
    FROM eligible
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM inserted;
  RETURN v_count;
END; $$;

CREATE OR REPLACE FUNCTION claim_catalog_refresh_work(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '2 minutes'
) RETURNS jsonb LANGUAGE plpgsql AS $$
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
    'refresh_id',id,'connection_id',connection_id,'operator_id',operator_id,
    'reason',reason,'leased_until',leased_until,
    'provider',(SELECT c.provider FROM provider_connections c WHERE c.id=connection_id),
    'billing_boundary',(SELECT c.billing_boundary FROM provider_connections c WHERE c.id=connection_id),
    'permissions',(SELECT c.permissions FROM provider_connections c WHERE c.id=connection_id)
  )) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

CREATE OR REPLACE FUNCTION upsert_catalog_entries(
  p_refresh_id uuid, p_worker_id text, p_entries jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
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
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog refresh lease is unavailable' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_connection FROM provider_connections WHERE id=v_job.connection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider connection is unavailable' USING ERRCODE='55000'; END IF;
  IF jsonb_typeof(p_entries)<>'array' OR jsonb_array_length(p_entries)>500 THEN
    RAISE EXCEPTION 'catalog entry list is invalid' USING ERRCODE='22023';
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
       OR COALESCE(length(v_entry->>'adapter_version'),0)>64
       OR COALESCE(length(v_entry->>'runtime_version'),0)>64
       OR COALESCE(v_entry->>'billing_boundary','') NOT IN ('','free','go','external_api','chatgpt_subscription')
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
           'capabilities','adapter_version','runtime_version','discovery_source'
         )
       ) THEN
      RAISE EXCEPTION 'catalog entry is not normalized: %', left(v_model_id,80) USING ERRCODE='22023';
    END IF;

    INSERT INTO provider_model_catalog(
      operator_id,connection_id,billing_boundary,runtime_type,provider_id,model_id,
      display_name,provider_badge,plan_badge,reasoning_efforts,service_tiers,
      capabilities,adapter_version,runtime_version,discovery_source,status
    ) VALUES(
      v_connection.operator_id,v_connection.id,
      COALESCE(v_entry->>'billing_boundary',''),
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
END; $$;

CREATE OR REPLACE FUNCTION complete_catalog_refresh(
  p_refresh_id uuid, p_worker_id text, p_seen_entry_ids uuid[],
  p_missing_status text DEFAULT 'unavailable'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job catalog_refresh_jobs%ROWTYPE; v_missing integer;
BEGIN
  IF p_missing_status NOT IN ('stale','unavailable') THEN
    RAISE EXCEPTION 'invalid catalog missing status' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM catalog_refresh_jobs
  WHERE id=p_refresh_id AND status='in_progress'
    AND leased_by=p_worker_id AND leased_until>clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog refresh lease is unavailable' USING ERRCODE='55000'; END IF;

  UPDATE provider_model_catalog SET
    status=p_missing_status, stale_at=clock_timestamp(),
    verification_id=NULL, verified_lease_until=NULL,
    gate_requested_at=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE connection_id=v_job.connection_id
    AND status IN ('discovered','verified','stale')
    AND NOT (id = ANY(COALESCE(p_seen_entry_ids,'{}'::uuid[])));
  GET DIAGNOSTICS v_missing = ROW_COUNT;

  UPDATE catalog_refresh_jobs SET
    status='completed', completed_at=clock_timestamp(),
    leased_by=NULL, leased_until=NULL
  WHERE id=v_job.id;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,
    'catalog.refresh_completed','provider_connection',v_job.connection_id::text,
    'allowed',NULL,jsonb_build_object('entries_seen',v_job.entries_seen,'missing',v_missing),
    v_job.id::text);
  RETURN jsonb_build_object(
    'refresh_id',v_job.id,'status','completed','entries_seen',v_job.entries_seen,
    'missing_marked',v_missing
  );
END; $$;

CREATE OR REPLACE FUNCTION fail_catalog_refresh(
  p_refresh_id uuid, p_worker_id text, p_failure_code text, p_failure_message text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job catalog_refresh_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM catalog_refresh_jobs
  WHERE id=p_refresh_id AND status='in_progress'
    AND leased_by=p_worker_id AND leased_until>clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog refresh lease is unavailable' USING ERRCODE='55000'; END IF;
  UPDATE catalog_refresh_jobs SET
    status='failed', failure_code=left(COALESCE(p_failure_code,'catalog_refresh_failed'),80),
    failure_message=left(COALESCE(regexp_replace(p_failure_message,'[[:cntrl:]]',' ','g'),'Catalog refresh failed.'),500),
    leased_by=NULL, leased_until=NULL
  WHERE id=v_job.id;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,
    'catalog.refresh_failed','provider_connection',v_job.connection_id::text,
    'allowed',NULL,jsonb_build_object('failure_code',p_failure_code),v_job.id::text);
  RETURN jsonb_build_object(
    'refresh_id',v_job.id,'status','failed','failure_code',p_failure_code
  );
END; $$;

-- Capability gate: claim only entries explicitly requested by the owner
-- (gate_requested_at set through request_catalog_verification) that are on the
-- curated allowlist. The claim is atomic and batch-safe: per-operator
-- advisory locks serialize concurrent claims, and every operator's entries
-- are ranked and capped to its remaining concurrency/daily slots, so a single
-- call with a large p_limit can never exceed the quota.
CREATE OR REPLACE FUNCTION claim_catalog_verifications(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '10 minutes'
) RETURNS jsonb LANGUAGE plpgsql AS $$
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
    'entry_id',id,'connection_id',connection_id,'operator_id',operator_id,
    'runtime_type',runtime_type,'provider_id',provider_id,'model_id',model_id,
    'billing_boundary',billing_boundary,'reasoning_efforts',reasoning_efforts,
    'service_tiers',service_tiers,'adapter_version',adapter_version,
    'runtime_version',runtime_version,'verification_id',verification_id
  )) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

CREATE OR REPLACE FUNCTION complete_catalog_verification(
  p_entry_id uuid, p_worker_id text, p_capabilities jsonb, p_smoke_checks jsonb,
  p_verification_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_entry provider_model_catalog%ROWTYPE; v_receipt uuid;
BEGIN
  SELECT * INTO v_entry FROM provider_model_catalog
  WHERE id=p_entry_id AND status='verifying'
    AND verified_lease_until>clock_timestamp() AND verification_id=p_verification_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog verification lease is unavailable' USING ERRCODE='55000'; END IF;
  IF jsonb_typeof(COALESCE(p_capabilities,'{}'::jsonb))<>'object'
     OR length(COALESCE(p_capabilities,'{}'::jsonb)::text)>4096
     OR jsonb_typeof(COALESCE(p_smoke_checks,'[]'::jsonb))<>'array'
     OR jsonb_array_length(COALESCE(p_smoke_checks,'[]'::jsonb))>32 THEN
    RAISE EXCEPTION 'verification receipt is invalid' USING ERRCODE='22023';
  END IF;
  INSERT INTO model_verification_receipts(
    catalog_entry_id,operator_id,connection_id,runtime_type,provider_id,model_id,
    adapter_version,runtime_version,result,capabilities,smoke_checks,verification_id
  ) VALUES(
    v_entry.id,v_entry.operator_id,v_entry.connection_id,v_entry.runtime_type,
    v_entry.provider_id,v_entry.model_id,v_entry.adapter_version,v_entry.runtime_version,
    'passed',COALESCE(p_capabilities,'{}'::jsonb),COALESCE(p_smoke_checks,'[]'::jsonb),
    v_entry.verification_id
  ) RETURNING id INTO v_receipt;
  UPDATE provider_model_catalog SET
    status='verified', last_verified_at=clock_timestamp(),
    capabilities=COALESCE(p_capabilities,capabilities),
    verified_lease_until=NULL,
    failure_code='', failure_message='',
    updated_at=clock_timestamp(), version=version+1
  WHERE id=v_entry.id;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,
    'catalog.entry_verified','provider_model_catalog',v_entry.id::text,
    'allowed',NULL,jsonb_build_object(
      'provider_id',v_entry.provider_id,'model_id',v_entry.model_id,
      'receipt_id',v_receipt
    ),v_receipt::text);
  RETURN jsonb_build_object(
    'entry_id',v_entry.id,'status','verified',
    'receipt_id',v_receipt,'last_verified_at',clock_timestamp()
  );
END; $$;

CREATE OR REPLACE FUNCTION fail_catalog_verification(
  p_entry_id uuid, p_worker_id text, p_failure_code text, p_failure_message text,
  p_verification_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_entry provider_model_catalog%ROWTYPE; v_receipt uuid;
BEGIN
  SELECT * INTO v_entry FROM provider_model_catalog
  WHERE id=p_entry_id AND status='verifying'
    AND verified_lease_until>clock_timestamp() AND verification_id=p_verification_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog verification lease is unavailable' USING ERRCODE='55000'; END IF;
  INSERT INTO model_verification_receipts(
    catalog_entry_id,operator_id,connection_id,runtime_type,provider_id,model_id,
    adapter_version,runtime_version,result,capabilities,smoke_checks,
    failure_code,failure_message
  ) VALUES(
    v_entry.id,v_entry.operator_id,v_entry.connection_id,v_entry.runtime_type,
    v_entry.provider_id,v_entry.model_id,v_entry.adapter_version,v_entry.runtime_version,
    'failed','{}'::jsonb,'[]'::jsonb,
    left(COALESCE(p_failure_code,'catalog_verification_failed'),80),
    left(COALESCE(regexp_replace(p_failure_message,'[[:cntrl:]]',' ','g'),'Capability verification failed.'),500)
  ) RETURNING id INTO v_receipt;
  UPDATE provider_model_catalog SET
    status='rejected', verified_lease_until=NULL, verification_id=NULL,
    failure_code=left(COALESCE(p_failure_code,'catalog_verification_failed'),80),
    failure_message=left(COALESCE(regexp_replace(p_failure_message,'[[:cntrl:]]',' ','g'),'Capability verification failed.'),500),
    updated_at=clock_timestamp(), version=version+1
  WHERE id=v_entry.id;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,
    'catalog.entry_rejected','provider_model_catalog',v_entry.id::text,
    'allowed',NULL,jsonb_build_object(
      'provider_id',v_entry.provider_id,'model_id',v_entry.model_id,
      'failure_code',p_failure_code,'receipt_id',v_receipt
    ),v_receipt::text);
  RETURN jsonb_build_object(
    'entry_id',v_entry.id,'status','rejected','receipt_id',v_receipt
  );
END; $$;

-- Safe owner-scoped read model for Settings: full catalog state, no raw
-- provider content, no secrets, no verification internals.
CREATE OR REPLACE FUNCTION get_operator_model_catalog(
  p_operator_id uuid
) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'entry_id',m.id,'connection_id',m.connection_id,
    'runtime_type',m.runtime_type,'provider_id',m.provider_id,'model_id',m.model_id,
    'display_name',m.display_name,'provider_badge',m.provider_badge,
    'plan_badge',m.plan_badge,'billing_boundary',m.billing_boundary,
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
$$;

-- Selector read model: only capability-verified entries, ordered with the
-- newest verification first. Everything else is invisible to selectors.
CREATE OR REPLACE FUNCTION get_operator_model_catalog_verified(
  p_operator_id uuid
) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'entry_id',m.id,'connection_id',m.connection_id,
    'runtime_type',m.runtime_type,'provider_id',m.provider_id,'model_id',m.model_id,
    'display_name',m.display_name,'provider_badge',m.provider_badge,
    'plan_badge',m.plan_badge,'billing_boundary',m.billing_boundary,
    'reasoning_efforts',m.reasoning_efforts,'service_tiers',m.service_tiers,
    'capabilities',m.capabilities,'adapter_version',m.adapter_version,
    'runtime_version',m.runtime_version,'last_verified_at',m.last_verified_at
  ) ORDER BY m.last_verified_at DESC,m.id),'[]'::jsonb)
  FROM provider_model_catalog m
  JOIN provider_connections c ON c.id=m.connection_id
  WHERE m.operator_id=p_operator_id AND m.status='verified' AND c.status='connected';
$$;

CREATE OR REPLACE FUNCTION get_operator_catalog_refresh_status(
  p_operator_id uuid
) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'connection_id',c.id,'provider',c.provider,'billing_boundary',c.billing_boundary,
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
$$;

ALTER FUNCTION request_catalog_refresh(uuid,uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION request_catalog_refreshes_due(interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_catalog_refresh_work(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION upsert_catalog_entries(uuid,text,jsonb)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION complete_catalog_refresh(uuid,text,uuid[],text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION fail_catalog_refresh(uuid,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION request_catalog_verification(uuid,uuid,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION gate_quota_available(uuid,integer,integer)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_catalog_verifications(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION complete_catalog_verification(uuid,text,jsonb,jsonb,uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION fail_catalog_verification(uuid,text,text,text,uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION get_operator_model_catalog(uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION get_operator_model_catalog_verified(uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION get_operator_catalog_refresh_status(uuid)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
