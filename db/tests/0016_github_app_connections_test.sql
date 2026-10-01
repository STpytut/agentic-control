\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_owner uuid;
  v_other uuid;
  v_session_id uuid;
  v_connection_id uuid;
  v_other_connection_id uuid;
  v_project uuid;
  v_deploy_project uuid;
  v_result jsonb;
  v_count integer;
  v_text text;
BEGIN
  INSERT INTO users(display_name) VALUES('GitHub App Owner') RETURNING id INTO v_owner;
  INSERT INTO users(display_name) VALUES('GitHub App Other') RETURNING id INTO v_other;

  -- Existing repository project backfilled to deploy_key must stay valid and selectable.
  INSERT INTO projects(id,owner_id,name,slug,workspace_path,repository_url,default_branch,status,settings,
    credential_mode)
  VALUES(gen_random_uuid(),v_owner,'Legacy Deploy','legacy-deploy','/srv/legacy-deploy',
    'https://github.com/owner/legacy.git','main','needs_attention',
    '{"provisioning_status":"pending","provisioning_source":"clone"}','deploy_key')
  RETURNING id INTO v_deploy_project;
  SELECT credential_mode INTO v_text FROM projects WHERE id=v_deploy_project;
  IF v_text<>'deploy_key' THEN RAISE EXCEPTION 'legacy repo project should remain deploy_key, got %',v_text; END IF;

  -- Empty workspace project stays empty.
  INSERT INTO projects(id,owner_id,name,slug,workspace_path,default_branch,status,settings)
  VALUES(gen_random_uuid(),v_owner,'Legacy Empty','legacy-empty','/srv/legacy-empty',
    'main','needs_attention','{"provisioning_status":"pending","provisioning_source":"empty"}');
  SELECT credential_mode INTO v_text FROM projects WHERE slug='legacy-empty';
  IF v_text<>'empty' THEN RAISE EXCEPTION 'empty workspace project should be empty, got %',v_text; END IF;

  -- The provisioner claim filter must keep selecting deploy_key/empty projects (broker only claims github_app).
  SELECT count(*) INTO v_count FROM projects
    WHERE credential_mode IN ('deploy_key','empty') AND status='needs_attention'
      AND (settings->>'provisioning_status'='pending');
  IF v_count<2 THEN RAISE EXCEPTION 'provisioner claim filter dropped legacy projects: %',v_count; END IF;

  -- Start a login session and consume it once.
  v_session_id := start_provider_login_session(v_owner,'github',encode(digest('state-secret','sha256'),'hex'));
  v_result := consume_provider_login_session(v_owner,'github',encode(digest('state-secret','sha256'),'hex'));
  IF (v_result->>'session_id')<>v_session_id::text THEN RAISE EXCEPTION 'consume returned wrong session'; END IF;

  -- Duplicate callback with the same state must fail (one-time session).
  BEGIN
    PERFORM consume_provider_login_session(v_owner,'github',encode(digest('state-secret','sha256'),'hex'));
    RAISE EXCEPTION 'duplicate callback should have been rejected';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%invalid, expired or already used%' THEN RAISE EXCEPTION 'unexpected duplicate error: %',SQLERRM; END IF;
  END;

  -- Expired session must not be accepted.
  v_session_id := start_provider_login_session(v_owner,'github',encode(digest('expired-state','sha256'),'hex'),interval '1 second');
  PERFORM pg_sleep(1.2);
  BEGIN
    PERFORM consume_provider_login_session(v_owner,'github',encode(digest('expired-state','sha256'),'hex'));
    RAISE EXCEPTION 'expired session should have been rejected';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%invalid, expired or already used%' THEN RAISE EXCEPTION 'unexpected expired error: %',SQLERRM; END IF;
  END;

  -- Wrong state (not owned / unknown) must be rejected.
  BEGIN
    PERFORM consume_provider_login_session(v_owner,'github',encode(digest('unknown-state','sha256'),'hex'));
    RAISE EXCEPTION 'unknown state should have been rejected';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%invalid, expired or already used%' THEN RAISE EXCEPTION 'unexpected unknown state error: %',SQLERRM; END IF;
  END;

  -- Successful callback creates a pending_finalize connection bound to the operator.
  v_connection_id := create_pending_github_connection(v_owner,'1234567','install','corr-1');
  SELECT status INTO v_text FROM provider_connections WHERE id=v_connection_id;
  IF v_text<>'pending_finalize' THEN RAISE EXCEPTION 'pending connection not in pending_finalize, got %',v_text; END IF;

  -- Another operator cannot see or operate on the owner connection.
  IF jsonb_array_length(get_operator_github_connections(v_other))<>0 THEN
    RAISE EXCEPTION 'other operator must not see owner connections';
  END IF;
  BEGIN
    PERFORM disconnect_github_connection(v_connection_id,v_other,'corr-x');
    RAISE EXCEPTION 'other operator must not disconnect owner connection';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%unavailable%' THEN RAISE EXCEPTION 'unexpected cross-operator disconnect error: %',SQLERRM; END IF;
  END;

  -- Broker claims pending_finalize work and activates the connection.
  v_result := claim_github_connection_work('github-broker-test',1);
  IF jsonb_array_length(v_result)<>1 OR (v_result->0->>'installation_id')<>'1234567'
     OR (v_result->0->>'work_kind')<>'finalize' THEN
    RAISE EXCEPTION 'claim did not return pending finalize work: %',v_result;
  END IF;
  v_result := activate_github_connection(v_connection_id,'github-broker-test','owner-account','Owner / 1234567',
    '1234','{"contents":"read","metadata":"read"}'::jsonb,'selected');
  IF (v_result->>'status')<>'connected' THEN RAISE EXCEPTION 'activation did not connect: %',v_result; END IF;

  -- Broker refreshes the installation repository cache.
  v_result := refresh_github_installation_repositories(v_connection_id,'github-broker-test',
    jsonb_build_array(
      jsonb_build_object('github_repository_id','9991','full_name','owner/private-repo','private',true,
        'archived',false,'default_branch','main','clone_url','https://github.com/owner/private-repo.git'),
      jsonb_build_object('github_repository_id','9992','full_name','owner/legacy','private',false,
        'archived',true,'default_branch','main','clone_url','https://github.com/owner/legacy.git')
    ));
  IF (v_result->>'repositories_refreshed')<>'2' THEN RAISE EXCEPTION 'repository refresh count wrong: %',v_result; END IF;

  -- Owner sees repositories; other operator sees none even with the owner connection id.
  v_result := list_operator_github_repositories(v_owner,v_connection_id,'',100);
  IF jsonb_array_length(v_result)<>2 THEN RAISE EXCEPTION 'owner should see 2 repositories'; END IF;
  IF (v_result->0->>'full_name')<>'owner/private-repo' THEN RAISE EXCEPTION 'non-archived should sort first, got %',v_result->0; END IF;
  v_result := list_operator_github_repositories(v_other,v_connection_id,'',100);
  IF jsonb_array_length(v_result)<>0 THEN RAISE EXCEPTION 'other operator must not see owner repositories'; END IF;
  v_result := list_operator_github_repositories(v_owner,v_connection_id,'private',100);
  IF jsonb_array_length(v_result)<>1 OR (v_result->0->>'full_name')<>'owner/private-repo' THEN
    RAISE EXCEPTION 'repository search failed: %',v_result;
  END IF;

  -- Cross-operator github binding guard: a repo from another operator's connection is not visible.
  SELECT count(*) INTO v_count FROM provider_installation_repositories r
    JOIN provider_connections c ON c.id=r.connection_id
    WHERE c.operator_id=v_other AND r.connection_id=v_connection_id;
  IF v_count<>0 THEN RAISE EXCEPTION 'cross-operator repository join leaked'; END IF;

  -- Create a github_app project and run the broker clone completion path.
  INSERT INTO projects(id,owner_id,name,slug,workspace_path,repository_url,default_branch,status,settings,
    credential_mode,provider_connection_id,github_repository_id,repository_full_name)
  VALUES(gen_random_uuid(),v_owner,'GitHub App Project','github-app-project','/srv/github-app-project',
    'https://github.com/owner/private-repo.git','main','needs_attention',
    '{"provisioning_status":"pending","provisioning_source":"clone"}',
    'github_app',v_connection_id,9991,'owner/private-repo')
  RETURNING id INTO v_project;

  v_result := claim_github_app_clone_projects('github-broker-test',1);
  IF jsonb_array_length(v_result)<>1 OR (v_result->0->>'project_id')<>v_project::text
     OR (v_result->0->>'installation_id')<>'1234567' THEN
    RAISE EXCEPTION 'clone claim did not return the github_app project: %',v_result;
  END IF;
  v_result := complete_github_app_clone(v_project,'github-broker-test');
  IF (v_result->>'status')<>'active' THEN RAISE EXCEPTION 'clone completion did not activate project: %',v_result; END IF;
  IF NOT EXISTS(SELECT 1 FROM domain_events WHERE project_id=v_project AND event_type='project.provisioned') THEN
    RAISE EXCEPTION 'project.provisioned event missing after github_app clone';
  END IF;

  -- Failed clone must fail closed with normalized provisioning error.
  INSERT INTO projects(id,owner_id,name,slug,workspace_path,repository_url,default_branch,status,settings,
    credential_mode,provider_connection_id,github_repository_id,repository_full_name)
  VALUES(gen_random_uuid(),v_owner,'GitHub App Fail','github-app-fail','/srv/github-app-fail',
    'https://github.com/owner/missing.git','main','needs_attention',
    '{"provisioning_status":"pending","provisioning_source":"clone"}',
    'github_app',v_connection_id,9993,'owner/missing');
  v_result := claim_github_app_clone_projects('github-broker-test',1);
  v_result := fail_github_app_clone((v_result->0->>'project_id')::uuid,'github-broker-test',
    'This repository is no longer available to the GitHub App.');
  IF (v_result->>'status')<>'needs_attention' THEN RAISE EXCEPTION 'failed clone should stay needs_attention: %',v_result; END IF;
  SELECT settings->>'provisioning_error' INTO v_text FROM projects WHERE id=(v_result->>'project_id')::uuid;
  IF v_text IS NULL OR v_text NOT ILIKE '%no longer available%' THEN
    RAISE EXCEPTION 'failed clone error not normalized: %',v_text;
  END IF;

  -- Verify request + claim as verify work.
  v_result := request_github_verify(v_connection_id,v_owner,'corr-verify');
  IF (v_result->>'status')<>'action_required' THEN RAISE EXCEPTION 'verify request should set action_required'; END IF;
  v_result := claim_github_connection_work('github-broker-test',5);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_result) el WHERE el->>'connection_id'=v_connection_id::text
     AND el->>'work_kind'='verify') THEN
    RAISE EXCEPTION 'verify work not claimed: %',v_result;
  END IF;

  -- Disconnect by owner.
  v_result := disconnect_github_connection(v_connection_id,v_owner,'corr-disc');
  IF (v_result->>'status')<>'disconnected' THEN RAISE EXCEPTION 'disconnect did not set disconnected'; END IF;
  BEGIN
    PERFORM request_github_verify(v_connection_id,v_owner,'corr-after');
    RAISE EXCEPTION 'verify on disconnected should fail';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%Disconnected%' THEN RAISE EXCEPTION 'unexpected disconnected verify error: %',SQLERRM; END IF;
  END;

  RAISE NOTICE 'github app connections assertions passed';
END $$;

ROLLBACK;
