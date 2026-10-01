\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_owner uuid;
  v_project uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_codex uuid;
  v_agent uuid;
  v_task uuid := gen_random_uuid();
  v_event uuid;
  v_result jsonb;
  v_claimed jsonb;
  v_operation uuid;
  v_version bigint;
BEGIN
  INSERT INTO users(display_name) VALUES('Provisioning Test') RETURNING id INTO v_owner;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('codex','t','t','openai','provisioning-test',clock_timestamp()) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('orchestrator-provisioning-test','architect',v_codex) RETURNING id INTO v_agent;

  INSERT INTO projects(id,owner_id,name,slug,workspace_path,repository_url,default_branch,status,settings,credential_mode)
  VALUES(v_project,v_owner,'Provisioning Test','provisioning-test','/srv/test/'||v_project,
         'https://github.com/example/repo','main','needs_attention',
         '{"provisioning_status":"pending"}'::jsonb,'deploy_key');
  INSERT INTO workspace_locks(project_id) VALUES(v_project);

  -- ------------------------------------------------ the two request paths ----

  -- An operator repair type must not be reachable through the system path.
  BEGIN
    PERFORM request_workspace_provisioning(v_project,'recover_lock','provisioner-1');
    RAISE EXCEPTION 'the system path accepted an operator repair type';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;

  -- ...and a system type must not be reachable through the operator path,
  -- whose lock preconditions do not apply to provisioning.
  BEGIN
    PERFORM request_workspace_operation(v_project,'provision_workspace','operator','because','');
    RAISE EXCEPTION 'the operator path accepted a system provisioning type';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;

  BEGIN
    PERFORM request_workspace_provisioning(v_project,'provision_workspace','x');
    RAISE EXCEPTION 'a one-character worker id was accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;

  -- ------------------------------------------------------------ requests ----

  v_result := request_workspace_provisioning(v_project,'provision_workspace','provisioner-1','corr-1');
  v_operation := (v_result->>'operation_id')::uuid;
  IF (v_result->>'status') <> 'pending' THEN
    RAISE EXCEPTION 'a new provisioning operation was not pending';
  END IF;

  -- The request is audited as system-initiated, not as an operator action.
  IF NOT EXISTS (SELECT 1 FROM audit_events
                 WHERE target_id=v_operation::text AND actor_type='system'
                   AND action='workspace.provisioning_requested') THEN
    RAISE EXCEPTION 'the provisioning request was not audited as system-initiated';
  END IF;

  -- One active operation per project.
  BEGIN
    PERFORM request_workspace_provisioning(v_project,'inspect_workspace','provisioner-1');
    RAISE EXCEPTION 'a second active operation was accepted for one project';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- --------------------------------------------------------- claim context ----

  v_claimed := claim_workspace_operation('supervisor-1');
  IF (v_claimed->>'id')::uuid <> v_operation THEN
    RAISE EXCEPTION 'the supervisor claimed a different operation';
  END IF;

  -- Everything needed to materialise the workspace comes from the claim, so the
  -- supervisor never takes a repository or a credential from the request.
  IF (v_claimed->>'repository_url') <> 'https://github.com/example/repo' THEN
    RAISE EXCEPTION 'the claim did not carry the repository url';
  END IF;
  IF (v_claimed->>'default_branch') <> 'main' THEN
    RAISE EXCEPTION 'the claim did not carry the default branch';
  END IF;
  IF (v_claimed->>'credential_mode') <> 'deploy_key' THEN
    RAISE EXCEPTION 'the claim did not carry the credential mode';
  END IF;
  IF (v_claimed->>'workspace_path') <> '/srv/test/'||v_project THEN
    RAISE EXCEPTION 'the claim did not carry the workspace path';
  END IF;
  IF v_claimed ? 'credential_locator' AND (v_claimed->>'credential_locator') IS NOT NULL THEN
    RAISE EXCEPTION 'a credential locator appeared with no active deploy key';
  END IF;

  -- With an active deploy key the locator is resolved from the database.
  INSERT INTO credential_references(project_id,provider,secret_locator,status,allowed_actions,version)
  VALUES(v_project,'github_deploy_key','/etc/infra-cod/github-deploy-keys/'||v_project,
         'active',ARRAY['clone'],1);

  PERFORM finish_workspace_operation(v_operation,'supervisor-1',true,'{}'::jsonb,NULL);
  v_result := request_workspace_provisioning(v_project,'provision_workspace','provisioner-1','corr-2');
  v_operation := (v_result->>'operation_id')::uuid;
  v_claimed := claim_workspace_operation('supervisor-1');
  IF (v_claimed->>'credential_locator') <> '/etc/infra-cod/github-deploy-keys/'||v_project THEN
    RAISE EXCEPTION 'the claim did not resolve the active deploy key locator';
  END IF;

  -- ------------------------------------------------------------- state ----

  IF (workspace_operation_state(v_operation,'provisioner-1')->>'status') <> 'running' THEN
    RAISE EXCEPTION 'the requester cannot observe its own operation';
  END IF;
  -- Another worker's operation is not readable through this function.
  IF workspace_operation_state(v_operation,'someone-else') IS NOT NULL THEN
    RAISE EXCEPTION 'an operation was readable by a worker that did not request it';
  END IF;

  PERFORM finish_workspace_operation(v_operation,'supervisor-1',true,
    '{"owner":"codex-worker"}'::jsonb,NULL);
  v_result := workspace_operation_state(v_operation,'provisioner-1');
  IF (v_result->>'status') <> 'completed' THEN
    RAISE EXCEPTION 'a finished operation did not report completed';
  END IF;
  IF (v_result->'result'->>'owner') <> 'codex-worker' THEN
    RAISE EXCEPTION 'the operation result was not returned to the requester';
  END IF;

  -- --------------------------------------------- the destructive fence ----

  -- provision_workspace removes and recreates the workspace, so it must not run
  -- while runtime work is in flight. inspect_workspace is read-only.
  INSERT INTO tasks(id,project_id,title,objective,status,active_agent_id,created_by)
  VALUES(v_task,v_project,'t','o','planning',v_agent,'test');
  INSERT INTO domain_events(
    event_type,project_id,task_id,actor_type,actor_id,correlation_id,
    aggregate_type,aggregate_id,aggregate_version,payload
  ) VALUES(
    'implementation.requested',v_project,v_task,'system','provisioning-test',
    'provisioning-correlation','task',v_task,1,'{}'::jsonb
  ) RETURNING id INTO v_event;
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
  VALUES(v_event,'implementation_run',v_project,v_task,'{}'::jsonb);

  BEGIN
    PERFORM request_workspace_provisioning(v_project,'provision_workspace','provisioner-1');
    RAISE EXCEPTION 'provisioning was accepted with runtime work in flight';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;

  IF request_workspace_provisioning(v_project,'inspect_workspace','provisioner-1') IS NULL THEN
    RAISE EXCEPTION 'read-only inspection was blocked by runtime work';
  END IF;

  -- ------------------------------------------------------ archived project ----

  DELETE FROM runtime_jobs WHERE project_id=v_project;
  DELETE FROM workspace_operations WHERE project_id=v_project;
  UPDATE projects SET status='archived' WHERE id=v_project;
  BEGIN
    PERFORM request_workspace_provisioning(v_project,'inspect_workspace','provisioner-1');
    RAISE EXCEPTION 'an archived project accepted a provisioning request';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;

  -- An unknown project is refused rather than silently creating an operation.
  BEGIN
    PERFORM request_workspace_provisioning(v_other,'inspect_workspace','provisioner-1');
    RAISE EXCEPTION 'an unknown project accepted a provisioning request';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;

  -- ------------------------------------------- completion semantics ----

  -- A system operation reports on itself and nothing else. finish_workspace_
  -- operation used to treat everything that was not recover_lock as an
  -- ownership repair: it bumped projects.version and appended
  -- workspace.ownership_restored. Applied to inspection, which runs every
  -- twenty seconds and changes nothing, that invalidated every expected_version
  -- the product holds and recorded a repair that never happened.
  DELETE FROM workspace_operations WHERE project_id=v_project;
  UPDATE projects SET status='needs_attention' WHERE id=v_project;
  SELECT version INTO v_version FROM projects WHERE id=v_project;

  v_result := request_workspace_provisioning(v_project,'inspect_workspace','provisioner-1');
  v_operation := (v_result->>'operation_id')::uuid;
  PERFORM claim_workspace_operation('supervisor-1');
  PERFORM finish_workspace_operation(v_operation,'supervisor-1',true,'{"branch":"main"}'::jsonb,NULL);

  IF (SELECT version FROM projects WHERE id=v_project) <> v_version THEN
    RAISE EXCEPTION 'inspection bumped the project version from % to %',
      v_version, (SELECT version FROM projects WHERE id=v_project);
  END IF;
  IF EXISTS (SELECT 1 FROM domain_events
             WHERE project_id=v_project AND event_type='workspace.ownership_restored') THEN
    RAISE EXCEPTION 'inspection emitted a workspace repair event';
  END IF;
  -- It is still audited, so the operation is not invisible.
  IF NOT EXISTS (SELECT 1 FROM audit_events
                 WHERE target_id=v_operation::text AND action='workspace.operation_completed') THEN
    RAISE EXCEPTION 'inspection was not audited';
  END IF;

  -- Provisioning is the same: the requester records the project outcome, so
  -- completion here must not move the project either.
  v_result := request_workspace_provisioning(v_project,'provision_workspace','provisioner-1');
  v_operation := (v_result->>'operation_id')::uuid;
  PERFORM claim_workspace_operation('supervisor-1');
  PERFORM finish_workspace_operation(v_operation,'supervisor-1',true,'{"owner":"codex-worker"}'::jsonb,NULL);
  IF (SELECT version FROM projects WHERE id=v_project) <> v_version THEN
    RAISE EXCEPTION 'provisioning completion bumped the project version';
  END IF;

  -- The operator repair path keeps the behaviour it had.
  UPDATE workspace_locks SET status='released' WHERE project_id=v_project;
  v_result := request_workspace_operation(v_project,'restore_owner','operator','manual repair','corr-r');
  v_operation := (v_result->>'operation_id')::uuid;
  PERFORM claim_workspace_operation('supervisor-1');
  PERFORM finish_workspace_operation(v_operation,'supervisor-1',true,'{}'::jsonb,NULL);
  IF (SELECT version FROM projects WHERE id=v_project) <= v_version THEN
    RAISE EXCEPTION 'an operator repair no longer bumps the project version';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM domain_events
                 WHERE project_id=v_project AND event_type='workspace.ownership_restored') THEN
    RAISE EXCEPTION 'an operator repair no longer emits its event';
  END IF;

  -- ------------------------------------------------ the deletion fence ----

  -- The lifecycle is checked when an operation is created; deletion can start
  -- afterwards. A claim must then fail the operation rather than let the
  -- supervisor touch a workspace cleanup is about to remove.
  DELETE FROM workspace_operations WHERE project_id=v_project;
  UPDATE projects SET status='needs_attention',
    settings=jsonb_set(settings,'{provisioning_status}','"provisioning"'::jsonb,true)
  WHERE id=v_project;
  v_result := request_workspace_provisioning(v_project,'provision_workspace','provisioner-1');
  v_operation := (v_result->>'operation_id')::uuid;

  -- projects_deleting_timestamps requires the deletion stamps to be consistent.
  UPDATE projects SET status='deleting',
    deletion_requested_at=clock_timestamp(), deletion_not_before=clock_timestamp()
  WHERE id=v_project;

  IF claim_workspace_operation('supervisor-1') IS NOT NULL THEN
    RAISE EXCEPTION 'an operation was claimed for a project that entered deletion';
  END IF;
  IF (SELECT status FROM workspace_operations WHERE id=v_operation) <> 'failed' THEN
    RAISE EXCEPTION 'the operation was not failed when its project entered deletion';
  END IF;

  -- And the outcome writers refuse to move a deleting project in either
  -- direction, which a plain UPDATE keyed on the project id would have done.
  IF complete_project_provisioning(v_project,'provisioner-1','corr-x') IS NOT NULL THEN
    RAISE EXCEPTION 'a deleting project was activated by provisioning completion';
  END IF;
  IF fail_project_provisioning(v_project,'boom') IS NOT NULL THEN
    RAISE EXCEPTION 'a deleting project was pulled back to needs_attention';
  END IF;
  IF (SELECT status FROM projects WHERE id=v_project) <> 'deleting' THEN
    RAISE EXCEPTION 'the deleting project was moved to %',
      (SELECT status FROM projects WHERE id=v_project);
  END IF;

  -- --------------------------------- the fence outlives the transaction ----

  -- claim_workspace_operation takes a row lock, and that lock is gone the
  -- moment the claim commits. The supervisor then works on the filesystem with
  -- nothing holding the project, so cleanup has to see a running system
  -- operation as a writer in its own right.
  UPDATE projects SET status='needs_attention',
    deletion_requested_at=NULL, deletion_not_before=NULL WHERE id=v_project;
  DELETE FROM workspace_operations WHERE project_id=v_project;

  IF EXISTS (SELECT 1 FROM active_workspace_operations(v_project)) THEN
    RAISE EXCEPTION 'a project with no operations reported an active one';
  END IF;

  v_result := request_workspace_provisioning(v_project,'provision_workspace','provisioner-1');
  v_operation := (v_result->>'operation_id')::uuid;

  -- Pending counts: the supervisor may claim it at any moment.
  IF NOT EXISTS (SELECT 1 FROM active_workspace_operations(v_project)) THEN
    RAISE EXCEPTION 'a pending system operation was not reported to cleanup';
  END IF;

  PERFORM claim_workspace_operation('supervisor-1');
  IF NOT EXISTS (SELECT 1 FROM active_workspace_operations(v_project)) THEN
    RAISE EXCEPTION 'a running system operation was not reported to cleanup';
  END IF;

  -- A claim older than the supervisor's own reclaim window is reported as
  -- stale, so cleanup asks for reconciliation instead of assuming it is gone.
  UPDATE workspace_operations SET started_at=clock_timestamp()-interval '10 minutes'
  WHERE id=v_operation;
  IF NOT (SELECT (op->>'stale')::boolean FROM active_workspace_operations(v_project) op) THEN
    RAISE EXCEPTION 'a long-running operation was not reported as stale';
  END IF;

  PERFORM finish_workspace_operation(v_operation,'supervisor-1',true,'{}'::jsonb,NULL);
  IF EXISTS (SELECT 1 FROM active_workspace_operations(v_project)) THEN
    RAISE EXCEPTION 'a finished operation is still reported as active';
  END IF;

  -- An operator repair is not a system operation and is not reported here; it
  -- has its own preconditions in the operator path.
  UPDATE workspace_locks SET status='released' WHERE project_id=v_project;
  v_result := request_workspace_operation(v_project,'restore_owner','operator','repair','corr-s');
  IF EXISTS (SELECT 1 FROM active_workspace_operations(v_project)) THEN
    RAISE EXCEPTION 'an operator repair was reported as a system operation';
  END IF;
  DELETE FROM workspace_operations WHERE project_id=v_project;

  -- ------------------------------------------------ archived is refused ----

  UPDATE projects SET status='archived' WHERE id=v_project;
  INSERT INTO workspace_operations(project_id,operation_type,requested_by,reason,correlation_id)
  VALUES(v_project,'inspect_workspace','provisioner-1','collect workspace state','corr-a');

  IF claim_workspace_operation('supervisor-1') IS NOT NULL THEN
    RAISE EXCEPTION 'an operation was claimed for an archived project';
  END IF;
  IF (SELECT status FROM workspace_operations WHERE project_id=v_project) <> 'failed' THEN
    RAISE EXCEPTION 'the operation was not failed when its project was archived';
  END IF;
  UPDATE projects SET status='needs_attention' WHERE id=v_project;
  DELETE FROM workspace_operations WHERE project_id=v_project;

  -- --------------------------------------- busy is not a failed deletion ----

  -- Cleanup refuses to run while a system workspace operation is active, and
  -- inspection runs every twenty seconds per project, so that collision is
  -- routine. Releasing hands the claim back with nothing else changed; failing
  -- would park the project in deletion_failed for an operator.
  UPDATE projects SET status='deleting',
    deletion_requested_at=clock_timestamp(), deletion_not_before=clock_timestamp(),
    cleanup_leased_by='deprovision-1', cleanup_leased_until=clock_timestamp()+interval '5 minutes'
  WHERE id=v_project;

  v_result := release_project_cleanup(v_project,'deprovision-1','an operation is running');
  IF v_result IS NULL THEN RAISE EXCEPTION 'the cleanup claim could not be released'; END IF;

  IF (SELECT status FROM projects WHERE id=v_project) <> 'deleting' THEN
    RAISE EXCEPTION 'releasing the claim changed the project status to %',
      (SELECT status FROM projects WHERE id=v_project);
  END IF;
  IF (SELECT cleanup_leased_by FROM projects WHERE id=v_project) IS NOT NULL THEN
    RAISE EXCEPTION 'releasing the claim left the lease in place';
  END IF;
  IF (SELECT deletion_requested_at FROM projects WHERE id=v_project) IS NULL THEN
    RAISE EXCEPTION 'releasing the claim cleared the deletion request';
  END IF;
  -- Visible, so a project that keeps colliding is not merely slow.
  IF NOT EXISTS (SELECT 1 FROM audit_events
                 WHERE target_id=v_project::text AND action='project.cleanup_deferred') THEN
    RAISE EXCEPTION 'the deferred cleanup was not recorded';
  END IF;

  -- Only the holder can release, and only while the project is deleting.
  IF release_project_cleanup(v_project,'someone-else','x') IS NOT NULL THEN
    RAISE EXCEPTION 'a worker released a cleanup claim it does not hold';
  END IF;

  UPDATE projects SET status='needs_attention',
    deletion_requested_at=NULL, deletion_not_before=NULL WHERE id=v_project;

  RAISE NOTICE 'workspace provisioning contract assertions passed';
END $$;

-- The provisioning surface belongs to the worker role. infra_web must not be
-- able to schedule filesystem work.
SET ROLE infra_web;
DO $$
BEGIN
  BEGIN
    PERFORM request_workspace_provisioning(gen_random_uuid(),'provision_workspace','probe');
    RAISE EXCEPTION 'infra_web can request workspace provisioning';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN others THEN RAISE EXCEPTION 'infra_web reached request_workspace_provisioning: %', SQLERRM;
  END;
  RAISE NOTICE 'infra_web cannot schedule workspace provisioning';
END $$;
RESET ROLE;

ROLLBACK;
