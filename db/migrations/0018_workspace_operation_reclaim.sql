BEGIN;
SET search_path TO control_plane,public,extensions;

CREATE OR REPLACE FUNCTION claim_workspace_operation(p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_operation workspace_operations%ROWTYPE; v_project projects%ROWTYPE; v_lock workspace_locks%ROWTYPE; v_run task_runs%ROWTYPE;
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
  RETURN jsonb_build_object('id',v_operation.id,'project_id',v_operation.project_id,
    'operation_type',v_operation.operation_type,'workspace_path',v_project.workspace_path,
    'lock_status',v_lock.status,'owner_run_id',v_lock.owner_run_id,'process_ref',v_run.process_ref);
END; $$;

ALTER FUNCTION claim_workspace_operation(text)
  SET search_path=control_plane,public,extensions,pg_temp;
COMMIT;
