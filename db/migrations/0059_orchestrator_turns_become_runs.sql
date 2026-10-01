-- Stage 11.1b, WP-3a: every orchestrator turn is a Run.
--
-- ADR-0013. The data model already says what a Run is — "a concrete turn,
-- resume, implementation or review" — and until now only an implementation had
-- one. A Codex chat turn and a review turn were runtime jobs with `run_id NULL`:
-- the worker handed the supervisor a project and nothing else, so there was
-- nothing a workspace access grant (WP-3b, 0060) could be bound to. This
-- migration gives every such turn a run, and fixes the places that read
-- `task_runs` as if a run could only be an implementation.
--
-- Where the run is created
-- ------------------------
-- In a trigger on runtime_jobs, not in the claim function. A Codex job changes
-- status on six paths — claimed, reclaimed after its lease ran out, completed,
-- retried, dead-lettered, interrupted — spread over five functions written in
-- four migrations. Putting the run into each would be six copies of one rule
-- waiting to drift, and the seventh path somebody adds later would be the one
-- that forgets. The trigger fires on the columns that mark an attempt
-- (`status`, `attempt_count`) and only for the two orchestrator job types.
--
-- What a turn run is, and what it never is
-- ----------------------------------------
-- `write_capable = false`, phase `orchestrator_turn` (codex_chat_turn) or
-- `review_turn` (resume_codex — its only producers are implementation.completed
-- and revision.completed, so in this schema "resume" and "review turn" are the
-- same job). One run per attempt: a retry is a new turn, and the attempt it
-- replaces is closed rather than reused, so a run's status describes one turn.
--
-- **A turn run is never `lost`.** `lost` means one thing in this schema: the
-- writer whose workspace lease expired, set by reconcile_expired_workspace_locks.
-- Lock recovery trusts it — `recover_lock` finds the most recent lost run of the
-- project and asks whether its process is still alive. A turn run has no process
-- ref, so a lost turn would answer "absent" on behalf of an implementation whose
-- process may still be running, and the workspace would be handed over. A turn
-- whose lease runs out is `failed` with `turn_lease_expired`. The release before
-- this one reads `lost` the old way, so this rule is also what keeps it safe
-- against this schema.
--
-- The readers that assumed a run is an implementation
-- ---------------------------------------------------
-- Every reader of task_runs was read for this migration; STAGE_11_1B_ACCEPTANCE
-- lists all of them. Two SQL functions change here:
--
-- * finalize_runtime_interrupt branched on `run_id IS NOT NULL` to mean "an
--   implementation was interrupted": release the lock, set the task to
--   needs_attention, file an input request. With turns carrying runs, stopping a
--   chat turn would have done all three. It now branches on the run's
--   `write_capable`, and a turn is simply interrupted.
-- * claim_workspace_operation's recover_lock lookup takes the most recent lost
--   run of the project. By the rule above no turn is ever lost, and the filter
--   `r.write_capable` says so where the assumption is made, rather than leaving
--   it to a rule written somewhere else.
--
-- A review job already carries a run — the wrong one
-- -------------------------------------------------
-- route_outbox_message copies the event's run_id into the job, and resume_codex
-- is routed from implementation.completed, so a review job is born pointing at
-- the *implementation* run it reviews. Found on the production host before this
-- migration ran: 4 of its 14 orchestrator jobs carried a run_id. Three things
-- follow, and each is handled here:
--
-- * the trigger closes the attempt a claim replaces only when that run is itself
--   a turn — never the implementation a review job arrived pointing at;
-- * the job's run_id then becomes the review turn. Nothing reads a review job's
--   run_id to find the implementation: the link lives in the source event's
--   run_id and in handoffs.target_run_id, and stays there;
-- * the invariant is "every attempt has its own turn run", not "run_id is not
--   null" — so the backfill also records a turn for past review jobs whose
--   run_id is an implementation's.
--
-- History
-- -------
-- Existing orchestrator jobs that were ever attempted get a run, so the
-- invariant holds for every row and is enforced by a CHECK rather than hoped for.
-- A backfilled run takes its times from the job; its status from the job's
-- outcome — completed, or failed with `backfilled_<job status>`. A job that was
-- never attempted had no turn and gets no run.
SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION orchestrator_turn_agent(p_task_id uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(pa.agent_id, t.active_agent_id)
  FROM tasks t
  LEFT JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
  WHERE t.id=p_task_id;
$$;

CREATE OR REPLACE FUNCTION orchestrator_turn_session(p_project_id uuid, p_task_id uuid, p_agent_id uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$
  -- The session bind_codex_chat_session creates and resumes for this task. It
  -- may not exist yet: a first turn is bound when it completes.
  SELECT s.id FROM agent_sessions s
  WHERE s.project_id=p_project_id AND s.agent_id=p_agent_id
    AND s.purpose='task_chat:'||p_task_id::text
  ORDER BY s.active DESC, s.updated_at DESC
  LIMIT 1;
$$;

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
  IF OLD.status='in_flight' AND NEW.status<>'in_flight' AND NEW.run_id IS NOT NULL THEN
    UPDATE task_runs r SET
      status=CASE WHEN NEW.status='completed' THEN 'completed' ELSE 'failed' END,
      failure_code=CASE
        WHEN NEW.status='completed' THEN NULL
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

CREATE TRIGGER runtime_jobs_orchestrator_turn_run
BEFORE UPDATE OF status, attempt_count ON runtime_jobs
FOR EACH ROW
WHEN (NEW.job_type IN ('codex_chat_turn','resume_codex'))
EXECUTE FUNCTION record_orchestrator_turn_run();

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
  END IF;
  IF v_run.write_capable THEN
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
  ELSIF v_run.id IS NOT NULL THEN
    -- An orchestrator turn. Nothing was writing, so there is no lock to give
    -- back, no worker to ask for instructions and nothing that needs attention:
    -- the turn stops, the run says so, and the task is where it was.
    UPDATE agent_sessions SET native_session_id=COALESCE(native_session_id,NULLIF(p_native_session_id,'')),
      updated_at=clock_timestamp(),version=version+1 WHERE id=v_run.session_id;
    UPDATE task_runs SET status='interrupted',finished_at=clock_timestamp(),failure_code='operator_interrupted',
      exit_code=NULL,updated_at=clock_timestamp(),version=version+1 WHERE id=v_run.id;
    UPDATE tasks SET version=version+1,updated_at=clock_timestamp() WHERE id=v_task.id RETURNING * INTO v_task;
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

CREATE OR REPLACE FUNCTION claim_workspace_operation(p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_operation workspace_operations%ROWTYPE;
  v_project projects%ROWTYPE;
  v_lock workspace_locks%ROWTYPE;
  v_run task_runs%ROWTYPE;
  v_credential text;
  v_refusal text;
BEGIN
  SELECT * INTO v_operation FROM workspace_operations
    WHERE status='pending' OR (status='running' AND started_at<clock_timestamp()-interval '5 minutes')
    ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO v_project FROM projects WHERE id=v_operation.project_id FOR UPDATE;

  IF workspace_operation_is_system(v_operation.operation_type) THEN
    IF v_project.status IN ('deleting','deletion_failed','deleted') THEN
      v_refusal := 'project entered deletion before the operation ran';
    ELSIF v_project.status='archived' THEN
      v_refusal := 'project was archived before the operation ran';
    END IF;
  END IF;

  IF v_refusal IS NOT NULL THEN
    UPDATE workspace_operations SET status='failed',error=v_refusal,
      worker_id=p_worker_id,completed_at=clock_timestamp()
    WHERE id=v_operation.id;
    PERFORM write_audit_event(v_operation.project_id,NULL,NULL,'system',p_worker_id,
      'workspace.operation_failed','workspace_operation',v_operation.id::text,'denied',NULL,
      jsonb_build_object('operation_type',v_operation.operation_type,'error',v_refusal),
      v_operation.correlation_id);
    RETURN NULL;
  END IF;

  UPDATE workspace_operations SET status='running',worker_id=p_worker_id,started_at=clock_timestamp(),
    error=NULL WHERE id=v_operation.id RETURNING * INTO v_operation;

  SELECT * INTO v_lock FROM workspace_locks WHERE project_id=v_operation.project_id;

  IF v_lock.owner_run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM task_runs WHERE id=v_lock.owner_run_id;
  ELSIF v_operation.operation_type='recover_lock' THEN
    SELECT r.* INTO v_run FROM task_runs r JOIN tasks t ON t.id=r.task_id
      WHERE t.project_id=v_operation.project_id AND r.status='lost' AND r.write_capable
      ORDER BY r.finished_at DESC NULLS LAST,r.created_at DESC LIMIT 1;
  END IF;

  IF v_operation.operation_type='provision_workspace' THEN
    SELECT secret_locator INTO v_credential FROM credential_references
    WHERE project_id=v_project.id AND provider='github_deploy_key' AND status='active'
      AND 'clone' = ANY(allowed_actions)
    ORDER BY version DESC LIMIT 1;
  END IF;

  RETURN jsonb_build_object('id',v_operation.id,'project_id',v_operation.project_id,
    'operation_type',v_operation.operation_type,'workspace_path',v_project.workspace_path,
    'lock_status',v_lock.status,'owner_run_id',v_lock.owner_run_id,'process_ref',v_run.process_ref,
    'project_name',v_project.name,'repository_url',v_project.repository_url,
    'default_branch',v_project.default_branch,
    'credential_mode',COALESCE(v_project.credential_mode,'empty'),
    'credential_locator',v_credential,
    'project_status',v_project.status,'project_version',v_project.version);
END $$;

-- Idempotent: it touches only attempted orchestrator jobs without a turn run of
-- their own, and gives each one, so a second call finds nothing. Kept as a function rather than inline so that the
-- database test can exercise it on legacy-shaped rows.
CREATE OR REPLACE FUNCTION backfill_orchestrator_turn_runs()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_job runtime_jobs%ROWTYPE;
  v_agent uuid;
  v_run uuid;
  v_status text;
  v_count integer:=0;
  v_orphans text;
BEGIN
  -- Checked before anything is written, so a host that cannot be backfilled is
  -- refused with the rows named, not half-migrated. The repair for a listed job
  -- is to give its task an orchestrator assignment (or an active agent) and run
  -- the update again; nothing here guesses an owner.
  SELECT string_agg(j.id::text,', ' ORDER BY j.id) INTO v_orphans
  FROM runtime_jobs j
  WHERE j.job_type IN ('codex_chat_turn','resume_codex') AND j.attempt_count>0
    AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.id=j.run_id AND NOT r.write_capable)
    AND orchestrator_turn_agent(j.task_id) IS NULL;
  IF v_orphans IS NOT NULL THEN
    RAISE EXCEPTION 'orchestrator jobs without an agent to own their turn: %',v_orphans
      USING ERRCODE='55000',
      DETAIL='backfill_orchestrator_turn_runs: each task needs an orchestrator assignment or an active agent';
  END IF;

  FOR v_job IN
    -- No turn run of its own: either no run at all, or — for a review job — the
    -- implementation run it was routed with.
    SELECT * FROM runtime_jobs j
    WHERE j.job_type IN ('codex_chat_turn','resume_codex') AND j.attempt_count>0
      AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.id=j.run_id AND NOT r.write_capable)
    ORDER BY j.id FOR UPDATE
  LOOP
    v_agent:=orchestrator_turn_agent(v_job.task_id);
    v_status:=CASE
      WHEN v_job.status='completed' THEN 'completed'
      WHEN v_job.status='in_flight' AND v_job.leased_until>clock_timestamp() THEN 'running'
      ELSE 'failed' END;
    INSERT INTO task_runs(task_id,session_id,agent_id,phase,status,write_capable,
      started_at,finished_at,failure_code,created_at,updated_at)
    VALUES(v_job.task_id,orchestrator_turn_session(v_job.project_id,v_job.task_id,v_agent),v_agent,
      CASE v_job.job_type WHEN 'resume_codex' THEN 'review_turn' ELSE 'orchestrator_turn' END,
      v_status,false,
      COALESCE(v_job.started_at,v_job.created_at),
      CASE WHEN v_status='running' THEN NULL
        ELSE COALESCE(v_job.completed_at,v_job.heartbeat_at,v_job.started_at,v_job.created_at) END,
      CASE WHEN v_status='failed' THEN 'backfilled_'||v_job.status END,
      -- Ordered by when the turn happened, not by when this migration ran:
      -- readers pick "the latest run" by created_at.
      COALESCE(v_job.started_at,v_job.created_at),
      clock_timestamp())
    RETURNING id INTO v_run;
    -- run_id alone: the trigger watches status and attempt_count, so the
    -- backfill does not open a second turn for the job it is recording.
    UPDATE runtime_jobs SET run_id=v_run WHERE id=v_job.id;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $$;

SELECT backfill_orchestrator_turn_runs();

-- The invariant, held by the database. An orchestrator job that was ever
-- attempted has a run; one that was not, has none to have.
ALTER TABLE runtime_jobs ADD CONSTRAINT runtime_jobs_orchestrator_turn_has_run
  CHECK (job_type NOT IN ('codex_chat_turn','resume_codex') OR attempt_count=0 OR run_id IS NOT NULL);

ALTER FUNCTION orchestrator_turn_agent(uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION orchestrator_turn_session(uuid,uuid,uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION record_orchestrator_turn_run()
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION backfill_orchestrator_turn_runs()
  SET search_path=control_plane,public,extensions,pg_temp;
-- Redefined above, and CREATE OR REPLACE does not keep a function's SET clause.
ALTER FUNCTION finalize_runtime_interrupt(bigint,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_workspace_operation(text)
  SET search_path=control_plane,public,extensions,pg_temp;

-- New functions carry their own grants: a default privilege is a property of the
-- database it was set in, and the production host does not have the global one.
REVOKE EXECUTE ON FUNCTION orchestrator_turn_agent(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION orchestrator_turn_session(uuid,uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_orchestrator_turn_run() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION backfill_orchestrator_turn_runs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orchestrator_turn_agent(uuid) TO infra_worker;
GRANT EXECUTE ON FUNCTION orchestrator_turn_session(uuid,uuid,uuid) TO infra_worker;
GRANT EXECUTE ON FUNCTION record_orchestrator_turn_run() TO infra_worker;
GRANT EXECUTE ON FUNCTION backfill_orchestrator_turn_runs() TO infra_worker;
