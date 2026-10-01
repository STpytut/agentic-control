-- The operator closes a task (sprint C, found accepting U2 on the host).
--
-- A task could end only by its workflow: approved, published, failed. One the
-- operator abandoned — a conversation that never delegated, a review nobody
-- will finish — stayed open for good, and an open task holds its executors:
-- disable_project_executor (0089) refuses an executor an open task is bound
-- to, rightly, because the task would delegate to an assignment that is gone.
-- So the team could not shrink past a stale conversation.
--
-- close_task is the operator's way out: owner-checked, at the version the
-- panel showed, audited, and said in the conversation. It closes a task only
-- while nothing of it is running — a job in flight or a run still open is
-- stopped first (Stop run), not taken from under the worker — and it takes
-- down what would otherwise act on a closed task: its queued jobs end with
-- task_closed and, like its earlier dead letters, are marked handled; its
-- pending approvals expire. The task becomes 'cancelled', a state every
-- reader already treats as closed: the composer then offers a linked
-- follow-up, retry refuses (dead_letter_task_closed), and the team counts it
-- no more. Approved and later tasks are done, not abandoned, and are refused.

SET search_path TO control_plane, public, extensions;

-- task_unavailable and task_version_stale are the vocabulary's already.
INSERT INTO failure_reasons(reason, code, note) VALUES
  ('task_already_closed','conflict','the task has already ended'),
  ('task_work_in_flight','conflict','work of this task is running; stop the run first, then close it'),
  ('task_closed','conflict','the operator closed the task');

CREATE FUNCTION close_task(p_project_id uuid, p_task_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_actor text, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_task tasks%ROWTYPE; v_job runtime_jobs%ROWTYPE; v_ended int := 0; v_handled int := 0;
  v_expired int := 0; v_event domain_events%ROWTYPE; v_audit uuid; v_from text;
BEGIN
  PERFORM 1 FROM projects p WHERE p.id=p_project_id AND p.owner_id=p_owner_id
    AND p.status NOT IN ('archived','deleting','deletion_failed','deleted');
  IF NOT FOUND THEN
    PERFORM refuse('task_unavailable', format('no project %s this operator owns', p_project_id));
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id=p_task_id AND project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('task_unavailable', format('no task %s in project %s', p_task_id, p_project_id));
  END IF;
  IF v_task.status IN ('approved','publishing','deployed','completed','cancelled','failed') THEN
    PERFORM refuse('task_already_closed', format('task %s is %s', v_task.id, v_task.status));
  END IF;
  IF p_expected_version IS DISTINCT FROM v_task.version THEN
    PERFORM refuse('task_version_stale',
      format('task %s is at version %s; the panel showed %s', v_task.id, v_task.version, p_expected_version), '40001');
  END IF;

  -- Nothing is taken from under a worker: its jobs are locked, and one in
  -- flight, or a run still open, refuses.
  PERFORM 1 FROM runtime_jobs j WHERE j.task_id=v_task.id AND j.status IN ('pending','in_flight') FOR UPDATE;
  IF EXISTS (SELECT 1 FROM runtime_jobs j WHERE j.task_id=v_task.id AND j.status='in_flight')
     OR EXISTS (SELECT 1 FROM task_runs r WHERE r.task_id=v_task.id
                AND r.status IN ('queued','starting','running','waiting_for_input','blocked')) THEN
    PERFORM refuse('task_work_in_flight', format('task %s has work running; stop the run first', v_task.id));
  END IF;

  FOR v_job IN SELECT * FROM runtime_jobs j WHERE j.task_id=v_task.id AND j.status='pending' ORDER BY j.id LOOP
    PERFORM end_runtime_job(v_job.id, p_actor, 'task_closed', 'the operator closed the task');
    v_ended:=v_ended+1;
  END LOOP;
  -- Its dead letters, the ones just ended among them, are answered: a closed
  -- task has nothing left to retry into.
  UPDATE runtime_jobs SET resolved_at=clock_timestamp(),resolved_by=p_actor,resolution='the operator closed the task'
  WHERE task_id=v_task.id AND status='dead_letter' AND resolved_at IS NULL;
  GET DIAGNOSTICS v_handled = ROW_COUNT;
  UPDATE approvals SET status='expired' WHERE task_id=v_task.id AND status='pending';
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  -- Re-read: ending an implementation job moves the task to needs_attention.
  v_from:=v_task.status;
  UPDATE tasks SET status='cancelled',version=version+1,updated_at=clock_timestamp()
  WHERE id=v_task.id RETURNING * INTO v_task;
  v_event:=append_event('task.cancelled',v_task.project_id,v_task.id,NULL,'user',p_actor,NULL,
    COALESCE(p_correlation_id,v_task.id::text),'task-closed:'||v_task.id,'task',v_task.id,v_task.version,
    jsonb_build_object('from_status',v_from,'jobs_ended',v_ended,
      'message','You closed this task. Nothing more runs for it; a message here starts a linked follow-up.'));
  v_audit:=write_audit_event(v_task.project_id,v_task.id,NULL,'operator',p_actor,'task.closed','task',v_task.id::text,
    'allowed',NULL,jsonb_build_object('from_status',v_from,'jobs_ended',v_ended,'dead_letters_handled',v_handled,
      'approvals_expired',v_expired),p_correlation_id);
  RETURN jsonb_build_object('project_id',v_task.project_id,'task_id',v_task.id,'status',v_task.status,
    'version',v_task.version,'from_status',v_from,'jobs_ended',v_ended,'dead_letters_handled',v_handled,
    'approvals_expired',v_expired,'event_id',v_event.id,'audit_event_id',v_audit);
END $$;

REVOKE EXECUTE ON FUNCTION close_task(uuid,uuid,uuid,bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_task(uuid,uuid,uuid,bigint,text,text) TO infra_web;
