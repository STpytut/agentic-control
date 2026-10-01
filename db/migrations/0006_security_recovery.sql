BEGIN;
SET search_path TO control_plane, public;

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid REFERENCES tasks(id),
  action_type text NOT NULL,
  action_fingerprint text NOT NULL CHECK (action_fingerprint ~ '^[0-9a-f]{64}$'),
  action_context jsonb NOT NULL,
  requested_by text NOT NULL,
  decided_by text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired','consumed')),
  reason text,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  UNIQUE(project_id, action_type, action_fingerprint),
  CHECK (expires_at > requested_at),
  CHECK ((status IN ('approved','denied','consumed')) = (decided_at IS NOT NULL)),
  CHECK (status <> 'consumed' OR consumed_at IS NOT NULL)
);

CREATE TABLE credential_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  provider text NOT NULL,
  secret_locator text NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  allowed_agent_ids uuid[] NOT NULL DEFAULT '{}',
  allowed_actions text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id, provider, secret_locator)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id),
  task_id uuid REFERENCES tasks(id),
  run_id uuid REFERENCES task_runs(id),
  actor_type text NOT NULL CHECK (actor_type IN ('user','agent','system','operator')),
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  policy_decision text NOT NULL CHECK (policy_decision IN ('allowed','denied','not_required')),
  approval_id uuid REFERENCES approvals(id),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE worker_interaction_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  run_id uuid NOT NULL REFERENCES task_runs(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  fencing_token bigint NOT NULL,
  native_session_id text NOT NULL,
  report_type text NOT NULL CHECK (report_type IN ('blocker','input_request')),
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','finalized','rejected')),
  result jsonb,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalized_at timestamptz,
  UNIQUE(run_id,idempotency_key),
  CHECK ((status='submitted')=(finalized_at IS NULL)),
  CHECK (status<>'finalized' OR result IS NOT NULL)
);
CREATE UNIQUE INDEX worker_interaction_one_submitted_run ON worker_interaction_reports(run_id) WHERE status='submitted';

ALTER TABLE runtime_jobs ADD COLUMN resolved_at timestamptz;
ALTER TABLE runtime_jobs ADD COLUMN resolved_by text;
ALTER TABLE runtime_jobs ADD COLUMN resolution text;

CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER credential_references_no_delete BEFORE DELETE ON credential_references FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER worker_interaction_reports_no_delete BEFORE DELETE ON worker_interaction_reports FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE OR REPLACE FUNCTION write_audit_event(
  p_project_id uuid,p_task_id uuid,p_run_id uuid,p_actor_type text,p_actor_id text,
  p_action text,p_target_type text,p_target_id text,p_policy_decision text,
  p_approval_id uuid,p_details jsonb,p_correlation_id text
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO audit_events(project_id,task_id,run_id,actor_type,actor_id,action,target_type,target_id,
    policy_decision,approval_id,details,correlation_id)
  VALUES(p_project_id,p_task_id,p_run_id,p_actor_type,p_actor_id,p_action,p_target_type,p_target_id,
    p_policy_decision,p_approval_id,p_details,p_correlation_id) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION request_approval(
  p_project_id uuid,p_task_id uuid,p_action_type text,p_action_fingerprint text,
  p_action_context jsonb,p_requested_by text,p_ttl interval,p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v approvals%ROWTYPE;
BEGIN
  IF p_action_fingerprint !~ '^[0-9a-f]{64}$' OR p_ttl<=interval '0 seconds' THEN
    RAISE EXCEPTION 'invalid approval fingerprint or ttl' USING ERRCODE='22023'; END IF;
  INSERT INTO approvals(project_id,task_id,action_type,action_fingerprint,action_context,requested_by,expires_at)
  VALUES(p_project_id,p_task_id,p_action_type,p_action_fingerprint,p_action_context,p_requested_by,clock_timestamp()+p_ttl)
  ON CONFLICT(project_id,action_type,action_fingerprint) DO UPDATE SET action_fingerprint=EXCLUDED.action_fingerprint
  RETURNING * INTO v;
  PERFORM write_audit_event(p_project_id,p_task_id,NULL,'agent',p_requested_by,'approval.requested','approval',v.id::text,
    'not_required',NULL,jsonb_build_object('action_type',p_action_type,'fingerprint',p_action_fingerprint),p_correlation_id);
  RETURN jsonb_build_object('approval_id',v.id,'status',v.status,'expires_at',v.expires_at,'fingerprint',v.action_fingerprint);
END; $$;

CREATE OR REPLACE FUNCTION decide_approval(
  p_approval_id uuid,p_decided_by text,p_decision text,p_reason text,p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v approvals%ROWTYPE;
BEGIN
  SELECT * INTO v FROM approvals WHERE id=p_approval_id FOR UPDATE;
  IF NOT FOUND OR v.status<>'pending' OR v.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'approval is unavailable' USING ERRCODE='55000'; END IF;
  IF p_decision NOT IN ('approved','denied') THEN RAISE EXCEPTION 'invalid approval decision' USING ERRCODE='22023'; END IF;
  UPDATE approvals SET status=p_decision,decided_by=p_decided_by,decided_at=clock_timestamp(),reason=p_reason
    WHERE id=p_approval_id RETURNING * INTO v;
  PERFORM write_audit_event(v.project_id,v.task_id,NULL,'user',p_decided_by,'approval.'||p_decision,'approval',v.id::text,
    CASE WHEN p_decision='approved' THEN 'allowed' ELSE 'denied' END,v.id,jsonb_build_object('reason',p_reason),p_correlation_id);
  RETURN jsonb_build_object('approval_id',v.id,'status',v.status,'fingerprint',v.action_fingerprint);
END; $$;

CREATE OR REPLACE FUNCTION consume_approval(
  p_approval_id uuid,p_action_fingerprint text,p_actor_id text,p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v approvals%ROWTYPE;
BEGIN
  SELECT * INTO v FROM approvals WHERE id=p_approval_id FOR UPDATE;
  IF NOT FOUND OR v.status<>'approved' OR v.expires_at<=clock_timestamp()
     OR v.action_fingerprint<>p_action_fingerprint THEN
    IF FOUND THEN PERFORM write_audit_event(v.project_id,v.task_id,NULL,'agent',p_actor_id,'approval.consume_denied','approval',v.id::text,
      'denied',v.id,jsonb_build_object('provided_fingerprint',p_action_fingerprint),p_correlation_id); END IF;
    RAISE EXCEPTION 'approval validation failed' USING ERRCODE='55000';
  END IF;
  UPDATE approvals SET status='consumed',consumed_at=clock_timestamp() WHERE id=p_approval_id RETURNING * INTO v;
  PERFORM write_audit_event(v.project_id,v.task_id,NULL,'agent',p_actor_id,'approval.consumed','approval',v.id::text,
    'allowed',v.id,'{}',p_correlation_id);
  RETURN jsonb_build_object('approval_id',v.id,'status',v.status,'fingerprint',v.action_fingerprint);
END; $$;

CREATE OR REPLACE FUNCTION submit_worker_interaction(
  p_project_id uuid,p_task_id uuid,p_run_id uuid,p_agent_id uuid,p_fencing_token bigint,
  p_native_session_id text,p_report_type text,p_payload jsonb,p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_run task_runs%ROWTYPE; v_task tasks%ROWTYPE; v_session agent_sessions%ROWTYPE; v worker_interaction_reports%ROWTYPE;
BEGIN
  SELECT * INTO v_task FROM tasks WHERE id=p_task_id AND project_id=p_project_id FOR UPDATE;
  SELECT * INTO v_run FROM task_runs WHERE id=p_run_id FOR UPDATE;
  IF v_task.id IS NULL OR v_run.id IS NULL OR v_run.task_id<>p_task_id OR v_run.agent_id<>p_agent_id
     OR v_run.status<>'running' OR v_task.active_agent_id<>p_agent_id OR v_task.status NOT IN ('implementing','revising') THEN
    RAISE EXCEPTION 'active worker interaction validation failed' USING ERRCODE='55000'; END IF;
  IF p_report_type NOT IN ('blocker','input_request') OR jsonb_typeof(p_payload)<>'object' THEN
    RAISE EXCEPTION 'invalid worker interaction payload' USING ERRCODE='22023'; END IF;
  PERFORM assert_workspace_fence(p_project_id,p_run_id,p_fencing_token);
  SELECT * INTO v_session FROM agent_sessions WHERE id=v_run.session_id;
  IF v_session.native_session_id IS NOT NULL AND v_session.native_session_id<>p_native_session_id THEN
    RAISE EXCEPTION 'worker session continuity validation failed' USING ERRCODE='55000'; END IF;
  INSERT INTO worker_interaction_reports(project_id,task_id,run_id,agent_id,fencing_token,native_session_id,report_type,payload,idempotency_key)
  VALUES(p_project_id,p_task_id,p_run_id,p_agent_id,p_fencing_token,p_native_session_id,p_report_type,p_payload,p_idempotency_key)
  ON CONFLICT(run_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING * INTO v;
  RETURN jsonb_build_object('report_id',v.id,'status',v.status,'report_type',v.report_type,'run_id',v.run_id);
END; $$;

CREATE OR REPLACE FUNCTION finalize_worker_interaction(p_report_id uuid,p_job_id bigint,p_supervisor_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v worker_interaction_reports%ROWTYPE; v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE; v_event domain_events%ROWTYPE; v_result jsonb;
BEGIN
  SELECT * INTO v FROM worker_interaction_reports WHERE id=p_report_id FOR UPDATE;
  IF v.status='finalized' THEN RETURN v.result; END IF;
  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF v.id IS NULL OR v.status<>'submitted' OR v_job.run_id<>v.run_id OR v_job.status<>'in_flight'
     OR v_job.leased_by<>p_supervisor_id OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'worker interaction is not finalizable' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_task FROM tasks WHERE id=v.task_id FOR UPDATE;
  UPDATE task_runs SET status='blocked',failure_code=CASE WHEN v.report_type='blocker' THEN 'worker_blocked' ELSE 'input_required' END,
    updated_at=clock_timestamp(),version=version+1 WHERE id=v.run_id;
  UPDATE tasks SET status='needs_attention',version=version+1,updated_at=clock_timestamp() WHERE id=v.task_id RETURNING * INTO v_task;
  v_event:=append_event(CASE WHEN v.report_type='blocker' THEN 'implementation.blocked' ELSE 'run.input_requested' END,
    v.project_id,v.task_id,v.run_id,'agent',v.agent_id::text,NULL,v.task_id::text,'interaction:'||v.id,
    'task',v.task_id,v_task.version,v.payload);
  PERFORM release_workspace_lock(v.project_id,v.run_id,v.fencing_token);
  PERFORM write_audit_event(v.project_id,v.task_id,v.run_id,'agent',v.agent_id::text,v.report_type,'task',v.task_id::text,
    'allowed',NULL,v.payload,v.task_id::text);
  v_result:=jsonb_build_object('status','needs_attention','report_id',v.id,'report_type',v.report_type,'event_id',v_event.id,'task_version',v_task.version);
  UPDATE worker_interaction_reports SET status='finalized',result=v_result,finalized_at=clock_timestamp() WHERE id=v.id;
  RETURN v_result;
END; $$;

CREATE OR REPLACE FUNCTION resolve_runtime_job_incident(p_job_id bigint,p_actor_id text,p_resolution text,p_correlation_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v runtime_jobs%ROWTYPE; v_audit uuid;
BEGIN
  SELECT * INTO v FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v.status<>'dead_letter' OR v.resolved_at IS NOT NULL OR length(trim(p_resolution))<8 THEN
    RAISE EXCEPTION 'dead-letter incident is not resolvable' USING ERRCODE='55000'; END IF;
  UPDATE runtime_jobs SET resolved_at=clock_timestamp(),resolved_by=p_actor_id,resolution=p_resolution WHERE id=p_job_id RETURNING * INTO v;
  v_audit:=write_audit_event(v.project_id,v.task_id,v.run_id,'operator',p_actor_id,'runtime_job.incident_resolved','runtime_job',v.id::text,
    'allowed',NULL,jsonb_build_object('resolution',p_resolution),p_correlation_id);
  RETURN jsonb_build_object('job_id',v.id,'resolved_at',v.resolved_at,'audit_event_id',v_audit);
END; $$;

ALTER FUNCTION write_audit_event(uuid,uuid,uuid,text,text,text,text,text,text,uuid,jsonb,text) SET search_path=control_plane,pg_temp;
ALTER FUNCTION request_approval(uuid,uuid,text,text,jsonb,text,interval,text) SET search_path=control_plane,pg_temp;
ALTER FUNCTION decide_approval(uuid,text,text,text,text) SET search_path=control_plane,pg_temp;
ALTER FUNCTION consume_approval(uuid,text,text,text) SET search_path=control_plane,pg_temp;
ALTER FUNCTION submit_worker_interaction(uuid,uuid,uuid,uuid,bigint,text,text,jsonb,text) SET search_path=control_plane,pg_temp;
ALTER FUNCTION finalize_worker_interaction(uuid,bigint,text) SET search_path=control_plane,pg_temp;
ALTER FUNCTION resolve_runtime_job_incident(bigint,text,text,text) SET search_path=control_plane,pg_temp;

COMMIT;
