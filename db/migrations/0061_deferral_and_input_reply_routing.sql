-- Stage 11.1b, WP-3c: a refusal that will succeed later is deferred, not retried,
-- and an answer typed into the chat reaches the run that asked for it.
--
-- defer_runtime_job
-- -----------------
-- 11.1 learned that a terminal failure for a refusal that would have succeeded
-- later loses the work (defect 35). With 0060 a Codex turn is refused a workspace
-- grant while a writer holds the tree — grant_writer_active — and the turn can
-- lose that race between the claim and the spawn. Until now the worker's only
-- answer was retry_runtime_job, which spends an attempt; five of them in a row
-- and a message that would have been answered in ten minutes is a dead letter.
--
-- Deferral hands the job back pending, after a delay, and gives the attempt
-- back. Its reasons are a closed list, because "defer" for a reason that will
-- not clear on its own is a retry loop without a budget:
--
--   grant_writer_active   a writer holds the workspace; it will release it
--   runtime_paused        the supervisor's admission fence is closed for an
--                         installation; it will reopen
--
-- Only orchestrator jobs. An implementation that could not launch has already
-- taken the workspace lock in start_implementation_job, and handing it back
-- pending would leave that lock held by a run nobody is running.
--
-- The turn run of a deferred attempt is `cancelled` with `turn_deferred`: it never
-- ran against the workspace. record_orchestrator_turn_run is redefined for that
-- and nothing else.
--
-- record_task_chat_message
-- ------------------------
-- While an implementation waits on an input request, the chat composer is still
-- open, and a message typed into it became a Codex turn. The run that asked stayed
-- blocked. Now a message on a task with an open input request resolves that
-- request through resolve_worker_interaction — the same path the dedicated reply
-- action takes — and starts no orchestrator turn.
--
-- resolve_worker_interaction
-- --------------------------
-- A resumed implementation inherited everything from the previous handoff except
-- the executor assignment — the same omission 0058 fixed in request_revision —
-- so its launch could never be validated. Found while wiring WP-3c's grants, which
-- derive a writer's assignment from that field, and fixed here because this
-- migration is what makes the path common.
SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION defer_runtime_job(
  p_job_id bigint, p_worker_id text, p_reason text, p_delay interval DEFAULT interval '30 seconds'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('grant_writer_active','runtime_paused') THEN
    RAISE EXCEPTION 'a job may be deferred only for a reason that clears on its own'
      USING ERRCODE='22023', DETAIL='defer_reason_not_transient';
  END IF;
  IF p_delay IS NULL OR p_delay < interval '1 second' OR p_delay > interval '10 minutes' THEN
    RAISE EXCEPTION 'defer delay must be between one second and ten minutes' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'in_flight' OR v_job.leased_by IS DISTINCT FROM p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'the job is not actively leased by this worker' USING ERRCODE='55000',
      DETAIL='defer_job_not_leased';
  END IF;
  IF v_job.job_type NOT IN ('codex_chat_turn','resume_codex') THEN
    RAISE EXCEPTION 'only an orchestrator job can be deferred' USING ERRCODE='55000',
      DETAIL='defer_job_type';
  END IF;

  UPDATE runtime_jobs SET
    status='pending', leased_by=NULL, leased_until=NULL,
    available_at=clock_timestamp()+p_delay,
    attempt_count=GREATEST(attempt_count-1,0),
    last_error=left('deferred: '||p_reason,4000),
    -- As a freshly queued job: the next claim writes its own phase and detail.
    activity_phase='queued', activity_detail='Waiting for an available runtime worker'
  WHERE id=p_job_id RETURNING * INTO v_job;

  RETURN jsonb_build_object('job_id',v_job.id,'status','deferred','reason',p_reason,
    'available_at',v_job.available_at,'attempt_count',v_job.attempt_count);
END $$;

-- record_orchestrator_turn_run, redefined from 0059: a deferred attempt ends as
-- cancelled/turn_deferred. The trigger itself is unchanged.
CREATE OR REPLACE FUNCTION record_orchestrator_turn_run()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_agent uuid;
  v_run uuid;
BEGIN
  -- An attempt begins: the job enters in_flight with a higher attempt count.
  -- That is a claim, of a pending job or of one whose lease ran out.
  IF NEW.status='in_flight' AND NEW.attempt_count>OLD.attempt_count THEN
    IF OLD.run_id IS NOT NULL THEN
      -- The attempt this one replaces. Failed, never lost — see the header.
      UPDATE task_runs SET status='failed',failure_code='turn_lease_expired',
        finished_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1
      -- `NOT write_capable`: a review job is routed pointing at the implementation
      -- it reviews, and that run is not an earlier attempt of this turn.
      WHERE id=OLD.run_id AND NOT write_capable
        AND status IN ('queued','starting','running','waiting_for_input','blocked');
    END IF;

    v_agent:=orchestrator_turn_agent(NEW.task_id);
    IF v_agent IS NULL THEN
      -- Refused rather than claimed without a run: the invariant this migration
      -- introduces is that no orchestrator attempt exists without one.
      RAISE EXCEPTION 'task % has no orchestrator agent to own the turn of job %',NEW.task_id,NEW.id
        USING ERRCODE='55000';
    END IF;

    INSERT INTO task_runs(task_id,session_id,agent_id,phase,status,write_capable,started_at)
    VALUES(NEW.task_id,orchestrator_turn_session(NEW.project_id,NEW.task_id,v_agent),v_agent,
      CASE NEW.job_type WHEN 'resume_codex' THEN 'review_turn' ELSE 'orchestrator_turn' END,
      'running',false,clock_timestamp())
    RETURNING id INTO v_run;
    NEW.run_id:=v_run;
    RETURN NEW;
  END IF;

  -- An attempt ends. Only a run that is still active is closed: an interrupt
  -- has already said `interrupted`, and that is the truer answer.
  --
  -- 0061: an attempt handed back by defer_runtime_job gives its attempt back,
  -- and that is how it is told apart. It never ran against the workspace — a
  -- writer was there first — so it is `cancelled` with `turn_deferred`, not a
  -- failure that would count against anything.
  IF OLD.status='in_flight' AND NEW.status<>'in_flight' AND NEW.run_id IS NOT NULL THEN
    UPDATE task_runs r SET
      status=CASE
        WHEN NEW.status='completed' THEN 'completed'
        WHEN NEW.status='pending' AND NEW.attempt_count<OLD.attempt_count THEN 'cancelled'
        ELSE 'failed' END,
      failure_code=CASE
        WHEN NEW.status='completed' THEN NULL
        WHEN NEW.status='pending' AND NEW.attempt_count<OLD.attempt_count THEN 'turn_deferred'
        WHEN NEW.status='dead_letter' THEN 'turn_dead_lettered'
        ELSE 'turn_retried' END,
      -- The session is bound when the turn completes (complete_codex_chat_job
      -- binds it before acknowledging), so a first turn learns it here.
      session_id=COALESCE(r.session_id,orchestrator_turn_session(NEW.project_id,NEW.task_id,r.agent_id)),
      finished_at=clock_timestamp(),updated_at=clock_timestamp(),version=r.version+1
    WHERE r.id=NEW.run_id AND NOT r.write_capable
      AND r.status IN ('queued','starting','running','waiting_for_input','blocked');
  END IF;
  RETURN NEW;
END $$;

-- record_task_chat_message, redefined from 0038: a message on a task with an open
-- input request answers it.
CREATE OR REPLACE FUNCTION record_task_chat_message(
  p_project_id uuid, p_task_id uuid, p_message text,
  p_actor text, p_correlation text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_task tasks%ROWTYPE; v_open worker_interaction_reports%ROWTYPE;
BEGIN
  -- 0061: a message typed into the chat while the implementation is waiting for
  -- an answer is that answer. Before, it became an orchestrator turn: Codex was
  -- asked, and the run that had asked stayed blocked on a question nobody had
  -- routed to it. The dedicated reply action already resolved the report
  -- correctly; the chat composer, open at the same moment, did not.
  SELECT * INTO v_open FROM worker_interaction_reports r
  WHERE r.project_id=p_project_id AND r.task_id=p_task_id
    AND r.report_type='input_request' AND r.status='finalized' AND r.resolved_at IS NULL
  ORDER BY r.finalized_at DESC NULLS LAST, r.id DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('project_id',p_project_id,'task_id',p_task_id,
      'status','answered_input_request','report_id',v_open.id,'run_id',v_open.run_id,
      'resolution',resolve_worker_interaction(v_open.id,p_actor,
        jsonb_build_object('response',p_message),p_correlation));
  END IF;

  UPDATE tasks SET version=version+1, updated_at=clock_timestamp()
  WHERE id=p_task_id AND project_id=p_project_id
    AND status NOT IN ('approved','deployed','completed','cancelled','failed')
  RETURNING * INTO v_task;

  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM append_event('chat.user_message',v_task.project_id,v_task.id,NULL,'user',p_actor,
    NULL,p_correlation,'chat-message:'||v_task.id||':'||v_task.version,'task',v_task.id,
    v_task.version, jsonb_build_object('content',p_message));

  RETURN jsonb_build_object('project_id',v_task.project_id,'task_id',v_task.id,
                            'status',v_task.status,'version',v_task.version);
END $$;

-- resolve_worker_interaction, redefined from 0008: the resumed handoff inherits
-- its executor assignment.
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
  -- 0061: the seventh inherited field, as 0058 did for request_revision.
  -- request_implementation copies everything else from the previous handoff and
  -- not the executor assignment, so the resumed handoff named no executor and its
  -- launch could not be validated — "start runtime job not found", three
  -- retries, a dead letter. Latent until now: on the production host no input
  -- request had ever been answered. 0061 routes answers typed into the chat here,
  -- which would have made it the ordinary way to lose a task.
  UPDATE handoffs SET executor_assignment_id=v_previous.executor_assignment_id
  WHERE id=(v_delegate->>'handoff_id')::uuid AND executor_assignment_id IS NULL;

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

ALTER FUNCTION defer_runtime_job(bigint,text,text,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION record_orchestrator_turn_run()
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION record_task_chat_message(uuid,uuid,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;

REVOKE EXECUTE ON FUNCTION defer_runtime_job(bigint,text,text,interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION defer_runtime_job(bigint,text,text,interval) TO infra_worker;
ALTER FUNCTION resolve_worker_interaction(uuid,text,jsonb,text)
  SET search_path=control_plane,public,extensions,pg_temp;
