-- Qualify and Promote from the panel, and the host's update pass (0127).
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_owner uuid; v_claim jsonb; v_result jsonb; v_reason text;
BEGIN
  DELETE FROM runtime_update_requests;
  INSERT INTO users(display_name) VALUES('Runtime updates') RETURNING id INTO v_owner;

  -- Promote only what passed.
  BEGIN
    PERFORM request_runtime_update(v_owner, 'codex', '9.9.1', 'promote');
    RAISE EXCEPTION 'an unqualified version was promoted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS v_reason = PG_EXCEPTION_DETAIL;
    IF v_reason NOT LIKE '%runtime_update_unqualified%' THEN RAISE EXCEPTION 'wrong refusal: %', v_reason; END IF;
  END;
  INSERT INTO runtime_qualifications(runtime_type, version, adapter_version, release_version, requested_by, finished_at, result)
  VALUES ('codex', '9.9.1', '1.2.0', 'test', 'test', clock_timestamp(), 'passed');

  -- One open request a runtime.
  v_result := request_runtime_update(v_owner, 'codex', '9.9.1', 'promote');
  IF v_result->>'status' <> 'requested' THEN RAISE EXCEPTION 'not requested: %', v_result; END IF;
  BEGIN
    PERFORM request_runtime_update(v_owner, 'codex', '9.9.1', 'qualify');
    RAISE EXCEPTION 'a second request was taken while one was open';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  PERFORM request_runtime_update(v_owner, 'claude', '9.9.2', 'qualify');

  -- The host's pass: claim, put back when busy, claim again, finish.
  v_claim := claim_runtime_update_request();
  IF v_claim->>'kind' <> 'promote' OR v_claim->>'runtime' <> 'codex' THEN RAISE EXCEPTION 'wrong claim: %', v_claim; END IF;
  PERFORM defer_runtime_update_request((v_claim->>'id')::uuid);
  v_claim := claim_runtime_update_request();
  IF v_claim->>'runtime' <> 'codex' THEN RAISE EXCEPTION 'a deferred request lost its place: %', v_claim; END IF;
  PERFORM finish_runtime_update_request((v_claim->>'id')::uuid, true, '9.9.0 → 9.9.1; on probation');
  v_claim := claim_runtime_update_request();
  IF v_claim->>'runtime' <> 'claude' THEN RAISE EXCEPTION 'the next request was not claimed: %', v_claim; END IF;
  -- A pass that died: its request is taken again after an hour.
  UPDATE runtime_update_requests SET started_at = clock_timestamp() - interval '2 hours' WHERE id = (v_claim->>'id')::uuid;
  IF (claim_runtime_update_request()->>'id') <> v_claim->>'id' THEN RAISE EXCEPTION 'a stale running request was not reclaimed'; END IF;
  IF claim_runtime_update_request() <> 'null'::jsonb THEN RAISE EXCEPTION 'nothing should be left to claim'; END IF;

  IF jsonb_array_length(get_runtime_update_requests()) < 2 THEN RAISE EXCEPTION 'the panel does not see the requests'; END IF;

  -- Offered once published (R8's 48 hours are gone).
  INSERT INTO runtime_watch_state(runtime_type, active_version, checked_at) VALUES ('codex', '9.9.0', clock_timestamp())
  ON CONFLICT (runtime_type) DO UPDATE SET active_version = '9.9.0';
  INSERT INTO runtime_versions(runtime_type, version, published_at, state) VALUES ('codex', '9.9.3', clock_timestamp() - interval '5 minutes', 'available');
  IF NOT (SELECT (n->>'offered')::boolean FROM jsonb_array_elements(get_runtime_versions()) r, jsonb_array_elements(r->'newer') n
          WHERE r->>'runtime' = 'codex' AND n->>'version' = '9.9.3') THEN
    RAISE EXCEPTION 'a version five minutes old is not offered';
  END IF;
END $$;

ROLLBACK;
