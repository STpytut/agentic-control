\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_owner uuid;
  v_state text := encode(digest('github-oauth-spoof-state','sha256'),'hex');
  v_state_success text := encode(digest('github-oauth-success-state','sha256'),'hex');
  v_code_id uuid;
  v_connection_id uuid;
  v_initial_version bigint;
  v_text text;
  v_refresh_result jsonb;
  v_list jsonb;
  v_authorization jsonb;
BEGIN
  INSERT INTO users(display_name) VALUES('OAuth Owner') RETURNING id INTO v_owner;

  -- Create the login session first; the combined function will consume it.
  PERFORM start_provider_login_session(v_owner,'github',v_state);
  v_code_id := ((consume_session_and_record_github_oauth(
    v_owner, v_state, '9000001', 'install',
    'ZmFrZS1jaXBoZXJ0ZXh0', 'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAA==',
    'Iv1_fake_client_id'
  )->>'code_id'))::uuid;

  -- Simulate the broker refusing a spoofed installation_id: claim the oauth
  -- row, begin exchange, then mark it failed. The encrypted envelope must be scrubbed.
  PERFORM claim_github_oauth_pending('security-scan-broker',1);
  PERFORM begin_github_oauth_exchange(v_code_id,'security-scan-broker');
  PERFORM fail_github_oauth_exchange(v_code_id,'security-scan-broker','installation_not_permitted',
    'The selected GitHub installation is not accessible to the authenticated user.');
  SELECT status INTO v_text FROM github_oauth_codes WHERE id=v_code_id;
  IF v_text<>'failed' THEN RAISE EXCEPTION 'spoofed installation should have been failed'; END IF;
  IF (SELECT authorization_code_ciphertext IS NOT NULL FROM github_oauth_codes WHERE id=v_code_id) THEN
    RAISE EXCEPTION 'authorization code envelope must be scrubbed on failure';
  END IF;

  -- A successful oauth completion atomically creates an oauth-verified connection
  -- and scrubs the encrypted envelope.
  PERFORM start_provider_login_session(v_owner,'github',v_state_success);
  v_code_id := ((consume_session_and_record_github_oauth(
    v_owner, v_state_success, '9000002', 'install',
    'c2Vjb25kLWNpcGhlcnRleHQ=', 'AQEBAQEBAQEBAQEB', 'AgICAgICAgICAgICAgICAg==',
    'Iv1_fake_client_id'
  )->>'code_id'))::uuid;
  PERFORM claim_github_oauth_pending('security-scan-broker',1);
  PERFORM begin_github_oauth_exchange(v_code_id,'security-scan-broker');
  UPDATE github_oauth_codes SET broker_leased_until=clock_timestamp()-interval '1 second' WHERE id=v_code_id;
  PERFORM claim_github_oauth_pending('recovery-broker',1);
  PERFORM begin_github_oauth_exchange(v_code_id,'recovery-broker');
  v_connection_id := ((complete_github_oauth_connection(v_code_id,'recovery-broker')->>'connection_id'))::uuid;
  SELECT verified_via INTO v_text FROM provider_connections WHERE id=v_connection_id;
  IF v_text<>'oauth' THEN RAISE EXCEPTION 'oauth-verified connection should be recorded as oauth, got %',v_text; END IF;
  IF (SELECT authorization_code_ciphertext IS NOT NULL FROM github_oauth_codes WHERE id=v_code_id) THEN
    RAISE EXCEPTION 'authorization code envelope must be scrubbed on completion';
  END IF;

  -- An active clone authorization blocks disconnect until the clone is terminal.
  PERFORM activate_github_connection(v_connection_id,'security-scan-broker','owner','User / owner',
    '9002','{"contents":"read"}'::jsonb,'selected');
  INSERT INTO projects(id,owner_id,name,slug,workspace_path,repository_url,default_branch,status,settings,
    credential_mode,provider_connection_id,github_repository_id,repository_full_name)
  VALUES(gen_random_uuid(),v_owner,'Race Project','race-project','/srv/race-project',
    'https://github.com/owner/race.git','main','needs_attention',
    '{"provisioning_status":"pending"}',
    'github_app',v_connection_id,7001,'owner/race');
  v_authorization := acquire_github_clone_authorization((SELECT id FROM projects WHERE slug='race-project'),'security-scan-broker');
  BEGIN
    PERFORM disconnect_github_connection(v_connection_id,v_owner,'corr-disc-busy');
    RAISE EXCEPTION 'disconnect must not complete during an active clone';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%clone is in progress%' THEN
      RAISE EXCEPTION 'unexpected error: %',SQLERRM;
    END IF;
  END;
  PERFORM finalize_github_clone_authorization((v_authorization->>'authorization_id')::uuid,'security-scan-broker',false);
  SELECT version INTO v_initial_version FROM provider_connections WHERE id=v_connection_id;
  PERFORM disconnect_github_connection(v_connection_id,v_owner,'corr-disc-oauth');
  IF (SELECT version FROM provider_connections WHERE id=v_connection_id)<=v_initial_version THEN
    RAISE EXCEPTION 'disconnect must bump connection version';
  END IF;

  -- list_operator_github_repositories must honor p_limit BEFORE aggregation.
  v_connection_id := create_pending_github_connection(v_owner,'9000003','install','corr-list','broker');
  PERFORM activate_github_connection(v_connection_id,'security-scan-broker','owner','User / owner',
    '9003','{"contents":"read"}'::jsonb,'selected');
  SELECT jsonb_agg(jsonb_build_object(
    'github_repository_id',i::text,'full_name','owner/repo-'||i,'private',false,
    'archived',false,'default_branch','main','clone_url','https://github.com/owner/repo-'||i||'.git')
  ) INTO v_refresh_result FROM generate_series(1,25) i;
  PERFORM refresh_github_installation_repositories(v_connection_id,'security-scan-broker',v_refresh_result);
  v_list := list_operator_github_repositories(v_owner,v_connection_id,'',5);
  IF jsonb_array_length(v_list)<>5 THEN
    RAISE EXCEPTION 'list_operator_github_repositories must honor p_limit, got % rows',jsonb_array_length(v_list);
  END IF;

  RAISE NOTICE 'oauth and disconnect-race assertions passed';
END $$;

ROLLBACK;
