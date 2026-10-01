BEGIN;

SET search_path TO control_plane, public;

CREATE TABLE runtime_jobs (
  id bigserial PRIMARY KEY,
  source_event_id uuid NOT NULL REFERENCES domain_events(id),
  job_type text NOT NULL CHECK (job_type IN ('start_implementation', 'resume_codex')),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  run_id uuid REFERENCES task_runs(id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_flight', 'completed', 'dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  leased_by text,
  leased_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (source_event_id, job_type),
  CHECK ((status = 'in_flight') = (leased_by IS NOT NULL AND leased_until IS NOT NULL)),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);

CREATE INDEX runtime_jobs_ready
  ON runtime_jobs(available_at, id)
  WHERE status IN ('pending', 'in_flight');

CREATE OR REPLACE FUNCTION retry_outbox_message(
  p_message_id bigint,
  p_dispatcher_id text,
  p_error text,
  p_delay interval DEFAULT interval '10 seconds',
  p_max_attempts integer DEFAULT 10
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  UPDATE outbox_messages
  SET status = CASE WHEN attempt_count >= p_max_attempts THEN 'dead_letter' ELSE 'pending' END,
      available_at = CASE
        WHEN attempt_count >= p_max_attempts THEN available_at
        ELSE clock_timestamp() + p_delay
      END,
      leased_by = NULL,
      leased_until = NULL,
      last_error = left(p_error, 4000)
  WHERE id = p_message_id
    AND status = 'in_flight'
    AND leased_by = p_dispatcher_id
  RETURNING status INTO v_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outbox message % is not leased by dispatcher %', p_message_id, p_dispatcher_id
      USING ERRCODE = '55000';
  END IF;
  RETURN v_status;
END;
$$;

CREATE OR REPLACE FUNCTION route_outbox_message(
  p_message_id bigint,
  p_dispatcher_id text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_message outbox_messages%ROWTYPE;
  v_event domain_events%ROWTYPE;
  v_job runtime_jobs%ROWTYPE;
  v_job_type text;
BEGIN
  SELECT * INTO v_message
  FROM outbox_messages o
  WHERE o.id = p_message_id
  FOR UPDATE;

  IF NOT FOUND OR v_message.status <> 'in_flight'
     OR v_message.leased_by <> p_dispatcher_id
     OR v_message.leased_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'outbox message % is not actively leased by dispatcher %', p_message_id, p_dispatcher_id
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_event FROM domain_events e WHERE e.id = v_message.event_id;
  v_job_type := CASE v_event.event_type
    WHEN 'implementation.requested' THEN 'start_implementation'
    WHEN 'implementation.completed' THEN 'resume_codex'
    ELSE NULL
  END;

  IF v_job_type IS NOT NULL THEN
    INSERT INTO runtime_jobs(
      source_event_id, job_type, project_id, task_id, run_id, payload
    ) VALUES (
      v_event.id, v_job_type, v_event.project_id, v_event.task_id, v_event.run_id,
      jsonb_build_object(
        'event_id', v_event.id,
        'event_type', v_event.event_type,
        'correlation_id', v_event.correlation_id,
        'event_payload', v_event.payload
      )
    )
    ON CONFLICT (source_event_id, job_type) DO UPDATE
      SET source_event_id = EXCLUDED.source_event_id
    RETURNING * INTO v_job;
  END IF;

  PERFORM acknowledge_outbox(p_message_id, p_dispatcher_id);

  RETURN jsonb_build_object(
    'message_id', p_message_id,
    'event_id', v_event.id,
    'event_type', v_event.event_type,
    'job_id', v_job.id,
    'job_type', v_job.job_type,
    'routed', v_job_type IS NOT NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION claim_runtime_jobs(
  p_supervisor_id text,
  p_limit integer DEFAULT 10,
  p_lease interval DEFAULT interval '60 seconds'
)
RETURNS SETOF runtime_jobs
LANGUAGE sql
AS $$
  WITH candidates AS (
    SELECT j.id
    FROM runtime_jobs j
    WHERE j.available_at <= clock_timestamp()
      AND (
        j.status = 'pending'
        OR (j.status = 'in_flight' AND j.leased_until <= clock_timestamp())
      )
    ORDER BY j.available_at, j.id
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(p_limit, 0)
  )
  UPDATE runtime_jobs j
  SET status = 'in_flight',
      attempt_count = j.attempt_count + 1,
      leased_by = p_supervisor_id,
      leased_until = clock_timestamp() + p_lease,
      last_error = NULL
  FROM candidates c
  WHERE j.id = c.id
  RETURNING j.*;
$$;

CREATE OR REPLACE FUNCTION claim_runtime_job_for_event(
  p_source_event_id uuid,
  p_job_type text,
  p_supervisor_id text,
  p_lease interval DEFAULT interval '60 seconds'
)
RETURNS runtime_jobs
LANGUAGE plpgsql
AS $$
DECLARE
  v_job runtime_jobs%ROWTYPE;
BEGIN
  UPDATE runtime_jobs
  SET status = 'in_flight',
      attempt_count = attempt_count + 1,
      leased_by = p_supervisor_id,
      leased_until = clock_timestamp() + p_lease,
      last_error = NULL
  WHERE source_event_id = p_source_event_id
    AND job_type = p_job_type
    AND available_at <= clock_timestamp()
    AND (status = 'pending' OR (status = 'in_flight' AND leased_until <= clock_timestamp()))
  RETURNING * INTO v_job;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime job for event % and type % is unavailable', p_source_event_id, p_job_type
      USING ERRCODE = '55P03';
  END IF;
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION heartbeat_runtime_job(
  p_job_id bigint,
  p_supervisor_id text,
  p_lease interval DEFAULT interval '60 seconds'
)
RETURNS timestamptz
LANGUAGE plpgsql
AS $$
DECLARE
  v_until timestamptz;
BEGIN
  UPDATE runtime_jobs
  SET leased_until = clock_timestamp() + p_lease
  WHERE id = p_job_id
    AND status = 'in_flight'
    AND leased_by = p_supervisor_id
    AND leased_until > clock_timestamp()
  RETURNING leased_until INTO v_until;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime job % is not actively leased by supervisor %', p_job_id, p_supervisor_id
      USING ERRCODE = '55000';
  END IF;
  RETURN v_until;
END;
$$;

CREATE OR REPLACE FUNCTION acknowledge_runtime_job(
  p_job_id bigint,
  p_supervisor_id text,
  p_result jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE runtime_jobs
  SET status = 'completed',
      result = p_result,
      leased_by = NULL,
      leased_until = NULL,
      last_error = NULL,
      completed_at = clock_timestamp()
  WHERE id = p_job_id
    AND status = 'in_flight'
    AND leased_by = p_supervisor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime job % is not leased by supervisor %', p_job_id, p_supervisor_id
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION retry_runtime_job(
  p_job_id bigint,
  p_supervisor_id text,
  p_error text,
  p_delay interval DEFAULT interval '10 seconds',
  p_max_attempts integer DEFAULT 5
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  UPDATE runtime_jobs
  SET status = CASE WHEN attempt_count >= p_max_attempts THEN 'dead_letter' ELSE 'pending' END,
      available_at = CASE
        WHEN attempt_count >= p_max_attempts THEN available_at
        ELSE clock_timestamp() + p_delay
      END,
      leased_by = NULL,
      leased_until = NULL,
      last_error = left(p_error, 4000)
  WHERE id = p_job_id
    AND status = 'in_flight'
    AND leased_by = p_supervisor_id
  RETURNING status INTO v_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime job % is not leased by supervisor %', p_job_id, p_supervisor_id
      USING ERRCODE = '55000';
  END IF;
  RETURN v_status;
END;
$$;

CREATE OR REPLACE FUNCTION start_implementation_job(
  p_job_id bigint,
  p_session_id uuid,
  p_supervisor_id text,
  p_lock_ttl interval DEFAULT interval '5 minutes'
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_job runtime_jobs%ROWTYPE;
  v_event domain_events%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_handoff handoffs%ROWTYPE;
  v_run task_runs%ROWTYPE;
  v_started_event domain_events%ROWTYPE;
  v_token bigint;
  v_result jsonb;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type <> 'start_implementation'
     OR v_job.status <> 'in_flight' OR v_job.leased_by <> p_supervisor_id
     OR v_job.leased_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'start job % is not actively leased by supervisor %', p_job_id, p_supervisor_id
      USING ERRCODE = '55000';
  END IF;
  IF v_job.result IS NOT NULL THEN
    RETURN v_job.result;
  END IF;

  SELECT * INTO v_event FROM domain_events e
  WHERE e.id = v_job.source_event_id AND e.event_type = 'implementation.requested';
  SELECT * INTO v_task FROM tasks t WHERE t.id = v_event.task_id FOR UPDATE;
  IF v_task.status <> 'implementation_requested' THEN
    RAISE EXCEPTION 'task % cannot start implementation from state %', v_task.id, v_task.status
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_handoff FROM handoffs h
  WHERE h.id = (v_event.payload->>'handoff_id')::uuid FOR UPDATE;
  IF v_handoff.to_agent_id <> v_task.active_agent_id THEN
    RAISE EXCEPTION 'handoff assignee does not match active task agent'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = p_session_id
      AND s.project_id = v_event.project_id
      AND s.agent_id = v_handoff.to_agent_id
      AND s.active
  ) THEN
    RAISE EXCEPTION 'worker session % is not active for the handoff agent', p_session_id
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO task_runs(task_id, session_id, agent_id, phase, status, write_capable)
  VALUES (v_task.id, p_session_id, v_handoff.to_agent_id, 'implementation', 'starting', true)
  RETURNING * INTO v_run;
  v_token := acquire_workspace_lock(v_event.project_id, v_run.id, 'implementation', p_lock_ttl);
  UPDATE task_runs
  SET status = 'running', started_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
  WHERE id = v_run.id RETURNING * INTO v_run;
  UPDATE handoffs SET target_run_id = v_run.id WHERE id = v_handoff.id;
  UPDATE tasks
  SET status = 'implementing', version = version + 1, updated_at = clock_timestamp()
  WHERE id = v_task.id RETURNING * INTO v_task;

  v_started_event := append_event(
    'implementation.started', v_event.project_id, v_task.id, v_run.id,
    'system', p_supervisor_id, v_event.causation_id, v_event.correlation_id,
    'start:' || v_event.id, 'task', v_task.id, v_task.version,
    jsonb_build_object('handoff_id', v_handoff.id, 'fencing_token', v_token)
  );

  v_result := jsonb_build_object(
    'status', 'running', 'run_id', v_run.id, 'task_id', v_task.id,
    'task_version', v_task.version, 'handoff_id', v_handoff.id,
    'fencing_token', v_token, 'started_event_id', v_started_event.id
  );
  UPDATE runtime_jobs SET run_id = v_run.id, result = v_result WHERE id = p_job_id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION reconcile_expired_workspace_locks(
  p_reconciler_id text,
  p_limit integer DEFAULT 20
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_lock workspace_locks%ROWTYPE;
  v_run task_runs%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_project projects%ROWTYPE;
BEGIN
  FOR v_lock IN
    SELECT l.* FROM workspace_locks l
    WHERE l.status = 'held' AND l.lease_expires_at <= clock_timestamp()
    ORDER BY l.lease_expires_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(p_limit, 0)
  LOOP
    SELECT * INTO v_run FROM task_runs r WHERE r.id = v_lock.owner_run_id FOR UPDATE;
    SELECT * INTO v_task FROM tasks t WHERE t.id = v_run.task_id FOR UPDATE;
    SELECT * INTO v_project FROM projects p WHERE p.id = v_lock.project_id FOR UPDATE;

    UPDATE task_runs
    SET status = 'lost', finished_at = clock_timestamp(),
        failure_code = 'workspace_lease_expired', version = version + 1,
        updated_at = clock_timestamp()
    WHERE id = v_run.id
    RETURNING * INTO v_run;
    UPDATE tasks
    SET status = 'needs_attention', version = version + 1, updated_at = clock_timestamp()
    WHERE id = v_task.id
    RETURNING * INTO v_task;
    UPDATE projects
    SET status = 'needs_attention', version = version + 1, updated_at = clock_timestamp()
    WHERE id = v_project.id
    RETURNING * INTO v_project;
    UPDATE workspace_locks
    SET owner_run_id = NULL, lease_expires_at = NULL,
        status = 'reconciliation_required', reason = 'lease_expired', version = version + 1
    WHERE project_id = v_lock.project_id;
    UPDATE runtime_jobs
    SET status = 'dead_letter', leased_by = NULL, leased_until = NULL,
        last_error = 'workspace lease expired; external side effect requires reconciliation'
    WHERE run_id = v_run.id AND status = 'in_flight';

    PERFORM append_event(
      'run.lost', v_project.id, v_task.id, v_run.id,
      'system', p_reconciler_id, NULL, v_task.id::text,
      'run-lost:' || v_run.id || ':' || v_run.version,
      'run', v_run.id, v_run.version,
      jsonb_build_object('failure_code', 'workspace_lease_expired', 'fencing_token', v_lock.fencing_token)
    );
    PERFORM append_event(
      'task.needs_attention', v_project.id, v_task.id, v_run.id,
      'system', p_reconciler_id, NULL, v_task.id::text,
      'task-needs-attention:' || v_task.id || ':' || v_task.version,
      'task', v_task.id, v_task.version,
      jsonb_build_object('reason', 'workspace_lease_expired', 'run_id', v_run.id)
    );
    PERFORM append_event(
      'workspace.reconciliation_required', v_project.id, v_task.id, v_run.id,
      'system', p_reconciler_id, NULL, v_task.id::text,
      'workspace-reconcile:' || v_project.id || ':' || v_project.version,
      'project', v_project.id, v_project.version,
      jsonb_build_object('expired_run_id', v_run.id, 'stale_fencing_token', v_lock.fencing_token)
    );

    RETURN NEXT jsonb_build_object(
      'project_id', v_project.id, 'task_id', v_task.id, 'run_id', v_run.id,
      'stale_fencing_token', v_lock.fencing_token, 'status', 'reconciliation_required'
    );
  END LOOP;
END;
$$;

COMMIT;
