BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS control_plane;

SET search_path TO control_plane, public;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  workspace_path text NOT NULL UNIQUE,
  repository_url text,
  default_branch text NOT NULL DEFAULT 'main',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'needs_attention', 'archived')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz
);

CREATE TABLE runtime_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_type text NOT NULL
    CHECK (runtime_type IN ('codex', 'opencode', 'antigravity')),
  adapter_version text NOT NULL,
  runtime_version text NOT NULL,
  provider_type text NOT NULL,
  model text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  environment_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at timestamptz,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('architect', 'reviewer', 'implementer')),
  runtime_profile_id uuid NOT NULL REFERENCES runtime_profiles(id),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  runtime_profile_id uuid NOT NULL REFERENCES runtime_profiles(id),
  native_session_id text,
  purpose text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'idle', 'unavailable', 'closed')),
  active boolean NOT NULL DEFAULT true,
  last_resumed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX agent_sessions_one_active_purpose
  ON agent_sessions(project_id, agent_id, purpose)
  WHERE active;

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL,
  objective text NOT NULL,
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft', 'planning', 'ready', 'implementation_requested',
      'implementing', 'awaiting_review', 'reviewing', 'changes_requested',
      'revising', 'approved', 'publishing', 'deployed', 'completed',
      'failed', 'cancelled', 'needs_attention'
    )),
  active_agent_id uuid REFERENCES agents(id),
  workflow_version bigint NOT NULL DEFAULT 1 CHECK (workflow_version > 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE task_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id),
  session_id uuid REFERENCES agent_sessions(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  phase text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'starting', 'running', 'waiting_for_input', 'blocked',
      'interrupted', 'completed', 'failed', 'cancelled', 'lost'
    )),
  write_capable boolean NOT NULL DEFAULT false,
  native_run_id text,
  process_ref text,
  workspace_fencing_token bigint CHECK (workspace_fencing_token > 0),
  started_at timestamptz,
  finished_at timestamptz,
  exit_code integer,
  failure_code text,
  usage_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT write_capable OR status IN ('queued', 'starting') OR workspace_fencing_token IS NOT NULL),
  CHECK (status NOT IN ('completed', 'failed', 'cancelled', 'lost') OR finished_at IS NOT NULL)
);

CREATE INDEX task_runs_active_by_task
  ON task_runs(task_id, status)
  WHERE status IN ('queued', 'starting', 'running', 'waiting_for_input', 'blocked', 'interrupted');

CREATE TABLE handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id),
  from_agent_id uuid NOT NULL REFERENCES agents(id),
  to_agent_id uuid NOT NULL REFERENCES agents(id),
  source_run_id uuid REFERENCES task_runs(id),
  target_run_id uuid REFERENCES task_runs(id),
  revision_number integer NOT NULL DEFAULT 1 CHECK (revision_number > 0),
  objective text NOT NULL,
  instructions jsonb NOT NULL DEFAULT '[]'::jsonb,
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  relevant_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  workspace_ref text NOT NULL,
  result_summary jsonb,
  checks_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (task_id, revision_number)
);

CREATE TABLE commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid REFERENCES tasks(id),
  command_type text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  expected_version bigint,
  status text NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'completed', 'rejected', 'failed')),
  result jsonb,
  error jsonb,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (project_id, idempotency_key)
);

CREATE TABLE domain_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid REFERENCES tasks(id),
  run_id uuid REFERENCES task_runs(id),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id text NOT NULL,
  causation_id uuid REFERENCES commands(id),
  correlation_id text NOT NULL,
  idempotency_key text,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  UNIQUE (aggregate_type, aggregate_id, aggregate_version),
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX domain_events_task_order
  ON domain_events(task_id, aggregate_version)
  WHERE task_id IS NOT NULL;

CREATE TABLE outbox_messages (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE REFERENCES domain_events(id),
  destination text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_flight', 'published', 'dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  leased_by text,
  leased_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  CHECK ((status = 'in_flight') = (leased_by IS NOT NULL AND leased_until IS NOT NULL)),
  CHECK (status <> 'published' OR published_at IS NOT NULL)
);

CREATE INDEX outbox_dispatch_ready
  ON outbox_messages(available_at, id)
  WHERE status IN ('pending', 'in_flight');

-- The row is never deleted: retaining it is what makes fencing tokens monotonic.
CREATE TABLE workspace_locks (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  owner_run_id uuid UNIQUE REFERENCES task_runs(id),
  mode text NOT NULL DEFAULT 'write' CHECK (mode = 'write'),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  reason text,
  status text NOT NULL DEFAULT 'released'
    CHECK (status IN ('held', 'released', 'expired', 'reconciliation_required')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((status = 'held') = (owner_run_id IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER domain_events_append_only
BEFORE UPDATE OR DELETE ON domain_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE OR REPLACE FUNCTION submit_command(
  p_project_id uuid,
  p_task_id uuid,
  p_command_type text,
  p_actor_type text,
  p_actor_id text,
  p_idempotency_key text,
  p_payload jsonb,
  p_expected_version bigint,
  p_correlation_id text
)
RETURNS commands
LANGUAGE plpgsql
AS $$
DECLARE
  v_command commands%ROWTYPE;
  v_hash text := encode(digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
BEGIN
  INSERT INTO commands (
    project_id, task_id, command_type, actor_type, actor_id,
    idempotency_key, payload, payload_hash, expected_version, correlation_id
  ) VALUES (
    p_project_id, p_task_id, p_command_type, p_actor_type, p_actor_id,
    p_idempotency_key, p_payload, v_hash, p_expected_version, p_correlation_id
  )
  ON CONFLICT (project_id, idempotency_key) DO NOTHING
  RETURNING * INTO v_command;

  IF v_command.id IS NULL THEN
    SELECT * INTO v_command
    FROM commands c
    WHERE c.project_id = p_project_id
      AND c.idempotency_key = p_idempotency_key
    FOR UPDATE;

    IF v_command.command_type <> p_command_type
       OR v_command.payload_hash <> v_hash
       OR v_command.expected_version IS DISTINCT FROM p_expected_version THEN
      RAISE EXCEPTION 'idempotency key % was already used with a different command payload', p_idempotency_key
        USING ERRCODE = '23505';
    END IF;
  END IF;

  RETURN v_command;
END;
$$;

CREATE OR REPLACE FUNCTION append_event(
  p_event_type text,
  p_project_id uuid,
  p_task_id uuid,
  p_run_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_causation_id uuid,
  p_correlation_id text,
  p_idempotency_key text,
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_aggregate_version bigint,
  p_payload jsonb,
  p_destination text DEFAULT 'domain-events'
)
RETURNS domain_events
LANGUAGE plpgsql
AS $$
DECLARE
  v_event domain_events%ROWTYPE;
BEGIN
  INSERT INTO domain_events (
    event_type, project_id, task_id, run_id, actor_type, actor_id,
    causation_id, correlation_id, idempotency_key, aggregate_type,
    aggregate_id, aggregate_version, payload
  ) VALUES (
    p_event_type, p_project_id, p_task_id, p_run_id, p_actor_type, p_actor_id,
    p_causation_id, p_correlation_id, p_idempotency_key, p_aggregate_type,
    p_aggregate_id, p_aggregate_version, p_payload
  )
  RETURNING * INTO v_event;

  INSERT INTO outbox_messages(event_id, destination)
  VALUES (v_event.id, p_destination);

  RETURN v_event;
END;
$$;

CREATE OR REPLACE FUNCTION acquire_workspace_lock(
  p_project_id uuid,
  p_run_id uuid,
  p_reason text,
  p_ttl interval DEFAULT interval '60 seconds'
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_lock workspace_locks%ROWTYPE;
  v_run_project_id uuid;
BEGIN
  IF p_ttl <= interval '0 seconds' THEN
    RAISE EXCEPTION 'workspace lock TTL must be positive' USING ERRCODE = '22023';
  END IF;

  SELECT t.project_id INTO v_run_project_id
  FROM task_runs r
  JOIN tasks t ON t.id = r.task_id
  WHERE r.id = p_run_id;

  IF v_run_project_id IS NULL OR v_run_project_id <> p_project_id THEN
    RAISE EXCEPTION 'run % does not belong to project %', p_run_id, p_project_id
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO workspace_locks(project_id)
  VALUES (p_project_id)
  ON CONFLICT (project_id) DO NOTHING;

  SELECT * INTO v_lock
  FROM workspace_locks l
  WHERE l.project_id = p_project_id
  FOR UPDATE;

  IF v_lock.status = 'held'
     AND v_lock.lease_expires_at > clock_timestamp()
     AND v_lock.owner_run_id <> p_run_id THEN
    RAISE EXCEPTION 'workspace for project % is held by run %', p_project_id, v_lock.owner_run_id
      USING ERRCODE = '55P03';
  END IF;

  IF v_lock.status = 'held'
     AND v_lock.lease_expires_at > clock_timestamp()
     AND v_lock.owner_run_id = p_run_id THEN
    UPDATE workspace_locks
    SET heartbeat_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + p_ttl,
        reason = p_reason,
        version = version + 1
    WHERE project_id = p_project_id
    RETURNING fencing_token INTO v_lock.fencing_token;
  ELSE
    UPDATE workspace_locks
    SET owner_run_id = p_run_id,
        fencing_token = fencing_token + 1,
        lease_expires_at = clock_timestamp() + p_ttl,
        heartbeat_at = clock_timestamp(),
        reason = p_reason,
        status = 'held',
        version = version + 1
    WHERE project_id = p_project_id
    RETURNING fencing_token INTO v_lock.fencing_token;
  END IF;

  UPDATE task_runs
  SET workspace_fencing_token = v_lock.fencing_token,
      updated_at = clock_timestamp(),
      version = version + 1
  WHERE id = p_run_id;

  RETURN v_lock.fencing_token;
END;
$$;

CREATE OR REPLACE FUNCTION assert_workspace_fence(
  p_project_id uuid,
  p_run_id uuid,
  p_fencing_token bigint
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM workspace_locks l
    WHERE l.project_id = p_project_id
      AND l.status = 'held'
      AND l.owner_run_id = p_run_id
      AND l.fencing_token = p_fencing_token
      AND l.lease_expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'stale or invalid workspace fencing token for run %', p_run_id
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION heartbeat_workspace_lock(
  p_project_id uuid,
  p_run_id uuid,
  p_fencing_token bigint,
  p_ttl interval DEFAULT interval '60 seconds'
)
RETURNS timestamptz
LANGUAGE plpgsql
AS $$
DECLARE
  v_expires_at timestamptz;
BEGIN
  PERFORM assert_workspace_fence(p_project_id, p_run_id, p_fencing_token);

  UPDATE workspace_locks
  SET heartbeat_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + p_ttl,
      version = version + 1
  WHERE project_id = p_project_id
  RETURNING lease_expires_at INTO v_expires_at;

  RETURN v_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION release_workspace_lock(
  p_project_id uuid,
  p_run_id uuid,
  p_fencing_token bigint
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_workspace_fence(p_project_id, p_run_id, p_fencing_token);

  UPDATE workspace_locks
  SET owner_run_id = NULL,
      lease_expires_at = NULL,
      heartbeat_at = clock_timestamp(),
      reason = NULL,
      status = 'released',
      version = version + 1
  WHERE project_id = p_project_id;
END;
$$;

CREATE OR REPLACE FUNCTION claim_outbox(
  p_worker_id text,
  p_limit integer DEFAULT 10,
  p_lease interval DEFAULT interval '30 seconds'
)
RETURNS SETOF outbox_messages
LANGUAGE sql
AS $$
  WITH candidates AS (
    SELECT o.id
    FROM outbox_messages o
    WHERE o.available_at <= clock_timestamp()
      AND (
        o.status = 'pending'
        OR (o.status = 'in_flight' AND o.leased_until <= clock_timestamp())
      )
    ORDER BY o.available_at, o.id
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(p_limit, 0)
  )
  UPDATE outbox_messages o
  SET status = 'in_flight',
      attempt_count = o.attempt_count + 1,
      leased_by = p_worker_id,
      leased_until = clock_timestamp() + p_lease,
      last_error = NULL
  FROM candidates c
  WHERE o.id = c.id
  RETURNING o.*;
$$;

CREATE OR REPLACE FUNCTION acknowledge_outbox(
  p_message_id bigint,
  p_worker_id text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE outbox_messages
  SET status = 'published',
      leased_by = NULL,
      leased_until = NULL,
      published_at = clock_timestamp(),
      last_error = NULL
  WHERE id = p_message_id
    AND status = 'in_flight'
    AND leased_by = p_worker_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outbox message % is not leased by worker %', p_message_id, p_worker_id
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION reject_terminal_run_regression()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed', 'cancelled', 'lost')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'terminal run % cannot transition from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_runs_terminal_status
BEFORE UPDATE OF status ON task_runs
FOR EACH ROW EXECUTE FUNCTION reject_terminal_run_regression();

COMMIT;
