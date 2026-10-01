\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

-- Security token scan: a unique fake installation token must never persist in any
-- control-plane table, git config, event, command, audit row or project metadata.
-- The DB functions only accept safe metadata; the broker is contractually required
-- to redact tokens before calling fail_* functions. This test exercises the safe
-- paths and proves the schema rejects token-embedded repository URLs and clone
-- URLs, then scans every relevant text/jsonb column for the fake token.

DO $$
DECLARE
  v_owner uuid;
  v_connection_id uuid;
  v_token text := 'ghs_SECURITYSCAN_7C1F_2026_FAKE_TOKEN';
  v_count integer;
  v_text text;
BEGIN
  INSERT INTO users(display_name) VALUES('Security Scan Owner') RETURNING id INTO v_owner;

  -- Simulate a completed callback + broker finalization using ONLY safe metadata.
  v_connection_id := create_pending_github_connection(v_owner,'5000001','install','corr-scan');
  PERFORM activate_github_connection(v_connection_id,'security-scan-broker','scan-account','User / scan-account',
    '5001','{"contents":"read","metadata":"read"}'::jsonb,'selected');

  -- A repository with a token-embedded clone_url must be rejected by the cache writer.
  PERFORM refresh_github_installation_repositories(v_connection_id,'security-scan-broker',
    jsonb_build_array(
      jsonb_build_object('github_repository_id','8001','full_name','scan/safe','private',true,
        'archived',false,'default_branch','main','clone_url','https://github.com/scan/safe.git'),
      jsonb_build_object('github_repository_id','8002','full_name','scan/leaky','private',true,
        'archived',false,'default_branch','main','clone_url','https://'||v_token||'@github.com/scan/leaky.git')
    ));
  SELECT count(*) INTO v_count FROM provider_installation_repositories
    WHERE connection_id=v_connection_id AND full_name='scan/leaky';
  IF v_count<>0 THEN RAISE EXCEPTION 'token-embedded clone_url must be rejected by the cache writer'; END IF;
  SELECT count(*) INTO v_count FROM provider_installation_repositories WHERE clone_url LIKE '%@%';
  IF v_count<>0 THEN RAISE EXCEPTION 'no cached clone_url may embed credentials'; END IF;

  -- A project repository_url that embeds the token must be rejected by the CHECK constraint.
  BEGIN
    INSERT INTO projects(id,owner_id,name,slug,workspace_path,repository_url,default_branch,status,settings)
    VALUES(gen_random_uuid(),v_owner,'Leaky','leaky','/srv/leaky',
      'https://'||v_token||'@github.com/scan/leaky.git','main','needs_attention','{"provisioning_status":"pending"}');
    RAISE EXCEPTION 'token-embedded project repository_url should have been rejected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Fail a clone with a SAFE (already redacted) message; the broker must never pass the raw token.
  INSERT INTO projects(id,owner_id,name,slug,workspace_path,repository_url,default_branch,status,settings,
    credential_mode,provider_connection_id,github_repository_id,repository_full_name)
  VALUES(gen_random_uuid(),v_owner,'Scan Fail','scan-fail','/srv/scan-fail',
    'https://github.com/scan/safe.git','main','needs_attention','{"provisioning_status":"pending"}',
    'github_app',v_connection_id,8001,'scan/safe');
  PERFORM fail_github_app_clone((SELECT id FROM projects WHERE slug='scan-fail'),'security-scan-broker',
    'This repository is no longer available to the GitHub App.');

  -- Full-table scan: the fake token must not appear in any relevant text/jsonb column.
  SELECT
    (SELECT count(*) FROM provider_connections WHERE (account_label||installation_label||native_credential_reference||
       external_account_id||external_installation_id||last_failure_code||last_failure_message||permissions::text) ILIKE '%'||v_token||'%')
    + (SELECT count(*) FROM provider_login_sessions WHERE state_digest ILIKE '%'||v_token||'%' OR failure_code ILIKE '%'||v_token||'%')
    + (SELECT count(*) FROM provider_installation_repositories WHERE full_name ILIKE '%'||v_token||'%' OR clone_url ILIKE '%'||v_token||'%')
    + (SELECT count(*) FROM projects WHERE repository_url ILIKE '%'||v_token||'%' OR repository_full_name ILIKE '%'||v_token||'%'
       OR settings::text ILIKE '%'||v_token||'%')
    + (SELECT count(*) FROM audit_events WHERE action ILIKE '%'||v_token||'%' OR target_id ILIKE '%'||v_token||'%'
       OR details::text ILIKE '%'||v_token||'%' OR correlation_id ILIKE '%'||v_token||'%')
    + (SELECT count(*) FROM domain_events WHERE event_type ILIKE '%'||v_token||'%' OR payload::text ILIKE '%'||v_token||'%'
       OR correlation_id ILIKE '%'||v_token||'%' OR idempotency_key ILIKE '%'||v_token||'%')
    + (SELECT count(*) FROM commands WHERE idempotency_key ILIKE '%'||v_token||'%' OR payload::text ILIKE '%'||v_token||'%'
       OR result::text ILIKE '%'||v_token||'%' OR error::text ILIKE '%'||v_token||'%')
    + (SELECT count(*) FROM runtime_jobs WHERE payload::text ILIKE '%'||v_token||'%' OR result::text ILIKE '%'||v_token||'%'
       OR last_error ILIKE '%'||v_token||'%')
    INTO v_count;
  IF v_count<>0 THEN RAISE EXCEPTION 'fake token leaked into control-plane tables: % occurrences',v_count; END IF;

  RAISE NOTICE 'security token scan passed: no fake token in database rows';
END $$;

ROLLBACK;
