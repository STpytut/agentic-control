BEGIN;
SET search_path TO control_plane,public;

ALTER TABLE worker_interaction_reports
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN resolved_by text,
  ADD COLUMN resolution jsonb;

CREATE OR REPLACE FUNCTION approve_task_review(
  p_project_id uuid,
  p_task_id uuid,
  p_actor_id text,
  p_summary text,
  p_idempotency_key text,
  p_expected_version bigint,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_command commands%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_event domain_events%ROWTYPE;
  v_result jsonb;
BEGIN
  IF length(trim(p_actor_id)) < 2 OR length(trim(p_summary)) < 3 THEN
    RAISE EXCEPTION 'review actor and summary are required' USING ERRCODE='22023';
  END IF;
  v_command := submit_command(
    p_project_id,p_task_id,'ApproveTaskReview','user',p_actor_id,p_idempotency_key,
    jsonb_build_object('summary',p_summary),p_expected_version,p_correlation_id
  );
  IF v_command.status='completed' THEN RETURN v_command.result; END IF;

  SELECT * INTO v_task FROM tasks
  WHERE id=p_task_id AND project_id=p_project_id FOR UPDATE;
  IF NOT FOUND OR v_task.status<>'awaiting_review' OR v_task.version<>p_expected_version THEN
    RAISE EXCEPTION 'task is not reviewable at the expected version' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM agents a
    WHERE a.id=v_task.active_agent_id AND a.enabled AND a.role IN ('architect','reviewer')
  ) THEN
    RAISE EXCEPTION 'active reviewer is unavailable' USING ERRCODE='55000';
  END IF;

  UPDATE tasks SET status='approved',version=version+1,updated_at=clock_timestamp()
  WHERE id=p_task_id RETURNING * INTO v_task;
  v_event:=append_event(
    'review.approved',p_project_id,p_task_id,NULL,'user',p_actor_id,v_command.id,p_correlation_id,
    'review-approved:'||p_idempotency_key,'task',p_task_id,v_task.version,
    jsonb_build_object('summary',p_summary,'reviewer_agent_id',v_task.active_agent_id)
  );
  PERFORM write_audit_event(
    p_project_id,p_task_id,NULL,'user',p_actor_id,'task.review_approved','task',p_task_id::text,
    'allowed',NULL,jsonb_build_object('summary',p_summary),p_correlation_id
  );
  v_result:=jsonb_build_object(
    'status','approved','task_id',p_task_id,'task_version',v_task.version,
    'command_id',v_command.id,'event_id',v_event.id
  );
  UPDATE commands SET status='completed',result=v_result,completed_at=clock_timestamp()
  WHERE id=v_command.id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION resolve_worker_interaction(
  p_report_id uuid,
  p_actor_id text,
  p_response jsonb,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_report worker_interaction_reports%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_previous handoffs%ROWTYPE;
  v_event domain_events%ROWTYPE;
  v_delegate jsonb;
  v_result jsonb;
BEGIN
  IF length(trim(p_actor_id))<2 OR jsonb_typeof(p_response)<>'object'
     OR length(trim(COALESCE(p_response->>'response','')))<2 THEN
    RAISE EXCEPTION 'operator response is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_report FROM worker_interaction_reports
  WHERE id=p_report_id FOR UPDATE;
  IF NOT FOUND OR v_report.status<>'finalized' THEN
    RAISE EXCEPTION 'worker interaction is unavailable' USING ERRCODE='55000';
  END IF;
  IF v_report.resolved_at IS NOT NULL THEN RETURN v_report.resolution; END IF;

  SELECT * INTO v_task FROM tasks WHERE id=v_report.task_id FOR UPDATE;
  SELECT * INTO v_previous FROM handoffs
  WHERE task_id=v_report.task_id AND target_run_id=v_report.run_id
  ORDER BY revision_number DESC LIMIT 1 FOR UPDATE;
  IF v_task.status<>'needs_attention' OR v_task.active_agent_id<>v_report.agent_id
     OR v_previous.id IS NULL THEN
    RAISE EXCEPTION 'interaction task cannot be resumed' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM workspace_locks WHERE project_id=v_report.project_id AND status='held') THEN
    RAISE EXCEPTION 'workspace is already locked' USING ERRCODE='55000';
  END IF;

  UPDATE tasks SET status='changes_requested',active_agent_id=v_previous.from_agent_id,
    version=version+1,updated_at=clock_timestamp()
  WHERE id=v_task.id RETURNING * INTO v_task;
  v_event:=append_event(
    'interaction.resolved',v_report.project_id,v_report.task_id,v_report.run_id,
    'user',p_actor_id,NULL,p_correlation_id,'interaction-resolved:'||v_report.id,
    'task',v_report.task_id,v_task.version,
    jsonb_build_object('report_id',v_report.id,'report_type',v_report.report_type,'response',p_response)
  );

  v_delegate:=request_implementation(
    v_report.project_id,v_report.task_id,v_previous.from_agent_id,v_previous.to_agent_id,
    v_previous.revision_number+1,v_previous.objective,
    v_previous.instructions || jsonb_build_array(jsonb_build_object(
      'type','operator_response','report_id',v_report.id,'report_type',v_report.report_type,
      'response',p_response
    )),
    v_previous.constraints,v_previous.acceptance_criteria,v_previous.relevant_paths,
    v_previous.workspace_ref,'resume-interaction:'||v_report.id,v_task.version,p_correlation_id
  );
  v_result:=jsonb_build_object(
    'status','resume_requested','report_id',v_report.id,'event_id',v_event.id,
    'revision_number',v_previous.revision_number+1,'delegation',v_delegate
  );
  UPDATE worker_interaction_reports SET resolved_at=clock_timestamp(),resolved_by=p_actor_id,
    resolution=v_result WHERE id=v_report.id;
  PERFORM write_audit_event(
    v_report.project_id,v_report.task_id,v_report.run_id,'user',p_actor_id,
    'worker_interaction.resolved','worker_interaction',v_report.id::text,'allowed',NULL,
    jsonb_build_object('report_type',v_report.report_type,'response',p_response),p_correlation_id
  );
  RETURN v_result;
END;
$$;

ALTER FUNCTION approve_task_review(uuid,uuid,text,text,text,bigint,text)
  SET search_path=control_plane,pg_temp;
ALTER FUNCTION resolve_worker_interaction(uuid,text,jsonb,text)
  SET search_path=control_plane,pg_temp;

COMMIT;
