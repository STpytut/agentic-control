-- Completion and claim semantics for system workspace operations.
--
-- 0039 added provision_workspace and inspect_workspace to the operation types
-- but left finish_workspace_operation unchanged, and that function treats every
-- successful operation that is not recover_lock as an ownership repair: it bumps
-- projects.version and appends workspace.ownership_restored. Applied to the new
-- types that means an inspection — which runs every twenty seconds per project
-- and changes nothing — silently invalidates every expected_version the web
-- layer holds, and emits a repair event that never happened. Provisioning bumps
-- the version twice, once here and once in the provisioner's own update.
--
-- It also left the project lifecycle checked only when an operation is created.
-- A project can enter deleting afterwards, and the operation would still run and
-- then be reported as a completed provisioning, putting the project back to
-- active.

SET search_path TO control_plane, public, extensions;

-- ------------------------------------------------------------- completion ----

CREATE OR REPLACE FUNCTION finish_workspace_operation(
  p_operation_id uuid, p_worker_id text, p_success boolean, p_result jsonb,
  p_error text DEFAULT NULL::text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_operation workspace_operations%ROWTYPE;
  v_project projects%ROWTYPE;
  v_event domain_events%ROWTYPE;
BEGIN
  SELECT * INTO v_operation FROM workspace_operations WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.status<>'running' OR v_operation.worker_id<>p_worker_id THEN
    RAISE EXCEPTION 'workspace operation is not owned by worker' USING ERRCODE='55000';
  END IF;

  IF NOT p_success THEN
    UPDATE workspace_operations SET status='failed',error=left(COALESCE(p_error,'operation failed'),1000),
      completed_at=clock_timestamp() WHERE id=v_operation.id RETURNING * INTO v_operation;
    PERFORM write_audit_event(v_operation.project_id,NULL,NULL,'system',p_worker_id,
      'workspace.operation_failed','workspace_operation',v_operation.id::text,'denied',NULL,
      jsonb_build_object('operation_type',v_operation.operation_type,'error',v_operation.error),
      v_operation.correlation_id);
    RETURN jsonb_build_object('operation_id',v_operation.id,'status',v_operation.status,
      'operation_type',v_operation.operation_type,'error',v_operation.error);
  END IF;

  -- System operations report only on themselves. Provisioning's effect on the
  -- project is recorded by the requester, which knows what it asked for;
  -- inspection has no effect on the project at all. Neither may touch
  -- projects.version, or every optimistic-concurrency check in the product
  -- starts failing for reasons the operator cannot see.
  IF workspace_operation_is_system(v_operation.operation_type) THEN
    UPDATE workspace_operations SET status='completed',result=COALESCE(p_result,'{}'::jsonb),
      completed_at=clock_timestamp() WHERE id=v_operation.id RETURNING * INTO v_operation;
    PERFORM write_audit_event(v_operation.project_id,NULL,NULL,'system',p_worker_id,
      'workspace.operation_completed','workspace_operation',v_operation.id::text,'allowed',NULL,
      COALESCE(p_result,'{}'::jsonb)||jsonb_build_object('operation_type',v_operation.operation_type),
      v_operation.correlation_id);
    RETURN jsonb_build_object('operation_id',v_operation.id,'status',v_operation.status,
      'operation_type',v_operation.operation_type,'error',NULL);
  END IF;

  -- Operator repairs keep the behaviour they had: they do change the project.
  IF v_operation.operation_type='recover_lock' THEN
    UPDATE workspace_locks SET owner_run_id=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
      status='released',reason=NULL,version=version+1
    WHERE project_id=v_operation.project_id AND status='reconciliation_required';
    IF NOT FOUND THEN RAISE EXCEPTION 'workspace recovery precondition changed' USING ERRCODE='40001'; END IF;
  END IF;

  UPDATE projects SET status=CASE WHEN settings->>'provisioning_status'='ready' THEN 'active' ELSE status END,
    version=version+1,updated_at=clock_timestamp() WHERE id=v_operation.project_id RETURNING * INTO v_project;

  v_event:=append_event(
    CASE WHEN v_operation.operation_type='recover_lock'
      THEN 'workspace.recovered' ELSE 'workspace.ownership_restored' END,
    v_project.id,NULL,NULL,'system',p_worker_id,NULL,v_operation.correlation_id,
    'workspace-operation:'||v_operation.id,'project',v_project.id,v_project.version,
    COALESCE(p_result,'{}'::jsonb)||jsonb_build_object('operation_id',v_operation.id));

  UPDATE workspace_operations SET status='completed',result=COALESCE(p_result,'{}'::jsonb),
    completed_at=clock_timestamp() WHERE id=v_operation.id RETURNING * INTO v_operation;

  PERFORM write_audit_event(v_project.id,NULL,NULL,'system',p_worker_id,'workspace.operation_completed',
    'workspace_operation',v_operation.id::text,'allowed',NULL,
    COALESCE(p_result,'{}'::jsonb)||jsonb_build_object('operation_type',v_operation.operation_type),
    v_operation.correlation_id);

  RETURN jsonb_build_object('operation_id',v_operation.id,'status',v_operation.status,
    'operation_type',v_operation.operation_type,'error',v_operation.error);
END $$;

ALTER FUNCTION finish_workspace_operation(uuid,text,boolean,jsonb,text)
  SET search_path=control_plane,public,extensions,pg_temp;

-- ------------------------------------------------------------ claim fence ----

-- The lifecycle was checked when the operation was created; deletion can start
-- afterwards. A system operation claimed against a project that has since
-- entered deleting is failed rather than executed, so the supervisor never
-- touches a workspace that cleanup is about to remove.
CREATE OR REPLACE FUNCTION claim_workspace_operation(p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_operation workspace_operations%ROWTYPE;
  v_project projects%ROWTYPE;
  v_lock workspace_locks%ROWTYPE;
  v_run task_runs%ROWTYPE;
  v_credential text;
BEGIN
  SELECT * INTO v_operation FROM workspace_operations
    WHERE status='pending' OR (status='running' AND started_at<clock_timestamp()-interval '5 minutes')
    ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO v_project FROM projects WHERE id=v_operation.project_id FOR UPDATE;

  IF workspace_operation_is_system(v_operation.operation_type)
     AND v_project.status IN ('deleting','deletion_failed','deleted') THEN
    UPDATE workspace_operations SET status='failed',
      error='project entered deletion before the operation ran',
      worker_id=p_worker_id,completed_at=clock_timestamp()
    WHERE id=v_operation.id;
    PERFORM write_audit_event(v_operation.project_id,NULL,NULL,'system',p_worker_id,
      'workspace.operation_failed','workspace_operation',v_operation.id::text,'denied',NULL,
      jsonb_build_object('operation_type',v_operation.operation_type,
                         'error','project entered deletion before the operation ran'),
      v_operation.correlation_id);
    RETURN NULL;
  END IF;

  UPDATE workspace_operations SET status='running',worker_id=p_worker_id,started_at=clock_timestamp(),
    error=NULL WHERE id=v_operation.id RETURNING * INTO v_operation;

  SELECT * INTO v_lock FROM workspace_locks WHERE project_id=v_operation.project_id;

  IF v_lock.owner_run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM task_runs WHERE id=v_lock.owner_run_id;
  ELSIF v_operation.operation_type='recover_lock' THEN
    SELECT r.* INTO v_run FROM task_runs r JOIN tasks t ON t.id=r.task_id
      WHERE t.project_id=v_operation.project_id AND r.status='lost'
      ORDER BY r.finished_at DESC NULLS LAST,r.created_at DESC LIMIT 1;
  END IF;

  IF v_operation.operation_type='provision_workspace' THEN
    SELECT secret_locator INTO v_credential FROM credential_references
    WHERE project_id=v_project.id AND provider='github_deploy_key' AND status='active'
      AND 'clone' = ANY(allowed_actions)
    ORDER BY version DESC LIMIT 1;
  END IF;

  RETURN jsonb_build_object('id',v_operation.id,'project_id',v_operation.project_id,
    'operation_type',v_operation.operation_type,'workspace_path',v_project.workspace_path,
    'lock_status',v_lock.status,'owner_run_id',v_lock.owner_run_id,'process_ref',v_run.process_ref,
    'project_name',v_project.name,'repository_url',v_project.repository_url,
    'default_branch',v_project.default_branch,
    'credential_mode',COALESCE(v_project.credential_mode,'empty'),
    'credential_locator',v_credential,
    'project_status',v_project.status,'project_version',v_project.version);
END $$;

ALTER FUNCTION claim_workspace_operation(text)
  SET search_path=control_plane,public,extensions,pg_temp;

-- ---------------------------------------------------- provisioning outcome ----

-- Compare-and-set replacements for the provisioner's inline project updates.
-- Those matched on the project id alone, so a project that entered deletion
-- while the supervisor worked would be put back to active, or to
-- needs_attention on the failure path. Both now refuse to move a project that
-- is no longer the one they claimed.
CREATE OR REPLACE FUNCTION complete_project_provisioning(
  p_project_id uuid, p_worker_id text, p_correlation text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_project projects%ROWTYPE;
BEGIN
  UPDATE projects SET status='active',version=version+1,updated_at=clock_timestamp(),
    settings=jsonb_set(settings - 'provisioning_error','{provisioning_status}','"ready"'::jsonb,true)
  WHERE id=p_project_id
    AND status NOT IN ('deleting','deletion_failed','deleted','archived')
    AND settings->>'provisioning_status'='provisioning'
  RETURNING * INTO v_project;

  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM append_event('project.provisioned',v_project.id,NULL,NULL,'system',p_worker_id,NULL,
    p_correlation,'project-provisioned:'||v_project.id,'project',v_project.id,v_project.version,
    jsonb_build_object('workspace_path',v_project.workspace_path,
                       'repository_url',v_project.repository_url));

  RETURN jsonb_build_object('project_id',v_project.id,'status',v_project.status,
                            'version',v_project.version);
END $$;

ALTER FUNCTION complete_project_provisioning(uuid,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;

CREATE OR REPLACE FUNCTION fail_project_provisioning(
  p_project_id uuid, p_error text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_project projects%ROWTYPE;
BEGIN
  UPDATE projects SET status='needs_attention',updated_at=clock_timestamp(),
    settings=jsonb_set(jsonb_set(settings,'{provisioning_status}','"failed"'::jsonb,true),
      '{provisioning_error}',to_jsonb(left(coalesce(p_error,'provisioning failed'),1000)),true)
  WHERE id=p_project_id
    AND status NOT IN ('deleting','deletion_failed','deleted','archived')
  RETURNING * INTO v_project;

  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object('project_id',v_project.id,'status',v_project.status,
                            'error',v_project.settings->>'provisioning_error');
END $$;

ALTER FUNCTION fail_project_provisioning(uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;

REVOKE ALL ON FUNCTION complete_project_provisioning(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_project_provisioning(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_project_provisioning(uuid,text,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION fail_project_provisioning(uuid,text) TO infra_worker;
