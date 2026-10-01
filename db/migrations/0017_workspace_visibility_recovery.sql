BEGIN;
SET search_path TO control_plane,public,extensions;

CREATE TABLE project_workspace_states (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  branch text NOT NULL DEFAULT '',
  head_sha text NOT NULL DEFAULT '',
  upstream text NOT NULL DEFAULT '',
  ahead integer NOT NULL DEFAULT 0 CHECK (ahead>=0),
  behind integer NOT NULL DEFAULT 0 CHECK (behind>=0),
  dirty boolean NOT NULL DEFAULT false,
  changed_files jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(changed_files)='array' AND octet_length(changed_files::text)<=131072),
  diff_summary jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(diff_summary)='object' AND octet_length(diff_summary::text)<=8192),
  collector text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE workspace_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  operation_type text NOT NULL CHECK (operation_type IN ('recover_lock','restore_owner')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  requested_by text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  correlation_id text NOT NULL,
  worker_id text,
  result jsonb,
  error text,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE UNIQUE INDEX workspace_operations_one_active_project
  ON workspace_operations(project_id) WHERE status IN ('pending','running');

CREATE OR REPLACE FUNCTION record_project_workspace_state(
  p_project_id uuid,p_collector text,p_branch text,p_head_sha text,p_upstream text,
  p_ahead integer,p_behind integer,p_dirty boolean,p_changed_files jsonb,p_diff_summary jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_state project_workspace_states%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM projects WHERE id=p_project_id AND status<>'archived')
     OR length(trim(p_collector))<2 OR p_ahead<0 OR p_behind<0
     OR jsonb_typeof(p_changed_files)<>'array' OR octet_length(p_changed_files::text)>131072
     OR jsonb_typeof(p_diff_summary)<>'object' OR octet_length(p_diff_summary::text)>8192 THEN
    RAISE EXCEPTION 'invalid project workspace snapshot' USING ERRCODE='22023';
  END IF;
  INSERT INTO project_workspace_states(project_id,branch,head_sha,upstream,ahead,behind,dirty,
    changed_files,diff_summary,collector,observed_at)
  VALUES(p_project_id,left(COALESCE(p_branch,''),300),left(COALESCE(p_head_sha,''),64),
    left(COALESCE(p_upstream,''),300),p_ahead,p_behind,p_dirty,p_changed_files,p_diff_summary,
    left(p_collector,120),clock_timestamp())
  ON CONFLICT(project_id) DO UPDATE SET branch=EXCLUDED.branch,head_sha=EXCLUDED.head_sha,
    upstream=EXCLUDED.upstream,ahead=EXCLUDED.ahead,behind=EXCLUDED.behind,dirty=EXCLUDED.dirty,
    changed_files=EXCLUDED.changed_files,diff_summary=EXCLUDED.diff_summary,
    collector=EXCLUDED.collector,observed_at=EXCLUDED.observed_at
  RETURNING * INTO v_state;
  RETURN to_jsonb(v_state);
END; $$;

CREATE OR REPLACE FUNCTION request_workspace_operation(
  p_project_id uuid,p_operation_type text,p_actor_id text,p_reason text,p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
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
  IF EXISTS(SELECT 1 FROM runtime_jobs WHERE project_id=p_project_id AND status IN ('pending','in_flight')) THEN
    RAISE EXCEPTION 'workspace has active or pending runtime work' USING ERRCODE='55000'; END IF;
  INSERT INTO workspace_operations(project_id,operation_type,requested_by,reason,correlation_id)
  VALUES(p_project_id,p_operation_type,p_actor_id,trim(p_reason),p_correlation_id) RETURNING * INTO v_operation;
  PERFORM write_audit_event(p_project_id,NULL,NULL,'user',p_actor_id,'workspace.operation_requested',
    'workspace_operation',v_operation.id::text,'allowed',NULL,
    jsonb_build_object('operation_type',p_operation_type,'reason',trim(p_reason)),p_correlation_id);
  RETURN jsonb_build_object('operation_id',v_operation.id,'status',v_operation.status,
    'operation_type',v_operation.operation_type);
END; $$;

CREATE OR REPLACE FUNCTION claim_workspace_operation(p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_operation workspace_operations%ROWTYPE; v_project projects%ROWTYPE; v_lock workspace_locks%ROWTYPE; v_run task_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_operation FROM workspace_operations WHERE status='pending'
    ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE workspace_operations SET status='running',worker_id=p_worker_id,started_at=clock_timestamp()
    WHERE id=v_operation.id RETURNING * INTO v_operation;
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

CREATE OR REPLACE FUNCTION finish_workspace_operation(
  p_operation_id uuid,p_worker_id text,p_success boolean,p_result jsonb,p_error text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_operation workspace_operations%ROWTYPE; v_project projects%ROWTYPE; v_event domain_events%ROWTYPE;
BEGIN
  SELECT * INTO v_operation FROM workspace_operations WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.status<>'running' OR v_operation.worker_id<>p_worker_id THEN
    RAISE EXCEPTION 'workspace operation is not owned by worker' USING ERRCODE='55000'; END IF;
  IF p_success THEN
    IF v_operation.operation_type='recover_lock' THEN
      UPDATE workspace_locks SET owner_run_id=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
        status='released',reason=NULL,version=version+1
      WHERE project_id=v_operation.project_id AND status='reconciliation_required';
      IF NOT FOUND THEN RAISE EXCEPTION 'workspace recovery precondition changed' USING ERRCODE='40001'; END IF;
    END IF;
    UPDATE projects SET status=CASE WHEN settings->>'provisioning_status'='ready' THEN 'active' ELSE status END,
      version=version+1,updated_at=clock_timestamp() WHERE id=v_operation.project_id RETURNING * INTO v_project;
    v_event:=append_event(CASE WHEN v_operation.operation_type='recover_lock' THEN 'workspace.recovered' ELSE 'workspace.ownership_restored' END,
      v_project.id,NULL,NULL,'system',p_worker_id,NULL,v_operation.correlation_id,
      'workspace-operation:'||v_operation.id,'project',v_project.id,v_project.version,
      COALESCE(p_result,'{}'::jsonb)||jsonb_build_object('operation_id',v_operation.id));
    UPDATE workspace_operations SET status='completed',result=COALESCE(p_result,'{}'::jsonb),
      completed_at=clock_timestamp() WHERE id=v_operation.id RETURNING * INTO v_operation;
    PERFORM write_audit_event(v_project.id,NULL,NULL,'system',p_worker_id,'workspace.operation_completed',
      'workspace_operation',v_operation.id::text,'allowed',NULL,
      COALESCE(p_result,'{}'::jsonb)||jsonb_build_object('operation_type',v_operation.operation_type),v_operation.correlation_id);
  ELSE
    UPDATE workspace_operations SET status='failed',error=left(COALESCE(p_error,'operation failed'),1000),
      completed_at=clock_timestamp() WHERE id=v_operation.id RETURNING * INTO v_operation;
    PERFORM write_audit_event(v_operation.project_id,NULL,NULL,'system',p_worker_id,'workspace.operation_failed',
      'workspace_operation',v_operation.id::text,'denied',NULL,
      jsonb_build_object('operation_type',v_operation.operation_type,'error',v_operation.error),v_operation.correlation_id);
  END IF;
  RETURN jsonb_build_object('operation_id',v_operation.id,'status',v_operation.status,
    'operation_type',v_operation.operation_type,'error',v_operation.error);
END; $$;

ALTER FUNCTION record_project_workspace_state(uuid,text,text,text,text,integer,integer,boolean,jsonb,jsonb)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION request_workspace_operation(uuid,text,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_workspace_operation(text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION finish_workspace_operation(uuid,text,boolean,jsonb,text)
  SET search_path=control_plane,public,extensions,pg_temp;
COMMIT;
