-- Stage 11.1b, WP-4: Conversation, Task, NativeSession and Run are four things.
--
-- ADR-0014. A conversation is one user-facing chat; its tasks form a line; its
-- native sessions belong to it and are never copied; its order is a number
-- allocated when an event is written.
--
-- What this replaces
-- ------------------
-- * A "conversation" was a chain of follow-up tasks walked in the browser, and
--   the chain could fork: tasks_followup_lineage was not unique.
-- * A session was found by purpose = 'task_chat:<task_id>', so a follow-up had to
--   copy the native session id into a new row — and two branches could resume
--   one native CLI session.
-- * The chat was ordered by occurred_at, which two agents writing at once do not
--   make deterministic.
--
-- What it becomes
-- ---------------
-- * conversations, and tasks.conversation_id set by a trigger: a new task opens a
--   conversation, a follow-up joins its parent's. Every task creator and every
--   fixture keeps working, and none can break the rule.
-- * A unique index makes the line a line.
-- * agent_sessions carries conversation_id, role and a session_namespace derived
--   from the runtime profile by a trigger; one active session per conversation,
--   role and agent; a native id unique within its namespace.
-- * domain_events carries conversation_id and conversation_sequence, allocated by
--   a BEFORE INSERT trigger from the conversation row, in the event's own
--   transaction. Not in append_event: the first run of the database suites
--   against this migration found four fixtures inserting task events directly,
--   and a number that only one function allocates is a number any other insert
--   path skips. The trigger derives both columns and ignores what a caller
--   supplies, so a sequence cannot be forged either.
--
-- Existing data
-- -------------
-- Checked first, refused by name if it cannot be made consistent: a task with two
-- follow-ups is a fork this migration will not choose between. On the production
-- host, before this migration: 11 tasks, no follow-ups, 20 sessions, no native id
-- carried by two rows.
--
-- Then: one conversation per root task and its chain; the conversation's events
-- numbered by (occurred_at, aggregate_version, id); each session's conversation
-- and role read from its purpose; copies of a native session merged into the
-- earliest row, each merged row closed and marked with what it was merged into.
--
-- domain_events is append-only, enforced by a trigger. Numbering history is the
-- one sanctioned exception: the trigger is disabled for exactly one UPDATE, which
-- writes only the two new columns, inside this migration's transaction.
SET search_path TO control_plane, public, extensions;

-- ---------------------------------------------------------------- conversations
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX conversations_by_project ON conversations(project_id, updated_at DESC);

ALTER TABLE tasks ADD COLUMN conversation_id uuid REFERENCES conversations(id);
ALTER TABLE domain_events
  ADD COLUMN conversation_id uuid REFERENCES conversations(id),
  ADD COLUMN conversation_sequence bigint;
ALTER TABLE agent_sessions
  ADD COLUMN session_namespace text,
  ADD COLUMN conversation_id uuid REFERENCES conversations(id),
  ADD COLUMN role text CHECK (role IN ('chat','executor'));

-- ------------------------------------------------------------------- pre-checks
DO $$
DECLARE v_forks text;
BEGIN
  SELECT string_agg(followup_of_task_id::text, ', ') INTO v_forks
  FROM (SELECT followup_of_task_id FROM tasks WHERE followup_of_task_id IS NOT NULL
        GROUP BY 1 HAVING count(*)>1) f;
  IF v_forks IS NOT NULL THEN
    -- Repair, deliberately manual: decide which follow-up continues the
    -- conversation and point the others' followup_of_task_id at NULL (they become
    -- conversations of their own), then run the update again.
    RAISE EXCEPTION 'tasks with more than one follow-up cannot become one linear conversation: %', v_forks
      USING ERRCODE='55000', DETAIL='conversation_fork_exists';
  END IF;
END $$;

-- -------------------------------------------------------------------- backfill
-- Idempotent, and a function so the database test can run it on legacy-shaped
-- rows. Returns what it did.
CREATE OR REPLACE FUNCTION backfill_conversations()
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_root tasks%ROWTYPE;
  v_conversation uuid;
  v_conversations integer:=0;
  v_events integer;
  v_sessions integer;
  v_merged integer;
BEGIN
  FOR v_root IN
    SELECT * FROM tasks WHERE followup_of_task_id IS NULL AND conversation_id IS NULL
    ORDER BY created_at, id
  LOOP
    INSERT INTO conversations(project_id, created_at, updated_at)
    VALUES(v_root.project_id, v_root.created_at, v_root.updated_at)
    RETURNING id INTO v_conversation;
    WITH RECURSIVE chain AS (
      SELECT id FROM tasks WHERE id=v_root.id
      UNION ALL
      SELECT t.id FROM tasks t JOIN chain c ON t.followup_of_task_id=c.id
    )
    UPDATE tasks SET conversation_id=v_conversation WHERE id IN (SELECT id FROM chain);
    v_conversations:=v_conversations+1;
  END LOOP;

  -- History, numbered in the order the chat has always shown it.
  ALTER TABLE domain_events DISABLE TRIGGER domain_events_append_only;
  WITH numbered AS (
    SELECT e.id, t.conversation_id,
      row_number() OVER (PARTITION BY t.conversation_id ORDER BY e.occurred_at, e.aggregate_version, e.id) AS n
    FROM domain_events e JOIN tasks t ON t.id=e.task_id
    WHERE e.conversation_id IS NULL
  )
  UPDATE domain_events e
  SET conversation_id=numbered.conversation_id,
      conversation_sequence=numbered.n + COALESCE((SELECT last_sequence FROM conversations c WHERE c.id=numbered.conversation_id),0)
  FROM numbered WHERE e.id=numbered.id;
  GET DIAGNOSTICS v_events=ROW_COUNT;
  ALTER TABLE domain_events ENABLE TRIGGER domain_events_append_only;
  UPDATE conversations c
  SET last_sequence=COALESCE((SELECT max(e.conversation_sequence) FROM domain_events e WHERE e.conversation_id=c.id),0);

  -- Sessions: namespace from the profile, conversation and role from purpose.
  UPDATE agent_sessions s SET session_namespace=rp.runtime_type
  FROM runtime_profiles rp WHERE rp.id=s.runtime_profile_id AND s.session_namespace IS NULL;
  UPDATE agent_sessions s
  SET role=CASE split_part(s.purpose,':',1) WHEN 'task_chat' THEN 'chat' ELSE 'executor' END,
      conversation_id=t.conversation_id
  FROM tasks t
  WHERE s.conversation_id IS NULL
    AND s.purpose ~ '^task_(chat|executor):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND t.id=split_part(s.purpose,':',2)::uuid;
  GET DIAGNOSTICS v_sessions=ROW_COUNT;

  -- Copies. Within one conversation, role and agent, the active row that holds a
  -- native id — the earliest if several — is canonical; every other active row
  -- is closed and says what it was merged into. A closed copy of the canonical's
  -- own native id gives the id up, since one native session has one record.
  WITH ranked AS (
    SELECT s.id, s.native_session_id,
      first_value(s.id) OVER w AS canonical,
      first_value(s.native_session_id) OVER w AS canonical_native,
      row_number() OVER w AS n
    FROM agent_sessions s
    WHERE s.active AND s.conversation_id IS NOT NULL
    WINDOW w AS (PARTITION BY s.conversation_id, s.role, s.agent_id
                 ORDER BY (s.native_session_id IS NULL), s.created_at, s.id)
  )
  UPDATE agent_sessions s
  SET active=false, status='closed', updated_at=clock_timestamp(), version=s.version+1,
      native_session_id=CASE WHEN s.native_session_id=ranked.canonical_native THEN NULL ELSE s.native_session_id END,
      metadata=s.metadata||jsonb_build_object('merged_into',ranked.canonical,'merged_by','0063')
  FROM ranked WHERE s.id=ranked.id AND ranked.n>1;
  GET DIAGNOSTICS v_merged=ROW_COUNT;

  -- Any native id still carried twice within a namespace — copies across
  -- conversations or of closed rows — keeps it on the earliest row only.
  WITH dup AS (
    SELECT s.id, row_number() OVER (PARTITION BY s.session_namespace, s.native_session_id ORDER BY s.created_at, s.id) AS n
    FROM agent_sessions s WHERE s.native_session_id IS NOT NULL
  )
  UPDATE agent_sessions s
  SET native_session_id=NULL, updated_at=clock_timestamp(), version=s.version+1,
      metadata=s.metadata||jsonb_build_object('native_session_id_released_by','0063')
  FROM dup WHERE s.id=dup.id AND dup.n>1;

  RETURN jsonb_build_object('conversations',v_conversations,'events_numbered',v_events,
    'sessions_attached',v_sessions,'session_copies_merged',v_merged);
END $$;

SELECT backfill_conversations();

-- --------------------------------------------------------- invariants, held
ALTER TABLE tasks ALTER COLUMN conversation_id SET NOT NULL;
DROP INDEX tasks_followup_lineage;
CREATE UNIQUE INDEX tasks_followup_is_linear ON tasks(followup_of_task_id) WHERE followup_of_task_id IS NOT NULL;
CREATE INDEX tasks_by_conversation ON tasks(conversation_id, created_at);

ALTER TABLE domain_events
  ADD CONSTRAINT domain_events_conversation_pair CHECK ((conversation_id IS NULL)=(conversation_sequence IS NULL)),
  ADD CONSTRAINT domain_events_conversation_sequence_positive CHECK (conversation_sequence > 0),
  ADD CONSTRAINT domain_events_task_event_in_conversation CHECK (task_id IS NULL OR conversation_id IS NOT NULL),
  ADD CONSTRAINT domain_events_conversation_order UNIQUE (conversation_id, conversation_sequence);

ALTER TABLE agent_sessions ALTER COLUMN session_namespace SET NOT NULL;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_conversation_role_pair
  CHECK ((conversation_id IS NULL)=(role IS NULL));
DROP INDEX agent_sessions_one_active_purpose;
CREATE UNIQUE INDEX agent_sessions_one_active_per_conversation_role
  ON agent_sessions(conversation_id, role, agent_id) WHERE active AND conversation_id IS NOT NULL;
CREATE UNIQUE INDEX agent_sessions_native_identity
  ON agent_sessions(session_namespace, native_session_id) WHERE native_session_id IS NOT NULL;

-- ------------------------------------------------------------------- triggers
CREATE OR REPLACE FUNCTION assign_task_conversation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_parent tasks%ROWTYPE; v_project uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.followup_of_task_id IS DISTINCT FROM OLD.followup_of_task_id THEN
      RAISE EXCEPTION 'a task does not move between conversations' USING ERRCODE='55000',
        DETAIL='conversation_immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.followup_of_task_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM tasks WHERE id=NEW.followup_of_task_id;
    IF NOT FOUND OR v_parent.project_id<>NEW.project_id THEN
      RAISE EXCEPTION 'a follow-up continues a task of its own project' USING ERRCODE='55000',
        DETAIL='conversation_cross_project';
    END IF;
    IF NEW.conversation_id IS NOT NULL AND NEW.conversation_id<>v_parent.conversation_id THEN
      RAISE EXCEPTION 'a follow-up joins its parent''s conversation' USING ERRCODE='55000',
        DETAIL='conversation_mismatch';
    END IF;
    NEW.conversation_id:=v_parent.conversation_id;
  ELSIF NEW.conversation_id IS NULL THEN
    INSERT INTO conversations(project_id) VALUES(NEW.project_id) RETURNING id INTO NEW.conversation_id;
  ELSE
    -- Only a follow-up joins an existing conversation: that is what keeps it a line.
    RAISE EXCEPTION 'only a follow-up joins an existing conversation' USING ERRCODE='55000',
      DETAIL='conversation_join_requires_followup';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tasks_assign_conversation
BEFORE INSERT OR UPDATE OF conversation_id, followup_of_task_id ON tasks
FOR EACH ROW EXECUTE FUNCTION assign_task_conversation();

-- The namespace is derived, never supplied: it cannot disagree with the profile.
CREATE OR REPLACE FUNCTION derive_session_namespace()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT rp.runtime_type INTO NEW.session_namespace FROM runtime_profiles rp WHERE rp.id=NEW.runtime_profile_id;
  IF NEW.session_namespace IS NULL THEN
    RAISE EXCEPTION 'a session needs a runtime profile to have a namespace' USING ERRCODE='23502';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_sessions_derive_namespace
BEFORE INSERT OR UPDATE OF runtime_profile_id, session_namespace ON agent_sessions
FOR EACH ROW EXECUTE FUNCTION derive_session_namespace();


-- Every task event takes the next number of its conversation, whichever path
-- inserts it. The conversation row is the counter and its lock orders concurrent
-- writers; a rolled-back insert rolls its increment back, so committed numbers
-- have no gaps. Writers lock their task before they write an event and nothing
-- locks a conversation first, so the lock order is always task, then
-- conversation.
CREATE OR REPLACE FUNCTION allocate_conversation_sequence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.conversation_id:=NULL;
  NEW.conversation_sequence:=NULL;
  IF NEW.task_id IS NOT NULL THEN
    UPDATE conversations c SET last_sequence=c.last_sequence+1, updated_at=clock_timestamp()
    FROM tasks t
    WHERE t.id=NEW.task_id AND c.id=t.conversation_id
    RETURNING c.id, c.last_sequence INTO NEW.conversation_id, NEW.conversation_sequence;
    IF NEW.conversation_id IS NULL THEN
      RAISE EXCEPTION 'task % belongs to no conversation', NEW.task_id USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER domain_events_conversation_sequence
BEFORE INSERT ON domain_events
FOR EACH ROW EXECUTE FUNCTION allocate_conversation_sequence();

-- --------------------------------------------------------- redefined functions

CREATE OR REPLACE FUNCTION bind_codex_chat_session(
  p_job_id bigint,p_worker_id text,p_native_session_id text
)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE;
  v_assignment project_agent_assignments%ROWTYPE; v_session agent_sessions%ROWTYPE; v_purpose text;
  v_conversation uuid;
BEGIN
  IF p_native_session_id IS NULL OR length(p_native_session_id)=0 THEN
    RAISE EXCEPTION 'native Codex session id is required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type NOT IN ('codex_chat_turn','resume_codex')
     OR v_job.status<>'in_flight' OR v_job.leased_by<>p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'Codex orchestration job is not actively leased' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_job.task_id;
  SELECT * INTO v_assignment FROM project_agent_assignments pa
  WHERE pa.id=v_task.orchestrator_assignment_id AND pa.enabled
    AND pa.assignment_role='orchestrator';
  IF NOT FOUND OR NOT EXISTS(
    SELECT 1 FROM agents a JOIN runtime_profiles rp ON rp.id=v_assignment.runtime_profile_id
    WHERE a.id=v_assignment.agent_id AND a.enabled AND rp.enabled AND rp.runtime_type='codex'
  ) THEN RAISE EXCEPTION 'task orchestrator is not an enabled Codex runtime' USING ERRCODE='55000'; END IF;
  -- 0063: the session belongs to the conversation (ADR-0014). A follow-up task
  -- finds the same row by these columns, so there is nothing to copy. purpose
  -- is description only.
  v_conversation:=v_task.conversation_id;
  v_purpose:='conversation_chat:' || v_conversation::text;
  -- A session in another runtime's namespace cannot be resumed by this one; it
  -- is closed rather than overwritten, and stays in the history.
  UPDATE agent_sessions SET active=false,status='closed',updated_at=clock_timestamp(),version=version+1,
    metadata=metadata||jsonb_build_object('closed_reason','runtime_changed')
  WHERE conversation_id=v_conversation AND role='chat' AND agent_id=v_assignment.agent_id AND active
    AND session_namespace<>(SELECT rp.runtime_type FROM runtime_profiles rp WHERE rp.id=v_assignment.runtime_profile_id);
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,native_session_id,purpose,
    status,active,last_resumed_at,metadata,conversation_id,role)
  VALUES(v_job.project_id,v_assignment.agent_id,v_assignment.runtime_profile_id,
    p_native_session_id,v_purpose,'active',true,clock_timestamp(),
    jsonb_build_object('task_id',v_job.task_id,'orchestrator_assignment_id',v_assignment.id),
    v_conversation,'chat')
  ON CONFLICT(conversation_id,role,agent_id) WHERE active AND conversation_id IS NOT NULL DO UPDATE
  SET native_session_id=CASE WHEN agent_sessions.native_session_id IS NULL
        THEN EXCLUDED.native_session_id ELSE agent_sessions.native_session_id END,
      runtime_profile_id=EXCLUDED.runtime_profile_id,status='active',
      last_resumed_at=clock_timestamp(),updated_at=clock_timestamp(),
      version=agent_sessions.version+1
  RETURNING * INTO v_session;
  IF v_session.native_session_id<>p_native_session_id
     OR v_session.runtime_profile_id<>v_assignment.runtime_profile_id THEN
    RAISE EXCEPTION 'orchestrator session continuity validation failed' USING ERRCODE='55000';
  END IF;
  RETURN v_session.id;
END; $$;

CREATE OR REPLACE FUNCTION codex_chat_job_context(p_job_id bigint,p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_context jsonb; v_snapshot jsonb; v_snapshot_model text;
BEGIN
  SELECT get_task_runtime_snapshot(t.id) INTO v_snapshot
  FROM runtime_jobs j JOIN tasks t ON t.id=j.task_id
  WHERE j.id=p_job_id AND j.job_type IN ('codex_chat_turn','resume_codex');
  IF v_snapshot IS NULL OR v_snapshot->>'source'<>'catalog' THEN
    v_snapshot := '{}'::jsonb;
  END IF;
  v_snapshot_model := v_snapshot->'orchestrator'->>'model_id';

  SELECT jsonb_build_object(
    'job_id',j.id,'job_type',j.job_type,'source_event_id',j.source_event_id,
    'project_id',j.project_id,'task_id',j.task_id,'task_status',t.status,
    'task_version',t.version,'task_title',t.title,'task_objective',t.objective,
    'task_constraints',t.constraints,'task_acceptance_criteria',t.acceptance_criteria,
    'followup_of_task_id',t.followup_of_task_id,
    'content',CASE WHEN j.job_type='codex_chat_turn'
      THEN j.payload#>>'{event_payload,content}'
      ELSE concat(
        'A durable ',j.payload->>'event_type',' event is ready for review. ',
        'Inspect the implementation in the read-only workspace. ',
        'If changes are required, call platform.request_revision. ',
        'Otherwise summarize the review result for the operator.',E'\n',
        jsonb_pretty(j.payload->'event_payload')) END,
    'correlation_id',j.payload->>'correlation_id','workspace_path',p.workspace_path,
    'agent_id',a.id,'agent_name',a.name,'orchestrator_assignment_id',pa.id,
    'runtime_profile_id',COALESCE(v_snapshot->'orchestrator'->>'entry_id',rp.id::text),
    'runtime_type',COALESCE(v_snapshot->'orchestrator'->>'runtime_type',rp.runtime_type),
    'provider_type',COALESCE(v_snapshot->'orchestrator'->>'provider_id',rp.provider_type),
    'model',COALESCE(v_snapshot_model,rp.model),
    'snapshot_entry_id',v_snapshot->'orchestrator'->>'entry_id',
    'snapshot_verification_id',v_snapshot->'orchestrator'->>'verification_id',
    'reasoning_effort',v_snapshot->'orchestrator'->>'reasoning_effort',
    'service_tier',v_snapshot->'orchestrator'->>'service_tier',
    'native_session_id',s.native_session_id,
    'executor',COALESCE((
      SELECT jsonb_build_object(
        'assignment_id',epa.id,'agent_id',ea.id,'agent_name',ea.name,
        'runtime_profile_id',COALESCE(esnap.e->>'entry_id',erp.id::text),
        'runtime_type',COALESCE(esnap.e->>'runtime_type',erp.runtime_type),
        'provider_type',COALESCE(esnap.e->>'provider_id',erp.provider_type),
        'model',COALESCE(esnap.e->>'model_id',erp.model),
        'reasoning_effort',esnap.e->>'reasoning_effort','service_tier',esnap.e->>'service_tier',
        'priority',tea.priority)
      FROM task_executor_assignments tea
      JOIN project_agent_assignments epa ON epa.id=tea.project_agent_assignment_id
        AND epa.enabled AND epa.assignment_role='executor'
      JOIN agents ea ON ea.id=epa.agent_id AND ea.enabled
      JOIN runtime_profiles erp ON erp.id=epa.runtime_profile_id
        AND erp.enabled AND erp.runtime_type='opencode'
      LEFT JOIN LATERAL (
        SELECT e FROM jsonb_array_elements(v_snapshot->'executors') e
        LIMIT 1
      ) esnap ON true
      WHERE tea.task_id=t.id AND tea.enabled
      ORDER BY tea.priority,tea.created_at LIMIT 1
    ),'null'::jsonb)
  ) INTO v_context
  FROM runtime_jobs j
  JOIN projects p ON p.id=j.project_id
  JOIN tasks t ON t.id=j.task_id
  JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
    AND pa.enabled AND pa.assignment_role='orchestrator'
  JOIN agents a ON a.id=pa.agent_id AND a.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    AND rp.enabled AND rp.runtime_type='codex'
  -- 0063: the conversation's chat session for this agent, in this runtime's
  -- namespace. A model change inside the runtime resumes the same native session.
  LEFT JOIN agent_sessions s ON s.conversation_id=t.conversation_id AND s.role='chat'
    AND s.agent_id=a.id AND s.session_namespace=rp.runtime_type AND s.active
  WHERE j.id=p_job_id AND j.job_type IN ('codex_chat_turn','resume_codex')
    AND j.status='in_flight' AND j.leased_by=p_worker_id
    AND j.leased_until>clock_timestamp();
  IF v_context IS NULL THEN
    RAISE EXCEPTION 'Codex orchestration job % is not actively leased by worker %',p_job_id,p_worker_id
      USING ERRCODE='55000';
  END IF;
  RETURN v_context;
END; $$;

CREATE OR REPLACE FUNCTION executor_job_context(p_job_id bigint,p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_context jsonb; v_session agent_sessions%ROWTYPE; v_snapshot jsonb;
  v_task_snapshot jsonb; v_snapshot_model text; v_snapshot_runtime text;
BEGIN
  SELECT get_task_runtime_snapshot(t.id) INTO v_task_snapshot
  FROM runtime_jobs j JOIN tasks t ON t.id=j.task_id
  WHERE j.id=p_job_id AND j.job_type='start_implementation';
  IF v_task_snapshot->>'source'='catalog' THEN
    -- Bind the snapshot executor to the exact project agent assignment that
    -- owns this job's handoff. A catalog snapshot carries assignment_ids
    -- provenance; if no entry matches the handoff assignment the snapshot is
    -- inconsistent and the launch must fail closed rather than silently use
    -- another executor's model. The generic first-executor fallback applies
    -- only to fully legacy snapshots (no assignment_ids at all).
    SELECT e INTO v_snapshot
    FROM runtime_jobs j
    JOIN domain_events ev ON ev.id=j.source_event_id AND ev.event_type='implementation.requested'
    JOIN handoffs h ON h.id=(ev.payload->>'handoff_id')::uuid
    CROSS JOIN LATERAL (
      SELECT e FROM jsonb_array_elements(v_task_snapshot->'executors') e
      WHERE e->>'model_id' IS NOT NULL
        AND e->'assignment_ids' @> to_jsonb(h.executor_assignment_id::text)
      LIMIT 1
    ) t1(e)
    WHERE j.id=p_job_id AND j.job_type='start_implementation';
    IF v_snapshot IS NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_task_snapshot->'executors') e
        WHERE e->>'model_id' IS NOT NULL AND jsonb_typeof(e->'assignment_ids')='array'
          AND jsonb_array_length(e->'assignment_ids')>0
      ) THEN
        -- Fully legacy provenance-free snapshot: first entry fallback.
        SELECT e INTO v_snapshot
        FROM jsonb_array_elements(v_task_snapshot->'executors') e
        WHERE e->>'model_id' IS NOT NULL
        ORDER BY e->>'model_id' LIMIT 1;
      ELSE
        RAISE EXCEPTION 'task runtime snapshot does not match the executor assignment' USING ERRCODE='55000';
      END IF;
    END IF;
  ELSE
    v_snapshot := '{}'::jsonb;
  END IF;
  v_snapshot_model := v_snapshot->>'model_id';
  v_snapshot_runtime := v_snapshot->>'runtime_type';

  SELECT s.* INTO v_session
  FROM runtime_jobs j
  JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
  JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
  JOIN project_agent_assignments pa ON pa.id=h.executor_assignment_id
    AND pa.project_id=j.project_id AND pa.agent_id=h.to_agent_id
    AND pa.assignment_role='executor' AND pa.enabled
  JOIN task_executor_assignments tea ON tea.task_id=j.task_id
    AND tea.project_agent_assignment_id=pa.id AND tea.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND rp.runtime_type='opencode'
  JOIN tasks session_task ON session_task.id=j.task_id
  -- 0063: the conversation's executor session for this agent (ADR-0014).
  LEFT JOIN agent_sessions s ON s.conversation_id=session_task.conversation_id AND s.role='executor'
    AND s.agent_id=pa.agent_id AND s.session_namespace=rp.runtime_type AND s.active
  WHERE j.id=p_job_id AND j.job_type='start_implementation' AND j.status='in_flight'
    AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp();

  IF v_session.id IS NULL THEN
    -- A session in another runtime's namespace is closed, not taken over: the
    -- upsert below would otherwise move it into this namespace with its foreign
    -- native id still on it.
    UPDATE agent_sessions s SET active=false,status='closed',updated_at=clock_timestamp(),version=s.version+1,
      metadata=s.metadata||jsonb_build_object('closed_reason','runtime_changed')
    FROM runtime_jobs j
    JOIN tasks session_task ON session_task.id=j.task_id
    JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
    JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
    WHERE j.id=p_job_id AND j.job_type='start_implementation' AND j.status='in_flight'
      AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp()
      AND s.conversation_id=session_task.conversation_id AND s.role='executor'
      AND s.agent_id=h.to_agent_id AND s.active AND s.session_namespace<>'opencode';
    INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,status,active,metadata,
      conversation_id,role)
    SELECT j.project_id,pa.agent_id,pa.runtime_profile_id,'conversation_executor:' || session_task.conversation_id::text,
      'active',true,jsonb_build_object('task_id',j.task_id,'executor_assignment_id',pa.id),
      session_task.conversation_id,'executor'
    FROM runtime_jobs j
    JOIN tasks session_task ON session_task.id=j.task_id
    JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
    JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
    JOIN project_agent_assignments pa ON pa.id=h.executor_assignment_id
      AND pa.project_id=j.project_id AND pa.agent_id=h.to_agent_id
      AND pa.assignment_role='executor' AND pa.enabled
    JOIN task_executor_assignments tea ON tea.task_id=j.task_id
      AND tea.project_agent_assignment_id=pa.id AND tea.enabled
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND rp.runtime_type='opencode'
    WHERE j.id=p_job_id AND j.job_type='start_implementation' AND j.status='in_flight'
      AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp()
    ON CONFLICT(conversation_id,role,agent_id) WHERE active AND conversation_id IS NOT NULL DO UPDATE
      SET runtime_profile_id=EXCLUDED.runtime_profile_id,updated_at=clock_timestamp(),
          version=agent_sessions.version+1
    RETURNING * INTO v_session;
  END IF;

  SELECT jsonb_build_object(
    'job_id',j.id,'project_id',j.project_id,'task_id',j.task_id,
    'source_event_id',j.source_event_id,'correlation_id',j.payload->>'correlation_id',
    'workspace_path',p.workspace_path,'handoff_id',h.id,'revision_number',h.revision_number,
    'objective',h.objective,'instructions',h.instructions,'constraints',h.constraints,
    'acceptance_criteria',h.acceptance_criteria,'relevant_paths',h.relevant_paths,
    'agent_id',a.id,'agent_name',a.name,'runtime_profile_id',rp.id,
    'runtime_type',COALESCE(v_snapshot_runtime,rp.runtime_type),
    'provider_type',COALESCE(v_snapshot->>'provider_id',rp.provider_type),
    'model',COALESCE(v_snapshot_model,rp.model),
    'snapshot_entry_id',v_snapshot->>'entry_id',
    'snapshot_verification_id',v_snapshot->>'verification_id',
    'reasoning_effort',v_snapshot->>'reasoning_effort',
    'service_tier',v_snapshot->>'service_tier',
    'session_id',v_session.id,'native_session_id',v_session.native_session_id
  ) INTO v_context
  FROM runtime_jobs j
  JOIN projects p ON p.id=j.project_id
  JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
  JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
  JOIN project_agent_assignments pa ON pa.id=h.executor_assignment_id
    AND pa.project_id=j.project_id AND pa.agent_id=h.to_agent_id
    AND pa.assignment_role='executor' AND pa.enabled
  JOIN task_executor_assignments tea ON tea.task_id=j.task_id
    AND tea.project_agent_assignment_id=pa.id AND tea.enabled
  JOIN agents a ON a.id=pa.agent_id AND a.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND rp.runtime_type='opencode'
  WHERE j.id=p_job_id AND j.job_type='start_implementation' AND j.status='in_flight'
    AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp();
  IF v_context IS NULL THEN
    RAISE EXCEPTION 'executor job % is not actively leased or assigned',p_job_id USING ERRCODE='55000';
  END IF;
  RETURN v_context;
END; $$;

CREATE OR REPLACE FUNCTION orchestrator_turn_session(p_project_id uuid, p_task_id uuid, p_agent_id uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$
  -- The conversation's chat session for this agent (0063). It may not exist
  -- yet: a first turn is bound when it completes.
  SELECT s.id FROM agent_sessions s JOIN tasks t ON t.id=p_task_id
  WHERE s.project_id=p_project_id AND s.agent_id=p_agent_id
    AND s.conversation_id=t.conversation_id AND s.role='chat'
  ORDER BY s.active DESC, s.updated_at DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION create_followup_task(
  p_project_id uuid,
  p_source_task_id uuid,
  p_new_task_id uuid,
  p_actor_id text,
  p_title text,
  p_objective text,
  p_idempotency_key text,
  p_expected_version bigint,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_command commands%ROWTYPE;
  v_source tasks%ROWTYPE;
  v_created tasks%ROWTYPE;
  v_event domain_events%ROWTYPE;
  v_audit uuid;
  v_executor_count integer;
  v_session_count integer;
  v_snapshot jsonb;
  v_result jsonb;
BEGIN
  IF p_new_task_id IS NULL OR length(trim(p_actor_id))=0
     OR length(trim(p_title))<2 OR length(p_title)>120
     OR length(trim(p_objective))<2 OR length(p_objective)>12000 THEN
    RAISE EXCEPTION 'invalid follow-up task arguments' USING ERRCODE='22023';
  END IF;

  v_command:=submit_command(
    p_project_id,p_source_task_id,'CreateFollowupTask','user',p_actor_id,
    p_idempotency_key,
    jsonb_build_object('source_task_id',p_source_task_id,'title',p_title,'objective',p_objective),
    p_expected_version,p_correlation_id
  );
  IF v_command.status='completed' THEN RETURN v_command.result; END IF;

  SELECT * INTO v_source FROM tasks t
  WHERE t.id=p_source_task_id AND t.project_id=p_project_id FOR UPDATE;
  IF NOT FOUND OR v_source.version<>p_expected_version
     OR v_source.status NOT IN ('approved','completed','deployed') THEN
    RAISE EXCEPTION 'source task is not terminal at the expected version' USING ERRCODE='40001';
  END IF;
  -- 0063: a conversation is linear. The unique index refuses a second
  -- follow-up of one task in any case; this says so in words first.
  IF EXISTS (SELECT 1 FROM tasks f WHERE f.followup_of_task_id=p_source_task_id) THEN
    RAISE EXCEPTION 'this task already has a follow-up; continue from the latest task of the conversation'
      USING ERRCODE='55000', DETAIL='followup_exists';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM project_agent_assignments pa
    JOIN agents a ON a.id=pa.agent_id AND a.enabled
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled
    WHERE pa.id=v_source.orchestrator_assignment_id AND pa.project_id=p_project_id
      AND pa.enabled AND pa.assignment_role='orchestrator' AND rp.runtime_type='codex'
  ) THEN
    RAISE EXCEPTION 'source task orchestrator is unavailable' USING ERRCODE='55000';
  END IF;

  INSERT INTO tasks(
    id,project_id,title,objective,constraints,acceptance_criteria,status,
    active_agent_id,orchestrator_assignment_id,created_by,followup_of_task_id
  ) VALUES (
    p_new_task_id,p_project_id,trim(p_title),trim(p_objective),
    v_source.constraints,v_source.acceptance_criteria,'planning',
    v_source.active_agent_id,v_source.orchestrator_assignment_id,p_actor_id,p_source_task_id
  ) RETURNING * INTO v_created;

  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority,enabled)
  SELECT v_created.id,tea.project_agent_assignment_id,tea.priority,tea.enabled
  FROM task_executor_assignments tea
  JOIN project_agent_assignments pa ON pa.id=tea.project_agent_assignment_id
    AND pa.project_id=p_project_id AND pa.enabled AND pa.assignment_role='executor'
  WHERE tea.task_id=p_source_task_id AND tea.enabled;
  GET DIAGNOSTICS v_executor_count=ROW_COUNT;

  v_snapshot := capture_task_runtime_snapshot(
    v_created.id,p_project_id,
    COALESCE(
      (SELECT array_agg(tea.project_agent_assignment_id ORDER BY tea.priority,tea.created_at)
       FROM task_executor_assignments tea
       WHERE tea.task_id=v_created.id AND tea.enabled),
      ARRAY[]::uuid[]
    )
  );

  -- 0063: nothing is copied. The follow-up belongs to the source's conversation
  -- (the tasks trigger set it), and the conversation's sessions are found by
  -- conversation, role and agent. What the event and audit report as continued
  -- is the number of sessions the new task will resume.
  SELECT count(*) INTO v_session_count FROM agent_sessions s
  WHERE s.conversation_id=v_created.conversation_id AND s.active AND s.native_session_id IS NOT NULL;

  v_event:=append_event(
    'chat.user_message',p_project_id,v_created.id,NULL,'user',p_actor_id,
    v_command.id,p_correlation_id,'followup-message:'||p_idempotency_key,
    'task',v_created.id,v_created.version,
    jsonb_build_object(
      'content',v_created.objective,'title',v_created.title,
      'followup_of_task_id',p_source_task_id,
      'orchestrator_assignment_id',v_created.orchestrator_assignment_id,
      'executor_assignment_ids',COALESCE((
        SELECT jsonb_agg(tea.project_agent_assignment_id ORDER BY tea.priority,tea.created_at)
        FROM task_executor_assignments tea WHERE tea.task_id=v_created.id AND tea.enabled
      ),'[]'::jsonb),
      'continued_session_count',v_session_count,
      'snapshot_source',v_snapshot->>'source'
    )
  );
  v_audit:=write_audit_event(
    p_project_id,v_created.id,NULL,'operator',p_actor_id,'task.followup_created',
    'task',v_created.id::text,'allowed',NULL,
    jsonb_build_object('source_task_id',p_source_task_id,'source_status',v_source.status,
      'source_version',v_source.version,'executor_count',v_executor_count,
      'continued_session_count',v_session_count,'command_id',v_command.id,
      'snapshot_source',v_snapshot->>'source'),p_correlation_id
  );
  v_result:=jsonb_build_object(
    'status','planning','project_id',p_project_id,'task_id',v_created.id,
    'task_version',v_created.version,'followup_of_task_id',p_source_task_id,
    'event_id',v_event.id,'audit_event_id',v_audit,
    'executor_count',v_executor_count,'continued_session_count',v_session_count,
    'snapshot_source',v_snapshot->>'source'
  );
  UPDATE commands SET status='completed',result=v_result,completed_at=clock_timestamp()
    WHERE id=v_command.id;
  RETURN v_result;
END;
$$;


-- -------------------------------------------------------- attributes and grants
-- CREATE OR REPLACE resets both SECURITY DEFINER and the SET clause (0062).
ALTER FUNCTION create_followup_task(uuid,uuid,uuid,text,text,text,text,bigint,text) SECURITY DEFINER;
ALTER FUNCTION create_followup_task(uuid,uuid,uuid,text,text,text,text,bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION bind_codex_chat_session(bigint,text,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION codex_chat_job_context(bigint,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION executor_job_context(bigint,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION orchestrator_turn_session(uuid,uuid,uuid) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION backfill_conversations() SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION assign_task_conversation() SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION derive_session_namespace() SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION allocate_conversation_sequence() SET search_path=control_plane,public,extensions,pg_temp;

REVOKE EXECUTE ON FUNCTION backfill_conversations() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION assign_task_conversation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION derive_session_namespace() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION allocate_conversation_sequence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assign_task_conversation() TO infra_worker;
GRANT EXECUTE ON FUNCTION derive_session_namespace() TO infra_worker;
GRANT EXECUTE ON FUNCTION allocate_conversation_sequence() TO infra_worker;

-- The web tier reads conversations, and the new columns through its existing
-- table grants; it writes none of them.
GRANT SELECT ON conversations TO infra_web;
