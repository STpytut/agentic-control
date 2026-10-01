-- An implementation that ends without its terminal report asks the operator,
-- instead of being retried whole and then dead-lettered (panel finding P-3).
--
-- Seen on the host: the executor wrote and committed the change, then called
-- no terminal tool — not in its turn, not in the two finalization turns bound to
-- its session. The worker treated that as a transient failure: the whole
-- implementation ran again, three times over twenty minutes, then the job was
-- dead-lettered, its run stayed `running` and held the workspace until the lease
-- ran out, and the lock ended in reconciliation_required for the operator to
-- recover by hand. The work was on disk the whole time.
--
-- finalize_unreported_run is that outcome named: the run fails with
-- terminal_report_missing, the lock is released at once with the run's fencing
-- token, the task needs attention, and an input request asks the operator what
-- to do — shaped like the one an interrupt opens, so the chat already routes an
-- answer to it and resolve_worker_interaction resumes the implementation, in the
-- same executor session, with the answer stated in its prompt.
SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION finalize_unreported_run(
  p_job_id bigint, p_worker_id text, p_native_session_id text DEFAULT NULL, p_detail text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE; v_run task_runs%ROWTYPE;
  v_report worker_interaction_reports%ROWTYPE; v_event domain_events%ROWTYPE; v_token bigint; v_result jsonb;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'in_flight' OR v_job.leased_by IS DISTINCT FROM p_worker_id
     OR v_job.job_type<>'start_implementation' OR v_job.run_id IS NULL THEN
    RAISE EXCEPTION 'the implementation job is not in flight for this worker' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_run FROM task_runs WHERE id=v_job.run_id FOR UPDATE;
  IF NOT v_run.write_capable OR v_run.status NOT IN ('starting','running') THEN
    RAISE EXCEPTION 'the run is not an active implementation' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id=v_job.task_id FOR UPDATE;

  UPDATE agent_sessions SET native_session_id=COALESCE(native_session_id,NULLIF(p_native_session_id,'')),
    updated_at=clock_timestamp(),version=version+1 WHERE id=v_run.session_id;
  UPDATE task_runs SET status='failed',finished_at=clock_timestamp(),failure_code='terminal_report_missing',
    exit_code=0,updated_at=clock_timestamp(),version=version+1 WHERE id=v_run.id;
  SELECT fencing_token INTO v_token FROM workspace_locks
  WHERE project_id=v_job.project_id AND status='held' AND owner_run_id=v_run.id;
  IF v_token IS NOT NULL THEN PERFORM release_workspace_lock(v_job.project_id,v_run.id,v_token); END IF;
  UPDATE tasks SET status='needs_attention',version=version+1,updated_at=clock_timestamp()
  WHERE id=v_task.id RETURNING * INTO v_task;

  INSERT INTO worker_interaction_reports(project_id,task_id,run_id,agent_id,fencing_token,native_session_id,
    report_type,payload,idempotency_key,status,result,finalized_at)
  VALUES(v_job.project_id,v_job.task_id,v_run.id,v_run.agent_id,COALESCE(v_run.workspace_fencing_token,v_token),
    COALESCE(NULLIF(p_native_session_id,''),'unreported:'||v_run.id),'input_request',
    jsonb_build_object(
      'question','The executor stopped without submitting its report. Anything it changed is in the workspace. '
        || 'Tell it how to continue — for example, to report what it did and finish.',
      'reason','terminal_report_missing',
      'context',left(COALESCE(p_detail,''),2000)),
    'unreported:'||v_job.id,'finalized',jsonb_build_object('status','needs_attention'),clock_timestamp())
  ON CONFLICT(run_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
  RETURNING * INTO v_report;

  v_event:=append_event('run.unreported',v_job.project_id,v_job.task_id,v_run.id,'system',p_worker_id,NULL,
    v_job.task_id::text,'unreported:'||v_job.id,'task',v_job.task_id,v_task.version,
    jsonb_build_object('job_id',v_job.id,'report_id',v_report.id,'question',v_report.payload->>'question'));
  v_result:=jsonb_build_object('project_id',v_job.project_id,'task_id',v_job.task_id,'job_id',v_job.id,
    'status','unreported','event_id',v_event.id,'report_id',v_report.id);
  UPDATE runtime_jobs SET status='completed',result=v_result,leased_by=NULL,leased_until=NULL,
    last_error='terminal_report_missing',completed_at=clock_timestamp(),activity_phase='completed',
    activity_detail='The executor ended without its report; the operator was asked how to continue'
  WHERE id=v_job.id;
  RETURN v_result;
END $$;

ALTER FUNCTION finalize_unreported_run(bigint,text,text,text) SET search_path=control_plane,public,extensions,pg_temp;
REVOKE EXECUTE ON FUNCTION finalize_unreported_run(bigint,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finalize_unreported_run(bigint,text,text,text) TO infra_worker;
