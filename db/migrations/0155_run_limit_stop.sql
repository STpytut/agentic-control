-- rc.147: a run stopped at its member's token limit ends, and the owner is
-- asked how to go on — it is not retried.
--
-- rc.146's live test: the supervisor stopped an executor past its 20 000
-- tokens, the worker took that for a transient fault, ran the whole
-- implementation twice more at the same cost, and dead-lettered it with "every
-- attempt the worker allows failed". Now the run ends as the unreported run
-- does (0066/0077): the workspace's lock released, the task needing
-- attention, and a question that says what happened and what to do; an answer
-- resumes the same session.

SET search_path TO control_plane, public, extensions;

CREATE FUNCTION finalize_over_limit_run(p_job_id bigint, p_worker_id text, p_native_session_id text, p_detail text)
RETURNS jsonb LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE; v_run task_runs%ROWTYPE;
  v_report worker_interaction_reports%ROWTYPE; v_event domain_events%ROWTYPE; v_token bigint; v_result jsonb;
  v_detail text := left(COALESCE(NULLIF(btrim(p_detail), ''), 'the run passed its token limit and was stopped'), 500);
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status <> 'in_flight' OR v_job.leased_by IS DISTINCT FROM p_worker_id
     OR v_job.job_type <> 'implementation_run' OR v_job.run_id IS NULL THEN
    PERFORM refuse('job_not_in_flight', format('implementation job %s is not in flight for %s', p_job_id, p_worker_id));
  END IF;
  SELECT * INTO v_run FROM task_runs WHERE id = v_job.run_id FOR UPDATE;
  IF NOT v_run.write_capable OR v_run.status NOT IN ('starting','running') THEN
    PERFORM refuse('run_not_running', format('run %s is not an active implementation', v_run.id));
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id = v_job.task_id FOR UPDATE;

  UPDATE agent_sessions SET native_session_id = COALESCE(native_session_id, NULLIF(p_native_session_id, '')),
    updated_at = clock_timestamp(), version = version + 1 WHERE id = v_run.session_id;
  UPDATE task_runs SET status = 'failed', finished_at = clock_timestamp(), failure_code = 'token_limit',
    exit_code = NULL, updated_at = clock_timestamp(), version = version + 1 WHERE id = v_run.id;
  SELECT fencing_token INTO v_token FROM workspace_locks
  WHERE project_id = v_job.project_id AND status = 'held' AND owner_run_id = v_run.id;
  IF v_token IS NOT NULL THEN PERFORM release_workspace_lock(v_job.project_id, v_run.id, v_token); END IF;
  UPDATE tasks SET status = 'needs_attention', version = version + 1, updated_at = clock_timestamp()
  WHERE id = v_task.id RETURNING * INTO v_task;

  INSERT INTO worker_interaction_reports(project_id, task_id, run_id, agent_id, fencing_token, native_session_id,
    report_type, payload, idempotency_key, status, result, finalized_at)
  VALUES (v_job.project_id, v_job.task_id, v_run.id, v_run.agent_id, COALESCE(v_run.workspace_fencing_token, v_token),
    COALESCE(NULLIF(p_native_session_id, ''), 'over-limit:' || v_run.id), 'input_request',
    jsonb_build_object(
      'question', 'The executor was stopped at its token limit: ' || v_detail || '. Anything it changed is in the workspace. '
        || 'Raise or clear the limit on the Team page and tell it to continue, or tell it how to finish with less.',
      'reason', 'token_limit', 'context', v_detail),
    'over-limit:' || v_job.id, 'finalized', jsonb_build_object('status', 'needs_attention'), clock_timestamp())
  ON CONFLICT (run_id, idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING * INTO v_report;

  -- The chat's record of it: run.unreported is the event the panel shows such
  -- a question by (product-data.ts), with the question as it is.
  v_event := append_event('run.unreported', v_job.project_id, v_job.task_id, v_run.id, 'system', p_worker_id, NULL,
    v_job.task_id::text, 'over-limit:' || v_job.id, 'task', v_job.task_id, v_task.version,
    jsonb_build_object('job_id', v_job.id, 'report_id', v_report.id, 'question', v_report.payload->>'question',
      'reason', 'token_limit'));
  v_result := jsonb_build_object('project_id', v_job.project_id, 'task_id', v_job.task_id, 'job_id', v_job.id,
    'status', 'over_token_limit', 'event_id', v_event.id, 'report_id', v_report.id);
  UPDATE runtime_jobs SET status = 'completed', result = v_result, leased_by = NULL, leased_until = NULL,
    last_error = left(v_detail, 500), completed_at = clock_timestamp(), activity_phase = 'completed',
    activity_detail = 'Stopped at the token limit; the owner was asked how to continue'
  WHERE id = v_job.id;
  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION finalize_over_limit_run(bigint,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finalize_over_limit_run(bigint,text,text,text) TO infra_worker;
