-- W5-b, the contract step (migration 0106): the capability gate's one-release
-- surface is gone, and 'stale' and 'verifying' are no longer statuses.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE
  v_left text;
  v_owner uuid; v_conn uuid; v_entry uuid; v_refresh uuid; v_upsert jsonb; v_pin jsonb;
BEGIN
  -- Nothing of the gate's surface is left, and nothing left refers to it.
  SELECT string_agg(p.proname, ', ') INTO v_left FROM pg_proc p
  WHERE p.pronamespace = 'control_plane'::regnamespace
    AND p.proname IN ('request_catalog_gate_allowlist','request_catalog_verification','claim_catalog_verifications',
      'complete_catalog_verification','fail_catalog_verification','defer_catalog_verification','gate_quota_available',
      'backfill_catalog_identity','backfill_model_checks','pin_catalog_entry_on_allowlist',
      'record_resolved_model_from_receipt');
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'still defined: %', v_left; END IF;
  IF to_regclass('control_plane.catalog_gate_allowlist') IS NOT NULL THEN
    RAISE EXCEPTION 'catalog_gate_allowlist is still a table';
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_left FROM pg_proc p
  WHERE p.pronamespace = 'control_plane'::regnamespace
    AND p.prosrc ~ '(catalog_gate_allowlist|request_catalog_verification|claim_catalog_verifications|gate_quota_available)';
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'functions still name the gate: %', v_left; END IF;
  IF has_function_privilege('infra_worker', 'control_plane.held_model_check(uuid,text)', 'EXECUTE')
     OR has_function_privilege('infra_worker', 'control_plane.model_check_usage(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the wrappers'' grants outlived them';
  END IF;

  INSERT INTO users(display_name,role) VALUES('Contract owner','owner') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','native','connected','free','opencode-home:opencode-worker') RETURNING id INTO v_conn;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source)
    VALUES(v_owner,v_conn,'opencode','opencode','contract-free','opencode_provider_api') RETURNING id INTO v_entry;

  -- Neither value is a status any more.
  BEGIN
    UPDATE provider_model_catalog SET status = 'stale' WHERE id = v_entry;
    RAISE EXCEPTION 'stale was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE provider_model_catalog SET status = 'verifying', verification_id = gen_random_uuid() WHERE id = v_entry;
    RAISE EXCEPTION 'verifying was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A pin is the one record of intent; the old read says "allowlisted" for it.
  v_pin := pin_model(v_owner, v_entry);
  IF NOT (v_pin->>'pinned')::boolean OR v_pin->>'check_id' IS NULL
     OR NOT (SELECT (m->>'allowlisted')::boolean FROM jsonb_array_elements(get_operator_model_catalog(v_owner)) m
             WHERE m->>'entry_id' = v_entry::text) THEN
    RAISE EXCEPTION 'pin: % / %', v_pin, get_operator_model_catalog(v_owner);
  END IF;
  PERFORM unpin_model(v_owner, v_entry);
  IF (SELECT pinned_at IS NOT NULL FROM provider_model_catalog WHERE id = v_entry) THEN RAISE EXCEPTION 'unpin'; END IF;

  -- A caller still asking a refresh to mark missing models stale gets what
  -- every refresh writes.
  UPDATE catalog_refresh_jobs SET status='failed', failure_code='test-isolation' WHERE status IN ('pending','in_progress');
  v_refresh := (request_catalog_refresh(v_conn, v_owner, 'contract')->>'refresh_id')::uuid;
  PERFORM claim_catalog_refresh_work('contract-refresh', 5, interval '2 minutes');
  v_upsert := upsert_catalog_entries(v_refresh, 'contract-refresh',
    '[{"runtime_type":"opencode","provider_id":"opencode","model_id":"other-free","discovery_source":"opencode_provider_api"}]');
  PERFORM complete_catalog_refresh(v_refresh, 'contract-refresh',
    ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(v_upsert->'seen_entry_ids') t(x)), 'stale');
  IF (SELECT status FROM provider_model_catalog WHERE id = v_entry) <> 'unavailable' THEN
    RAISE EXCEPTION 'a model missing from the list is %', (SELECT status FROM provider_model_catalog WHERE id = v_entry);
  END IF;
  RAISE NOTICE 'catalog contract assertions passed';
END $$;

ROLLBACK;
