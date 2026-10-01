-- Workspace provisioning through the Runtime Supervisor.
--
-- See docs/adr/0011-self-hosted-access-model.md, decision 3. Today
-- project-provisioner runs as codex-poc so it can chown the workspace to
-- itself, which means the sandboxed agent's OS account also carries the
-- provisioner's database access. Moving the privileged filesystem work behind
-- workspace_operations is what lets that unit run as infra-control instead.
--
-- This migration only adds the contract. The supervisor and the provisioner are
-- rewired on top of it.
--
-- Note for future migrations: from 0039 onward a migration contains no
-- transaction-control statements. migrate.mjs wraps the file together with its
-- verification and its ledger row in one transaction, which is what makes a
-- failed migration leave nothing behind. It refuses a file that opens its own.

SET search_path TO control_plane, public, extensions;

-- ---------------------------------------------------------- operations ----

ALTER TABLE workspace_operations
  DROP CONSTRAINT workspace_operations_operation_type_check;

ALTER TABLE workspace_operations
  ADD CONSTRAINT workspace_operations_operation_type_check
    CHECK (operation_type IN (
      -- Operator-initiated repairs, requested through request_workspace_operation.
      'recover_lock', 'restore_owner',
      -- System-initiated, requested through request_workspace_provisioning.
      'provision_workspace', 'inspect_workspace'));

-- Distinguishes the two request paths without reading the operation type at
-- every call site, and lets the supervisor refuse an operator-requested type
-- arriving through the system path and the reverse.
CREATE OR REPLACE FUNCTION workspace_operation_is_system(p_operation_type text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_operation_type IN ('provision_workspace','inspect_workspace');
$$;

ALTER FUNCTION workspace_operation_is_system(text)
  SET search_path=control_plane,public,extensions,pg_temp;

-- --------------------------------------------------------- system path ----

-- The system counterpart of request_workspace_operation. That one is
-- operator-facing and enforces lock preconditions that make no sense here: a
-- brand new project has no lock history, and provisioning is not a repair.
-- Keeping them separate means neither set of preconditions can be bypassed by
-- choosing the other entry point.
CREATE OR REPLACE FUNCTION request_workspace_provisioning(
  p_project_id uuid, p_operation_type text, p_worker_id text,
  p_correlation_id text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_project projects%ROWTYPE;
  v_operation workspace_operations%ROWTYPE;
BEGIN
  IF NOT workspace_operation_is_system(p_operation_type) THEN
    RAISE EXCEPTION 'operation type % is not a system workspace operation', p_operation_type
      USING ERRCODE='22023';
  END IF;
  IF length(trim(coalesce(p_worker_id,'')))<2 THEN
    RAISE EXCEPTION 'invalid worker id' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_project FROM projects WHERE id=p_project_id FOR UPDATE;
  IF NOT FOUND OR v_project.status='archived' THEN
    RAISE EXCEPTION 'project is unavailable' USING ERRCODE='55000';
  END IF;

  -- provision_workspace removes and recreates the workspace, so it must never
  -- run against a project that still has runtime work in flight. inspect is
  -- read-only and needs no such fence.
  IF p_operation_type='provision_workspace'
     AND EXISTS (SELECT 1 FROM runtime_jobs
                 WHERE project_id=p_project_id AND status IN ('pending','in_flight')) THEN
    RAISE EXCEPTION 'workspace has active or pending runtime work' USING ERRCODE='55000';
  END IF;

  INSERT INTO workspace_operations(project_id,operation_type,requested_by,reason,correlation_id)
  VALUES (p_project_id,p_operation_type,p_worker_id,
          CASE p_operation_type
            WHEN 'provision_workspace' THEN 'materialise the project workspace'
            ELSE 'collect workspace state'
          END,
          coalesce(p_correlation_id,''))
  RETURNING * INTO v_operation;

  PERFORM write_audit_event(p_project_id,NULL,NULL,'system',p_worker_id,
    'workspace.provisioning_requested','workspace_operation',v_operation.id::text,'allowed',NULL,
    jsonb_build_object('operation_type',p_operation_type),coalesce(p_correlation_id,''));

  RETURN jsonb_build_object('operation_id',v_operation.id,'status',v_operation.status,
                            'operation_type',v_operation.operation_type);
END $$;

ALTER FUNCTION request_workspace_provisioning(uuid,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;

-- Lets the requester wait for the supervisor without reading the table
-- directly, and without granting it any wider view of other projects' work.
CREATE OR REPLACE FUNCTION workspace_operation_state(p_operation_id uuid, p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_operation workspace_operations%ROWTYPE;
BEGIN
  SELECT * INTO v_operation FROM workspace_operations
  WHERE id=p_operation_id AND requested_by=p_worker_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'operation_id',v_operation.id,'project_id',v_operation.project_id,
    'operation_type',v_operation.operation_type,'status',v_operation.status,
    'result',v_operation.result,'error',v_operation.error,
    'requested_at',v_operation.requested_at,'completed_at',v_operation.completed_at);
END $$;

ALTER FUNCTION workspace_operation_state(uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;

-- ------------------------------------------------------- claim context ----

-- The supervisor needs everything required to materialise a workspace, because
-- the provisioner no longer touches the filesystem. Repository, branch and the
-- deploy-key locator come from here rather than from the request, so a claimed
-- operation cannot be pointed at another project's repository or credential.
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

  UPDATE workspace_operations SET status='running',worker_id=p_worker_id,started_at=clock_timestamp(),
    error=NULL WHERE id=v_operation.id RETURNING * INTO v_operation;

  SELECT * INTO v_project FROM projects WHERE id=v_operation.project_id;
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
    'credential_locator',v_credential);
END $$;

ALTER FUNCTION claim_workspace_operation(text)
  SET search_path=control_plane,public,extensions,pg_temp;

-- The provisioner is a worker, not an operator. infra_web gets nothing here:
-- provisioning is system-initiated and the operator surface is unchanged.
REVOKE ALL ON FUNCTION request_workspace_provisioning(uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION workspace_operation_state(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION workspace_operation_is_system(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_workspace_provisioning(uuid,text,text,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION workspace_operation_state(uuid,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION workspace_operation_is_system(text) TO infra_worker;
