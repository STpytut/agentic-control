-- The GitHub App from the settings page (migration 0125): a state, GitHub's
-- sealed code for it, the broker's conversion, and one registered App.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE
  v_owner uuid; v_other uuid; v_claim jsonb; v_status jsonb; v_registration jsonb;
  v_state text := repeat('a', 64); v_state2 text := repeat('b', 64);
  v_cipher text := encode('sealed-code-bytes'::bytea, 'base64');
  v_iv text := encode(decode(repeat('01', 12), 'hex'), 'base64');
  v_tag text := encode(decode(repeat('02', 16), 'hex'), 'base64');
BEGIN
  DELETE FROM github_app_manifests;
  INSERT INTO users(display_name) VALUES('Manifest owner') RETURNING id INTO v_owner;
  INSERT INTO users(display_name) VALUES('Someone else') RETURNING id INTO v_other;

  IF github_app_registration() <> 'null'::jsonb THEN RAISE EXCEPTION 'no App yet, but one is registered'; END IF;
  PERFORM start_github_app_manifest(v_owner, v_state, NULL);

  -- Another operator cannot hand in a code for this state.
  BEGIN
    PERFORM record_github_app_manifest_code(v_other, v_state, v_cipher, v_iv, v_tag);
    RAISE EXCEPTION 'a code was recorded for someone else''s state';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM record_github_app_manifest_code(v_owner, v_state, v_cipher, v_iv, v_tag);
  -- And the state is spent.
  BEGIN
    PERFORM record_github_app_manifest_code(v_owner, v_state, v_cipher, v_iv, v_tag);
    RAISE EXCEPTION 'a manifest state took two codes';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  v_claim := claim_github_app_manifest('broker-test');
  IF v_claim->>'ciphertext' <> v_cipher THEN RAISE EXCEPTION 'the broker did not get the sealed code: %', v_claim; END IF;
  IF claim_github_app_manifest('broker-2') <> 'null'::jsonb THEN RAISE EXCEPTION 'a leased manifest was claimed twice'; END IF;

  v_registration := complete_github_app_manifest((v_claim->>'manifest_id')::uuid, 'broker-test', 4242, 'infra-cod-test',
    'Iv1.abcdef12', 'owner', 'https://github.com/apps/infra-cod-test');
  IF v_registration->>'slug' <> 'infra-cod-test' OR (v_registration->>'app_id')::bigint <> 4242 THEN
    RAISE EXCEPTION 'the registration is wrong: %', v_registration;
  END IF;
  IF EXISTS (SELECT 1 FROM github_app_manifests WHERE code_ciphertext IS NOT NULL) THEN
    RAISE EXCEPTION 'the sealed code outlived its conversion';
  END IF;
  v_status := get_github_app_manifest_status(v_owner);
  IF v_status->>'status' <> 'registered' THEN RAISE EXCEPTION 'the owner does not see the App registered: %', v_status; END IF;

  -- One App per panel.
  BEGIN
    PERFORM start_github_app_manifest(v_owner, v_state2, NULL);
    RAISE EXCEPTION 'a second App was started';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  -- A failed conversion keeps no code and says why.
  DELETE FROM github_app_manifests;
  PERFORM start_github_app_manifest(v_owner, v_state2, 'my-org');
  PERFORM record_github_app_manifest_code(v_owner, v_state2, v_cipher, v_iv, v_tag);
  v_claim := claim_github_app_manifest('broker-test');
  PERFORM fail_github_app_manifest((v_claim->>'manifest_id')::uuid, 'broker-test', 'not_found', 'the code expired on GitHub');
  v_status := get_github_app_manifest_status(v_owner);
  IF v_status->>'status' <> 'failed' OR v_status->>'failure_message' <> 'the code expired on GitHub' THEN
    RAISE EXCEPTION 'a failure is not reported: %', v_status;
  END IF;
  IF (SELECT owner_kind FROM github_app_manifests) <> 'organization' THEN RAISE EXCEPTION 'the organization was lost'; END IF;
  IF github_app_registration() <> 'null'::jsonb THEN RAISE EXCEPTION 'a failed App is registered'; END IF;
END $$;

ROLLBACK;
