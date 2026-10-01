\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_owner uuid;
  v_other uuid;
  v_start jsonb;
  v_enrollment uuid;
  v_connection uuid;
  v_stored jsonb;
  v_claim jsonb;
  v_status jsonb;
  v_action jsonb;
  v_free_count integer;
  v_ciphertext text;
  v_iv text;
  v_tag text;
  v_wrap text;
  v_row provider_secret_enrollments%ROWTYPE;
BEGIN
  INSERT INTO users(display_name) VALUES('OpenCode connection owner') RETURNING id INTO v_owner;
  INSERT INTO users(display_name) VALUES('Other OpenCode owner') RETURNING id INTO v_other;

  -- 12-byte IV, 16-byte tag, non-trivial ciphertext/wrap envelopes.
  v_iv := encode('0123456789ab','base64');
  v_tag := encode('0123456789abcdef','base64');
  v_ciphertext := encode('ciphertext-bytes','base64');
  v_wrap := encode('key-wrap-material','base64');

  -- Free is available without enrollment and is created idempotently.
  v_status := get_operator_opencode_connections(v_owner);
  IF (SELECT jsonb_array_length(v_status)) <> 1 OR (v_status->0->>'billing_boundary')<>'free' OR (v_status->0->>'status')<>'connected' THEN
    RAISE EXCEPTION 'OpenCode Free was not auto-created';
  END IF;
  PERFORM get_operator_opencode_connections(v_owner);
  SELECT count(*) INTO v_free_count FROM provider_connections
    WHERE operator_id=v_owner AND provider='opencode' AND billing_boundary='free';
  IF v_free_count<>1 THEN RAISE EXCEPTION 'OpenCode Free was duplicated'; END IF;
  IF (v_status->0->>'last_failure_code')<>'' OR (v_status->0 ? 'secret') THEN
    RAISE EXCEPTION 'Free connection leaked secret or failure metadata';
  END IF;

  -- Start Go enrollment; a duplicate free row is rejected by the unique index.
  BEGIN
    INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','native','connected','free','opencode-home:opencode-worker');
    RAISE EXCEPTION 'duplicate Free connection was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  v_start := start_opencode_enrollment(v_owner,'opencode_go','opencode-go-test');
  v_enrollment := (v_start->>'enrollment_id')::uuid;
  v_connection := (v_start->>'connection_id')::uuid;
  IF (v_start->>'access_gateway')<>'opencode_go' OR (v_start->>'billing_boundary')<>'subscription' THEN RAISE EXCEPTION 'enrollment gateway or billing is incorrect: %', v_start; END IF;

  v_stored := store_opencode_enrollment_secret(
    v_enrollment,v_owner,v_ciphertext,v_iv,v_tag,v_wrap,'fp-test-1'
  );
  IF v_stored->>'status'<>'provisioned' THEN RAISE EXCEPTION 'enrollment secret was not stored'; END IF;
  IF get_operator_opencode_enrollment_status(v_other)<>'null'::jsonb THEN
    RAISE EXCEPTION 'another operator can see the enrollment';
  END IF;

  -- Owner isolation: foreign operator cannot store into this enrollment.
  BEGIN
    PERFORM store_opencode_enrollment_secret(v_enrollment,v_other,'x','x','x','x','');
    RAISE EXCEPTION 'foreign operator stored an enrollment secret';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%unavailable%' THEN RAISE; END IF;
  END;

  v_claim := claim_opencode_enrollments('opencode-account-test',1,interval '90 seconds')->0;
  IF (v_claim->>'enrollment_id')::uuid<>v_enrollment OR (v_claim->>'ciphertext')<>v_ciphertext THEN
    RAISE EXCEPTION 'provisioned enrollment was not claimed with its envelope';
  END IF;
  IF get_operator_opencode_enrollment_status(v_owner)->>'status'<>'claimed' THEN
    RAISE EXCEPTION 'enrollment status is not claimed';
  END IF;

  PERFORM complete_opencode_enrollment(v_enrollment,'opencode-account-test','owner@example.test');
  IF (get_operator_opencode_connections(v_owner)->1->>'status')<>'connected'
     OR (get_operator_opencode_connections(v_owner)->1->>'access_gateway')<>'opencode_go' THEN
    RAISE EXCEPTION 'Go connection was not activated';
  END IF;
  SELECT * INTO v_row FROM provider_secret_enrollments WHERE id=v_enrollment;
  IF v_row.status<>'completed' OR v_row.secret_ciphertext IS NOT NULL THEN
    RAISE EXCEPTION 'enrollment was not completed and scrubbed';
  END IF;
  IF (SELECT native_credential_reference FROM provider_connections WHERE id=v_connection)<>'opencode-home:opencode-worker' THEN
    RAISE EXCEPTION 'OpenCode native credential reference is incorrect';
  END IF;

  -- Verify and Disconnect on the Go connection.
  BEGIN
    PERFORM request_opencode_connection_action(v_connection,v_other,'disconnect','foreign');
    RAISE EXCEPTION 'foreign operator disconnected OpenCode';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%unavailable%' THEN RAISE; END IF;
  END;
  v_action := request_opencode_connection_action(v_connection,v_owner,'verify','verify');
  IF v_action->>'requested_action'<>'verify' THEN RAISE EXCEPTION 'verify was not queued'; END IF;
  v_claim := claim_opencode_connection_work('opencode-account-test',1,interval '90 seconds')->0;
  IF v_claim->>'work_kind'<>'verify' THEN RAISE EXCEPTION 'verify work was not claimed'; END IF;
  PERFORM complete_opencode_connection_work(v_connection,'opencode-account-test','owner@example.test');

  PERFORM request_opencode_connection_action(v_connection,v_owner,'disconnect','disconnect');
  v_claim := claim_opencode_connection_work('opencode-account-test',1,interval '90 seconds')->0;
  IF v_claim->>'work_kind'<>'disconnect' THEN RAISE EXCEPTION 'disconnect work was not claimed'; END IF;
  PERFORM complete_opencode_connection_work(v_connection,'opencode-account-test','');
  IF (SELECT status FROM provider_connections WHERE id=v_connection)<>'disconnected' THEN
    RAISE EXCEPTION 'Go connection was not disconnected';
  END IF;

  -- Disconnect of Go does not break Free.
  v_status := get_operator_opencode_connections(v_owner);
  IF (v_status->0->>'billing_boundary')<>'free' OR (v_status->0->>'status')<>'connected' THEN
    RAISE EXCEPTION 'Free execution depends on Go connection';
  END IF;

  -- Failure path: new enrollment on the same (reconnected) connection, invalid key.
  v_start := start_opencode_enrollment(v_owner,'opencode_go','opencode-go-fail');
  v_enrollment := (v_start->>'enrollment_id')::uuid;
  v_connection := (v_start->>'connection_id')::uuid;
  IF (SELECT status FROM provider_connections WHERE id=v_connection)<>'pending_finalize' THEN
    RAISE EXCEPTION 'reconnect did not reset the connection';
  END IF;
  PERFORM store_opencode_enrollment_secret(v_enrollment,v_owner,v_ciphertext,v_iv,v_tag,v_wrap,'fp-test-1');
  PERFORM claim_opencode_enrollments('opencode-account-test',1,interval '90 seconds')->0;
  PERFORM fail_opencode_enrollment(v_enrollment,'opencode-account-test','invalid_api_key','OpenCode rejected the key');
  IF (get_operator_opencode_connections(v_owner)->1->>'status')<>'expired'
     OR (get_operator_opencode_connections(v_owner)->1->>'last_failure_code')<>'invalid_api_key' THEN
    RAISE EXCEPTION 'invalid key did not fail closed';
  END IF;

  -- Expiry scrubs ciphertext.
  -- A previous release's panel sends the old boundary word; it names the same gateway (0083).
  v_start := start_opencode_enrollment(v_owner,'go','opencode-go-expiry');
  v_enrollment := (v_start->>'enrollment_id')::uuid;
  PERFORM store_opencode_enrollment_secret(v_enrollment,v_owner,v_ciphertext,v_iv,v_tag,v_wrap,'fp-test-1');
  UPDATE provider_secret_enrollments
    SET created_at=clock_timestamp()-interval '2 seconds', expires_at=clock_timestamp()-interval '1 second'
    WHERE id=v_enrollment;
  IF (SELECT jsonb_array_length(claim_opencode_enrollments('opencode-account-test',1,interval '90 seconds')))<>0 THEN
    RAISE EXCEPTION 'expired enrollment was claimed';
  END IF;
  SELECT * INTO v_row FROM provider_secret_enrollments WHERE id=v_enrollment;
  IF v_row.status<>'expired' OR v_row.secret_ciphertext IS NOT NULL OR v_row.failure_code<>'enrollment_expired' THEN
    RAISE EXCEPTION 'expired enrollment was not scrubbed';
  END IF;

  -- OpenRouter (11.2): the openrouter gateway is its own connection beside
  -- Go, enrolled the same way, and its claims say which boundary they are —
  -- the worker signs the key in to the provider that boundary names.
  v_start := start_opencode_enrollment(v_owner,'openrouter','openrouter-test');
  IF (v_start->>'access_gateway')<>'openrouter' OR (v_start->>'billing_boundary')<>'third_party_metered' THEN RAISE EXCEPTION 'OpenRouter enrollment gateway or billing is incorrect: %', v_start; END IF;
  IF (v_start->>'connection_id')::uuid=v_connection THEN
    RAISE EXCEPTION 'OpenRouter reused the Go connection';
  END IF;
  v_enrollment := (v_start->>'enrollment_id')::uuid;
  PERFORM store_opencode_enrollment_secret(v_enrollment,v_owner,v_ciphertext,v_iv,v_tag,v_wrap,'fp-test-or');
  v_claim := claim_opencode_enrollments('opencode-account-test',1,interval '90 seconds')->0;
  IF (v_claim->>'enrollment_id')::uuid<>v_enrollment OR v_claim->>'access_gateway'<>'openrouter' THEN
    RAISE EXCEPTION 'the OpenRouter claim does not name its boundary: %', v_claim;
  END IF;
  PERFORM complete_opencode_enrollment(v_enrollment,'opencode-account-test','OpenRouter');
  SELECT count(*) INTO v_free_count FROM provider_connections
    WHERE operator_id=v_owner AND provider='opencode' AND access_gateway='openrouter' AND status='connected';
  IF v_free_count<>1 THEN RAISE EXCEPTION 'OpenRouter connection was not activated'; END IF;
  IF (SELECT status FROM provider_connections WHERE id=v_connection)<>'expired' THEN
    RAISE EXCEPTION 'connecting OpenRouter changed the Go connection';
  END IF;
  PERFORM request_opencode_connection_action((v_start->>'connection_id')::uuid,v_owner,'verify','verify-or');
  v_claim := claim_opencode_connection_work('opencode-account-test',1,interval '90 seconds')->0;
  IF v_claim->>'access_gateway'<>'openrouter' THEN
    RAISE EXCEPTION 'OpenRouter verify work does not name its boundary: %', v_claim;
  END IF;

  RAISE NOTICE 'OpenCode connection assertions passed';
END $$;

ROLLBACK;
