-- Conversation ingress and the active-run mailbox (migration 0070, WP-9a).
--
-- Two channels, and each is shown to be one:
--
--   * ingress — a message, a handoff or a resume creates a run, in the order
--     of its conversation, and never while another run of the conversation is
--     live: a message typed during a live turn is a new run after it, not a
--     write into the running one;
--   * the mailbox — input_response, steer and interrupt are commands to a run
--     that is running, ordered by the run's own sequence, idempotent by key,
--     and acknowledged only with what the runtime answered.
--
-- And the mutation check for the idempotency key: with the lookup switched off
-- the same click is no longer the same command.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

CREATE FUNCTION pg_temp.reason_of(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_detail text;
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF v_detail IS NULL OR left(v_detail, 1) <> '{' THEN RETURN 'NO_DETAIL: ' || SQLERRM; END IF;
  RETURN v_detail::jsonb->>'reason';
END $$;

CREATE FUNCTION pg_temp.expect_reason(p_sql text, p_reason text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_reason text := pg_temp.reason_of(p_sql);
BEGIN
  IF v_reason IS DISTINCT FROM p_reason THEN
    RAISE EXCEPTION '%: expected %, got %', p_what, p_reason, COALESCE(v_reason, '<accepted>');
  END IF;
END $$;

-- A project with Codex orchestrating and OpenCode executing, and a task.
CREATE FUNCTION pg_temp.fixture(p_slug text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_user uuid; v_project uuid; v_codex_profile uuid; v_executor_profile uuid; v_codex uuid;
  v_worker uuid; v_orchestrator uuid; v_executor uuid; v_task uuid;
BEGIN
  INSERT INTO users(display_name) VALUES('Ingress '||p_slug) RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Ingress '||p_slug,'ingress-'||p_slug,'/srv/infra-cod/workspaces/ingress-'||p_slug) RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-'||p_slug) RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','opencode-'||p_slug) RETURNING id INTO v_executor_profile;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('ingress-codex-'||p_slug,'architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('ingress-worker-'||p_slug,'implementer',v_executor_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING id INTO v_orchestrator;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_executor_profile,'executor') RETURNING id INTO v_executor;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Ingress '||p_slug,'test','planning',v_codex,v_orchestrator,'test') RETURNING id INTO v_task;
  RETURN jsonb_build_object('project',v_project,'task',v_task,'codex',v_codex,'worker',v_worker);
END $$;

-- An event of the task and the job it routes to, as route_outbox_message would.
CREATE FUNCTION pg_temp.routed(p_fixture jsonb, p_event_type text, p_job_type text, p_key text,
  p_version bigint) RETURNS runtime_jobs LANGUAGE plpgsql AS $$
DECLARE v_event domain_events; v_job runtime_jobs;
BEGIN
  v_event:=append_event(p_event_type,(p_fixture->>'project')::uuid,(p_fixture->>'task')::uuid,NULL,'user','operator',
    NULL,p_key,p_key,'task',(p_fixture->>'task')::uuid,p_version,jsonb_build_object('content',p_key));
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    VALUES(v_event.id,p_job_type,(p_fixture->>'project')::uuid,(p_fixture->>'task')::uuid,'{}') RETURNING * INTO v_job;
  RETURN v_job;
END $$;

CREATE FUNCTION pg_temp.finish(p_job bigint) RETURNS void LANGUAGE sql AS $$
  UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp(),leased_by=NULL,leased_until=NULL
  WHERE id=p_job;
$$;

-- ------------------------------------------------------------------ ingress
DO $$
DECLARE f jsonb; v_first runtime_jobs; v_second runtime_jobs; v_claimed runtime_jobs; v_later runtime_jobs;
  v_earlier runtime_jobs; v_handoff runtime_jobs; v_first_run uuid; v_kind text; v_count integer;
BEGIN
  f:=pg_temp.fixture('order');

  -- A message, and its turn claimed: a live run of the conversation.
  v_first:=pg_temp.routed(f,'chat.user_message','orchestrator_turn','ingress-first',1);
  SELECT ingress_kind INTO v_kind FROM conversation_ingress WHERE job_id=v_first.id;
  IF v_kind IS DISTINCT FROM 'orchestrator_message' THEN
    RAISE EXCEPTION 'a chat message was recorded as % ingress, not orchestrator_message', v_kind;
  END IF;
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('ingress-codex',1,interval '5 minutes');
  IF v_claimed.id IS DISTINCT FROM v_first.id OR v_claimed.run_id IS NULL THEN
    RAISE EXCEPTION 'the first message was not claimed as a turn with a run: %', v_claimed;
  END IF;
  v_first_run:=v_claimed.run_id;

  -- The operator types again while it runs. The message is ingress: a job of
  -- its own, waiting, and nothing is written into the live run's mailbox.
  v_second:=pg_temp.routed(f,'chat.user_message','orchestrator_turn','ingress-second',2);
  IF ingress_blocker(v_second.id) IS DISTINCT FROM v_first.id THEN
    RAISE EXCEPTION 'the second message does not wait for the live turn: blocker %', ingress_blocker(v_second.id);
  END IF;
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('ingress-codex-2',1,interval '5 minutes');
  IF v_claimed.id IS NOT NULL THEN
    RAISE EXCEPTION 'a message was claimed while a turn of its conversation was live: job %', v_claimed.id;
  END IF;
  SELECT count(*) INTO v_count FROM run_commands WHERE run_id=v_first_run;
  IF v_count<>0 THEN RAISE EXCEPTION 'ingress was delivered into the live run as % command(s)', v_count; END IF;

  -- The same, from another task of the conversation — a follow-up — which the
  -- claim's older per-task order never saw: only the ingress holds it.
  DECLARE v_followup uuid; v_followup_job runtime_jobs;
  BEGIN
    INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by,followup_of_task_id)
      SELECT project_id,'Follow-up','test','planning',active_agent_id,orchestrator_assignment_id,'test',id
      FROM tasks WHERE id=(f->>'task')::uuid RETURNING id INTO v_followup;
    v_followup_job:=pg_temp.routed(jsonb_build_object('project',f->>'project','task',v_followup),
      'chat.user_message','orchestrator_turn','ingress-followup',1);
    IF ingress_blocker(v_followup_job.id) IS DISTINCT FROM v_first.id THEN
      RAISE EXCEPTION 'a follow-up''s message does not wait for its conversation''s live turn: %', ingress_blocker(v_followup_job.id);
    END IF;
    SELECT * INTO v_claimed FROM claim_orchestrator_jobs('ingress-codex-3',1,interval '5 minutes');
    IF v_claimed.id IS NOT NULL THEN
      RAISE EXCEPTION 'a follow-up''s message was claimed while a turn of its conversation was live: job %', v_claimed.id;
    END IF;
    PERFORM set_config('ingress.followup_job', v_followup_job.id::text, true);
  END;

  -- A handoff routed during the live turn waits for it too: the executor does
  -- not start while the turn that delegated it is still reading the tree.
  v_handoff:=pg_temp.routed(f,'implementation.requested','implementation_run','ingress-handoff',3);
  SELECT ingress_kind INTO v_kind FROM conversation_ingress WHERE job_id=v_handoff.id;
  IF v_kind IS DISTINCT FROM 'handoff' THEN RAISE EXCEPTION 'a delegation was recorded as %', v_kind; END IF;
  SELECT * INTO v_claimed FROM claim_executor_jobs('ingress-executor',1,interval '5 minutes');
  IF v_claimed.id IS NOT NULL THEN
    RAISE EXCEPTION 'an implementation was claimed while the delegating turn was live: job %', v_claimed.id;
  END IF;

  -- The turn ends. The next message becomes a run of its own, after it.
  PERFORM pg_temp.finish(v_first.id);
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('ingress-codex-2',1,interval '5 minutes');
  IF v_claimed.id IS DISTINCT FROM v_second.id THEN
    RAISE EXCEPTION 'the waiting message was not claimed after the live turn ended: %', v_claimed;
  END IF;
  IF v_claimed.run_id IS NULL OR v_claimed.run_id=v_first_run THEN
    RAISE EXCEPTION 'the message did not get a run of its own: % (the live one was %)', v_claimed.run_id, v_first_run;
  END IF;
  IF (SELECT status FROM task_runs WHERE id=v_first_run)<>'completed' THEN
    RAISE EXCEPTION 'the first run was touched by the second message';
  END IF;
  -- And the handoff still waits: the second turn is now the live run.
  SELECT * INTO v_claimed FROM claim_executor_jobs('ingress-executor',1,interval '5 minutes');
  IF v_claimed.id IS NOT NULL THEN RAISE EXCEPTION 'the handoff overtook the second turn'; END IF;
  PERFORM pg_temp.finish(v_second.id);
  -- The follow-up's message was written before the handoff, so it is next,
  -- and the handoff waits for it: the conversation's order, not the kind.
  SELECT * INTO v_claimed FROM claim_executor_jobs('ingress-executor',1,interval '5 minutes');
  IF v_claimed.id IS NOT NULL THEN RAISE EXCEPTION 'the handoff overtook an earlier message of its conversation'; END IF;
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('ingress-codex-3',1,interval '5 minutes');
  IF v_claimed.id::text IS DISTINCT FROM current_setting('ingress.followup_job') THEN
    RAISE EXCEPTION 'the follow-up''s message was not claimed after the runs in front of it: %', v_claimed;
  END IF;
  PERFORM pg_temp.finish(v_claimed.id);
  SELECT * INTO v_claimed FROM claim_executor_jobs('ingress-executor',1,interval '5 minutes');
  IF v_claimed.id IS DISTINCT FROM v_handoff.id THEN RAISE EXCEPTION 'the handoff was not claimed in its turn: %', v_claimed; END IF;
  PERFORM pg_temp.finish(v_handoff.id);

  -- Order is the conversation's, not the job ids': a job routed late for an
  -- earlier message is claimed before one routed early for a later message.
  f:=pg_temp.fixture('sequence');
  SELECT * INTO v_later FROM runtime_jobs LIMIT 0;
  DECLARE v_e1 domain_events; v_e2 domain_events;
  BEGIN
    v_e1:=append_event('chat.user_message',(f->>'project')::uuid,(f->>'task')::uuid,NULL,'user','operator',
      NULL,'seq-1','seq-1','task',(f->>'task')::uuid,1,'{"content":"one"}');
    v_e2:=append_event('chat.user_message',(f->>'project')::uuid,(f->>'task')::uuid,NULL,'user','operator',
      NULL,'seq-2','seq-2','task',(f->>'task')::uuid,2,'{"content":"two"}');
    -- Another task of the same conversation would be ordered by id otherwise;
    -- here the later event's job simply exists first.
    INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
      VALUES(v_e2.id,'orchestrator_turn',(f->>'project')::uuid,(f->>'task')::uuid,'{}') RETURNING * INTO v_later;
    INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
      VALUES(v_e1.id,'orchestrator_turn',(f->>'project')::uuid,(f->>'task')::uuid,'{}') RETURNING * INTO v_earlier;
  END;
  IF ingress_blocker(v_later.id) IS DISTINCT FROM v_earlier.id THEN
    RAISE EXCEPTION 'the later message does not wait for the earlier one: %', ingress_blocker(v_later.id);
  END IF;
  IF ingress_blocker(v_earlier.id) IS NOT NULL THEN
    RAISE EXCEPTION 'the earlier message waits for %', ingress_blocker(v_earlier.id);
  END IF;

  -- A dead letter does not hold its conversation.
  UPDATE runtime_jobs SET status='dead_letter',last_error='test' WHERE id=v_earlier.id;
  IF ingress_blocker(v_later.id) IS NOT NULL THEN
    RAISE EXCEPTION 'a dead-lettered message still holds the conversation';
  END IF;

  -- Recorded is recorded.
  PERFORM pg_temp.expect_reason(format('UPDATE conversation_ingress SET ingress_kind=%L WHERE job_id=%s','resume',v_later.id),
    'conversation_ingress_immutable','changing an ingress entry');
  PERFORM pg_temp.expect_reason(format('DELETE FROM conversation_ingress WHERE job_id=%s',v_later.id),
    'conversation_ingress_immutable','deleting an ingress entry');
  PERFORM pg_temp.finish(v_later.id);

  RAISE NOTICE 'ingress: a message typed during a live turn becomes a run after it, never a command into it; a handoff waits for the delegating turn; order is by conversation_sequence; a dead letter does not hold the conversation';
END $$;

-- ------------------------------------------------------------------ mailbox
DO $$
DECLARE f jsonb; v_job runtime_jobs; v_claimed runtime_jobs; v_run uuid; v_request jsonb; v_repeat jsonb;
  v_command jsonb; v_row run_commands; v_count integer; v_final jsonb; v_steer jsonb;
BEGIN
  f:=pg_temp.fixture('mailbox');
  v_job:=pg_temp.routed(f,'chat.user_message','orchestrator_turn','mailbox-turn',1);
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('mailbox-worker',1,interval '5 minutes');
  IF v_claimed.id IS DISTINCT FROM v_job.id THEN RAISE EXCEPTION 'fixture: claimed % not %', v_claimed.id, v_job.id; END IF;
  v_run:=v_claimed.run_id;

  -- The panel's Stop: an interrupt command in the run's mailbox.
  v_request:=request_runtime_interrupt((f->>'project')::uuid,(f->>'task')::uuid,'operator','Stop it','corr-1');
  SELECT * INTO v_row FROM run_commands WHERE id=(v_request->>'command_id')::bigint;
  IF v_row.run_id IS DISTINCT FROM v_run OR v_row.command_kind<>'interrupt' OR v_row.sequence<>1
     OR v_row.status<>'pending' OR v_row.job_id<>v_job.id THEN
    RAISE EXCEPTION 'the interrupt is not the run''s first pending command: %', v_row;
  END IF;
  IF (SELECT interrupt_requested_at FROM runtime_jobs WHERE id=v_job.id) IS NULL THEN
    RAISE EXCEPTION 'the job no longer carries interrupt_requested_at, which the previous release polls';
  END IF;

  -- The same click again is the same command.
  v_repeat:=request_runtime_interrupt((f->>'project')::uuid,(f->>'task')::uuid,'operator','Stop it','corr-1');
  SELECT count(*) INTO v_count FROM run_commands WHERE run_id=v_run;
  IF v_repeat->>'command_id'<>v_request->>'command_id' OR v_count<>1 THEN
    RAISE EXCEPTION 'a repeated interrupt made % command(s): %', v_count, v_repeat;
  END IF;
  IF (SELECT count(*) FROM domain_events WHERE task_id=(f->>'task')::uuid AND event_type='run.interrupt_requested')<>1 THEN
    RAISE EXCEPTION 'a repeated interrupt wrote the event twice';
  END IF;
  PERFORM pg_temp.expect_reason(format($q$SELECT request_run_command(%L,%L,'interrupt','{"reason":"other"}'::jsonb,%L,'operator')$q$,
    f->>'project',f->>'task','interrupt:job:'||v_job.id),
    'run_command_idempotency_conflict','the same key with another payload');

  -- The argument checks, each by reason.
  PERFORM pg_temp.expect_reason(format($q$SELECT request_run_command(%L,%L,'orchestrator_message','{}'::jsonb,'key-12345','operator')$q$,
    f->>'project',f->>'task'),'run_command_kind_invalid','a message is ingress, not a command');
  PERFORM pg_temp.expect_reason(format($q$SELECT request_run_command(%L,%L,'steer','{}'::jsonb,'short','operator')$q$,
    f->>'project',f->>'task'),'run_command_idempotency_key_invalid','a short key');
  PERFORM pg_temp.expect_reason(format($q$SELECT request_run_command(%L,%L,'steer','[]'::jsonb,'key-12345','operator')$q$,
    f->>'project',f->>'task'),'run_command_payload_invalid','a payload that is not an object');

  -- A steer is taken in order after the interrupt: sequence 2.
  v_steer:=request_run_command((f->>'project')::uuid,(f->>'task')::uuid,'steer','{"text":"focus"}','steer-key-1','operator');
  IF (v_steer->>'sequence')::integer<>2 THEN RAISE EXCEPTION 'the steer is not the run''s second command: %', v_steer; END IF;

  -- Delivery belongs to the job's lease holder, one command at a time.
  PERFORM pg_temp.expect_reason(format($q$SELECT claim_run_command(%s,'someone-else')$q$,v_job.id),
    'run_command_not_leased','a worker without the lease');
  v_command:=claim_run_command(v_job.id,'mailbox-worker');
  IF v_command->>'command_kind'<>'interrupt' OR (v_command->>'sequence')::integer<>1 THEN
    RAISE EXCEPTION 'the first command claimed is not the interrupt: %', v_command;
  END IF;
  IF claim_run_command(v_job.id,'mailbox-worker') IS NOT NULL THEN
    RAISE EXCEPTION 'a second command was handed out while the first was being delivered';
  END IF;
  PERFORM pg_temp.expect_reason(format($q$SELECT acknowledge_run_command(%s,'mailbox-worker','{}'::jsonb)$q$,v_command->>'command_id'),
    'run_command_receipt_invalid','an acknowledgement without a receipt');
  PERFORM pg_temp.expect_reason(format($q$SELECT acknowledge_run_command(%s,'someone-else','{"x":1}'::jsonb)$q$,v_command->>'command_id'),
    'run_command_not_delivering','another worker acknowledging');
  PERFORM acknowledge_run_command((v_command->>'command_id')::bigint,'mailbox-worker',
    jsonb_build_object('mechanism','protocol','method','turn/interrupt','response','{}'::jsonb));
  SELECT * INTO v_row FROM run_commands WHERE id=(v_command->>'command_id')::bigint;
  IF v_row.status<>'acknowledged' OR v_row.native_receipt->>'method'<>'turn/interrupt' OR v_row.finished_at IS NULL THEN
    RAISE EXCEPTION 'the interrupt was not acknowledged with its receipt: %', v_row;
  END IF;
  PERFORM pg_temp.expect_reason(format($q$UPDATE run_commands SET status='failed',failure_reason='run_command_run_ended' WHERE id=%s$q$,v_row.id),
    'run_command_immutable','an acknowledged command changed');
  PERFORM pg_temp.expect_reason(format($q$UPDATE run_commands SET status='acknowledged',native_receipt='{"x":1}' WHERE id=%s$q$,(v_steer->>'command_id')),
    'run_command_immutable','a pending command acknowledged without a delivery');

  -- The steer: Codex's driver does not declare input.steer, so its delivery
  -- ends as failed with that reason — never as a fresh prompt.
  v_command:=claim_run_command(v_job.id,'mailbox-worker');
  PERFORM finish_run_command((v_command->>'command_id')::bigint,'mailbox-worker','failed','run_command_unsupported',
    '{"capability":"input.steer"}');
  IF (SELECT status FROM run_commands WHERE id=(v_command->>'command_id')::bigint)<>'failed' THEN
    RAISE EXCEPTION 'an unsupported steer was not failed';
  END IF;

  -- The interrupt finalizes as before; the run is interrupted.
  v_final:=finalize_runtime_interrupt(v_job.id,'mailbox-worker','thread-mailbox');
  IF v_final->>'status'<>'interrupted' OR (SELECT status FROM task_runs WHERE id=v_run)<>'interrupted' THEN
    RAISE EXCEPTION 'the interrupt did not finalize: %', v_final;
  END IF;
  PERFORM pg_temp.expect_reason(format($q$SELECT request_run_command(%L,%L,'steer','{}'::jsonb,'late-key-1','operator')$q$,
    f->>'project',f->>'task'),'run_command_no_active_run','a command after the run ended');

  RAISE NOTICE 'mailbox: interrupt is a command in the run''s mailbox, one per click; delivered by the lease holder in sequence; acknowledged only with the runtime''s receipt; finished commands do not change';
END $$;

-- ------------------------------------ the run ends under undelivered commands
DO $$
DECLARE f jsonb; v_job runtime_jobs; v_claimed runtime_jobs; v_a jsonb; v_b jsonb; v_c jsonb;
BEGIN
  f:=pg_temp.fixture('ended');
  v_job:=pg_temp.routed(f,'chat.user_message','orchestrator_turn','ended-turn',1);
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('ended-worker',1,interval '5 minutes');
  v_a:=request_run_command((f->>'project')::uuid,(f->>'task')::uuid,'steer','{"n":1}','ended-key-1','operator');
  v_b:=request_run_command((f->>'project')::uuid,(f->>'task')::uuid,'steer','{"n":2}','ended-key-2','operator');
  PERFORM claim_run_command(v_job.id,'ended-worker');
  -- The turn completes with one command in delivery and one never delivered.
  PERFORM pg_temp.finish(v_job.id);
  IF (SELECT status||'/'||failure_reason FROM run_commands WHERE id=(v_a->>'command_id')::bigint)<>'outcome_unknown/run_command_delivery_lost' THEN
    RAISE EXCEPTION 'a command in delivery when the run ended is not outcome_unknown: %',
      (SELECT to_jsonb(c) FROM run_commands c WHERE id=(v_a->>'command_id')::bigint);
  END IF;
  IF (SELECT status||'/'||failure_reason FROM run_commands WHERE id=(v_b->>'command_id')::bigint)<>'failed/run_command_run_ended' THEN
    RAISE EXCEPTION 'a command never delivered when the run ended is not failed: %',
      (SELECT to_jsonb(c) FROM run_commands c WHERE id=(v_b->>'command_id')::bigint);
  END IF;

  -- An implementation interrupted between its claim and its run: the request
  -- is kept on the job, and becomes the run's command when the run starts.
  f:=pg_temp.fixture('early');
  v_job:=pg_temp.routed(f,'implementation.requested','implementation_run','early-impl',1);
  SELECT * INTO v_claimed FROM claim_executor_jobs('early-supervisor',1,interval '5 minutes');
  v_c:=request_runtime_interrupt((f->>'project')::uuid,(f->>'task')::uuid,'operator','Too soon','corr-early');
  IF v_c->>'command_status'<>'awaiting_run' OR v_c->'command_id'<>'null'::jsonb THEN
    RAISE EXCEPTION 'an interrupt before the run started was not kept for it: %', v_c;
  END IF;
  DECLARE v_run uuid;
  BEGIN
    INSERT INTO task_runs(task_id,agent_id,phase,status,write_capable,workspace_fencing_token)
      VALUES((f->>'task')::uuid,(f->>'worker')::uuid,'implementation','running',true,1) RETURNING id INTO v_run;
    UPDATE runtime_jobs SET run_id=v_run WHERE id=v_job.id;
    v_c:=claim_run_command(v_job.id,'early-supervisor');
    IF v_c->>'command_kind'<>'interrupt' OR (v_c->>'run_id')::uuid<>v_run THEN
      RAISE EXCEPTION 'the early interrupt did not become the run''s command: %', v_c;
    END IF;
  END;

  RAISE NOTICE 'a run that ends fails its undelivered commands and marks the one in delivery outcome_unknown; an interrupt that arrives before the run starts reaches it when it does';
END $$;

-- ------------------------------------------------------ mutation: the ingress
-- With the ingress condition taken out of both claims, a follow-up's message is
-- claimed while its conversation's turn is live, and an implementation starts
-- under the turn that delegated it — so the ingress assertions above are held by
-- that condition, not by the claims' older per-task order.
DO $$
DECLARE f jsonb; v_turn runtime_jobs; v_claimed runtime_jobs; v_followup uuid; v_msg runtime_jobs; v_impl runtime_jobs;
BEGIN
  EXECUTE replace(pg_get_functiondef('claim_orchestrator_jobs(text,integer,interval)'::regprocedure),
    'AND ingress_blocker(j.id) IS NULL', '');
  EXECUTE replace(pg_get_functiondef('claim_executor_jobs(text,integer,interval)'::regprocedure),
    'AND ingress_blocker(j.id) IS NULL', '');
  IF position('ingress_blocker' IN pg_get_functiondef('claim_orchestrator_jobs(text,integer,interval)'::regprocedure)) > 0
     OR position('ingress_blocker' IN pg_get_functiondef('claim_executor_jobs(text,integer,interval)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'mutation: the ingress condition was not found to take out';
  END IF;
  f:=pg_temp.fixture('ingress-mutant');
  v_turn:=pg_temp.routed(f,'chat.user_message','orchestrator_turn','mutant-live',1);
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('mutant-codex',1,interval '5 minutes');
  IF v_claimed.id IS DISTINCT FROM v_turn.id THEN RAISE EXCEPTION 'fixture: % not %', v_claimed.id, v_turn.id; END IF;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by,followup_of_task_id)
    SELECT project_id,'Follow-up','test','planning',active_agent_id,orchestrator_assignment_id,'test',id
    FROM tasks WHERE id=(f->>'task')::uuid RETURNING id INTO v_followup;
  v_msg:=pg_temp.routed(jsonb_build_object('project',f->>'project','task',v_followup),'chat.user_message','orchestrator_turn','mutant-msg',1);
  v_impl:=pg_temp.routed(f,'implementation.requested','implementation_run','mutant-impl',2);
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('mutant-codex-2',1,interval '5 minutes');
  IF v_claimed.id IS DISTINCT FROM v_msg.id THEN
    RAISE EXCEPTION 'mutation: without the ingress condition the follow-up''s message was still held (claimed %)', v_claimed.id;
  END IF;
  SELECT * INTO v_claimed FROM claim_executor_jobs('mutant-executor',1,interval '5 minutes');
  IF v_claimed.id IS DISTINCT FROM v_impl.id THEN
    RAISE EXCEPTION 'mutation: without the ingress condition the implementation was still held (claimed %)', v_claimed.id;
  END IF;
  RAISE NOTICE 'mutation: without the ingress condition a follow-up''s message and an implementation both start under a live turn';
END $$;

-- ------------------------------------------------ mutation: the idempotency key
-- With request_run_command's lookup switched off, the same click is two
-- commands (or a refusal by the unique key) instead of one — so the assertions
-- above fail without it and are not passing for another reason.
DO $$
DECLARE f jsonb; v_job runtime_jobs; v_claimed runtime_jobs; v_count integer; v_failed boolean := false;
BEGIN
  EXECUTE replace(pg_get_functiondef('request_run_command(uuid,uuid,text,jsonb,text,text,text)'::regprocedure),
    'WHERE run_id=v_run AND command_kind=p_command_kind AND idempotency_key=p_idempotency_key;',
    'WHERE false;');
  IF position('WHERE false;' IN pg_get_functiondef('request_run_command(uuid,uuid,text,jsonb,text,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'mutation: the idempotency lookup in request_run_command was not found to switch off';
  END IF;
  f:=pg_temp.fixture('mutant');
  v_job:=pg_temp.routed(f,'chat.user_message','orchestrator_turn','mutant-turn',1);
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('mutant-worker',1,interval '5 minutes');
  PERFORM request_run_command((f->>'project')::uuid,(f->>'task')::uuid,'steer','{"a":1}','mutant-key-1','operator');
  BEGIN
    PERFORM request_run_command((f->>'project')::uuid,(f->>'task')::uuid,'steer','{"a":1}','mutant-key-1','operator');
  EXCEPTION WHEN unique_violation THEN v_failed := true;
  END;
  SELECT count(*) INTO v_count FROM run_commands WHERE run_id=v_claimed.run_id;
  IF NOT v_failed AND v_count=1 THEN
    RAISE EXCEPTION 'mutation: with the lookup off, a repeated request was still answered as the same command';
  END IF;
  RAISE NOTICE 'mutation: without the idempotency lookup a repeated click is refused by the unique key or doubled (% row(s), refused: %)', v_count, v_failed;
END $$;

ROLLBACK;
