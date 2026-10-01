BEGIN;

SET search_path TO control_plane, public, extensions;

-- Safe project deletion and workspace deprovisioning (7.1E).
--
-- Project deletion is an owner-only destructive workflow, not a direct row
-- delete and not an unscoped filesystem operation. The project row is kept as
-- an audit tombstone: task/run/event/audit history stays attributable.
--
-- Lifecycle: an owner request with a version fence moves the project to
-- `deleting`, hides it from normal navigation, blocks new tasks/messages/runs
-- and cancels queued outbox/runtime work. Physical cleanup starts only after
-- the grace period (deletion_not_before). `Undo delete` is allowed only before
-- cleanup is claimed. `Delete now` requires a second explicit approval and
-- bypasses only the grace timer. A dedicated deprovision worker claims cleanup
-- with an idempotent lease, stops active work worker-first, verifies
-- filesystem absence, then marks the tombstone `deleted`. Partial failures
-- leave the project in `deletion_failed` and are retryable.

ALTER TABLE projects
  DROP CONSTRAINT projects_status_check,
  ADD CONSTRAINT projects_status_check
    CHECK (status IN ('active','needs_attention','archived','deleting','deletion_failed','deleted'));

ALTER TABLE projects
  ADD COLUMN deletion_requested_at timestamptz,
  ADD COLUMN deletion_not_before timestamptz,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deprovisioned_at timestamptz,
  ADD COLUMN deletion_failure_code text NOT NULL DEFAULT '' CHECK (length(deletion_failure_code) <= 80),
  ADD COLUMN deletion_failure_message text NOT NULL DEFAULT '' CHECK (length(deletion_failure_message) <= 500),
  ADD COLUMN deletion_attempt_count integer NOT NULL DEFAULT 0 CHECK (deletion_attempt_count >= 0),
  ADD COLUMN cleanup_leased_by text,
  ADD COLUMN cleanup_leased_until timestamptz,
  ADD CONSTRAINT projects_deletion_failure_bounded CHECK (
    deletion_failure_message = left(deletion_failure_message, 500)
  ),
  ADD CONSTRAINT projects_cleanup_lease_pair CHECK (
    cleanup_leased_by IS NULL = (cleanup_leased_until IS NULL)
  ),
  ADD CONSTRAINT projects_deleted_deprovisioned CHECK (
    status <> 'deleted' OR (deleted_at IS NOT NULL AND deprovisioned_at IS NOT NULL)
  ),
  ADD CONSTRAINT projects_deleting_timestamps CHECK (
    status NOT IN ('deleting','deletion_failed','deleted')
    OR deletion_requested_at IS NOT NULL
  ),
  ADD CONSTRAINT projects_grace_not_before CHECK (
    deletion_not_before IS NULL OR deletion_requested_at IS NULL
    OR deletion_not_before >= deletion_requested_at
  );

CREATE INDEX projects_deletion_work
  ON projects(status, cleanup_leased_until, deletion_not_before)
  WHERE status IN ('deleting','deletion_failed');

CREATE INDEX projects_deletion_operator
  ON projects(owner_id, status)
  WHERE status IN ('deleting','deletion_failed','deleted');

-- Launch admission reservations (launch fence).
--
-- A runtime launch is admitted in three atomic steps so deprovisioning can
-- never race a new writer:
--   1. reserve_runtime_launch locks the project row FOR UPDATE (serializing
--      with request_project_deletion), validates the run/job/project/lease
--      binding and inserts a `reserved` reservation with a random token
--      BEFORE the process is spawned;
--   2. bind_runtime_launch_pid attaches the spawned PID to the reservation
--      via a CAS on (token, supervisor_id, state='reserved', unexpired);
--   3. complete_runtime_launch atomically replaces the reservation with the
--      real task_runs.process_ref under a second lifecycle check and marks
--      the reservation `completed`.
-- Deprovision treats any `reserved` reservation as an active writer: live
-- ones fail closed; expired PID-bound reservations are terminated/reaped and
-- token-cancelled before the filesystem phase. Expired unbound reservations
-- require operator reconciliation because process absence cannot be proved.
-- A late complete after cancel/expiry is impossible (CAS requires
-- state='reserved' and an unexpired TTL).
CREATE TABLE runtime_launch_reservations (
  run_id uuid PRIMARY KEY REFERENCES task_runs(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  job_id bigint NOT NULL REFERENCES runtime_jobs(id),
  supervisor_id text NOT NULL CHECK (length(supervisor_id) BETWEEN 2 AND 120),
  token text NOT NULL CHECK (token ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved','completed','cancelled')),
  process_ref text CHECK (process_ref IS NULL OR length(process_ref) <= 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (state <> 'completed' OR process_ref IS NOT NULL)
);

CREATE INDEX runtime_launch_reservations_project
  ON runtime_launch_reservations(project_id, state, expires_at);

-- Reserve launch admission BEFORE spawn. Locks the project row so the
-- lifecycle check and the reservation insert are serialized with
-- request_project_deletion; validates the run/job/project/lease binding.
CREATE OR REPLACE FUNCTION reserve_runtime_launch(
  p_run_id uuid, p_project_id uuid, p_job_id bigint, p_supervisor_id text,
  p_ttl interval DEFAULT interval '90 seconds'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_project projects%ROWTYPE; v_token text;
  v_reservation runtime_launch_reservations%ROWTYPE;
  v_lease_valid boolean;
BEGIN
  IF p_ttl <= interval '0 seconds' OR p_ttl > interval '10 minutes' THEN
    RAISE EXCEPTION 'invalid launch reservation lifetime' USING ERRCODE='22023';
  END IF;
  -- Serialize with deletion: both this function and request_project_deletion
  -- lock the project row, so a concurrent deletion cannot change the status
  -- between the check and the reservation insert.
  SELECT * INTO v_project FROM projects WHERE id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project is unavailable' USING ERRCODE='55000'; END IF;
  IF v_project.status IN ('deleting','deletion_failed','deleted') THEN
    RAISE EXCEPTION 'project is being deleted' USING ERRCODE='55000';
  ELSIF v_project.status NOT IN ('active','needs_attention') THEN
    RAISE EXCEPTION 'project is not operable' USING ERRCODE='55000';
  END IF;
  -- Validate the run/job/project/lease binding: the run must belong to a task
  -- of this project, the job must be leased to this supervisor and still
  -- in flight.
  SELECT (
    r.id IS NOT NULL
    AND j.id IS NOT NULL
    AND j.status='in_flight'
    AND j.leased_by=p_supervisor_id
    AND j.leased_until>clock_timestamp()
  ) INTO v_lease_valid
  FROM task_runs r
  JOIN tasks t ON t.id=r.task_id
  LEFT JOIN runtime_jobs j ON j.id=p_job_id
    AND j.project_id=p_project_id
    AND j.task_id=t.id
    AND j.run_id=p_run_id
    AND j.job_type='start_implementation'
  WHERE r.id=p_run_id AND t.project_id=p_project_id AND r.status='running';
  IF v_lease_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'runtime launch binding is invalid' USING ERRCODE='55000';
  END IF;
  v_token := encode(gen_random_bytes(32),'hex');
  INSERT INTO runtime_launch_reservations(run_id,project_id,job_id,supervisor_id,token,expires_at)
  VALUES(p_run_id,p_project_id,p_job_id,p_supervisor_id,v_token,clock_timestamp()+p_ttl)
  ON CONFLICT (run_id) DO UPDATE SET
    project_id=EXCLUDED.project_id, job_id=EXCLUDED.job_id,
    supervisor_id=EXCLUDED.supervisor_id, token=EXCLUDED.token,
    state='reserved', process_ref=NULL,
    created_at=clock_timestamp(), updated_at=clock_timestamp(),
    expires_at=EXCLUDED.expires_at
  WHERE runtime_launch_reservations.state='cancelled'
  RETURNING * INTO v_reservation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime launch reservation already exists' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object(
    'run_id',v_reservation.run_id,'status','reserved',
    'token',v_reservation.token,'expires_at',v_reservation.expires_at
  );
END; $$;

-- Attach the spawned PID to the reservation right after spawn. CAS on
-- (token, supervisor, state='reserved', unexpired): an expired or cancelled
-- reservation cannot accept a PID, so the supervisor must terminate the
-- child instead.
CREATE OR REPLACE FUNCTION bind_runtime_launch_pid(
  p_run_id uuid, p_token text, p_supervisor_id text, p_process_ref text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_reservation runtime_launch_reservations%ROWTYPE;
BEGIN
  IF p_process_ref IS NULL OR length(p_process_ref)=0 THEN
    RAISE EXCEPTION 'process identity is required' USING ERRCODE='22023';
  END IF;
  UPDATE runtime_launch_reservations SET
    process_ref=p_process_ref, updated_at=clock_timestamp()
  WHERE run_id=p_run_id AND token=p_token AND supervisor_id=p_supervisor_id
    AND state='reserved' AND expires_at>clock_timestamp()
  RETURNING * INTO v_reservation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'launch reservation is not active' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object(
    'run_id',v_reservation.run_id,'status','pid_bound',
    'process_ref',v_reservation.process_ref
  );
END; $$;

-- Complete launch registration: second lifecycle check (project row locked),
-- reservation CAS (token/owner/state/TTL) and task_runs.process_ref write in
-- one transaction. Late completes after cancel/expiry are impossible.
CREATE OR REPLACE FUNCTION complete_runtime_launch(
  p_run_id uuid, p_project_id uuid, p_job_id bigint, p_supervisor_id text,
  p_token text, p_process_ref text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_project projects%ROWTYPE; v_updated integer;
  v_reservation runtime_launch_reservations%ROWTYPE;
BEGIN
  IF p_process_ref IS NULL OR length(p_process_ref)=0 THEN
    RAISE EXCEPTION 'process identity is required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_project FROM projects WHERE id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project is unavailable' USING ERRCODE='55000'; END IF;
  IF v_project.status IN ('deleting','deletion_failed','deleted') THEN
    RAISE EXCEPTION 'project is being deleted' USING ERRCODE='55000';
  ELSIF v_project.status NOT IN ('active','needs_attention') THEN
    RAISE EXCEPTION 'project is not operable' USING ERRCODE='55000';
  END IF;
  UPDATE runtime_launch_reservations SET
    state='completed', updated_at=clock_timestamp()
  WHERE run_id=p_run_id AND token=p_token AND supervisor_id=p_supervisor_id
    AND state='reserved' AND expires_at>clock_timestamp() AND job_id=p_job_id
    AND process_ref=p_process_ref
  RETURNING * INTO v_reservation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'launch reservation is not active' USING ERRCODE='55000';
  END IF;
  UPDATE task_runs r SET
    process_ref=p_process_ref, updated_at=clock_timestamp(), version=r.version+1
  FROM tasks t
  WHERE r.id=p_run_id AND t.id=r.task_id AND t.project_id=p_project_id
    AND r.status='running';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated<>1 THEN
    RAISE EXCEPTION 'runtime run is not in the running state' USING ERRCODE='55000';
  END IF;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_supervisor_id,
    'runtime.launch_registered','task_run',p_run_id::text,'allowed',NULL,
    jsonb_build_object('process_ref',p_process_ref),p_run_id::text);
  RETURN jsonb_build_object(
    'run_id',p_run_id,'status','launched','process_ref',p_process_ref
  );
END; $$;

-- CAS transition reserved -> cancelled (used by the supervisor on launch
-- failure after confirmed child termination, and by deprovision for expired
-- reservations before the filesystem phase). Only the owning supervisor can
-- cancel a live reservation; expired ones may be cancelled by any caller.
CREATE OR REPLACE FUNCTION cancel_runtime_launch(
  p_run_id uuid, p_job_id bigint, p_supervisor_id text, p_token text,
  p_force_expired boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_reservation runtime_launch_reservations%ROWTYPE;
BEGIN
  UPDATE runtime_launch_reservations SET state='cancelled', updated_at=clock_timestamp()
  WHERE run_id=p_run_id AND job_id=p_job_id AND token=p_token AND state='reserved'
    AND (supervisor_id=p_supervisor_id
         OR (p_force_expired AND expires_at<=clock_timestamp()))
  RETURNING * INTO v_reservation;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('run_id',p_run_id,'status','not_reserved');
  END IF;
  RETURN jsonb_build_object(
    'run_id',p_run_id,'status','cancelled',
    'process_ref',v_reservation.process_ref
  );
END; $$;

ALTER FUNCTION reserve_runtime_launch(uuid,uuid,bigint,text,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION bind_runtime_launch_pid(uuid,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION complete_runtime_launch(uuid,uuid,bigint,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION cancel_runtime_launch(uuid,bigint,text,text,boolean)
  SET search_path=control_plane,public,extensions,pg_temp;

-- DB-level fail-closed lifecycle guard. A project in deleting/deletion_failed/
-- deleted must not accept new work through any code path: tasks, new user
-- messages, delegation events, outbox rows, runtime jobs or workspace
-- operations all raise. Reading history and audit remains allowed. The stop
-- path (run.interrupt_requested / run.interrupted) stays open so active work
-- can be shut down during cleanup.
CREATE OR REPLACE FUNCTION assert_project_operable(
  p_project_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  IF p_project_id IS NULL THEN RETURN; END IF;
  SELECT status INTO v_status FROM projects WHERE id=p_project_id;
  IF v_status IN ('deleting','deletion_failed','deleted') THEN
    RAISE EXCEPTION 'project is being deleted' USING ERRCODE='55000';
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION guard_project_tasks_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_project_operable(NEW.project_id);
  RETURN NEW;
END; $$;

CREATE TRIGGER tasks_lifecycle_guard
  BEFORE INSERT ON tasks
  FOR EACH ROW EXECUTE FUNCTION guard_project_tasks_lifecycle();

CREATE OR REPLACE FUNCTION guard_project_events_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type IN ('chat.user_message','implementation.requested') THEN
    PERFORM assert_project_operable(NEW.project_id);
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER domain_events_lifecycle_guard
  BEFORE INSERT ON domain_events
  FOR EACH ROW EXECUTE FUNCTION guard_project_events_lifecycle();

CREATE OR REPLACE FUNCTION guard_project_outbox_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_project_operable((SELECT project_id FROM domain_events WHERE id=NEW.event_id));
  RETURN NEW;
END; $$;

CREATE TRIGGER outbox_messages_lifecycle_guard
  BEFORE INSERT ON outbox_messages
  FOR EACH ROW EXECUTE FUNCTION guard_project_outbox_lifecycle();

CREATE OR REPLACE FUNCTION guard_project_runtime_jobs_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_project_operable(NEW.project_id);
  RETURN NEW;
END; $$;

CREATE TRIGGER runtime_jobs_lifecycle_guard
  BEFORE INSERT ON runtime_jobs
  FOR EACH ROW EXECUTE FUNCTION guard_project_runtime_jobs_lifecycle();

CREATE OR REPLACE FUNCTION guard_project_workspace_operations_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_project_operable(NEW.project_id);
  RETURN NEW;
END; $$;

CREATE TRIGGER workspace_operations_lifecycle_guard
  BEFORE INSERT ON workspace_operations
  FOR EACH ROW EXECUTE FUNCTION guard_project_workspace_operations_lifecycle();

ALTER FUNCTION assert_project_operable(uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION guard_project_tasks_lifecycle()
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION guard_project_events_lifecycle()
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION guard_project_outbox_lifecycle()
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION guard_project_runtime_jobs_lifecycle()
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION guard_project_workspace_operations_lifecycle()
  SET search_path=control_plane,public,extensions,pg_temp;

-- Owner/version-fenced deletion request. Atomic: marks the project `deleting`,
-- records an audit fingerprint, hides it from navigation (read models filter
-- by status), blocks new work and cancels queued outbox/runtime jobs.
CREATE OR REPLACE FUNCTION request_project_deletion(
  p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_correlation_id text DEFAULT '', p_skip_grace boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_project projects%ROWTYPE;
  v_queued_outbox integer;
  v_queued_jobs integer;
  v_active_jobs integer;
BEGIN
  IF p_skip_grace AND p_correlation_id = '' THEN
    RAISE EXCEPTION 'delete-now requires a confirmed approval correlation' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_project FROM projects p
  WHERE p.id=p_project_id AND p.owner_id=p_owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project is unavailable' USING ERRCODE='55000'; END IF;
  IF v_project.status IN ('deleting','deletion_failed','deleted') THEN
    RAISE EXCEPTION 'project deletion is already in progress' USING ERRCODE='55000';
  END IF;
  IF v_project.version<>p_expected_version THEN
    RAISE EXCEPTION 'project version is stale' USING ERRCODE='40001';
  END IF;
  IF v_project.status='archived' THEN
    RAISE EXCEPTION 'archived projects must be restored before deletion' USING ERRCODE='55000';
  END IF;

  SELECT count(*) INTO v_active_jobs FROM runtime_jobs j
  WHERE j.project_id=p_project_id AND j.status IN ('pending','in_flight');

  UPDATE projects SET
    status='deleting',
    deletion_requested_at=clock_timestamp(),
    deletion_not_before=CASE WHEN p_skip_grace THEN clock_timestamp()
      ELSE clock_timestamp()+interval '24 hours' END,
    deletion_failure_code='', deletion_failure_message='',
    deletion_attempt_count=0,
    cleanup_leased_by=NULL, cleanup_leased_until=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=p_project_id RETURNING * INTO v_project;

  -- Cancel queued work: pending outbox and runtime jobs for this project.
  WITH cancelled_outbox AS (
    UPDATE outbox_messages o SET
      status='dead_letter',
      last_error=left(COALESCE(last_error,'')||' cancelled by project deletion;', 4000)
    WHERE o.status='pending'
      AND EXISTS (
        SELECT 1 FROM domain_events e WHERE e.id=o.event_id AND e.project_id=p_project_id
      )
    RETURNING id
  ), cancelled_jobs AS (
    UPDATE runtime_jobs j SET
      status='dead_letter',
      last_error=left(COALESCE(last_error,'')||' cancelled by project deletion;', 4000)
    WHERE j.status='pending' AND j.project_id=p_project_id
    RETURNING id
  )
  SELECT
    (SELECT count(*) FROM cancelled_outbox),
    (SELECT count(*) FROM cancelled_jobs)
  INTO v_queued_outbox, v_queued_jobs;

  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_owner_id::text,
    'project.deletion_requested','project',p_project_id::text,'allowed',NULL,
    jsonb_build_object('grace_hours',CASE WHEN p_skip_grace THEN 0 ELSE 24 END,
      'active_jobs',v_active_jobs,'cancelled_outbox',v_queued_outbox,
      'cancelled_jobs',v_queued_jobs),
    COALESCE(NULLIF(p_correlation_id,''),p_project_id::text));
  RETURN jsonb_build_object(
    'project_id',p_project_id,'status',v_project.status,
    'deletion_requested_at',v_project.deletion_requested_at,
    'deletion_not_before',v_project.deletion_not_before,
    'active_jobs',v_active_jobs,'cancelled_outbox',v_queued_outbox,
    'cancelled_jobs',v_queued_jobs
  );
END; $$;

-- Second explicit approval for Delete now: bypasses only the grace timer,
-- never the stop/containment checks. Fenced on version.
CREATE OR REPLACE FUNCTION approve_project_delete_now(
  p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_project projects%ROWTYPE;
BEGIN
  SELECT * INTO v_project FROM projects p
  WHERE p.id=p_project_id AND p.owner_id=p_owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project is unavailable' USING ERRCODE='55000'; END IF;
  IF v_project.status<>'deleting' THEN
    RAISE EXCEPTION 'project is not in the deleting state' USING ERRCODE='55000';
  END IF;
  IF v_project.version<>p_expected_version THEN
    RAISE EXCEPTION 'project version is stale' USING ERRCODE='40001';
  END IF;
  UPDATE projects SET
    deletion_not_before=clock_timestamp(),
    updated_at=clock_timestamp(), version=version+1
  WHERE id=p_project_id RETURNING * INTO v_project;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_owner_id::text,
    'project.deletion_approved_now','project',p_project_id::text,'allowed',NULL,
    jsonb_build_object('approval','delete_now'),p_correlation_id);
  RETURN jsonb_build_object(
    'project_id',p_project_id,'status',v_project.status,
    'deletion_not_before',v_project.deletion_not_before
  );
END; $$;

-- Undo is allowed only before the first cleanup claim; after any cleanup
-- attempt (claim incremented deletion_attempt_count) the project may already
-- be partially deprovisioned, so only Retry cleanup is valid. A deletion_failed
-- project is never restored to active by undo.
CREATE OR REPLACE FUNCTION undo_project_deletion(
  p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_correlation_id text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_project projects%ROWTYPE;
BEGIN
  SELECT * INTO v_project FROM projects p
  WHERE p.id=p_project_id AND p.owner_id=p_owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project is unavailable' USING ERRCODE='55000'; END IF;
  IF v_project.status<>'deleting' THEN
    RAISE EXCEPTION 'project deletion cannot be undone' USING ERRCODE='55000';
  END IF;
  IF v_project.version<>p_expected_version THEN
    RAISE EXCEPTION 'project version is stale' USING ERRCODE='40001';
  END IF;
  IF v_project.deletion_attempt_count>0 THEN
    RAISE EXCEPTION 'project cleanup has already been claimed; retry or inspect cleanup instead' USING ERRCODE='55000';
  END IF;
  IF v_project.cleanup_leased_by IS NOT NULL AND v_project.cleanup_leased_until>clock_timestamp() THEN
    RAISE EXCEPTION 'project cleanup is already claimed' USING ERRCODE='55000';
  END IF;
  UPDATE projects SET
    status='active',
    deletion_requested_at=NULL, deletion_not_before=NULL,
    deletion_failure_code='', deletion_failure_message='',
    deletion_attempt_count=0,
    cleanup_leased_by=NULL, cleanup_leased_until=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=p_project_id RETURNING * INTO v_project;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_owner_id::text,
    'project.deletion_undone','project',p_project_id::text,'allowed',NULL,
    jsonb_build_object(),COALESCE(NULLIF(p_correlation_id,''),p_project_id::text));
  RETURN jsonb_build_object('project_id',p_project_id,'status',v_project.status);
END; $$;

-- Idempotent cleanup claim with lease, bounded to projects past their grace
-- deadline or previously failed cleanups.
CREATE OR REPLACE FUNCTION claim_project_cleanup(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '10 minutes'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
  UPDATE projects SET
    cleanup_leased_by=NULL, cleanup_leased_until=NULL
  WHERE status='deleting' AND cleanup_leased_until<=clock_timestamp();

  WITH candidates AS (
    SELECT id FROM projects p
    WHERE p.status='deleting'
      AND p.deletion_not_before<=clock_timestamp()
      AND (p.cleanup_leased_until IS NULL OR p.cleanup_leased_until<=clock_timestamp())
    ORDER BY p.deletion_requested_at,p.id
    FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE projects p SET
      cleanup_leased_by=p_worker_id,
      cleanup_leased_until=clock_timestamp()+p_lease,
      deletion_attempt_count=p.deletion_attempt_count+1,
      updated_at=clock_timestamp(), version=p.version+1
    FROM candidates c WHERE p.id=c.id
    RETURNING p.*
  )
  SELECT jsonb_agg(jsonb_build_object(
    'project_id',id,'workspace_path',workspace_path,'status',status,
    'deletion_requested_at',deletion_requested_at,
    'deletion_not_before',deletion_not_before,
    'credential_mode',credential_mode,
    'github_repository_id',github_repository_id,
    'deletion_attempt_count',deletion_attempt_count
  )) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

CREATE OR REPLACE FUNCTION complete_project_cleanup(
  p_project_id uuid, p_worker_id text, p_deprovisioned_at timestamptz DEFAULT clock_timestamp()
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_project projects%ROWTYPE;
BEGIN
  SELECT * INTO v_project FROM projects p
  WHERE p.id=p_project_id AND p.status='deleting'
    AND p.cleanup_leased_by=p_worker_id AND p.cleanup_leased_until>clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project cleanup lease is unavailable' USING ERRCODE='55000'; END IF;
  UPDATE projects SET
    status='deleted', deleted_at=clock_timestamp(),
    deprovisioned_at=p_deprovisioned_at,
    cleanup_leased_by=NULL, cleanup_leased_until=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=p_project_id RETURNING * INTO v_project;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,
    'project.deprovisioned','project',p_project_id::text,'allowed',NULL,
    jsonb_build_object('deprovisioned_at',p_deprovisioned_at),p_project_id::text);
  RETURN jsonb_build_object(
    'project_id',p_project_id,'status',v_project.status,
    'deleted_at',v_project.deleted_at,'deprovisioned_at',v_project.deprovisioned_at
  );
END; $$;

CREATE OR REPLACE FUNCTION fail_project_cleanup(
  p_project_id uuid, p_worker_id text, p_failure_code text, p_failure_message text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_project projects%ROWTYPE;
BEGIN
  SELECT * INTO v_project FROM projects p
  WHERE p.id=p_project_id AND p.status='deleting'
    AND p.cleanup_leased_by=p_worker_id AND p.cleanup_leased_until>clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project cleanup lease is unavailable' USING ERRCODE='55000'; END IF;
  UPDATE projects SET
    status='deletion_failed',
    deletion_failure_code=left(COALESCE(p_failure_code,'cleanup_failed'),80),
    deletion_failure_message=left(COALESCE(regexp_replace(p_failure_message,'[[:cntrl:]]',' ','g'),'Cleanup failed.'),500),
    cleanup_leased_by=NULL, cleanup_leased_until=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=p_project_id RETURNING * INTO v_project;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,
    'project.cleanup_failed','project',p_project_id::text,'allowed',NULL,
    jsonb_build_object('failure_code',p_failure_code,'attempt',v_project.deletion_attempt_count),
    p_project_id::text);
  RETURN jsonb_build_object(
    'project_id',p_project_id,'status',v_project.status,
    'failure_code',v_project.deletion_failure_code,
    'attempt',v_project.deletion_attempt_count
  );
END; $$;

CREATE OR REPLACE FUNCTION retry_project_cleanup(
  p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_correlation_id text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_project projects%ROWTYPE;
BEGIN
  SELECT * INTO v_project FROM projects p
  WHERE p.id=p_project_id AND p.owner_id=p_owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project is unavailable' USING ERRCODE='55000'; END IF;
  IF v_project.status<>'deletion_failed' THEN
    RAISE EXCEPTION 'project cleanup is not in a retryable state' USING ERRCODE='55000';
  END IF;
  IF v_project.version<>p_expected_version THEN
    RAISE EXCEPTION 'project version is stale' USING ERRCODE='40001';
  END IF;
  UPDATE projects SET
    status='deleting',
    deletion_not_before=clock_timestamp(),
    deletion_failure_code='', deletion_failure_message='',
    cleanup_leased_by=NULL, cleanup_leased_until=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=p_project_id RETURNING * INTO v_project;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_owner_id::text,
    'project.cleanup_retried','project',p_project_id::text,'allowed',NULL,
    jsonb_build_object(),COALESCE(NULLIF(p_correlation_id,''),p_project_id::text));
  RETURN jsonb_build_object('project_id',p_project_id,'status',v_project.status);
END; $$;

-- Operations read model: tombstones and deletion lifecycle state, safe and
-- owner-scoped.
CREATE OR REPLACE FUNCTION get_operator_project_deletion_status(
  p_owner_id uuid
) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'project_id',p.id,'name',p.name,'slug',p.slug,'status',p.status,
    'workspace_path',p.workspace_path,'credential_mode',p.credential_mode,
    'repository_full_name',p.repository_full_name,
    'deletion_requested_at',p.deletion_requested_at,
    'deletion_not_before',p.deletion_not_before,
    'deleted_at',p.deleted_at,'deprovisioned_at',p.deprovisioned_at,
    'deletion_failure_code',p.deletion_failure_code,
    'deletion_failure_message',p.deletion_failure_message,
    'deletion_attempt_count',p.deletion_attempt_count,
    'cleanup_leased_by',p.cleanup_leased_by,'cleanup_leased_until',p.cleanup_leased_until,
    'version',p.version
  ) ORDER BY p.updated_at DESC),'[]'::jsonb)
  FROM projects p
  WHERE p.owner_id=p_owner_id
    AND p.status IN ('deleting','deletion_failed','deleted');
$$;

ALTER FUNCTION request_project_deletion(uuid,uuid,bigint,text,boolean)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION approve_project_delete_now(uuid,uuid,bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION undo_project_deletion(uuid,uuid,bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_project_cleanup(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION complete_project_cleanup(uuid,text,timestamptz)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION fail_project_cleanup(uuid,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION retry_project_cleanup(uuid,uuid,bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION get_operator_project_deletion_status(uuid)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
