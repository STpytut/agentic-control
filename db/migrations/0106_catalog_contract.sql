-- W5-b, the contract step of the catalog's new identity (Stage 12;
-- docs/RUNTIMES_AND_MODELS_DESIGN.md §5.1 "Migration W5-b").
--
-- W5-a (0098) and W6 (0099–0102) kept the capability gate's surface for one
-- release, as wrappers over the check lane, beside the new functions; the
-- previous release (rc.89) already calls only the new ones — its check worker
-- claims from the lane, its panel pins and asks for checks — so what the
-- wrappers were kept for is gone. Dropped here:
--
--  * request_catalog_gate_allowlist, request_catalog_verification,
--    claim_catalog_verifications, complete_/fail_/defer_catalog_verification and
--    gate_quota_available — the gate's surface, now only wrappers (0102) or
--    their callers;
--  * catalog_gate_allowlist and the trigger that followed it into pins (0098),
--    after every row in it is a pin; pin_model and unpin_model stop writing it,
--    and get_operator_model_catalog's "allowlisted" is the pin;
--  * the receipt trigger that copied a gate's resolved alias to the row (0098)
--    — model_verification_receipts is history, and checks record it now;
--  * backfill_catalog_identity() and backfill_model_checks(), which ran once on
--    every host (rc.82, rc.85) and are only safe as they were written, against
--    the schema they were written for;
--  * the status values 'stale' and 'verifying'. Nothing writes them since 0098
--    and 0099; rows that still hold them are converted first: 'verifying' was a
--    gate in flight, which no longer exists, and 'stale' a row seen at an older
--    runtime version that no refresh has marked since — both are 'discovered'
--    (not selectable, like before; a check decides the rest), and neither was
--    selectable, so nothing that was stops being.
--
-- The previous release keeps working against this schema: it calls none of the
-- dropped functions on any path it reaches with the W6 functions present (its
-- Settings page falls back to the old catalog card only when
-- get_operator_models is missing), passes 'unavailable' to
-- complete_catalog_refresh, and its health snapshot's count of 'stale' rows
-- reads 0. A browser tab left open from before W7 that still posts the old
-- "verify" action gets an error instead of a pin.
--
-- A dry run on a host is this file inside BEGIN … ROLLBACK: the NOTICE names
-- what was converted and dropped, every model that stops being selectable
-- (none is expected), and every team model that is not verified.

SET search_path TO control_plane, public, extensions;

DO $$
DECLARE
  v_before uuid[];
  v_stale integer;
  v_verifying integer;
  v_allowlist integer;
  v_pins integer;
  v_lost jsonb;
  v_team_total integer;
  v_team_unverified jsonb;
BEGIN
  SELECT COALESCE(array_agg(id), '{}') INTO v_before FROM provider_model_catalog
  WHERE status = 'verified' AND superseded_by IS NULL;

  -- Every allowlisted model is a pin (0098 made them so, and its trigger kept
  -- them so); a row the trigger could not reach is pinned here.
  SELECT count(*) INTO v_allowlist FROM catalog_gate_allowlist;
  UPDATE provider_model_catalog m SET pinned_at = a.first_asked_at
  FROM (SELECT operator_id, connection_id, provider_id, model_id, min(created_at) AS first_asked_at
        FROM catalog_gate_allowlist GROUP BY 1, 2, 3, 4) a
  WHERE m.superseded_by IS NULL AND m.pinned_at IS NULL
    AND a.operator_id = m.operator_id AND a.connection_id = m.connection_id
    AND a.provider_id = m.provider_id AND a.model_id = m.model_id;
  GET DIAGNOSTICS v_pins = ROW_COUNT;

  UPDATE provider_model_catalog SET status = 'discovered', verification_id = NULL, verified_lease_until = NULL,
    updated_at = clock_timestamp(), version = version + 1
  WHERE status = 'verifying';
  GET DIAGNOSTICS v_verifying = ROW_COUNT;
  UPDATE provider_model_catalog SET status = 'discovered', updated_at = clock_timestamp(), version = version + 1
  WHERE status = 'stale';
  GET DIAGNOSTICS v_stale = ROW_COUNT;
  -- A converted row a check has judged takes its status from the checks, as
  -- every judged row does.
  PERFORM project_model_status(id) FROM provider_model_catalog
  WHERE superseded_by IS NULL AND status = 'discovered'
    AND EXISTS (SELECT 1 FROM model_checks k WHERE k.entry_id = provider_model_catalog.id);

  SELECT COALESCE(jsonb_agg(format('%s %s (%s)', m.runtime_type, m.model_id, model_eligibility(m.id)->>'reason')
      ORDER BY m.runtime_type, m.model_id), '[]'::jsonb)
    INTO v_lost FROM provider_model_catalog m
  WHERE m.id = ANY(v_before) AND m.status <> 'verified';
  SELECT count(*), COALESCE(jsonb_agg(format('%s %s (%s)', m.runtime_type, m.model_id, model_eligibility(m.id)->>'reason')
      ORDER BY m.runtime_type, m.model_id) FILTER (WHERE m.status <> 'verified'), '[]'::jsonb)
    INTO v_team_total, v_team_unverified
  FROM provider_model_catalog m WHERE m.id IN (SELECT entry_id FROM model_entries_in_use());

  RAISE NOTICE 'catalog contract (W5-b): %', jsonb_build_object(
    'stale_to_discovered', v_stale, 'verifying_to_discovered', v_verifying,
    'allowlist_rows_dropped', v_allowlist, 'allowlist_rows_pinned_now', v_pins,
    'verified_before', cardinality(v_before),
    'verified_after', (SELECT count(*) FROM provider_model_catalog WHERE status = 'verified' AND superseded_by IS NULL),
    'no_longer_selectable', v_lost,
    'team_models', v_team_total, 'team_models_not_verified', v_team_unverified);
  IF jsonb_array_length(v_team_unverified) > 0 THEN
    RAISE WARNING 'team models that are not verified: %', v_team_unverified;
  END IF;
END $$;

-- ------------------------------------------------------------ the gate's surface

DROP FUNCTION request_catalog_gate_allowlist(uuid, jsonb, text, text);
DROP FUNCTION request_catalog_verification(uuid, uuid, text, text);
DROP FUNCTION claim_catalog_verifications(text, integer, interval);
DROP FUNCTION complete_catalog_verification(uuid, text, jsonb, jsonb, uuid);
DROP FUNCTION fail_catalog_verification(uuid, text, text, text, uuid);
DROP FUNCTION defer_catalog_verification(uuid, text, uuid);
DROP FUNCTION gate_quota_available(uuid, integer, integer);
DROP FUNCTION backfill_catalog_identity();
DROP FUNCTION backfill_model_checks();
-- Granted to the worker role only for the wrappers, which ran as their caller.
REVOKE EXECUTE ON FUNCTION held_model_check(uuid, text) FROM infra_worker;
REVOKE EXECUTE ON FUNCTION model_check_usage(uuid) FROM infra_worker;

DROP TRIGGER model_verification_receipts_resolved_model ON model_verification_receipts;
DROP FUNCTION record_resolved_model_from_receipt();

-- 0101's functions, same signatures and keys: a pin is the one record of
-- intent now.
CREATE OR REPLACE FUNCTION pin_model(p_operator_id uuid, p_entry_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_entry provider_model_catalog%ROWTYPE;
  v_current model_checks%ROWTYPE;
  v_usage jsonb;
  v_check uuid;
BEGIN
  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = p_entry_id AND operator_id = p_operator_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('catalog_entry_not_owned', format('no model %s in this operator''s catalog', p_entry_id), '42501');
  END IF;
  IF v_entry.superseded_by IS NOT NULL THEN
    PERFORM refuse('catalog_entry_unavailable', format('model %s was replaced by %s', p_entry_id, v_entry.superseded_by));
  END IF;
  UPDATE provider_model_catalog SET pinned_at = COALESCE(pinned_at, clock_timestamp()) WHERE id = p_entry_id;
  v_current := model_check_current(p_entry_id);
  IF v_current.id IS NOT NULL THEN
    v_check := v_current.id;
  ELSIF NOT (model_eligibility(p_entry_id)->>'eligible')::boolean
    AND v_entry.status <> 'unavailable'
    AND EXISTS (SELECT 1 FROM provider_connections WHERE id = v_entry.connection_id AND status = 'connected') THEN
    v_usage := model_check_usage(p_operator_id);
    IF (v_usage->>'used')::int + (v_usage->>'operator_pending')::int < (model_check_limits()->>'hard_per_day')::int THEN
      v_check := (queue_model_check(p_entry_id, 'pin', false, p_operator_id::text)->>'check_id')::uuid;
    END IF;
  END IF;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,'model.pinned','provider_model_catalog',
    p_entry_id::text,'allowed',NULL,jsonb_build_object('model_id',v_entry.model_id,'check_id',v_check),p_entry_id::text);
  RETURN jsonb_build_object('entry_id', p_entry_id, 'pinned', true, 'check_id', v_check);
END $$;

CREATE OR REPLACE FUNCTION unpin_model(p_operator_id uuid, p_entry_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_entry provider_model_catalog%ROWTYPE;
BEGIN
  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = p_entry_id AND operator_id = p_operator_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('catalog_entry_not_owned', format('no model %s in this operator''s catalog', p_entry_id), '42501');
  END IF;
  UPDATE provider_model_catalog SET pinned_at = NULL WHERE id = p_entry_id AND pinned_at IS NOT NULL;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,'model.unpinned','provider_model_catalog',
    p_entry_id::text,'allowed',NULL,jsonb_build_object('model_id',v_entry.model_id),p_entry_id::text);
  RETURN jsonb_build_object('entry_id', p_entry_id, 'pinned', false, 'check_id', NULL);
END $$;

-- 0098's read, same signature and keys, for the previous release's fallback
-- card: "allowlisted" is the pin.
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
    'allowlisted',m.pinned_at IS NOT NULL,
    'connection_status',c.status,'connection_provider',c.provider
  ) ORDER BY m.updated_at DESC),'[]'::jsonb)
  FROM provider_model_catalog m
  JOIN provider_connections c ON c.id=m.connection_id
  WHERE m.operator_id=p_operator_id AND m.superseded_by IS NULL;
$function$;

DROP TRIGGER catalog_gate_allowlist_pins ON catalog_gate_allowlist;
DROP FUNCTION pin_catalog_entry_on_allowlist();
DROP TABLE catalog_gate_allowlist;

-- ------------------------------------------------------------ status values

-- 0105's function, same signature: 'stale' is no longer a status, so a caller
-- still asking for it gets what every refresh writes.
CREATE OR REPLACE FUNCTION complete_catalog_refresh(
  p_refresh_id uuid, p_worker_id text, p_seen_entry_ids uuid[],
  p_missing_status text DEFAULT 'unavailable'
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_job catalog_refresh_jobs%ROWTYPE; v_missing integer;
BEGIN
  IF p_missing_status NOT IN ('stale','unavailable') THEN
    RAISE EXCEPTION 'invalid catalog missing status' USING ERRCODE='22023',
      DETAIL=jsonb_build_object('reason','catalog_entry_invalid')::text;
  END IF;
  SELECT * INTO v_job FROM catalog_refresh_jobs
  WHERE id=p_refresh_id AND status='in_progress'
    AND leased_by=p_worker_id AND leased_until>clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog refresh lease is unavailable' USING ERRCODE='55000',
    DETAIL=jsonb_build_object('reason','catalog_refresh_not_leased')::text; END IF;

  UPDATE provider_model_catalog SET
    status='unavailable', stale_at=clock_timestamp(),
    verification_id=NULL, verified_lease_until=NULL,
    gate_requested_at=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE connection_id=v_job.connection_id
    AND superseded_by IS NULL
    AND status IN ('discovered','verified','rejected')
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

-- 0027's trigger function, same trigger: the statuses a connection going away
-- takes models out of.
CREATE OR REPLACE FUNCTION mark_catalog_unavailable_on_connection_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF NEW.status IN ('disconnected','expired') AND OLD.status <> NEW.status THEN
    UPDATE provider_model_catalog SET
      status='unavailable', stale_at=clock_timestamp(),
      verification_id=NULL, verified_lease_until=NULL,
      updated_at=clock_timestamp(), version=version+1
    WHERE connection_id=NEW.id AND status IN ('discovered','verified');
  END IF;
  RETURN NEW;
END; $$;

-- The constraints that named the two values, rewritten without them.
DO $$
DECLARE v_name text;
BEGIN
  FOR v_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'provider_model_catalog'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ~ '''(stale|verifying)'''
  LOOP
    EXECUTE format('ALTER TABLE provider_model_catalog DROP CONSTRAINT %I', v_name);
  END LOOP;
END $$;
ALTER TABLE provider_model_catalog
  ADD CONSTRAINT provider_model_catalog_status_check
    CHECK (status IN ('discovered','verified','rejected','unavailable')),
  ADD CONSTRAINT provider_model_catalog_verified_lease_check
    CHECK (verified_lease_until IS NULL OR status = 'verified'),
  ADD CONSTRAINT provider_model_catalog_verification_id_check
    CHECK (verification_id IS NULL OR status = 'verified');
