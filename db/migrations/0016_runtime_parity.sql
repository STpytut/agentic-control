BEGIN;
SET search_path TO control_plane,public,extensions;

CREATE TABLE runtime_activity_events (
  id bigserial PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES runtime_jobs(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  run_id uuid REFERENCES task_runs(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  runtime_type text NOT NULL CHECK (runtime_type IN ('codex','opencode','antigravity')),
  event_type text NOT NULL CHECK (event_type ~ '^runtime[.][a-z0-9_.-]+$'),
  phase text NOT NULL,
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object' AND octet_length(details::text)<=8192),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(job_id,sequence)
);
CREATE INDEX runtime_activity_events_task_recent ON runtime_activity_events(task_id,id DESC);
CREATE TRIGGER runtime_activity_events_append_only BEFORE UPDATE OR DELETE ON runtime_activity_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

ALTER TABLE runtime_jobs
  ADD COLUMN interrupt_requested_at timestamptz,
  ADD COLUMN interrupt_requested_by text,
  ADD COLUMN interrupt_reason text,
  ADD COLUMN interrupted_at timestamptz;

CREATE OR REPLACE FUNCTION append_runtime_activity_event(
  p_job_id bigint,p_worker_id text,p_runtime_type text,p_event_type text,
  p_phase text,p_summary text,p_details jsonb DEFAULT '{}'::jsonb
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_id bigint; v_sequence integer;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'in_flight' OR v_job.leased_by<>p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'runtime activity job is not actively leased' USING ERRCODE='55000';
  END IF;
  IF p_runtime_type NOT IN ('codex','opencode','antigravity') OR p_event_type !~ '^runtime[.][a-z0-9_.-]+$'
     OR length(trim(p_summary))<1 OR jsonb_typeof(p_details)<>'object' OR octet_length(p_details::text)>8192 THEN
    RAISE EXCEPTION 'invalid normalized runtime activity event' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(max(sequence),0)+1 INTO v_sequence FROM runtime_activity_events WHERE job_id=p_job_id;
  INSERT INTO runtime_activity_events(job_id,project_id,task_id,run_id,sequence,runtime_type,event_type,phase,summary,details)
  VALUES(v_job.id,v_job.project_id,v_job.task_id,v_job.run_id,v_sequence,p_runtime_type,p_event_type,
    left(p_phase,80),left(trim(p_summary),500),p_details) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION request_runtime_interrupt(
  p_project_id uuid,p_task_id uuid,p_actor_id text,p_reason text,p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_runtime text; v_capabilities jsonb; v_task tasks%ROWTYPE; v_event domain_events%ROWTYPE;
BEGIN
  SELECT j.* INTO v_job FROM runtime_jobs j
  WHERE j.project_id=p_project_id AND j.task_id=p_task_id AND j.status='in_flight'
  ORDER BY j.id DESC LIMIT 1 FOR UPDATE;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'no active runtime job is available' USING ERRCODE='55000'; END IF;
  SELECT COALESCE(rrp.runtime_type,orp.runtime_type),COALESCE(rrp.capabilities,orp.capabilities)
    INTO v_runtime,v_capabilities
  FROM tasks t JOIN project_agent_assignments opa ON opa.id=t.orchestrator_assignment_id
  JOIN runtime_profiles orp ON orp.id=opa.runtime_profile_id
  LEFT JOIN task_runs r ON r.id=v_job.run_id LEFT JOIN agent_sessions s ON s.id=r.session_id
  LEFT JOIN runtime_profiles rrp ON rrp.id=s.runtime_profile_id WHERE t.id=v_job.task_id;
  IF COALESCE((v_capabilities->>'interrupt')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the active runtime profile does not support interrupt' USING ERRCODE='55000';
  END IF;
  IF v_job.interrupt_requested_at IS NULL THEN
    UPDATE runtime_jobs SET interrupt_requested_at=clock_timestamp(),interrupt_requested_by=p_actor_id,
      interrupt_reason=left(trim(p_reason),500) WHERE id=v_job.id RETURNING * INTO v_job;
    SELECT * INTO v_task FROM tasks WHERE id=p_task_id FOR UPDATE;
    UPDATE tasks SET version=version+1,updated_at=clock_timestamp() WHERE id=p_task_id RETURNING * INTO v_task;
    v_event:=append_event('run.interrupt_requested',p_project_id,p_task_id,v_job.run_id,'user',p_actor_id,
      NULL,p_correlation_id,'interrupt-requested:'||v_job.id,'task',p_task_id,v_task.version,
      jsonb_build_object('job_id',v_job.id,'runtime_type',v_runtime,'reason',left(trim(p_reason),500)));
    PERFORM write_audit_event(p_project_id,p_task_id,v_job.run_id,'user',p_actor_id,'runtime.interrupt_requested',
      'runtime_job',v_job.id::text,'allowed',NULL,jsonb_build_object('runtime_type',v_runtime),p_correlation_id);
  END IF;
  RETURN jsonb_build_object('project_id',p_project_id,'task_id',p_task_id,'job_id',v_job.id,
    'runtime_type',v_runtime,'status','interrupt_requested');
END; $$;

CREATE OR REPLACE FUNCTION runtime_interrupt_request(p_job_id bigint,p_worker_id text)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN interrupt_requested_at IS NULL OR interrupted_at IS NOT NULL THEN NULL ELSE
    jsonb_build_object('requested_at',interrupt_requested_at,'requested_by',interrupt_requested_by,'reason',interrupt_reason) END
  FROM runtime_jobs WHERE id=p_job_id AND status='in_flight' AND leased_by=p_worker_id;
$$;

CREATE OR REPLACE FUNCTION finalize_runtime_interrupt(p_job_id bigint,p_worker_id text,p_native_session_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE; v_run task_runs%ROWTYPE; v_report worker_interaction_reports%ROWTYPE; v_event domain_events%ROWTYPE; v_token bigint; v_result jsonb;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'in_flight' OR v_job.leased_by<>p_worker_id OR v_job.interrupt_requested_at IS NULL THEN
    RAISE EXCEPTION 'runtime interrupt is not finalizable' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_task FROM tasks WHERE id=v_job.task_id FOR UPDATE;
  IF v_job.run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM task_runs WHERE id=v_job.run_id FOR UPDATE;
    UPDATE agent_sessions SET native_session_id=COALESCE(native_session_id,NULLIF(p_native_session_id,'')),
      updated_at=clock_timestamp(),version=version+1 WHERE id=v_run.session_id;
    UPDATE task_runs SET status='interrupted',finished_at=clock_timestamp(),failure_code='operator_interrupted',
      exit_code=NULL,updated_at=clock_timestamp(),version=version+1 WHERE id=v_run.id;
    SELECT fencing_token INTO v_token FROM workspace_locks WHERE project_id=v_job.project_id AND status='held' AND owner_run_id=v_run.id;
    IF v_token IS NOT NULL THEN PERFORM release_workspace_lock(v_job.project_id,v_run.id,v_token); END IF;
    UPDATE tasks SET status='needs_attention',version=version+1,updated_at=clock_timestamp() WHERE id=v_task.id RETURNING * INTO v_task;
    INSERT INTO worker_interaction_reports(project_id,task_id,run_id,agent_id,fencing_token,native_session_id,
      report_type,payload,idempotency_key,status,result,finalized_at)
    VALUES(v_job.project_id,v_job.task_id,v_run.id,v_run.agent_id,COALESCE(v_run.workspace_fencing_token,v_token),
      COALESCE(NULLIF(p_native_session_id,''),'interrupted:'||v_run.id),'input_request',
      jsonb_build_object('question','The run was interrupted. Provide instructions to resume.','reason',v_job.interrupt_reason),
      'interrupt:'||v_job.id,'finalized',jsonb_build_object('status','needs_attention'),clock_timestamp())
    ON CONFLICT(run_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING * INTO v_report;
  ELSE
    UPDATE tasks SET version=version+1,updated_at=clock_timestamp() WHERE id=v_task.id RETURNING * INTO v_task;
  END IF;
  v_event:=append_event('run.interrupted',v_job.project_id,v_job.task_id,v_job.run_id,'system',p_worker_id,NULL,
    v_job.task_id::text,'interrupted:'||v_job.id,'task',v_job.task_id,v_task.version,
    jsonb_build_object('job_id',v_job.id,'reason',v_job.interrupt_reason,'report_id',v_report.id));
  v_result:=jsonb_build_object('project_id',v_job.project_id,'task_id',v_job.task_id,'job_id',v_job.id,
    'status','interrupted','event_id',v_event.id,'report_id',v_report.id);
  UPDATE runtime_jobs SET status='completed',result=v_result,leased_by=NULL,leased_until=NULL,last_error=NULL,
    completed_at=clock_timestamp(),interrupted_at=clock_timestamp(),activity_phase='completed',
    activity_detail='Interrupted by operator' WHERE id=v_job.id;
  RETURN v_result;
END; $$;

UPDATE runtime_profiles SET capabilities=capabilities||jsonb_build_object(
  'stream',true,'interrupt',true,'bounded_activity_events',true,
  'server_http_sse_verified',runtime_type='opencode','active_input_verified',runtime_type='opencode'
),last_verified_at=clock_timestamp(),updated_at=clock_timestamp()
WHERE enabled AND runtime_type IN ('codex','opencode');

ALTER FUNCTION append_runtime_activity_event(bigint,text,text,text,text,text,jsonb) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION request_runtime_interrupt(uuid,uuid,text,text,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION runtime_interrupt_request(bigint,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION finalize_runtime_interrupt(bigint,text,text) SET search_path=control_plane,public,extensions,pg_temp;
COMMIT;
