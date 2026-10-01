SET search_path=control_plane,public,extensions;

-- Every claim states the lease. Checked against the definitions the database
-- actually holds, so this cannot pass because a file says so.
DO $$
DECLARE v_name text; v_missing text[] := '{}';
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'claim_opencode_enrollments','claim_opencode_connection_work',
    'claim_codex_login_sessions','claim_codex_connection_work',
    'claim_model_checks','claim_catalog_refresh_work'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='control_plane' AND p.proname=v_name
        AND pg_get_functiondef(p.oid) LIKE '%lease_expires_at%'
    ) THEN v_missing := v_missing || v_name; END IF;
  END LOOP;
  IF array_length(v_missing,1) IS NOT NULL THEN
    RAISE EXCEPTION 'these claims do not state the lease: %', v_missing;
  END IF;
  RAISE NOTICE 'all six claims state lease_expires_at';
END $$;

-- And the deferring works end to end, on the path whose requeue was broken:
-- an OpenCode enrollment that was left `claimed` and never selected again.
DO $$
DECLARE v jsonb; v_user uuid; v_conn uuid; v_enr uuid; v_lease text;
BEGIN
  INSERT INTO users(id,email,display_name,role)
    VALUES (gen_random_uuid(),'lease-check@example.com','lease check','owner')
    ON CONFLICT DO NOTHING;
  SELECT id INTO v_user FROM users WHERE email='lease-check@example.com';
  INSERT INTO provider_connections(id,operator_id,provider,auth_method,status,billing_boundary,access_gateway,native_credential_reference)
    VALUES (gen_random_uuid(), v_user,'opencode','api_key','connected','subscription','opencode_go','opencode-home:opencode-worker')
    RETURNING id INTO v_conn;
  INSERT INTO provider_secret_enrollments(
    id,operator_id,connection_id,provider,access_gateway,status,state_digest,key_fingerprint,
    secret_ciphertext,secret_iv,secret_auth_tag,key_wrap_ciphertext,expires_at)
    VALUES (gen_random_uuid(), v_user, v_conn,'opencode','opencode_go','provisioned',repeat('a',64),'fp',
      decode(repeat('00',32),'hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),decode(repeat('00',32),'hex'), clock_timestamp()+interval '1 hour')
    RETURNING id INTO v_enr;

  v := claim_opencode_enrollments('worker-a', 1, interval '90 seconds');
  IF jsonb_array_length(v) <> 1 THEN RAISE EXCEPTION 'nothing claimed: %', v; END IF;
  v_lease := v->0->>'lease_expires_at';
  IF v_lease IS NULL THEN RAISE EXCEPTION 'the claim did not state its lease: %', v->0; END IF;
  RAISE NOTICE 'enrollment lease_expires_at = % (from the database, not the worker)', v_lease;

  -- Before this, an enrollment handed back stayed `claimed` and the picker only
  -- takes `provisioned`, so the work was simply lost.
  PERFORM defer_opencode_enrollment(v_enr, 'worker-a');
  v := claim_opencode_enrollments('worker-b', 1, interval '90 seconds');
  IF jsonb_array_length(v) <> 1 THEN
    RAISE EXCEPTION 'a deferred enrollment was not claimable again: %', v;
  END IF;
  RAISE NOTICE 'a deferred enrollment is claimable again';

  -- And one worker may not hand back another worker's claim.
  IF (defer_opencode_enrollment(v_enr, 'worker-a')->>'status') <> 'not_held' THEN
    RAISE EXCEPTION 'a worker deferred a claim it does not hold';
  END IF;
  RAISE NOTICE 'deferring somebody else''s claim is refused';
END $$;
