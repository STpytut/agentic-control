-- The models Claude's subscription names (after Codex 0.159.3).
--
-- Claude Code has no model list, so Claude's catalog was its three aliases
-- (0091). Opus 5.5 was out while `opus` in Claude Code 2.1.286 still meant
-- Opus 5, and the catalog had no way to say so. The supervisor now reads
-- Anthropic's model list with the subscription's login, as claude-worker
-- (claude-models.mjs), and the refresh offers the newest model of each family
-- beside the aliases. This admits that source; upsert_catalog_entries is 0118's
-- with the one word added.

SET search_path TO control_plane, public, extensions;

ALTER TABLE provider_model_catalog DROP CONSTRAINT provider_model_catalog_discovery_source_check,
  ADD CONSTRAINT provider_model_catalog_discovery_source_check CHECK (
    discovery_source IN ('codex_model_list','opencode_provider_api','claude_aliases','anthropic_models','manual'));

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
       OR COALESCE(v_entry->>'discovery_source','') NOT IN ('codex_model_list','opencode_provider_api','claude_aliases','anthropic_models')
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
