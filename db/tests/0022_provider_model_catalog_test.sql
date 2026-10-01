\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_owner uuid;
  v_connection uuid;
  v_github uuid;
  v_claim jsonb;
  v_refresh uuid;
  v_upsert jsonb;
  v_complete jsonb;
  v_status jsonb;
  v_catalog jsonb;
  v_verified jsonb;
  v_entry uuid;
  v_receipt jsonb;
  v_entry_2 uuid;
  v_fail jsonb;
  v_missing integer;
  v_rows integer;
BEGIN
  INSERT INTO users(display_name) VALUES('Catalog owner') RETURNING id INTO v_owner;

  -- OpenCode Free connection (always available) as discovery target.
  SELECT id INTO v_connection FROM provider_connections
  WHERE operator_id=v_owner AND provider='opencode' AND billing_boundary='free';
  IF v_connection IS NULL THEN
    INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,
      native_credential_reference)
    VALUES(v_owner,'opencode','native','connected','free','opencode-home:opencode-worker')
    RETURNING id INTO v_connection;
  END IF;

  -- Manual refresh request is owner-scoped and idempotent.
  v_claim := request_catalog_refresh(v_connection,v_owner,'test-manual');
  v_refresh := (v_claim->>'refresh_id')::uuid;
  IF v_claim->>'duplicate'<>'false' THEN RAISE EXCEPTION 'first refresh request was reported as duplicate'; END IF;
  v_claim := request_catalog_refresh(v_connection,v_owner,'test-again');
  IF v_claim->>'duplicate'<>'true' OR (v_claim->>'refresh_id')::uuid<>v_refresh THEN
    RAISE EXCEPTION 'second refresh request was not deduplicated';
  END IF;

  -- Another operator cannot request a refresh on this connection.
  BEGIN
    PERFORM request_catalog_refresh(v_connection, gen_random_uuid(), 'foreign');
    RAISE EXCEPTION 'foreign operator queued a catalog refresh';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%unavailable%' THEN RAISE; END IF;
  END;

  -- Claim and upsert a normalized catalog; raw/unbounded entries are rejected.
  v_claim := claim_catalog_refresh_work('catalog-test-worker',1,interval '2 minutes')->0;
  IF (v_claim->>'refresh_id')::uuid<>v_refresh OR v_claim->>'reason'<>'test-manual' THEN
    RAISE EXCEPTION 'manual refresh job was not claimed';
  END IF;

  BEGIN
    PERFORM upsert_catalog_entries(v_refresh,'catalog-test-worker',
      '[{"runtime_type":"opencode","provider_id":"opencode","model_id":"mini",
        "discovery_source":"opencode_provider_api",
        "capabilities": {"nested": {"big": "payload"}},
        "raw": {"unbounded": "provider blob"}}]'::jsonb);
    RAISE EXCEPTION 'raw provider content was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%not normalized%' THEN RAISE; END IF;
  END;

  v_upsert := upsert_catalog_entries(v_refresh,'catalog-test-worker',
    '[{"runtime_type":"opencode","provider_id":"opencode","model_id":"opencode-free",
      "display_name":"OpenCode Free","provider_badge":"OpenCode","plan_badge":"Free",
      "billing_boundary":"free",
      "reasoning_efforts":["low","medium"],
      "service_tiers":["free"],
      "capabilities":{"streaming":true,"interrupt":true},
      "adapter_version":"1.18.3","runtime_version":"1.18.3",
      "discovery_source":"opencode_provider_api"},
     {"runtime_type":"opencode","provider_id":"opencode","model_id":"opencode-plus",
      "display_name":"OpenCode Plus","provider_badge":"OpenCode","plan_badge":"Plus",
      "billing_boundary":"free",
      "service_tiers":["plus"],
      "adapter_version":"1.18.3","runtime_version":"1.18.3",
      "discovery_source":"opencode_provider_api"}]'::jsonb);
  IF (v_upsert->>'created')::integer<>2 OR (v_upsert->>'entries_seen')::integer<>2 THEN
    RAISE EXCEPTION 'initial catalog upsert counts are incorrect';
  END IF;

  -- Idempotent re-upsert: same boundary updates, no duplicates.
  v_upsert := upsert_catalog_entries(v_refresh,'catalog-test-worker',
    '[{"runtime_type":"opencode","provider_id":"opencode","model_id":"opencode-free",
      "display_name":"OpenCode Free (updated)","provider_badge":"OpenCode","plan_badge":"Free",
      "billing_boundary":"free",
      "reasoning_efforts":["low","medium"],
      "service_tiers":["free"],
      "capabilities":{"streaming":true,"interrupt":true},
      "adapter_version":"1.18.3","runtime_version":"1.18.3",
      "discovery_source":"opencode_provider_api"}]'::jsonb);
  IF (v_upsert->>'created')::integer<>0 OR (v_upsert->>'updated')::integer<>1 THEN
    RAISE EXCEPTION 'idempotent catalog upsert counts are incorrect';
  END IF;
  SELECT count(*) INTO v_rows FROM provider_model_catalog WHERE connection_id=v_connection;
  IF v_rows<>2 THEN RAISE EXCEPTION 'catalog upsert created duplicates'; END IF;

  -- Complete refresh marks missing entries (plus was dropped) unavailable.
  v_complete := complete_catalog_refresh(v_refresh,'catalog-test-worker',
    (SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(v_upsert->'seen_entry_ids') t(x)),
    'unavailable');
  IF v_complete->>'status'<>'completed' THEN RAISE EXCEPTION 'catalog refresh did not complete'; END IF;
  IF (SELECT count(*) FROM provider_model_catalog m
      WHERE m.connection_id=v_connection AND m.status='unavailable')<>1 THEN
    RAISE EXCEPTION 'missing catalog entry was not marked unavailable';
  END IF;

  -- A small free list is checked by itself (Stage 12 W6, R2): the refresh
  -- that completed above queued its models, and the lane runs one at a time.
  v_entry := (SELECT id FROM provider_model_catalog
    WHERE connection_id=v_connection AND model_id='opencode-free');
  IF NOT EXISTS (SELECT 1 FROM model_checks WHERE entry_id=v_entry AND finished_at IS NULL
                 AND trigger='auto_small_list' AND automatic) THEN
    RAISE EXCEPTION 'the refresh of a small free list queued no automatic check';
  END IF;

  -- A foreign operator cannot ask for a check (Stage 12 W6; the gate's
  -- functions went in W5-b, 0106).
  BEGIN
    PERFORM request_model_check(gen_random_uuid(),v_entry,'pin');
    RAISE EXCEPTION 'foreign operator requested a check';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;

  -- A pin takes over the queued automatic check at the operator's priority
  -- rather than adding one.
  PERFORM pin_model(v_owner,v_entry);
  v_claim := request_model_check(v_owner,v_entry,'pin');
  IF v_claim->>'state'<>'checking' THEN RAISE EXCEPTION 'the pin''s check is not pending: %', v_claim; END IF;
  IF v_claim->>'deduplicated'<>'true' THEN RAISE EXCEPTION 'the queued automatic check was not reused'; END IF;
  IF (SELECT pinned_at IS NULL FROM provider_model_catalog WHERE id=v_entry) THEN
    RAISE EXCEPTION 'a pin did not pin the model';
  END IF;
  IF (SELECT priority||' '||trigger FROM model_checks WHERE entry_id=v_entry AND finished_at IS NULL)<>'1 pin' THEN
    RAISE EXCEPTION 'the operator''s request did not raise the check''s priority';
  END IF;
  v_claim := request_model_check(v_owner,v_entry,'pin');
  IF v_claim->>'deduplicated'<>'true' THEN RAISE EXCEPTION 'a check request is not idempotent'; END IF;

  -- The claim hands out the pinned model first, and one check at a time.
  v_claim := claim_model_checks('catalog-gate-worker',interval '10 minutes')->0;
  IF (v_claim->>'entry_id')::uuid<>v_entry THEN RAISE EXCEPTION 'model check claim is incorrect'; END IF;
  IF v_claim->>'lease_expires_at' IS NULL THEN RAISE EXCEPTION 'the claim does not state its lease'; END IF;
  IF jsonb_array_length(claim_model_checks('catalog-gate-worker-b',interval '10 minutes'))<>0 THEN
    RAISE EXCEPTION 'a second check ran beside the first';
  END IF;
  v_receipt := complete_model_check((v_claim->>'check_id')::uuid,'catalog-gate-worker','passed',NULL,
    'PARITY_OK','',NULL,true);
  IF (SELECT status FROM provider_model_catalog WHERE id=v_entry)<>'verified'
     OR (SELECT last_verified_at IS NULL FROM provider_model_catalog WHERE id=v_entry) THEN
    RAISE EXCEPTION 'verified catalog state was not persisted';
  END IF;
  -- Completing twice is refused: the lease went with the verdict.
  BEGIN
    PERFORM complete_model_check((v_claim->>'check_id')::uuid,'catalog-gate-worker','passed',NULL,'','',NULL,true);
    RAISE EXCEPTION 'a finished check was completed again';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%not leased%' THEN RAISE; END IF;
  END;

  -- The automatic checks of the rest of the small list are not the selector's
  -- business here; they are set aside so what follows is about one model.
  DELETE FROM model_checks WHERE operator_id=v_owner AND finished_at IS NULL;

  -- Verified entries appear in the selector read model; stale does not.
  v_verified := get_operator_model_catalog_verified(v_owner);
  IF jsonb_array_length(v_verified)<>1 OR v_verified->0->>'model_id'<>'opencode-free' THEN
    RAISE EXCEPTION 'verified selector catalog is incorrect';
  END IF;

  -- Version drift: re-discover with a new runtime version. The model keeps its
  -- row (identity is connection, provider, model since 0098); the new version
  -- is a listing, the row says where it was last seen, and nothing goes stale.
  -- opencode-plus, listed again, comes back as discovered.
  v_claim := request_catalog_refresh(v_connection,v_owner,'version-drift');
  v_refresh := (v_claim->>'refresh_id')::uuid;
  v_claim := claim_catalog_refresh_work('catalog-test-worker',1,interval '2 minutes')->0;
  v_upsert := upsert_catalog_entries(v_refresh,'catalog-test-worker',
    '[{"runtime_type":"opencode","provider_id":"opencode","model_id":"opencode-free",
      "display_name":"OpenCode Free","provider_badge":"OpenCode","plan_badge":"Free",
      "billing_boundary":"free",
      "service_tiers":["free"],
      "adapter_version":"1.18.3","runtime_version":"1.18.4",
      "discovery_source":"opencode_provider_api"},
     {"runtime_type":"opencode","provider_id":"opencode","model_id":"opencode-plus",
      "display_name":"OpenCode Plus","provider_badge":"OpenCode","plan_badge":"Plus",
      "billing_boundary":"free",
      "service_tiers":["plus"],
      "adapter_version":"1.18.3","runtime_version":"1.18.4",
      "discovery_source":"opencode_provider_api"}]'::jsonb);
  IF (v_upsert->>'created')::integer<>0 OR (v_upsert->>'updated')::integer<>2
     OR (v_upsert->>'stale_marked')::integer<>0 OR (v_upsert->>'listings_added')::integer<>2 THEN
    RAISE EXCEPTION 'version drift upsert counts are incorrect: %', v_upsert;
  END IF;
  IF (SELECT count(*) FROM provider_model_catalog
      WHERE connection_id=v_connection AND model_id='opencode-free')<>1 THEN
    RAISE EXCEPTION 'version drift created a second row for the same model';
  END IF;
  IF (SELECT status||' '||runtime_version FROM provider_model_catalog WHERE id=v_entry)<>'verified 1.18.4' THEN
    RAISE EXCEPTION 'the model did not keep its row and status across the version: %',
      (SELECT status||' '||runtime_version FROM provider_model_catalog WHERE id=v_entry);
  END IF;
  IF (SELECT array_agg(runtime_version ORDER BY runtime_version) FROM model_listings WHERE entry_id=v_entry)
     <>ARRAY['1.18.3','1.18.4'] THEN
    RAISE EXCEPTION 'the versions listing the model are not recorded';
  END IF;
  v_verified := get_operator_model_catalog_verified(v_owner);
  IF jsonb_array_length(v_verified)<>1 OR v_verified->0->>'entry_id'<>v_entry::text THEN
    RAISE EXCEPTION 'a new runtime version took the model out of the selector catalog';
  END IF;
  v_entry_2 := (SELECT id FROM provider_model_catalog
    WHERE connection_id=v_connection AND model_id='opencode-plus');
  IF (SELECT status FROM provider_model_catalog WHERE id=v_entry_2)<>'discovered' THEN
    RAISE EXCEPTION 'a model listed again is not discovered';
  END IF;
  v_complete := complete_catalog_refresh(v_refresh,'catalog-test-worker',
    (SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(v_upsert->'seen_entry_ids') t(x)),
    'unavailable');

  -- A check the model refused -> rejected with its reason; not selectable.
  DELETE FROM model_checks WHERE operator_id=v_owner AND finished_at IS NULL;
  v_entry := v_entry_2;
  PERFORM request_model_check(v_owner,v_entry,'pin');
  v_claim := claim_model_checks('catalog-gate-worker',interval '10 minutes')->0;
  v_fail := complete_model_check((v_claim->>'check_id')::uuid,'catalog-gate-worker','rejected','model',
    'runtime could not start the model','',NULL,true);
  IF (SELECT status FROM provider_model_catalog WHERE id=v_entry)<>'rejected' THEN
    RAISE EXCEPTION 'a refused check did not reject the entry';
  END IF;
  v_verified := get_operator_model_catalog_verified(v_owner);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_verified) e WHERE e->>'entry_id'=v_entry::text) THEN
    RAISE EXCEPTION 'rejected entry is selectable';
  END IF;

  -- Connection disconnect marks remaining entries unavailable (fail closed).
  UPDATE provider_connections SET status='disconnected', updated_at=clock_timestamp(), version=version+1
  WHERE id=v_connection;
  IF (SELECT count(*) FROM provider_model_catalog m
      WHERE m.connection_id=v_connection AND m.status IN ('discovered','verified'))<>0 THEN
    RAISE EXCEPTION 'disconnect did not fail closed the catalog';
  END IF;

  -- Owner-scoped read model hides nothing sensitive and requires ownership.
  v_catalog := get_operator_model_catalog(v_owner);
  -- Two models, one row each: the version drift above added no row (0098).
  IF jsonb_array_length(v_catalog)<>2 THEN RAISE EXCEPTION 'owner catalog read model is incorrect'; END IF;
  IF get_operator_model_catalog(gen_random_uuid())<>'[]'::jsonb THEN
    RAISE EXCEPTION 'foreign operator can read the catalog';
  END IF;

  -- Unsupported connections are rejected both manually and by the periodic
  -- scheduler. Catalog discovery must never create failed jobs for GitHub.
  INSERT INTO provider_connections(
    operator_id,provider,auth_method,status,external_installation_id,
    repository_selection,native_credential_reference
  ) VALUES(
    v_owner,'github','github_app','connected','987654321','selected','github-app:987654321'
  ) RETURNING id INTO v_github;
  BEGIN
    PERFORM request_catalog_refresh(v_github,v_owner,'unsupported-manual');
    RAISE EXCEPTION 'manual refresh accepted an unsupported provider';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%does not expose a runtime model catalog%' THEN RAISE; END IF;
  END;
  PERFORM request_catalog_refreshes_due(interval '0 seconds');
  IF EXISTS(
    SELECT 1 FROM catalog_refresh_jobs
    WHERE connection_id=v_github AND status IN ('pending','in_progress')
  ) THEN
    RAISE EXCEPTION 'periodic scheduler queued an unsupported provider';
  END IF;

  -- A failed supported refresh receives a bounded scheduler backoff instead
  -- of producing another failed row on every worker poll. Manual retry remains
  -- available through request_catalog_refresh.
  UPDATE provider_connections SET status='connected',updated_at=clock_timestamp(),version=version+1
  WHERE id=v_connection;
  v_claim := request_catalog_refresh(v_connection,v_owner,'backoff-fixture');
  v_refresh := (v_claim->>'refresh_id')::uuid;
  -- The claim used to be read as `claim_catalog_refresh_work(...,1,...)->0`,
  -- which is whichever pending job ranks first — not necessarily this fixture's.
  -- It held only while no other connection in the database had an older pending
  -- job; on an installation that had used the catalog, the worker took that
  -- older row and `fail_catalog_refresh` below then refused the lease for a job
  -- nobody had claimed. Unrelated work is set aside inside this file's
  -- transaction — the rollback restores it — so the claim below is this
  -- fixture's job by construction instead of by timestamps.
  UPDATE catalog_refresh_jobs SET
    status='failed', failure_code='test-isolation', leased_by=NULL, leased_until=NULL
  WHERE status IN ('pending','in_progress') AND id<>v_refresh;
  v_claim := claim_catalog_refresh_work('catalog-test-worker',1,interval '2 minutes')->0;
  IF (v_claim->>'refresh_id')::uuid<>v_refresh THEN
    RAISE EXCEPTION 'the claim did not return the backoff fixture job';
  END IF;
  PERFORM fail_catalog_refresh(v_refresh,'catalog-test-worker','fixture_failed','bounded fixture failure');
  PERFORM request_catalog_refreshes_due(interval '0 seconds');
  IF EXISTS(
    SELECT 1 FROM catalog_refresh_jobs
    WHERE connection_id=v_connection AND status IN ('pending','in_progress')
  ) THEN
    RAISE EXCEPTION 'failed refresh ignored the scheduler backoff';
  END IF;

  RAISE NOTICE 'provider model catalog assertions passed';
END $$;

ROLLBACK;
