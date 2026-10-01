\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_code uuid;
  v_claim jsonb;
  v_envelope jsonb;
BEGIN
  INSERT INTO users(id,display_name) VALUES(v_user,'Existing GitHub installation test');
  INSERT INTO provider_login_sessions(operator_id,provider,state_digest,status,expires_at,consumed_at)
  VALUES(v_user,'github',repeat('a',64),'consumed',clock_timestamp()+interval '10 minutes',clock_timestamp());

  v_code := record_github_oauth_callback(v_user,repeat('a',64),'','',
    encode(convert_to('encrypted-code','utf8'),'base64'),
    encode(decode(repeat('01',12),'hex'),'base64'),
    encode(decode(repeat('02',16),'hex'),'base64'),
    'Iv1.existing-installation-client',interval '10 minutes');

  v_claim := claim_github_oauth_pending('existing-installation-test',1,interval '90 seconds')->0;
  IF v_claim->>'code_id' <> v_code::text OR v_claim->>'installation_id' <> '' THEN
    RAISE EXCEPTION 'standalone OAuth row was not claimed without an installation id';
  END IF;
  v_envelope := begin_github_oauth_exchange(v_code,'existing-installation-test');
  IF v_envelope->>'ciphertext' IS NULL THEN RAISE EXCEPTION 'OAuth envelope missing'; END IF;

  PERFORM select_github_oauth_installation(v_code,'existing-installation-test','148349432');
  IF (SELECT installation_id FROM github_oauth_codes WHERE id=v_code) <> '148349432' THEN
    RAISE EXCEPTION 'broker did not bind the verified installation';
  END IF;

  BEGIN
    PERFORM select_github_oauth_installation(v_code,'existing-installation-test','999');
    RAISE EXCEPTION 'installation selection was not one-time';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  RAISE NOTICE 'existing-installation OAuth assertions passed';
END $$;

ROLLBACK;
