-- A model's catalog row survives a runtime version (migration 0098, Stage 12
-- W5-a): a refresh at the same version changes nothing; a new version adds a
-- listing, not a row; a refresh finds the live row, never a superseded one.
--
-- The collapse of legacy rows duplicated by version (backfill_catalog_identity)
-- ran once on every host and was dropped with the rest of W5-a's one-release
-- surface in W5-b (0106); its test went with it. The rows here are what the
-- collapse left: one live row per model, and a superseded one kept as history.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

CREATE TEMP TABLE w5_fixture(key text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;

CREATE FUNCTION pg_temp.w5_row(p_key text, p_connection uuid, p_runtime text, p_provider text, p_model text,
  p_version text, p_status text, p_created interval, p_seen interval, p_verified interval DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,
      adapter_version,runtime_version,discovery_source,status,last_verified_at,verification_id,
      discovered_at,created_at,last_seen_at)
  SELECT c.operator_id, c.id, p_runtime, p_provider, p_model, p_version, p_version,
    CASE p_runtime WHEN 'codex' THEN 'codex_model_list' WHEN 'claude' THEN 'claude_aliases' ELSE 'opencode_provider_api' END,
    p_status, clock_timestamp()-p_verified,
    CASE WHEN p_status='verified' THEN gen_random_uuid() END,
    clock_timestamp()-p_created, clock_timestamp()-p_created, clock_timestamp()-p_seen
  FROM provider_connections c WHERE c.id=p_connection
  RETURNING id INTO v_id;
  INSERT INTO w5_fixture VALUES (p_key, v_id);
  RETURN v_id;
END $$;

CREATE FUNCTION pg_temp.w5(p_key text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM w5_fixture WHERE key=p_key $$;

DO $$
DECLARE v_owner uuid; v_router uuid; v_codex uuid; v_claude uuid;
BEGIN
  INSERT INTO users(display_name,role) VALUES('Catalog identity owner','owner') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','api_key','connected','openrouter','third_party_metered','opencode-home:opencode-worker')
    RETURNING id INTO v_router;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,native_credential_reference)
    VALUES(v_owner,'codex','device_code','connected','codex-home:codex-worker') RETURNING id INTO v_codex;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,
      native_credential_reference,account_label,last_verified_at)
    VALUES(v_owner,'claude','native','connected','claude_subscription','subscription',
      'claude-home:claude-worker','Claude subscription',clock_timestamp()) RETURNING id INTO v_claude;
  INSERT INTO w5_fixture VALUES ('owner',v_owner),('router',v_router),('codex',v_codex),('claude',v_claude);

  -- one: the live row, and the row an older version wrote, superseded by it.
  PERFORM pg_temp.w5_row('one.new',v_router,'opencode','openrouter','vendor/one','1.18.4','verified','2 days','1 hour','1 day');
  PERFORM pg_temp.w5_row('one.old',v_router,'opencode','openrouter','vendor/one.old','1.18.3','discovered','3 days','2 days');
  UPDATE provider_model_catalog SET model_id='vendor/one', status='unavailable', superseded_by=pg_temp.w5('one.new')
  WHERE id=pg_temp.w5('one.old');
  -- Codex and Claude rows as the host has them: no version recorded.
  PERFORM pg_temp.w5_row('gpt',v_codex,'codex','chatgpt','gpt-x','','verified','3 days','1 day','1 day');
  PERFORM pg_temp.w5_row('gpt.later',v_codex,'codex','chatgpt','gpt-y','','verified','2 days','1 day','1 day');
  PERFORM pg_temp.w5_row('sonnet',v_claude,'claude','anthropic','sonnet','','verified','3 days','1 day','1 day');

  -- The Settings list shows models, not history.
  IF jsonb_array_length(get_operator_model_catalog(v_owner))<>4 THEN
    RAISE EXCEPTION 'the Settings catalog shows superseded rows';
  END IF;
END $$;

-- Refreshes after the migration.
DO $$
DECLARE v_refresh uuid; v_upsert jsonb; v_rows bigint; v_listings bigint; v_state text; v_codex uuid := pg_temp.w5('codex');
  v_entries jsonb := '[{"runtime_type":"codex","provider_id":"chatgpt","model_id":"gpt-x","discovery_source":"codex_model_list","billing_boundary":"subscription"},
                       {"runtime_type":"codex","provider_id":"chatgpt","model_id":"gpt-y","discovery_source":"codex_model_list","billing_boundary":"subscription"}]';
BEGIN
  -- The host reports Codex 0.154.0; the worker sends no version for Codex.
  INSERT INTO runtime_health(singleton,status,snapshot,observed_at)
  VALUES (true,'healthy',jsonb_build_object('runtimes',jsonb_build_array(
      jsonb_build_object('runtime','codex','installed',true,'authenticated',true,'version','0.154.0'))),clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE SET snapshot=EXCLUDED.snapshot, observed_at=EXCLUDED.observed_at;

  v_refresh := (request_catalog_refresh(v_codex,pg_temp.w5('owner'),'identity-test')->>'refresh_id')::uuid;
  PERFORM claim_catalog_refresh_work('identity-worker',5,interval '2 minutes');
  v_upsert := upsert_catalog_entries(v_refresh,'identity-worker',v_entries);
  IF (v_upsert->>'created')::int<>0 OR (v_upsert->>'listings_added')::int<>2 THEN
    RAISE EXCEPTION 'the first refresh after the migration did not list at the reported version: %', v_upsert;
  END IF;
  IF (SELECT runtime_version FROM provider_model_catalog WHERE id=pg_temp.w5('gpt'))<>'0.154.0'
     OR NOT EXISTS (SELECT 1 FROM model_listings WHERE entry_id=pg_temp.w5('gpt') AND runtime_version='0.154.0') THEN
    RAISE EXCEPTION 'the version the list was read at is not recorded';
  END IF;

  -- The same version again changes nothing: no row, no listing, no status.
  SELECT count(*), string_agg(id||status||runtime_version, ',' ORDER BY id) INTO v_rows, v_state
    FROM provider_model_catalog WHERE connection_id=v_codex;
  SELECT count(*) INTO v_listings FROM model_listings l JOIN provider_model_catalog m ON m.id=l.entry_id WHERE m.connection_id=v_codex;
  v_upsert := upsert_catalog_entries(v_refresh,'identity-worker',v_entries);
  IF (v_upsert->>'created')::int<>0 OR (v_upsert->>'listings_added')::int<>0 OR (v_upsert->>'stale_marked')::int<>0
     OR (SELECT count(*) FROM provider_model_catalog WHERE connection_id=v_codex)<>v_rows
     OR (SELECT string_agg(id||status||runtime_version, ',' ORDER BY id) FROM provider_model_catalog WHERE connection_id=v_codex)<>v_state
     OR (SELECT count(*) FROM model_listings l JOIN provider_model_catalog m ON m.id=l.entry_id WHERE m.connection_id=v_codex)<>v_listings THEN
    RAISE EXCEPTION 'a refresh at the same version changed something: %', v_upsert;
  END IF;

  -- A new runtime version: a listing each, no new row, nothing stale, the
  -- verified models still verified (checks per version are W6).
  UPDATE runtime_health SET snapshot=jsonb_set(snapshot,'{runtimes,0,version}','"0.158.0"');
  v_upsert := upsert_catalog_entries(v_refresh,'identity-worker',v_entries);
  IF (v_upsert->>'created')::int<>0 OR (v_upsert->>'listings_added')::int<>2
     OR (SELECT count(*) FROM provider_model_catalog WHERE connection_id=v_codex)<>v_rows
     OR (SELECT count(*) FROM model_listings l JOIN provider_model_catalog m ON m.id=l.entry_id WHERE m.connection_id=v_codex)<>v_listings+2
     OR EXISTS (SELECT 1 FROM provider_model_catalog WHERE connection_id=v_codex AND status<>'verified') THEN
    RAISE EXCEPTION 'a new runtime version made rows instead of listings: %', v_upsert;
  END IF;
  PERFORM complete_catalog_refresh(v_refresh,'identity-worker',
    ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(v_upsert->'seen_entry_ids') t(x)),'unavailable');

  -- An OpenCode refresh finds the live row, never a superseded one.
  v_refresh := (request_catalog_refresh(pg_temp.w5('router'),pg_temp.w5('owner'),'identity-test')->>'refresh_id')::uuid;
  PERFORM claim_catalog_refresh_work('identity-worker',5,interval '2 minutes');
  v_upsert := upsert_catalog_entries(v_refresh,'identity-worker',
    '[{"runtime_type":"opencode","provider_id":"openrouter","model_id":"vendor/one","discovery_source":"opencode_provider_api",
       "adapter_version":"1.18.5","runtime_version":"1.18.5"}]');
  IF (v_upsert->'seen_entry_ids'->>0)::uuid<>pg_temp.w5('one.new') OR (v_upsert->>'created')::int<>0
     OR (SELECT status FROM provider_model_catalog WHERE id=pg_temp.w5('one.old'))<>'unavailable' THEN
    RAISE EXCEPTION 'a refresh wrote to a superseded row: %', v_upsert;
  END IF;

  RAISE NOTICE 'a refresh at the same version changes nothing; a new version adds listings, not rows';
END $$;

ROLLBACK;
