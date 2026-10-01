-- Holds the deletion fence for the duration of the filesystem work.
--
-- 0040 made claim_workspace_operation refuse a system operation whose project
-- had entered deletion, but that check is a row lock inside one SQL
-- transaction: it is released the moment the claim commits. The supervisor then
-- does its filesystem work with nothing holding the fence, so deletion can
-- start and deprovision_project can remove the workspace while provisioning is
-- recreating it. The compare-and-set writers added in 0040 protect the projects
-- row; nothing protected the directory.
--
-- A running system operation is therefore a writer, in the same sense as a
-- runtime launch reservation: deprovision refuses to enter its filesystem phase
-- while one exists, and fails closed rather than racing it.

SET search_path TO control_plane, public, extensions;

-- Reported to the supervisor's deprovision writer scan.
CREATE OR REPLACE FUNCTION active_workspace_operations(p_project_id uuid)
RETURNS SETOF jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'operation_id',op.id,'operation_type',op.operation_type,'status',op.status,
    'worker_id',op.worker_id,'requested_by',op.requested_by,
    'started_at',op.started_at,
    -- A claim that has been running longer than the supervisor's own reclaim
    -- window is stale; cleanup reports it for reconciliation rather than
    -- assuming it is gone.
    'stale',op.status='running' AND op.started_at<clock_timestamp()-interval '5 minutes')
  FROM workspace_operations op
  WHERE op.project_id=p_project_id
    AND op.status IN ('pending','running')
    AND workspace_operation_is_system(op.operation_type)
  ORDER BY op.requested_at;
$$;

ALTER FUNCTION active_workspace_operations(uuid)
  SET search_path=control_plane,public,extensions,pg_temp;

-- claim also has to refuse an archived project, which 0040 missed: archived is
-- not deletion, but it is not a project that should have work done to its
-- workspace either.
CREATE OR REPLACE FUNCTION claim_workspace_operation(p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_operation workspace_operations%ROWTYPE;
  v_project projects%ROWTYPE;
  v_lock workspace_locks%ROWTYPE;
  v_run task_runs%ROWTYPE;
  v_credential text;
  v_refusal text;
BEGIN
  SELECT * INTO v_operation FROM workspace_operations
    WHERE status='pending' OR (status='running' AND started_at<clock_timestamp()-interval '5 minutes')
    ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO v_project FROM projects WHERE id=v_operation.project_id FOR UPDATE;

  IF workspace_operation_is_system(v_operation.operation_type) THEN
    IF v_project.status IN ('deleting','deletion_failed','deleted') THEN
      v_refusal := 'project entered deletion before the operation ran';
    ELSIF v_project.status='archived' THEN
      v_refusal := 'project was archived before the operation ran';
    END IF;
  END IF;

  IF v_refusal IS NOT NULL THEN
    UPDATE workspace_operations SET status='failed',error=v_refusal,
      worker_id=p_worker_id,completed_at=clock_timestamp()
    WHERE id=v_operation.id;
    PERFORM write_audit_event(v_operation.project_id,NULL,NULL,'system',p_worker_id,
      'workspace.operation_failed','workspace_operation',v_operation.id::text,'denied',NULL,
      jsonb_build_object('operation_type',v_operation.operation_type,'error',v_refusal),
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

REVOKE ALL ON FUNCTION active_workspace_operations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION active_workspace_operations(uuid) TO infra_worker;
