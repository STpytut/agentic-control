-- WP-3a: every orchestrator turn is a Run (migration 0059, ADR-0013).
--
-- What is pinned here: a claim opens a run and the job points at it; every way an
-- attempt ends closes that run with the right status; a retry is a new turn, not
-- the old run reused; a turn whose lease runs out is failed and never lost;
-- stopping a chat turn does not treat it as an interrupted implementation; lock
-- recovery ignores turn runs; the database refuses an attempted orchestrator job
-- without a run; and the backfill records history without inventing owners.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane,public,extensions;

-- One project with a Codex orchestrator and an executor, and a helper that
-- queues an orchestrator job the way route_outbox_message does.
CREATE TEMP TABLE turn_fixture(project_id uuid, orchestrator uuid, executor uuid, task_id uuid,
  review_task_id uuid, codex_profile uuid, executor_profile uuid) ON COMMIT DROP;
-- Each event on an aggregate needs its own version; the fixture writes many.
CREATE TEMP SEQUENCE turn_event_version START 1000;

DO $$
DECLARE
  v_user uuid; v_project uuid; v_codex_profile uuid; v_executor_profile uuid;
  v_codex uuid; v_executor uuid; v_orch_assignment uuid; v_task uuid; v_review_task uuid;
BEGIN
  INSERT INTO users(display_name) VALUES('Turn Runs') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Turn Runs','turn-runs','/srv/turn-runs') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,capabilities)
    VALUES('codex','test','test','openai','codex-turn-runs','{"interrupt":true}') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','opencode-turn-runs') RETURNING id INTO v_executor_profile;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('turn-runs-codex','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('turn-runs-executor','implementer',v_executor_profile) RETURNING id INTO v_executor;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING id INTO v_orch_assignment;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Planning task','Plan the work','planning',v_codex,v_orch_assignment,'test')
    RETURNING id INTO v_task;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Reviewed task','Review the work','awaiting_review',v_codex,v_orch_assignment,'test')
    RETURNING id INTO v_review_task;
  INSERT INTO turn_fixture VALUES(v_project,v_codex,v_executor,v_task,v_review_task,v_codex_profile,v_executor_profile);
END $$;

CREATE FUNCTION pg_temp.queue_turn(p_job_type text, p_key text, p_task uuid DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_fixture turn_fixture; v_event domain_events; v_job bigint; v_task uuid;
BEGIN
  SELECT * INTO v_fixture FROM turn_fixture;
  v_task:=COALESCE(p_task,v_fixture.task_id);
  v_event:=append_event(
    CASE p_job_type WHEN 'resume_orchestrator' THEN 'implementation.completed' ELSE 'chat.user_message' END,
    v_fixture.project_id,v_task,NULL,'user','operator',NULL,'turn-runs',p_key,'task',v_task,nextval('turn_event_version'),
    jsonb_build_object('content','hello'));
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status)
    VALUES(v_event.id,p_job_type,v_fixture.project_id,v_task,'pending') RETURNING id INTO v_job;
  RETURN v_job;
END $$;

-- A claim opens a running, read-only turn run owned by the orchestrator, and a
-- completion closes it and learns the session the completion bound.
DO $$
DECLARE v_fixture turn_fixture; v_job_id bigint; v_job runtime_jobs; v_run task_runs;
BEGIN
  SELECT * INTO v_fixture FROM turn_fixture;
  v_job_id:=pg_temp.queue_turn('orchestrator_turn','turn-runs-complete');
  SELECT * INTO v_job FROM claim_orchestrator_jobs('turn-worker',1,interval '5 minutes');
  IF v_job.id<>v_job_id OR v_job.run_id IS NULL THEN
    RAISE EXCEPTION 'the claim returned no run for job %: %',v_job_id,v_job;
  END IF;
  SELECT * INTO v_run FROM task_runs WHERE id=v_job.run_id;
  IF v_run.status<>'running' OR v_run.write_capable OR v_run.phase<>'orchestrator_turn'
     OR v_run.agent_id<>v_fixture.orchestrator OR v_run.task_id<>v_fixture.task_id OR v_run.started_at IS NULL THEN
    RAISE EXCEPTION 'the claimed turn run is wrong: %',v_run;
  END IF;

  PERFORM complete_orchestrator_job(v_job.id,'turn-worker','native-turn-thread','turn-1','Planned.');
  SELECT * INTO v_run FROM task_runs WHERE id=v_job.run_id;
  IF v_run.status<>'completed' OR v_run.finished_at IS NULL OR v_run.failure_code IS NOT NULL THEN
    RAISE EXCEPTION 'a completed turn did not complete its run: %',v_run;
  END IF;
  IF v_run.session_id IS NULL
     OR (SELECT native_session_id FROM agent_sessions WHERE id=v_run.session_id)<>'native-turn-thread' THEN
    RAISE EXCEPTION 'the first turn did not learn the session its completion bound: %',v_run;
  END IF;
  RAISE NOTICE 'a claimed turn has a running read-only run, and completion closes it with its session';
END $$;

-- A retry is a new turn. The first attempt is failed, the next claim opens a
-- second run, and the job points at the second.
DO $$
DECLARE v_job_id bigint; v_first runtime_jobs; v_second runtime_jobs; v_status text; v_run task_runs;
BEGIN
  v_job_id:=pg_temp.queue_turn('orchestrator_turn','turn-runs-retry');
  SELECT * INTO v_first FROM claim_orchestrator_jobs('turn-worker',1,interval '5 minutes');
  v_status:=retry_runtime_job(v_first.id,'turn-worker','codex app-server exited',interval '0 seconds',5);
  IF v_status<>'pending' THEN RAISE EXCEPTION 'the fixture did not retry: %',v_status; END IF;
  SELECT * INTO v_run FROM task_runs WHERE id=v_first.run_id;
  IF v_run.status<>'failed' OR v_run.failure_code<>'turn_retried' OR v_run.finished_at IS NULL THEN
    RAISE EXCEPTION 'a retried attempt did not fail its run: %',v_run;
  END IF;

  SELECT * INTO v_second FROM claim_orchestrator_jobs('turn-worker',1,interval '5 minutes');
  IF v_second.id<>v_job_id OR v_second.run_id IS NULL OR v_second.run_id=v_first.run_id THEN
    RAISE EXCEPTION 'the retry reused the failed run or opened none: first %, second %',v_first.run_id,v_second.run_id;
  END IF;
  IF (SELECT count(*) FROM task_runs WHERE task_id=v_first.task_id AND phase='orchestrator_turn'
        AND id IN (v_first.run_id,v_second.run_id))<>2 THEN
    RAISE EXCEPTION 'two attempts did not leave two runs';
  END IF;

  -- Exhaust the budget: the last attempt dead-letters, and its run says so.
  v_status:=retry_runtime_job(v_second.id,'turn-worker','still failing',interval '0 seconds',2);
  IF v_status<>'dead_letter' THEN RAISE EXCEPTION 'the fixture did not dead-letter: %',v_status; END IF;
  SELECT * INTO v_run FROM task_runs WHERE id=v_second.run_id;
  IF v_run.status<>'failed' OR v_run.failure_code<>'turn_dead_lettered' THEN
    RAISE EXCEPTION 'a dead-lettered attempt did not fail its run: %',v_run;
  END IF;
  RAISE NOTICE 'a retry is a new turn; retried and dead-lettered attempts fail their own runs';
END $$;

-- A turn whose lease runs out is reclaimed. The expired attempt is failed with
-- turn_lease_expired and never lost: lost belongs to the writer whose workspace
-- lease expired, and lock recovery trusts it.
DO $$
DECLARE v_first runtime_jobs; v_second runtime_jobs; v_run task_runs;
BEGIN
  PERFORM pg_temp.queue_turn('orchestrator_turn','turn-runs-lease');
  SELECT * INTO v_first FROM claim_orchestrator_jobs('turn-worker-a',1,interval '5 minutes');
  UPDATE runtime_jobs SET leased_until=clock_timestamp()-interval '1 second' WHERE id=v_first.id;
  SELECT * INTO v_second FROM claim_orchestrator_jobs('turn-worker-b',1,interval '5 minutes');
  IF v_second.id<>v_first.id OR v_second.run_id=v_first.run_id THEN
    RAISE EXCEPTION 'the expired turn was not reclaimed as a new attempt';
  END IF;
  SELECT * INTO v_run FROM task_runs WHERE id=v_first.run_id;
  IF v_run.status<>'failed' OR v_run.failure_code<>'turn_lease_expired' THEN
    RAISE EXCEPTION 'an expired turn run is % (%), not failed/turn_lease_expired',v_run.status,v_run.failure_code;
  END IF;
  IF EXISTS(SELECT 1 FROM task_runs WHERE NOT write_capable AND status='lost') THEN
    RAISE EXCEPTION 'a turn run became lost';
  END IF;
  PERFORM acknowledge_runtime_job(v_second.id,'turn-worker-b','{}'::jsonb);
  RAISE NOTICE 'an expired turn is failed with turn_lease_expired, never lost';
END $$;

-- A review turn is a run too, with its own phase.
DO $$
DECLARE v_fixture turn_fixture; v_job runtime_jobs; v_run task_runs;
BEGIN
  SELECT * INTO v_fixture FROM turn_fixture;
  PERFORM pg_temp.queue_turn('resume_orchestrator','turn-runs-review',v_fixture.review_task_id);
  SELECT * INTO v_job FROM claim_orchestrator_jobs('turn-worker',1,interval '5 minutes');
  SELECT * INTO v_run FROM task_runs WHERE id=v_job.run_id;
  IF v_job.job_type<>'resume_orchestrator' OR v_run.phase<>'review_turn' OR v_run.write_capable OR v_run.status<>'running' THEN
    RAISE EXCEPTION 'a review turn run is wrong: job %, run %',v_job,v_run;
  END IF;
  PERFORM complete_orchestrator_job(v_job.id,'turn-worker','native-review-thread','review-1','Reviewed.');
  IF (SELECT status FROM task_runs WHERE id=v_job.run_id)<>'completed' THEN
    RAISE EXCEPTION 'a completed review turn did not complete its run';
  END IF;
  RAISE NOTICE 'a review turn is a run with phase review_turn';
END $$;

-- A review job is routed pointing at the implementation it reviews:
-- route_outbox_message copies the event's run_id. On the production host 4 of 14
-- orchestrator jobs looked like this before 0059. The claim must open a review
-- turn of its own and must not close, fail or otherwise touch that
-- implementation run — here still running, which is the case that would hurt.
DO $$
DECLARE v_fixture turn_fixture; v_impl uuid; v_event domain_events; v_job_id bigint; v_job runtime_jobs; v_impl_run task_runs;
BEGIN
  SELECT * INTO v_fixture FROM turn_fixture;
  INSERT INTO task_runs(task_id,agent_id,phase,status,write_capable,workspace_fencing_token,started_at)
    VALUES(v_fixture.review_task_id,v_fixture.executor,'implementation','running',true,7,clock_timestamp())
    RETURNING id INTO v_impl;
  v_event:=append_event('implementation.completed',v_fixture.project_id,v_fixture.review_task_id,v_impl,
    'system','worker',NULL,'turn-runs','turn-runs-routed-review','task',v_fixture.review_task_id,
    nextval('turn_event_version'),'{}'::jsonb);
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,run_id,status)
    VALUES(v_event.id,'resume_orchestrator',v_fixture.project_id,v_fixture.review_task_id,v_impl,'pending')
    RETURNING id INTO v_job_id;

  SELECT * INTO v_job FROM claim_orchestrator_jobs('turn-worker',1,interval '5 minutes');
  SELECT * INTO v_impl_run FROM task_runs WHERE id=v_impl;
  IF v_job.id<>v_job_id OR v_job.run_id=v_impl THEN
    RAISE EXCEPTION 'the review claim kept the implementation run as its turn: %',v_job;
  END IF;
  IF v_impl_run.status<>'running' OR v_impl_run.failure_code IS NOT NULL OR v_impl_run.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'claiming a review touched the implementation it reviews: %',v_impl_run;
  END IF;
  IF (SELECT phase FROM task_runs WHERE id=v_job.run_id)<>'review_turn' THEN
    RAISE EXCEPTION 'the routed review job did not open a review turn';
  END IF;
  IF (SELECT run_id FROM domain_events WHERE id=v_job.source_event_id)<>v_impl THEN
    RAISE EXCEPTION 'the link from the review to its implementation is gone from the source event';
  END IF;

  PERFORM retry_runtime_job(v_job.id,'turn-worker','review app-server exited',interval '0 seconds',1);
  SELECT * INTO v_impl_run FROM task_runs WHERE id=v_impl;
  IF v_impl_run.status<>'running' THEN
    RAISE EXCEPTION 'ending a review attempt touched the implementation run: %',v_impl_run;
  END IF;
  UPDATE task_runs SET status='completed',finished_at=clock_timestamp() WHERE id=v_impl;
  RAISE NOTICE 'a review routed with its implementation run opens its own turn and leaves that run alone';
END $$;

-- Stopping a chat turn stops the turn. Before 0059 finalize_runtime_interrupt
-- read "the job has a run" as "an implementation was interrupted": with turns
-- carrying runs, that would have set the task to needs_attention and filed an
-- input request for a conversation nobody was writing in.
DO $$
DECLARE v_fixture turn_fixture; v_job runtime_jobs; v_run task_runs; v_before text; v_result jsonb;
BEGIN
  SELECT * INTO v_fixture FROM turn_fixture;
  PERFORM pg_temp.queue_turn('orchestrator_turn','turn-runs-interrupt');
  SELECT * INTO v_job FROM claim_orchestrator_jobs('turn-worker',1,interval '5 minutes');
  SELECT status INTO v_before FROM tasks WHERE id=v_fixture.task_id;

  PERFORM request_runtime_interrupt(v_fixture.project_id,v_fixture.task_id,'operator','Stop this turn','turn-runs');
  v_result:=finalize_runtime_interrupt(v_job.id,'turn-worker','native-turn-thread');

  SELECT * INTO v_run FROM task_runs WHERE id=v_job.run_id;
  IF v_run.status<>'interrupted' OR v_run.failure_code<>'operator_interrupted' THEN
    RAISE EXCEPTION 'the interrupted turn run is % (%), not interrupted — the job''s completion must not overwrite it',
      v_run.status,v_run.failure_code;
  END IF;
  IF (SELECT status FROM tasks WHERE id=v_fixture.task_id)<>v_before THEN
    RAISE EXCEPTION 'stopping a chat turn moved the task from % to %',v_before,
      (SELECT status FROM tasks WHERE id=v_fixture.task_id);
  END IF;
  IF EXISTS(SELECT 1 FROM worker_interaction_reports WHERE run_id=v_run.id) THEN
    RAISE EXCEPTION 'stopping a chat turn filed a worker interaction report';
  END IF;
  IF (SELECT status FROM runtime_jobs WHERE id=v_job.id)<>'completed' OR v_result->>'report_id' IS NOT NULL THEN
    RAISE EXCEPTION 'the interrupted turn job did not finish cleanly: %',v_result;
  END IF;
  RAISE NOTICE 'stopping a chat turn interrupts its run and leaves the task where it was';
END $$;

-- Lock recovery reads the most recent lost *writer*. A turn run marked lost —
-- which 0059 never does, but the release before it or a manual repair could —
-- must not stand in for it: it has no process ref, and "no process" would be
-- read as "the writer is gone".
DO $$
DECLARE v_fixture turn_fixture; v_writer uuid; v_claim jsonb;
BEGIN
  SELECT * INTO v_fixture FROM turn_fixture;
  INSERT INTO task_runs(task_id,agent_id,phase,status,write_capable,workspace_fencing_token,process_ref,started_at,finished_at)
    VALUES(v_fixture.task_id,v_fixture.executor,'implementation','lost',true,1,'runtime-supervisor:4242',
      clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')
    RETURNING id INTO v_writer;
  INSERT INTO task_runs(task_id,agent_id,phase,status,write_capable,started_at,finished_at)
    VALUES(v_fixture.task_id,v_fixture.orchestrator,'orchestrator_turn','lost',false,
      clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '5 minutes');
  INSERT INTO workspace_operations(project_id,operation_type,requested_by,reason,correlation_id)
    VALUES(v_fixture.project_id,'recover_lock','operator','Recover after a lost writer','turn-runs-recover');

  v_claim:=claim_workspace_operation('turn-recovery-worker');
  IF v_claim->>'process_ref' IS DISTINCT FROM 'runtime-supervisor:4242' THEN
    RAISE EXCEPTION 'lock recovery read the newer turn run instead of the lost writer: %',v_claim;
  END IF;
  RAISE NOTICE 'lock recovery reads the lost writer, not a newer turn run';
END $$;

-- The invariant is the database's, not the trigger's alone.
DO $$
DECLARE v_fixture turn_fixture; v_event domain_events; v_constraint text;
BEGIN
  SELECT * INTO v_fixture FROM turn_fixture;
  v_event:=append_event('chat.user_message',v_fixture.project_id,v_fixture.task_id,NULL,'user','operator',
    NULL,'turn-runs','turn-runs-check','task',v_fixture.task_id,nextval('turn_event_version'),'{}'::jsonb);
  BEGIN
    INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status,attempt_count)
      VALUES(v_event.id,'orchestrator_turn',v_fixture.project_id,v_fixture.task_id,'dead_letter',1);
    RAISE EXCEPTION 'an attempted orchestrator job without a run was accepted';
  EXCEPTION WHEN check_violation THEN
    -- Any CHECK would satisfy a bare handler, and an older one refusing the
    -- fixture for an unrelated reason would make this test prove nothing.
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint<>'runtime_jobs_orchestrator_turn_has_run' THEN
      RAISE EXCEPTION 'refused by % instead of the turn-run invariant',v_constraint;
    END IF;
  END;
  RAISE NOTICE 'the database refuses an attempted orchestrator job without a run';
END $$;

-- The backfill, on rows shaped the way 0058 left them. The constraint is set
-- aside for the length of this block — the rows it would refuse are exactly the
-- history being recorded — and put back afterwards, validating what was written.
DO $$
DECLARE
  v_fixture turn_fixture; v_orphan_task uuid;
  v_done bigint; v_dead bigint; v_review bigint; v_never bigint; v_routed bigint; v_impl uuid;
  v_count integer; v_run task_runs;
  v_at timestamptz:=clock_timestamp()-interval '3 days';
BEGIN
  SELECT * INTO v_fixture FROM turn_fixture;
  ALTER TABLE runtime_jobs DROP CONSTRAINT runtime_jobs_orchestrator_turn_has_run;

  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status,attempt_count,
      created_at,started_at,completed_at)
    VALUES((append_event('chat.user_message',v_fixture.project_id,v_fixture.task_id,NULL,'user','operator',
      NULL,'turn-runs','legacy-done','task',v_fixture.task_id,nextval('turn_event_version'),'{}'::jsonb)).id,
      'orchestrator_turn',v_fixture.project_id,v_fixture.task_id,'completed',1,
      v_at,v_at+interval '1 second',v_at+interval '40 seconds')
    RETURNING id INTO v_done;
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status,attempt_count,
      created_at,started_at,heartbeat_at,last_error)
    VALUES((append_event('chat.user_message',v_fixture.project_id,v_fixture.task_id,NULL,'user','operator',
      NULL,'turn-runs','legacy-dead','task',v_fixture.task_id,nextval('turn_event_version'),'{}'::jsonb)).id,
      'orchestrator_turn',v_fixture.project_id,v_fixture.task_id,'dead_letter',3,
      v_at,v_at+interval '1 second',v_at+interval '9 seconds','exhausted')
    RETURNING id INTO v_dead;
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status,attempt_count,
      created_at,started_at,completed_at)
    VALUES((append_event('implementation.completed',v_fixture.project_id,v_fixture.review_task_id,NULL,'system','worker',
      NULL,'turn-runs','legacy-review','task',v_fixture.review_task_id,nextval('turn_event_version'),'{}'::jsonb)).id,
      'resume_orchestrator',v_fixture.project_id,v_fixture.review_task_id,'completed',1,
      v_at,v_at+interval '2 seconds',v_at+interval '30 seconds')
    RETURNING id INTO v_review;
  INSERT INTO task_runs(task_id,agent_id,phase,status,write_capable,workspace_fencing_token,started_at,finished_at)
    VALUES(v_fixture.review_task_id,v_fixture.executor,'implementation','completed',true,3,v_at,v_at+interval '20 seconds')
    RETURNING id INTO v_impl;
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,run_id,status,attempt_count,
      created_at,started_at,completed_at)
    VALUES((append_event('implementation.completed',v_fixture.project_id,v_fixture.review_task_id,v_impl,'system','worker',
      NULL,'turn-runs','legacy-routed-review','task',v_fixture.review_task_id,nextval('turn_event_version'),'{}'::jsonb)).id,
      'resume_orchestrator',v_fixture.project_id,v_fixture.review_task_id,v_impl,'completed',1,
      v_at,v_at+interval '21 seconds',v_at+interval '50 seconds')
    RETURNING id INTO v_routed;
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status,attempt_count,created_at,last_error)
    VALUES((append_event('chat.user_message',v_fixture.project_id,v_fixture.task_id,NULL,'user','operator',
      NULL,'turn-runs','legacy-never','task',v_fixture.task_id,nextval('turn_event_version'),'{}'::jsonb)).id,
      'orchestrator_turn',v_fixture.project_id,v_fixture.task_id,'dead_letter',0,v_at,'cancelled by project deletion;')
    RETURNING id INTO v_never;

  v_count:=backfill_orchestrator_turn_runs();
  IF v_count<>4 THEN RAISE EXCEPTION 'the backfill recorded % turns, expected 4',v_count; END IF;

  -- The host's shape: a past review job whose run_id is its implementation's.
  SELECT r.* INTO v_run FROM task_runs r JOIN runtime_jobs j ON j.run_id=r.id WHERE j.id=v_routed;
  IF v_run.id=v_impl OR v_run.phase<>'review_turn' OR v_run.write_capable OR v_run.status<>'completed'
     OR v_run.started_at<>v_at+interval '21 seconds' THEN
    RAISE EXCEPTION 'a past review routed with its implementation run was not given its own turn: %',v_run;
  END IF;
  IF (SELECT status FROM task_runs WHERE id=v_impl)<>'completed'
     OR (SELECT finished_at FROM task_runs WHERE id=v_impl)<>v_at+interval '20 seconds' THEN
    RAISE EXCEPTION 'the backfill touched the implementation run a past review pointed at';
  END IF;

  SELECT r.* INTO v_run FROM task_runs r JOIN runtime_jobs j ON j.run_id=r.id WHERE j.id=v_done;
  IF v_run.status<>'completed' OR v_run.phase<>'orchestrator_turn' OR v_run.write_capable
     OR v_run.started_at<>v_at+interval '1 second' OR v_run.finished_at<>v_at+interval '40 seconds'
     OR v_run.created_at<>v_run.started_at OR v_run.agent_id<>v_fixture.orchestrator THEN
    RAISE EXCEPTION 'a completed legacy turn was recorded wrongly: %',v_run;
  END IF;
  SELECT r.* INTO v_run FROM task_runs r JOIN runtime_jobs j ON j.run_id=r.id WHERE j.id=v_dead;
  IF v_run.status<>'failed' OR v_run.failure_code<>'backfilled_dead_letter'
     OR v_run.finished_at<>v_at+interval '9 seconds' THEN
    RAISE EXCEPTION 'a dead-lettered legacy turn was recorded wrongly: %',v_run;
  END IF;
  SELECT r.* INTO v_run FROM task_runs r JOIN runtime_jobs j ON j.run_id=r.id WHERE j.id=v_review;
  IF v_run.phase<>'review_turn' OR v_run.status<>'completed' THEN
    RAISE EXCEPTION 'a legacy review turn was recorded wrongly: %',v_run;
  END IF;
  IF (SELECT run_id FROM runtime_jobs WHERE id=v_never) IS NOT NULL THEN
    RAISE EXCEPTION 'a job that was never attempted was given a run';
  END IF;
  IF backfill_orchestrator_turn_runs()<>0 THEN
    RAISE EXCEPTION 'the backfill is not idempotent';
  END IF;

  -- A turn nobody can own is refused by name, before anything is written.
  INSERT INTO tasks(project_id,title,objective,status,created_by)
    VALUES(v_fixture.project_id,'Ownerless','No orchestrator','planning','test') RETURNING id INTO v_orphan_task;
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status,attempt_count,completed_at)
    VALUES((append_event('chat.user_message',v_fixture.project_id,v_orphan_task,NULL,'user','operator',
      NULL,'turn-runs','legacy-orphan','task',v_orphan_task,nextval('turn_event_version'),'{}'::jsonb)).id,
      'orchestrator_turn',v_fixture.project_id,v_orphan_task,'completed',1,clock_timestamp());
  BEGIN
    PERFORM backfill_orchestrator_turn_runs();
    RAISE EXCEPTION 'a turn with no owner was backfilled';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE 'orchestrator jobs without an agent to own their turn:%' THEN RAISE; END IF;
  END;
  DELETE FROM runtime_jobs WHERE task_id=v_orphan_task;

  ALTER TABLE runtime_jobs ADD CONSTRAINT runtime_jobs_orchestrator_turn_has_run
    CHECK (job_type NOT IN ('orchestrator_turn','resume_orchestrator') OR attempt_count=0 OR run_id IS NOT NULL);
  RAISE NOTICE 'the backfill records attempted turns from job history, skips unattempted ones, and refuses an ownerless one by name';
END $$;

ROLLBACK;
