-- Recovering a stale workspace lock is no longer refused by the Codex turns that
-- are waiting for it.
--
-- Found in the panel on rc.27. An implementation dead-lettered, and at its lease
-- expiry the reconciler put the project's lock in reconciliation_required. A new
-- task's Codex turn then waited, `pending` with no attempt spent — WP-3b's rule:
-- a turn does not read a workspace a writer may still be in. "Recover stale lock"
-- was refused with "workspace has active or pending runtime work", and the
-- pending work was that turn. The turn waited for the recovery, the recovery for
-- the turn, and no action in the panel could end it.
--
-- request_workspace_operation, from 0017, refused on any pending job — written
-- before a job could be pending *because* of the lock. What recovery must not
-- run beside is work in the workspace: a job in flight, or an implementation
-- about to take the lock. A pending read-only turn is neither; it is waiting for
-- exactly this, and starts once the lock is released. restore_owner keeps the
-- 0017 rule: it changes the tree's owner, which a pending turn about to start
-- would change too.
SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION request_workspace_operation(
  p_project_id uuid,p_operation_type text,p_actor_id text,p_reason text,p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_lock workspace_locks%ROWTYPE; v_operation workspace_operations%ROWTYPE;
BEGIN
  IF p_operation_type NOT IN ('recover_lock','restore_owner') OR length(trim(p_actor_id))<2
     OR length(trim(p_reason))<3 OR length(p_reason)>500 THEN
    RAISE EXCEPTION 'invalid workspace operation request' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM projects WHERE id=p_project_id AND status<>'archived' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project is unavailable' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_lock FROM workspace_locks WHERE project_id=p_project_id FOR UPDATE;
  IF p_operation_type='recover_lock' AND v_lock.status<>'reconciliation_required' THEN
    RAISE EXCEPTION 'workspace lock does not require reconciliation' USING ERRCODE='55000'; END IF;
  IF p_operation_type='restore_owner' AND v_lock.status<>'released' THEN
    RAISE EXCEPTION 'workspace ownership can only be restored while the lock is released' USING ERRCODE='55000'; END IF;
  IF EXISTS(
    SELECT 1 FROM runtime_jobs j
    WHERE j.project_id=p_project_id
      AND (j.status='in_flight'
           OR (j.status='pending' AND (p_operation_type<>'recover_lock' OR j.job_type='start_implementation')))
  ) THEN
    RAISE EXCEPTION 'workspace has active or pending runtime work' USING ERRCODE='55000',
      DETAIL=CASE WHEN p_operation_type='recover_lock'
        THEN 'recover_lock waits for work in flight and for a pending implementation; a pending read-only turn does not block it'
        ELSE 'restore_owner waits for all pending and in-flight work' END;
  END IF;
  INSERT INTO workspace_operations(project_id,operation_type,requested_by,reason,correlation_id)
  VALUES(p_project_id,p_operation_type,p_actor_id,trim(p_reason),p_correlation_id) RETURNING * INTO v_operation;
  PERFORM write_audit_event(p_project_id,NULL,NULL,'user',p_actor_id,'workspace.operation_requested',
    'workspace_operation',v_operation.id::text,'allowed',NULL,
    jsonb_build_object('operation_type',p_operation_type,'reason',trim(p_reason)),p_correlation_id);
  RETURN jsonb_build_object('operation_id',v_operation.id,'status',v_operation.status,
    'operation_type',v_operation.operation_type);
END; $$;

ALTER FUNCTION request_workspace_operation(uuid,text,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE EXECUTE ON FUNCTION request_workspace_operation(uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_workspace_operation(uuid,text,text,text,text) TO infra_web;

SELECT assert_web_functions_run_as_definer();
