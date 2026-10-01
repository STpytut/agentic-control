\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_owner uuid;
  v_other uuid;
  v_start jsonb;
  v_session uuid;
  v_connection uuid;
  v_claim jsonb;
  v_status jsonb;
  v_action jsonb;
BEGIN
  INSERT INTO users(display_name) VALUES('Codex connection owner') RETURNING id INTO v_owner;
  INSERT INTO users(display_name) VALUES('Other Codex owner') RETURNING id INTO v_other;

  v_start := start_codex_device_login(v_owner,'codex-test');
  v_session := (v_start->>'session_id')::uuid;
  v_connection := (v_start->>'connection_id')::uuid;
  v_claim := claim_codex_login_sessions('codex-account-test',1,interval '15 minutes')->0;
  IF (v_claim->>'session_id')::uuid<>v_session THEN
    RAISE EXCEPTION 'Codex login session was not claimed';
  END IF;

  PERFORM publish_codex_device_code(
    v_session,'codex-account-test','native-login-1',
    'https://auth.openai.com/codex/device','ABCD-EFGH'
  );
  v_status := get_operator_codex_login_status(v_owner);
  IF v_status->>'user_code'<>'ABCD-EFGH' OR v_status->>'verification_url'<>'https://auth.openai.com/codex/device' THEN
    RAISE EXCEPTION 'device authorization presentation data is missing';
  END IF;
  IF get_operator_codex_login_status(v_other)<>'null'::jsonb THEN
    RAISE EXCEPTION 'another operator can see the Codex login session';
  END IF;

  PERFORM complete_codex_device_login(
    v_session,'codex-account-test','owner@example.test','plus'
  );
  v_status := get_operator_codex_login_status(v_owner);
  IF v_status->>'status'<>'consumed' OR v_status->>'user_code'<>'' OR v_status->>'verification_url'<>'' THEN
    RAISE EXCEPTION 'device presentation data was not scrubbed after completion';
  END IF;
  IF (get_operator_codex_connection(v_owner)->>'status')<>'connected' THEN
    RAISE EXCEPTION 'Codex connection was not activated';
  END IF;
  IF (SELECT native_credential_reference FROM provider_connections WHERE id=v_connection)<>'codex-home:codex-worker' THEN
    RAISE EXCEPTION 'native credential reference is incorrect';
  END IF;

  BEGIN
    PERFORM request_codex_connection_action(v_connection,v_other,'disconnect','foreign');
    RAISE EXCEPTION 'foreign operator disconnected Codex';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%unavailable%' THEN RAISE; END IF;
  END;

  v_action := request_codex_connection_action(v_connection,v_owner,'verify','verify');
  IF v_action->>'requested_action'<>'verify' THEN RAISE EXCEPTION 'verify was not queued'; END IF;
  v_claim := claim_codex_connection_work('codex-account-test',1,interval '90 seconds')->0;
  IF v_claim->>'work_kind'<>'verify' THEN RAISE EXCEPTION 'verify work was not claimed'; END IF;
  PERFORM complete_codex_connection_work(v_connection,'codex-account-test','owner@example.test','plus');

  PERFORM request_codex_connection_action(v_connection,v_owner,'disconnect','disconnect');
  v_claim := claim_codex_connection_work('codex-account-test',1,interval '90 seconds')->0;
  IF v_claim->>'work_kind'<>'disconnect' THEN RAISE EXCEPTION 'disconnect work was not claimed'; END IF;
  PERFORM complete_codex_connection_work(v_connection,'codex-account-test','','');
  IF (get_operator_codex_connection(v_owner)->>'status')<>'disconnected' THEN
    RAISE EXCEPTION 'Codex connection was not disconnected';
  END IF;

  RAISE NOTICE 'Codex account connection assertions passed';
END $$;

ROLLBACK;
