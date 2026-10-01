-- The capability gate's functions, kept for one release as wrappers over the
-- check lane (Stage 12 W6; docs/RUNTIMES_AND_MODELS_DESIGN.md §5.1). W5-b
-- drops them with catalog_gate_allowlist.
--
-- Same names, arguments, grants and result keys. What changes underneath:
--  * asking for verification is a pin and a pin check — the allowlist the old
--    request required is what a pin is, so it is no longer a precondition;
--  * the claim hands out the one check the lane allows at a time, with the
--    check's id where the verification id was; completing and failing record
--    the check's verdict, from which `status` follows, and no new receipt
--    (model_verification_receipts is history now);
--  * the quota is the lane's: one check at a time, and the day's budget.
-- request_catalog_gate_allowlist is not redefined: it still writes the
-- allowlist (which pins, 0098) and calls request_catalog_verification below.

SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION request_catalog_verification(p_entry_id uuid, p_operator_id uuid, p_actor text DEFAULT ''::text, p_correlation_id text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_entry provider_model_catalog%ROWTYPE; v_check jsonb;
BEGIN
  SELECT * INTO v_entry FROM provider_model_catalog
  WHERE id=p_entry_id AND operator_id=p_operator_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM refuse('catalog_entry_unavailable', 'catalog entry is unavailable'); END IF;
  IF v_entry.status IN ('stale','unavailable') OR v_entry.superseded_by IS NOT NULL THEN
    PERFORM refuse('catalog_entry_unavailable', 'catalog entry is stale or unavailable; refresh discovery first');
  END IF;
  UPDATE provider_model_catalog SET pinned_at = COALESCE(pinned_at, clock_timestamp()) WHERE id = v_entry.id;
  INSERT INTO catalog_gate_allowlist(operator_id,connection_id,provider_id,model_id,created_by)
  VALUES (v_entry.operator_id, v_entry.connection_id, v_entry.provider_id, v_entry.model_id,
    COALESCE(NULLIF(p_actor,''), p_operator_id::text))
  ON CONFLICT DO NOTHING;
  v_check := request_model_check(p_operator_id, p_entry_id, 'pin');
  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = p_entry_id;
  RETURN jsonb_build_object('entry_id', v_entry.id, 'status', v_entry.status,
    'pending', v_check->>'state' IN ('checking','waiting'),
    'check_id', v_check->>'check_id',
    'reason', CASE WHEN (v_check->>'deduplicated')::boolean THEN 'already_requested' END);
END; $function$;

-- lease_expires_at: the absolute moment the claim's lease ends, as every claim
-- states it (db/test/lease-and-defer.sql).
CREATE OR REPLACE FUNCTION claim_catalog_verifications(p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT '00:10:00'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_claims jsonb;
BEGIN
  IF COALESCE(p_limit, 0) < 1 THEN RETURN '[]'::jsonb; END IF;
  v_claims := claim_model_checks(p_worker_id, p_lease);
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'lease_expires_at', c->'lease_expires_at',
      'entry_id', c->'entry_id', 'connection_id', c->'connection_id', 'operator_id', c->'operator_id',
      'runtime_type', c->'runtime_type', 'provider_id', c->'provider_id', 'model_id', c->'model_id',
      'billing_boundary', m.billing_boundary, 'access_gateway', m.access_gateway, 'model_vendor', m.model_vendor,
      'reasoning_efforts', m.reasoning_efforts, 'service_tiers', m.service_tiers,
      'adapter_version', c->'adapter_version', 'runtime_version', c->'runtime_version',
      'verification_id', c->'check_id'))
    FROM jsonb_array_elements(v_claims) c
    JOIN provider_model_catalog m ON m.id = (c->>'entry_id')::uuid), '[]'::jsonb);
END; $function$;

CREATE OR REPLACE FUNCTION complete_catalog_verification(p_entry_id uuid, p_worker_id text, p_capabilities jsonb, p_smoke_checks jsonb, p_verification_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_check model_checks%ROWTYPE; v_resolved text; v_entry provider_model_catalog%ROWTYPE;
BEGIN
  v_check := held_model_check(p_verification_id, p_worker_id);
  IF v_check.id IS NULL OR v_check.entry_id IS DISTINCT FROM p_entry_id THEN
    PERFORM refuse('model_check_not_leased', 'catalog verification lease is unavailable');
  END IF;
  IF jsonb_typeof(COALESCE(p_capabilities,'{}'::jsonb))<>'object'
     OR length(COALESCE(p_capabilities,'{}'::jsonb)::text)>4096
     OR jsonb_typeof(COALESCE(p_smoke_checks,'[]'::jsonb))<>'array'
     OR jsonb_array_length(COALESCE(p_smoke_checks,'[]'::jsonb))>32 THEN
    PERFORM refuse('model_check_invalid', 'verification receipt is invalid', '22023');
  END IF;
  SELECT left(c->>'detail', 200) INTO v_resolved FROM jsonb_array_elements(COALESCE(p_smoke_checks,'[]'::jsonb)) c
  WHERE c->>'name' = 'resolved_model' AND c->>'ok' = 'true' LIMIT 1;
  UPDATE provider_model_catalog SET capabilities = COALESCE(p_capabilities, capabilities) WHERE id = p_entry_id;
  PERFORM complete_model_check(p_verification_id, p_worker_id, 'passed', NULL,
    'passed through the capability gate interface', COALESCE(v_resolved,''), NULL, true);
  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = p_entry_id;
  RETURN jsonb_build_object('entry_id', p_entry_id, 'status', v_entry.status,
    'receipt_id', p_verification_id, 'last_verified_at', v_entry.last_verified_at);
END; $function$;

CREATE OR REPLACE FUNCTION fail_catalog_verification(p_entry_id uuid, p_worker_id text, p_failure_code text, p_failure_message text, p_verification_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_check model_checks%ROWTYPE; v_entry provider_model_catalog%ROWTYPE;
BEGIN
  v_check := held_model_check(p_verification_id, p_worker_id);
  IF v_check.id IS NULL OR v_check.entry_id IS DISTINCT FROM p_entry_id THEN
    PERFORM refuse('model_check_not_leased', 'catalog verification lease is unavailable');
  END IF;
  PERFORM complete_model_check(p_verification_id, p_worker_id, 'rejected', 'model',
    left(COALESCE(NULLIF(p_failure_code,''),'catalog_verification_failed') || ': '
      || COALESCE(p_failure_message,'Capability verification failed.'), 500), '', NULL, true);
  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = p_entry_id;
  RETURN jsonb_build_object('entry_id', p_entry_id, 'status', v_entry.status, 'receipt_id', p_verification_id);
END; $function$;

CREATE OR REPLACE FUNCTION defer_catalog_verification(p_entry_id uuid, p_worker_id text, p_verification_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_result jsonb;
BEGIN
  v_result := defer_model_check(p_verification_id, p_worker_id, 'handed back by the capability gate interface', false);
  RETURN jsonb_build_object('status', CASE WHEN v_result->>'status' = 'not_held' THEN 'not_held' ELSE 'deferred' END,
    'entry_id', p_entry_id);
END; $function$;

-- The lane's quota, in the old shape: fewer running than the concurrency limit
-- (the lane allows one), and the day's checks under the total.
CREATE OR REPLACE FUNCTION gate_quota_available(p_operator_id uuid, p_concurrency_limit integer DEFAULT 2, p_total_limit integer DEFAULT 20)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_in_flight integer; v_total integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('model-check-lane', 0));
  SELECT count(*) INTO v_in_flight FROM model_checks WHERE finished_at IS NULL AND lease_until > clock_timestamp();
  v_total := (model_check_usage(p_operator_id)->>'used')::int;
  RETURN v_in_flight < LEAST(GREATEST(p_concurrency_limit,1), 1)
    AND v_in_flight + v_total < GREATEST(p_total_limit,1);
END; $function$;

-- The wrappers run as their caller, the previous release's gate worker
-- (infra_worker), and read the lane through these two.
GRANT EXECUTE ON FUNCTION held_model_check(uuid, text) TO infra_worker;
GRANT EXECUTE ON FUNCTION model_check_usage(uuid) TO infra_worker;
