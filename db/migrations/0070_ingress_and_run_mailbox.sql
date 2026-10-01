-- Two channels, not one mailbox (WP-9a, prework A4).
--
-- A message to an agent is one of two different things, and the product had
-- one path for both:
--
--   * a new orchestrator message, a handoff to the executor, a resume after the
--     operator answered — each *creates* a run. It is ordered in its
--     conversation, and it must not reach a process that is already running;
--   * an answer to a structured request, a steer, an interrupt — each is a
--     command to a run that is already running, and it is ordered in that run.
--
-- `sendInput()` drives a live process; `resumeSession()` starts a new native run
-- inside an existing session. Merging them makes one of the two lie.
--
-- conversation_ingress
-- --------------------
-- One row per runtime job created from a conversation's event, keyed by the
-- event's `conversation_sequence` (0063 allocates it in the event's own
-- transaction). Written by a trigger on runtime_jobs, not by
-- route_outbox_message: 0063 learned that a number only one function writes is a
-- number every other insert path skips.
--
-- A job with an ingress row is claimed only when no earlier entry of its
-- conversation is still pending or in flight, and no other entry of the
-- conversation is in flight. That is what "ingress during a live run creates a
-- run afterwards" means in the claim: a message typed while a Codex turn runs,
-- or while an implementation runs, is a new job that waits for the run in front
-- of it — it is never written into the live one. Before this, only jobs of one
-- task were ordered, only by id, and an implementation could start while the
-- turn that delegated it was still reading the workspace.
--
-- A dead-lettered entry does not hold its conversation: it is the operator's
-- (the panel shows the incident), and a queue that waits forever for a dead
-- letter is the silent loss the plan's risk register names.
--
-- run_commands
-- ------------
-- The active-run mailbox: run_id + sequence + command_kind + idempotency_key,
-- `pending → delivering → acknowledged | outcome_unknown | failed`, and a
-- `native_receipt` — what the runtime itself answered. Acknowledged means the
-- runtime said so; a command whose delivery started and whose answer never came
-- is `outcome_unknown`, never `failed` (defects 47 and 49: a failure recorded
-- for something that may have happened is its own kind of wrong).
--
-- The kinds are `input_response`, `steer` and `interrupt`. A runtime that has no
-- active input declares so, and its command fails as `run_command_unsupported`;
-- the product's answer path for such a runtime is interrupt plus native resume
-- (resolve_worker_interaction → a new run in the same session), which is ingress,
-- not this table. Nothing here ever becomes a fresh prompt.
--
-- request_runtime_interrupt, the panel's "Stop run", now writes an interrupt into
-- the mailbox. It keeps setting runtime_jobs.interrupt_requested_at, which the
-- previous release's workers poll, and it no longer asks runtime_profiles whether
-- the runtime can be interrupted: rc.38 showed a Codex profile whose row did not
-- say `interrupt` while its driver declared it in the mandatory core. The driver
-- is the authority; the side that delivers refuses a kind its driver does not
-- declare, and 0071 lets the request read the same declaration from provenance.
--
-- No BEGIN/COMMIT: migrate.mjs owns the transaction (0039 onwards).
SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('run_command_kind_invalid','invalid_argument','a command kind outside input_response, steer and interrupt'),
  ('run_command_idempotency_key_invalid','invalid_argument','the key is absent, shorter than eight or longer than 200 characters'),
  ('run_command_payload_invalid','invalid_argument','a payload that is not a bounded JSON object'),
  ('run_command_idempotency_conflict','conflict','the same run, kind and key with a different payload'),
  ('run_command_no_active_run','conflict','no runtime job of the task is running'),
  ('run_command_run_not_started','unavailable','the job is claimed and its run has not started yet'),
  ('run_command_not_leased','lease_lost','the job is not leased by the worker delivering its commands'),
  ('run_command_not_delivering','conflict','the command is not being delivered by this worker'),
  ('run_command_receipt_invalid','invalid_argument','an acknowledgement without a bounded native receipt'),
  ('run_command_unsupported','invalid_argument','the runtime''s driver does not declare the capability the command needs'),
  ('run_command_run_ended','conflict','the run ended before the command was delivered'),
  ('run_command_delivery_lost','unavailable','the run or its lease ended while the command was being delivered'),
  ('run_command_delivery_failed','internal','the runtime refused or could not be reached'),
  ('run_command_immutable','conflict','a finished command cannot change'),
  ('conversation_ingress_immutable','conflict','an ingress entry is a record of what was asked, and does not change')
ON CONFLICT (reason) DO NOTHING;

-- ------------------------------------------------------------------- ingress
CREATE TABLE conversation_ingress (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  conversation_sequence bigint NOT NULL CHECK (conversation_sequence > 0),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  source_event_id uuid NOT NULL REFERENCES domain_events(id),
  -- Cascade only so that the row follows a job nothing in the product deletes;
  -- the trigger below refuses a delete while the job exists.
  job_id bigint NOT NULL UNIQUE REFERENCES runtime_jobs(id) ON DELETE CASCADE,
  ingress_kind text NOT NULL CHECK (ingress_kind IN ('orchestrator_message','handoff','resume')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Not unique: one event may be routed to two job types (the unique key is
-- runtime_jobs' (source_event_id, job_type)). Within one sequence the job id
-- decides, which is the order they were routed in.
CREATE INDEX conversation_ingress_order ON conversation_ingress(conversation_id, conversation_sequence, job_id);

-- What an event asks for, as ingress. A resume is the handoff
-- resolve_worker_interaction writes after the operator answered — its event key
-- says so ('event:resume-interaction:<report>'); any other delegation or review
-- is a handoff.
CREATE OR REPLACE FUNCTION ingress_kind_of(p_event domain_events)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_event.event_type='chat.user_message' THEN 'orchestrator_message'
    WHEN p_event.event_type='implementation.requested'
         AND p_event.idempotency_key LIKE 'event:resume-interaction:%' THEN 'resume'
    WHEN p_event.event_type IN ('implementation.requested','implementation.completed','revision.completed')
      THEN 'handoff'
  END;
$$;

CREATE OR REPLACE FUNCTION record_conversation_ingress()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_event domain_events%ROWTYPE; v_kind text;
BEGIN
  SELECT * INTO v_event FROM domain_events WHERE id=NEW.source_event_id;
  v_kind:=ingress_kind_of(v_event);
  -- An event with no conversation (none since 0063) or a kind this table does
  -- not order is left alone rather than refused: refusing here would refuse the
  -- job, and that is not this trigger's decision.
  IF v_event.conversation_id IS NULL OR v_event.conversation_sequence IS NULL OR v_kind IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO conversation_ingress(conversation_id,conversation_sequence,project_id,task_id,
    source_event_id,job_id,ingress_kind)
  VALUES(v_event.conversation_id,v_event.conversation_sequence,NEW.project_id,NEW.task_id,
    v_event.id,NEW.id,v_kind)
  ON CONFLICT (job_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER runtime_jobs_conversation_ingress AFTER INSERT ON runtime_jobs
  FOR EACH ROW EXECUTE FUNCTION record_conversation_ingress();

CREATE OR REPLACE FUNCTION refuse_ingress_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM runtime_jobs WHERE id=OLD.job_id) THEN
    RETURN OLD;
  END IF;
  PERFORM refuse('conversation_ingress_immutable',
    format('conversation_ingress rows are immutable (%s refused)', TG_OP));
  RETURN NULL;
END $$;
CREATE TRIGGER conversation_ingress_immutable BEFORE UPDATE OR DELETE ON conversation_ingress
  FOR EACH ROW EXECUTE FUNCTION refuse_ingress_change();

-- Existing jobs, in their conversations: a pending job at the moment this
-- migration runs is ordered like a new one. Sequences come from the events,
-- which 0063 numbered.
INSERT INTO conversation_ingress(conversation_id,conversation_sequence,project_id,task_id,
  source_event_id,job_id,ingress_kind)
SELECT e.conversation_id,e.conversation_sequence,j.project_id,j.task_id,e.id,j.id,ingress_kind_of(e)
FROM runtime_jobs j JOIN domain_events e ON e.id=j.source_event_id
WHERE e.conversation_id IS NOT NULL AND e.conversation_sequence IS NOT NULL AND ingress_kind_of(e) IS NOT NULL
ON CONFLICT DO NOTHING;

-- The job whose run the given job has to wait for, or NULL. Named rather than
-- answered yes/no so the panel can say what a message is waiting for.
CREATE OR REPLACE FUNCTION ingress_blocker(p_job_id bigint)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT other.job_id
  FROM conversation_ingress mine
  JOIN conversation_ingress other ON other.conversation_id=mine.conversation_id AND other.job_id<>mine.job_id
  JOIN runtime_jobs oj ON oj.id=other.job_id
  WHERE mine.job_id=p_job_id
    AND (oj.status='in_flight'
         OR ((other.conversation_sequence,other.job_id)<(mine.conversation_sequence,mine.job_id)
             AND oj.status='pending'))
  ORDER BY other.conversation_sequence,other.job_id
  LIMIT 1;
$$;

-- claim_codex_chat_jobs, redefined from 0060: one more condition, the ingress
-- order. Everything else is 0060's.
CREATE OR REPLACE FUNCTION claim_codex_chat_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 1,
  p_lease interval DEFAULT interval '5 minutes'
)
RETURNS SETOF runtime_jobs
LANGUAGE sql
AS $$
  WITH candidates AS (
    SELECT j.id FROM runtime_jobs j
    WHERE j.job_type IN ('codex_chat_turn','resume_codex')
      AND j.available_at<=clock_timestamp()
      AND (j.status='pending' OR (j.status='in_flight' AND j.leased_until<=clock_timestamp()))
      AND NOT EXISTS (
        SELECT 1 FROM runtime_jobs earlier
        WHERE earlier.job_type IN ('codex_chat_turn','resume_codex')
          AND earlier.task_id=j.task_id AND earlier.id<j.id
          AND earlier.status IN ('pending','in_flight')
      )
      AND NOT workspace_has_foreign_writer(j.project_id, NULL)
      -- 0070: a run of this conversation is live, or an earlier message has not
      -- run yet. The job waits, in order, and becomes a run after it.
      AND ingress_blocker(j.id) IS NULL
    ORDER BY j.available_at,j.id FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE runtime_jobs j
    SET status='in_flight',attempt_count=j.attempt_count+1,leased_by=p_worker_id,
        leased_until=clock_timestamp()+p_lease,last_error=NULL,
        activity_phase='starting_runtime',activity_detail='Preparing the Codex runtime',
        started_at=COALESCE(j.started_at,clock_timestamp()),heartbeat_at=clock_timestamp()
    FROM candidates c WHERE j.id=c.id RETURNING j.*
  ), reviewing AS (
    UPDATE tasks t SET status='reviewing',version=t.version+1,updated_at=clock_timestamp()
    FROM claimed j
    WHERE j.job_type='resume_codex' AND t.id=j.task_id AND t.status='awaiting_review'
    RETURNING t.id
  )
  SELECT j.* FROM claimed j LEFT JOIN reviewing r ON r.id=j.task_id;
$$;

-- claim_executor_jobs, redefined from 0014 with the same condition. The
-- executor used to start as soon as the handoff was routed, while the Codex turn
-- that delegated it was still running against the same workspace.
CREATE OR REPLACE FUNCTION claim_executor_jobs(
  p_worker_id text,p_limit integer DEFAULT 1,p_lease interval DEFAULT interval '5 minutes'
)
RETURNS SETOF runtime_jobs LANGUAGE sql AS $$
  WITH candidates AS (
    SELECT j.id FROM runtime_jobs j
    WHERE j.job_type='start_implementation' AND j.available_at<=clock_timestamp()
      AND (j.status='pending' OR (j.status='in_flight' AND j.leased_until<=clock_timestamp()))
      AND ingress_blocker(j.id) IS NULL
    ORDER BY j.available_at,j.id FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  )
  UPDATE runtime_jobs j
  SET status='in_flight',attempt_count=j.attempt_count+1,leased_by=p_worker_id,
      leased_until=clock_timestamp()+p_lease,last_error=NULL,
      activity_phase='starting_runtime',activity_detail='Preparing the selected executor runtime',
      started_at=COALESCE(j.started_at,clock_timestamp()),heartbeat_at=clock_timestamp()
  FROM candidates c WHERE j.id=c.id RETURNING j.*;
$$;

-- ------------------------------------------------------------ run mailbox
CREATE TABLE run_commands (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES task_runs(id),
  job_id bigint NOT NULL REFERENCES runtime_jobs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  command_kind text NOT NULL CHECK (command_kind IN ('input_response','steer','interrupt')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=16384),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivering','acknowledged','outcome_unknown','failed')),
  requested_by text NOT NULL,
  correlation_id text,
  delivering_by text,
  delivery_started_at timestamptz,
  finished_at timestamptz,
  native_receipt jsonb CHECK (native_receipt IS NULL
    OR (jsonb_typeof(native_receipt)='object' AND octet_length(native_receipt::text)<=8192)),
  failure_reason text REFERENCES failure_reasons(reason),
  failure_detail jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, sequence),
  UNIQUE (run_id, command_kind, idempotency_key),
  -- Acknowledged is the runtime's word, so it carries what the runtime said.
  CHECK ((status='acknowledged') = (native_receipt IS NOT NULL)),
  CHECK ((status IN ('failed','outcome_unknown')) = (failure_reason IS NOT NULL)),
  CHECK ((status IN ('acknowledged','outcome_unknown','failed')) = (finished_at IS NOT NULL)),
  CHECK (status='pending' OR status='failed' OR delivering_by IS NOT NULL)
);
CREATE INDEX run_commands_pending ON run_commands(run_id, sequence) WHERE status IN ('pending','delivering');
GRANT SELECT, INSERT, UPDATE ON conversation_ingress, run_commands TO infra_worker;
GRANT USAGE ON SEQUENCE conversation_ingress_id_seq, run_commands_id_seq TO infra_worker;
-- Read by the panel: what a message waits for, and what became of a Stop.
GRANT SELECT ON conversation_ingress, run_commands TO infra_web;

-- A command moves forward and stops. Finished is final; pending cannot skip
-- to acknowledged, because only a delivery can be acknowledged.
CREATE OR REPLACE FUNCTION guard_run_command_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM runtime_jobs WHERE id=OLD.job_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP='DELETE' OR OLD.status IN ('acknowledged','outcome_unknown','failed')
     OR NOT ((OLD.status='pending' AND NEW.status IN ('delivering','failed'))
          OR (OLD.status='delivering' AND NEW.status IN ('acknowledged','outcome_unknown','failed')))
     OR NEW.run_id<>OLD.run_id OR NEW.sequence<>OLD.sequence OR NEW.command_kind<>OLD.command_kind
     OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.payload<>OLD.payload THEN
    PERFORM refuse('run_command_immutable',
      format('run command %s cannot go from %s to %s', OLD.id, OLD.status,
        CASE WHEN TG_OP='DELETE' THEN 'deleted' ELSE NEW.status END));
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER run_commands_transition BEFORE UPDATE OR DELETE ON run_commands
  FOR EACH ROW EXECUTE FUNCTION guard_run_command_transition();

-- The run a job is running now, or NULL. A job is routed carrying the run of
-- the event that caused it — a delegation carries the Codex turn's, a review
-- the implementation's — so the run is read as the job's own only when its kind
-- matches: a turn is never write-capable and an implementation always is.
CREATE OR REPLACE FUNCTION active_run_of_job(p_job runtime_jobs)
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT r.id FROM task_runs r
  WHERE r.id=p_job.run_id
    AND r.status IN ('starting','running','waiting_for_input','blocked')
    AND ((p_job.job_type IN ('codex_chat_turn','resume_codex') AND NOT r.write_capable)
      OR (p_job.job_type='start_implementation' AND r.write_capable));
$$;

-- Writes a command into a running run's mailbox. The same key for the same run
-- and kind is the same command: the stored one is returned, and a different
-- payload under it is refused. The sequence is the run's own, allocated under
-- the run's row lock.
CREATE OR REPLACE FUNCTION request_run_command(
  p_project_id uuid, p_task_id uuid, p_command_kind text, p_payload jsonb,
  p_idempotency_key text, p_actor_id text, p_correlation_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_run uuid; v_command run_commands%ROWTYPE; v_sequence integer;
BEGIN
  IF p_command_kind IS NULL OR p_command_kind NOT IN ('input_response','steer','interrupt') THEN
    PERFORM refuse('run_command_kind_invalid', format('%s is not a command to a running run', p_command_kind), '22023');
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    PERFORM refuse('run_command_idempotency_key_invalid', 'a run command needs an idempotency key of 8 to 200 characters', '22023');
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>16384 THEN
    PERFORM refuse('run_command_payload_invalid', 'a run command payload is a JSON object of at most 16 KiB', '22023');
  END IF;

  SELECT j.* INTO v_job FROM runtime_jobs j
  WHERE j.project_id=p_project_id AND j.task_id=p_task_id AND j.status='in_flight'
  ORDER BY j.id DESC LIMIT 1 FOR UPDATE;
  IF v_job.id IS NULL THEN
    PERFORM refuse('run_command_no_active_run', 'no active runtime job is available');
  END IF;
  v_run:=active_run_of_job(v_job);
  IF v_run IS NULL THEN
    PERFORM refuse('run_command_run_not_started',
      format('job %s is claimed and its run has not started yet', v_job.id));
  END IF;
  PERFORM 1 FROM task_runs WHERE id=v_run FOR UPDATE;

  SELECT * INTO v_command FROM run_commands
  WHERE run_id=v_run AND command_kind=p_command_kind AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_command.payload<>p_payload THEN
      PERFORM refuse('run_command_idempotency_conflict',
        format('command %s of run %s was requested with a different payload', v_command.id, v_run));
    END IF;
    RETURN jsonb_build_object('command_id',v_command.id,'run_id',v_run,'job_id',v_command.job_id,
      'sequence',v_command.sequence,'command_kind',v_command.command_kind,'status',v_command.status,'repeat',true);
  END IF;

  SELECT COALESCE(max(sequence),0)+1 INTO v_sequence FROM run_commands WHERE run_id=v_run;
  INSERT INTO run_commands(run_id,job_id,project_id,task_id,sequence,command_kind,idempotency_key,
    payload,requested_by,correlation_id)
  VALUES(v_run,v_job.id,p_project_id,p_task_id,v_sequence,p_command_kind,p_idempotency_key,
    p_payload,p_actor_id,NULLIF(p_correlation_id,''))
  RETURNING * INTO v_command;
  RETURN jsonb_build_object('command_id',v_command.id,'run_id',v_run,'job_id',v_job.id,
    'sequence',v_sequence,'command_kind',p_command_kind,'status',v_command.status,'repeat',false);
END $$;

-- The next command of a job's run, taken for delivery by the worker that holds
-- the job. One at a time, in the run's order: while a command is being
-- delivered the next one waits.
CREATE OR REPLACE FUNCTION claim_run_command(p_job_id bigint, p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_run uuid; v_command run_commands%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id;
  IF NOT FOUND OR v_job.status<>'in_flight' OR v_job.leased_by IS DISTINCT FROM p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    PERFORM refuse('run_command_not_leased', format('job %s is not leased by %s', p_job_id, p_worker_id));
  END IF;
  v_run:=active_run_of_job(v_job);
  IF v_run IS NULL THEN RETURN NULL; END IF;
  -- An interrupt asked for while the job was claimed and its run not yet
  -- started (an implementation between its claim and start_implementation_job)
  -- was recorded on the job. It becomes the run's command the first time the
  -- run's worker asks, rather than being refused to the operator for arriving a
  -- second early.
  IF v_job.interrupt_requested_at IS NOT NULL AND v_job.interrupted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM run_commands WHERE run_id=v_run AND command_kind='interrupt') THEN
    PERFORM request_run_command(v_job.project_id,v_job.task_id,'interrupt',
      jsonb_build_object('reason',COALESCE(v_job.interrupt_reason,'')),
      'interrupt:job:'||v_job.id,COALESCE(v_job.interrupt_requested_by,'operator'),NULL);
  END IF;
  IF EXISTS (SELECT 1 FROM run_commands WHERE run_id=v_run AND status='delivering') THEN RETURN NULL; END IF;
  SELECT * INTO v_command FROM run_commands
  WHERE run_id=v_run AND status='pending' ORDER BY sequence LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE run_commands SET status='delivering',delivering_by=p_worker_id,delivery_started_at=clock_timestamp()
  WHERE id=v_command.id RETURNING * INTO v_command;
  RETURN jsonb_build_object('command_id',v_command.id,'run_id',v_command.run_id,'job_id',v_job.id,
    'sequence',v_command.sequence,'command_kind',v_command.command_kind,'payload',v_command.payload,
    'requested_by',v_command.requested_by);
END $$;

-- The runtime answered. The receipt is what it said, not what the worker
-- concluded: Codex's turn/interrupt response, OpenCode's exit after the signal.
CREATE OR REPLACE FUNCTION acknowledge_run_command(p_command_id bigint, p_worker_id text, p_native_receipt jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_command run_commands%ROWTYPE;
BEGIN
  IF p_native_receipt IS NULL OR jsonb_typeof(p_native_receipt)<>'object'
     OR p_native_receipt='{}'::jsonb OR octet_length(p_native_receipt::text)>8192 THEN
    PERFORM refuse('run_command_receipt_invalid', 'an acknowledgement carries the runtime''s receipt, a JSON object of at most 8 KiB', '22023');
  END IF;
  SELECT * INTO v_command FROM run_commands WHERE id=p_command_id FOR UPDATE;
  IF NOT FOUND OR v_command.status<>'delivering' OR v_command.delivering_by IS DISTINCT FROM p_worker_id THEN
    PERFORM refuse('run_command_not_delivering',
      format('command %s is not being delivered by %s', p_command_id, p_worker_id));
  END IF;
  UPDATE run_commands SET status='acknowledged',native_receipt=p_native_receipt,finished_at=clock_timestamp()
  WHERE id=p_command_id RETURNING * INTO v_command;
  RETURN jsonb_build_object('command_id',v_command.id,'status',v_command.status,'run_id',v_command.run_id);
END $$;

-- The delivery ended without the runtime's acknowledgement: `failed` when it is
-- known that nothing reached the runtime (it was refused, or the driver has no
-- such capability), `outcome_unknown` when it may have.
CREATE OR REPLACE FUNCTION finish_run_command(
  p_command_id bigint, p_worker_id text, p_status text, p_reason text, p_detail jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_command run_commands%ROWTYPE;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('failed','outcome_unknown') THEN
    PERFORM refuse('run_command_kind_invalid', format('%s is not how a delivery ends without a receipt', p_status), '22023');
  END IF;
  SELECT * INTO v_command FROM run_commands WHERE id=p_command_id FOR UPDATE;
  IF NOT FOUND OR v_command.status<>'delivering' OR v_command.delivering_by IS DISTINCT FROM p_worker_id THEN
    PERFORM refuse('run_command_not_delivering',
      format('command %s is not being delivered by %s', p_command_id, p_worker_id));
  END IF;
  UPDATE run_commands SET status=p_status,failure_reason=p_reason,finished_at=clock_timestamp(),
    failure_detail=CASE WHEN p_detail IS NULL THEN NULL ELSE left(p_detail::text,4000)::jsonb END
  WHERE id=p_command_id RETURNING * INTO v_command;
  RETURN jsonb_build_object('command_id',v_command.id,'status',v_command.status,'reason',p_reason);
END $$;

-- When a run ends, what was never delivered to it failed — it is known not to
-- have happened — and what was being delivered may have happened.
CREATE OR REPLACE FUNCTION close_run_commands_of_ended_run()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('interrupted','completed','failed','cancelled','lost')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE run_commands SET status='failed',failure_reason='run_command_run_ended',finished_at=clock_timestamp()
    WHERE run_id=NEW.id AND status='pending';
    UPDATE run_commands SET status='outcome_unknown',failure_reason='run_command_delivery_lost',finished_at=clock_timestamp()
    WHERE run_id=NEW.id AND status='delivering';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_runs_close_run_commands AFTER UPDATE OF status ON task_runs
  FOR EACH ROW EXECUTE FUNCTION close_run_commands_of_ended_run();

-- And when the lease a delivery was made under ends, whoever held it cannot
-- report the answer any more.
CREATE OR REPLACE FUNCTION close_run_commands_of_released_job()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='in_flight' AND (NEW.status<>'in_flight' OR NEW.leased_by IS DISTINCT FROM OLD.leased_by) THEN
    UPDATE run_commands SET status='outcome_unknown',failure_reason='run_command_delivery_lost',finished_at=clock_timestamp()
    WHERE job_id=NEW.id AND status='delivering';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_jobs_close_run_commands AFTER UPDATE OF status, leased_by ON runtime_jobs
  FOR EACH ROW EXECUTE FUNCTION close_run_commands_of_released_job();

-- request_runtime_interrupt, redefined from 0016 under its signature, grant and
-- SECURITY DEFINER (0038). The panel's "Stop run" is now an interrupt command
-- in the run's mailbox. Two things change: it no longer consults
-- runtime_profiles.capabilities, and it refuses by reason. It keeps writing
-- interrupt_requested_at, the run.interrupt_requested event and the audit row,
-- once per job, as before — the previous release's workers poll that column.
CREATE OR REPLACE FUNCTION request_runtime_interrupt(
  p_project_id uuid,p_task_id uuid,p_actor_id text,p_reason text,p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_runtime text; v_task tasks%ROWTYPE; v_event domain_events%ROWTYPE;
  v_command jsonb;
BEGIN
  SELECT j.* INTO v_job FROM runtime_jobs j
  WHERE j.project_id=p_project_id AND j.task_id=p_task_id AND j.status='in_flight'
  ORDER BY j.id DESC LIMIT 1 FOR UPDATE;
  IF v_job.id IS NULL THEN
    PERFORM refuse('run_command_no_active_run', 'no active runtime job is available');
  END IF;
  SELECT rp.runtime_type INTO v_runtime FROM task_runs r JOIN agent_sessions s ON s.id=r.session_id
    JOIN runtime_profiles rp ON rp.id=s.runtime_profile_id WHERE r.id=v_job.run_id;
  IF v_runtime IS NULL THEN
    SELECT rp.runtime_type INTO v_runtime FROM tasks t JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
      JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id WHERE t.id=p_task_id;
  END IF;
  -- One interrupt per job: the key is the job's, so a second click, or the
  -- same click retried, is the same command. A job whose run has not started
  -- keeps the request on the job, and claim_run_command turns it into the run's
  -- command when the run starts.
  IF active_run_of_job(v_job) IS NOT NULL THEN
    v_command:=request_run_command(p_project_id,p_task_id,'interrupt',
      jsonb_build_object('reason',left(trim(COALESCE(p_reason,'')),500)),
      'interrupt:job:'||v_job.id,p_actor_id,p_correlation_id);
  ELSE
    v_command:=jsonb_build_object('command_id',NULL,'status','awaiting_run','run_id',NULL);
  END IF;
  IF v_job.interrupt_requested_at IS NULL THEN
    UPDATE runtime_jobs SET interrupt_requested_at=clock_timestamp(),interrupt_requested_by=p_actor_id,
      interrupt_reason=left(trim(p_reason),500) WHERE id=v_job.id RETURNING * INTO v_job;
    SELECT * INTO v_task FROM tasks WHERE id=p_task_id FOR UPDATE;
    UPDATE tasks SET version=version+1,updated_at=clock_timestamp() WHERE id=p_task_id RETURNING * INTO v_task;
    v_event:=append_event('run.interrupt_requested',p_project_id,p_task_id,v_job.run_id,'user',p_actor_id,
      NULL,p_correlation_id,'interrupt-requested:'||v_job.id,'task',p_task_id,v_task.version,
      jsonb_build_object('job_id',v_job.id,'runtime_type',v_runtime,'reason',left(trim(p_reason),500),
        'command_id',v_command->'command_id'));
    PERFORM write_audit_event(p_project_id,p_task_id,v_job.run_id,'user',p_actor_id,'runtime.interrupt_requested',
      'runtime_job',v_job.id::text,'allowed',NULL,
      jsonb_build_object('runtime_type',v_runtime,'command_id',v_command->'command_id'),p_correlation_id);
  END IF;
  RETURN jsonb_build_object('project_id',p_project_id,'task_id',p_task_id,'job_id',v_job.id,
    'runtime_type',v_runtime,'status','interrupt_requested','command_id',v_command->'command_id',
    'command_status',v_command->>'status','run_id',v_command->>'run_id');
END; $$;

ALTER FUNCTION ingress_kind_of(domain_events) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION record_conversation_ingress() SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION refuse_ingress_change() SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION ingress_blocker(bigint) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_codex_chat_jobs(text,integer,interval) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_executor_jobs(text,integer,interval) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION guard_run_command_transition() SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION active_run_of_job(runtime_jobs) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION request_run_command(uuid,uuid,text,jsonb,text,text,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_run_command(bigint,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION acknowledge_run_command(bigint,text,jsonb) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION finish_run_command(bigint,text,text,text,jsonb) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION close_run_commands_of_ended_run() SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION close_run_commands_of_released_job() SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION request_runtime_interrupt(uuid,uuid,text,text,text) SET search_path=control_plane,public,extensions,pg_temp;

REVOKE EXECUTE ON FUNCTION ingress_kind_of(domain_events) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_conversation_ingress() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION refuse_ingress_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ingress_blocker(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION guard_run_command_transition() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION active_run_of_job(runtime_jobs) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION request_run_command(uuid,uuid,text,jsonb,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_run_command(bigint,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION acknowledge_run_command(bigint,text,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finish_run_command(bigint,text,text,text,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION close_run_commands_of_ended_run() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION close_run_commands_of_released_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingress_kind_of(domain_events) TO infra_worker;
GRANT EXECUTE ON FUNCTION record_conversation_ingress() TO infra_worker;
GRANT EXECUTE ON FUNCTION refuse_ingress_change() TO infra_worker;
GRANT EXECUTE ON FUNCTION ingress_blocker(bigint) TO infra_worker;
GRANT EXECUTE ON FUNCTION guard_run_command_transition() TO infra_worker;
GRANT EXECUTE ON FUNCTION active_run_of_job(runtime_jobs) TO infra_worker;
GRANT EXECUTE ON FUNCTION claim_run_command(bigint,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION acknowledge_run_command(bigint,text,jsonb) TO infra_worker;
GRANT EXECUTE ON FUNCTION finish_run_command(bigint,text,text,text,jsonb) TO infra_worker;
GRANT EXECUTE ON FUNCTION close_run_commands_of_ended_run() TO infra_worker;
GRANT EXECUTE ON FUNCTION close_run_commands_of_released_job() TO infra_worker;
