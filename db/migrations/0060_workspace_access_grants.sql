-- Stage 11.1b, WP-3b: filesystem access follows an explicit grant.
--
-- The A1 race (STAGE_11_2_PREWORK) is a Codex chat turn opened while an OpenCode
-- implementation holds the workspace: the supervisor chowned the whole tree to
-- Codex as a side effect of opening a channel, and the running implementation
-- lost its filesystem with its database lease and fencing token intact. On the
-- host, job 14 did exactly that to run fc7bbace, which ended `lost`.
--
-- Two things close it, and both are here.
--
-- 1. The claim waits. claim_codex_chat_jobs skips a project whose workspace a
--    writer holds. The operator's message is still recorded — refusing it would
--    be the wrong fix — and its job stays pending until the writer is done.
--    This inverts WP-2's `characterises_chat_claim_ignores_an_active_implementation`.
--
-- 2. Access is a grant, resolved rather than asserted. A launch no longer
--    carries "open Codex for project X"; it carries an opaque token. The grant
--    behind it is bound to the job, the run, the assignment and the project, and
--    it has a mode, an expiry and — for read_write — the fencing token of the
--    lock it was issued under. The supervisor resolves the token immediately
--    before it acts, and every one of those is checked again at that moment.
--
-- Who chooses the mode
-- --------------------
-- Neither the supervisor's client nor the worker. The mode is derived from what
-- the run is (ADR-0013): a writing run gets read_write, an orchestrator turn gets
-- read_only. A caller that could name the mode could name the wrong one, and the
-- whole point of a grant is that the answer comes from the state that justifies it.
--
-- What a grant does not contain
-- -----------------------------
-- No operating-system account and no path. A grant resolves to a runtime type
-- through the assignment; which Unix account runs that runtime is the adapter's
-- business (WP-5a), and the PoC account names this schema would otherwise record
-- are exactly what 11.1b is retiring.
--
-- The token
-- ---------
-- 32 random bytes, returned once, stored as its SHA-256. runtime_launch_reservations
-- stores its token as issued; a workspace grant is kept as a hash because the
-- backup role reads every table, and a token that opens a workspace has no
-- business being restorable.
SET search_path TO control_plane, public, extensions;

CREATE TABLE workspace_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_sha256 bytea NOT NULL UNIQUE CHECK (length(token_sha256) = 32),
  project_id uuid NOT NULL REFERENCES projects(id),
  job_id bigint NOT NULL REFERENCES runtime_jobs(id),
  run_id uuid NOT NULL REFERENCES task_runs(id),
  assignment_id uuid NOT NULL REFERENCES project_agent_assignments(id),
  mode text NOT NULL CHECK (mode IN ('read_only','read_write')),
  fencing_token bigint CHECK (fencing_token > 0),
  issued_to text NOT NULL CHECK (length(issued_to) BETWEEN 2 AND 120),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 200),
  CHECK ((mode = 'read_write') = (fencing_token IS NOT NULL)),
  CHECK (expires_at > issued_at),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);

-- One live grant per run: issuing again replaces, and says so.
CREATE UNIQUE INDEX workspace_access_grants_one_live_per_run
  ON workspace_access_grants(run_id) WHERE revoked_at IS NULL;
CREATE INDEX workspace_access_grants_project
  ON workspace_access_grants(project_id, expires_at) WHERE revoked_at IS NULL;

-- Whether some writer other than p_run_id may be in the workspace. A lock that is
-- held has a live writer; one that needs reconciliation has lost its owner row
-- but not necessarily its process. Both mean: do not read and do not write.
CREATE OR REPLACE FUNCTION workspace_has_foreign_writer(p_project_id uuid, p_run_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_locks l
    WHERE l.project_id=p_project_id
      AND (l.status='reconciliation_required'
           OR (l.status='held' AND l.owner_run_id IS DISTINCT FROM p_run_id))
  );
$$;

-- The assignment a run acts for: the task's orchestrator for a turn, the
-- handoff's executor for a writing run.
CREATE OR REPLACE FUNCTION workspace_grant_assignment(p_run task_runs)
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_run.write_capable
    THEN (SELECT h.executor_assignment_id FROM handoffs h WHERE h.target_run_id=p_run.id
          ORDER BY h.revision_number DESC LIMIT 1)
    ELSE (SELECT t.orchestrator_assignment_id FROM tasks t WHERE t.id=p_run.task_id)
  END;
$$;

-- Refusals carry a stable reason in DETAIL, so the caller can tell a refusal
-- that will succeed later (a writer is busy: defer) from one that will not.
CREATE OR REPLACE FUNCTION issue_workspace_access_grant(
  p_job_id bigint, p_worker_id text, p_ttl interval DEFAULT interval '10 minutes'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_job runtime_jobs%ROWTYPE;
  v_run task_runs%ROWTYPE;
  v_lock workspace_locks%ROWTYPE;
  v_assignment uuid;
  v_mode text;
  v_token bytea;
  v_grant workspace_access_grants%ROWTYPE;
BEGIN
  IF p_ttl IS NULL OR p_ttl <= interval '0' OR p_ttl > interval '2 hours' THEN
    RAISE EXCEPTION 'grant lifetime must be positive and at most two hours' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'in_flight' OR v_job.leased_by IS DISTINCT FROM p_worker_id
     OR v_job.leased_until<=clock_timestamp() OR v_job.run_id IS NULL THEN
    RAISE EXCEPTION 'the job is not actively leased by this worker' USING ERRCODE='55000',
      DETAIL='grant_job_not_leased';
  END IF;

  SELECT * INTO v_run FROM task_runs WHERE id=v_job.run_id FOR UPDATE;
  IF v_run.status NOT IN ('starting','running') OR v_run.task_id<>v_job.task_id THEN
    RAISE EXCEPTION 'the run is not active' USING ERRCODE='55000', DETAIL='grant_run_inactive';
  END IF;

  v_assignment:=workspace_grant_assignment(v_run);
  IF v_assignment IS NULL THEN
    RAISE EXCEPTION 'the run acts for no assignment' USING ERRCODE='55000', DETAIL='grant_no_assignment';
  END IF;

  SELECT * INTO v_lock FROM workspace_locks WHERE project_id=v_job.project_id FOR UPDATE;
  IF v_run.write_capable THEN
    v_mode:='read_write';
    IF v_lock.status IS DISTINCT FROM 'held' OR v_lock.owner_run_id IS DISTINCT FROM v_run.id
       OR v_lock.lease_expires_at<=clock_timestamp()
       OR v_lock.fencing_token IS DISTINCT FROM v_run.workspace_fencing_token THEN
      RAISE EXCEPTION 'the run does not hold the workspace lock' USING ERRCODE='55000',
        DETAIL='grant_lock_not_held';
    END IF;
  ELSE
    v_mode:='read_only';
    IF workspace_has_foreign_writer(v_job.project_id, v_run.id) THEN
      RAISE EXCEPTION 'another run is writing in this workspace' USING ERRCODE='55000',
        DETAIL='grant_writer_active';
    END IF;
  END IF;

  UPDATE workspace_access_grants SET revoked_at=clock_timestamp(), revoke_reason='superseded'
  WHERE run_id=v_run.id AND revoked_at IS NULL;

  v_token:=gen_random_bytes(32);
  INSERT INTO workspace_access_grants(token_sha256,project_id,job_id,run_id,assignment_id,mode,
    fencing_token,issued_to,expires_at)
  VALUES(digest(v_token,'sha256'),v_job.project_id,v_job.id,v_run.id,v_assignment,v_mode,
    CASE WHEN v_mode='read_write' THEN v_lock.fencing_token END,p_worker_id,clock_timestamp()+p_ttl)
  RETURNING * INTO v_grant;

  RETURN jsonb_build_object('grant_id',v_grant.id,'token',encode(v_token,'hex'),
    'mode',v_grant.mode,'run_id',v_grant.run_id,'expires_at',v_grant.expires_at);
END $$;

-- Called by the supervisor immediately before it acts. Nothing the grant was
-- issued under is taken on trust: each condition is read again now.
CREATE OR REPLACE FUNCTION resolve_workspace_access_grant(p_token text, p_project_id uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_grant workspace_access_grants%ROWTYPE;
  v_job runtime_jobs%ROWTYPE;
  v_run task_runs%ROWTYPE;
  v_lock workspace_locks%ROWTYPE;
  v_runtime text;
  v_reason text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'the grant token is malformed' USING ERRCODE='22023', DETAIL='grant_malformed';
  END IF;

  SELECT * INTO v_grant FROM workspace_access_grants
  WHERE token_sha256=digest(decode(p_token,'hex'),'sha256');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such grant' USING ERRCODE='55000', DETAIL='grant_unknown';
  END IF;

  SELECT * INTO v_job FROM runtime_jobs WHERE id=v_grant.job_id;
  SELECT * INTO v_run FROM task_runs WHERE id=v_grant.run_id;
  SELECT * INTO v_lock FROM workspace_locks WHERE project_id=v_grant.project_id;

  v_reason:=CASE
    WHEN v_grant.project_id<>p_project_id THEN 'grant_project_mismatch'
    WHEN v_grant.revoked_at IS NOT NULL THEN 'grant_revoked'
    WHEN v_grant.expires_at<=clock_timestamp() THEN 'grant_expired'
    WHEN v_job.status<>'in_flight' OR v_job.leased_by IS DISTINCT FROM v_grant.issued_to
         OR v_job.leased_until<=clock_timestamp() OR v_job.run_id IS DISTINCT FROM v_grant.run_id
      THEN 'grant_job_not_leased'
    WHEN v_run.status NOT IN ('starting','running') THEN 'grant_run_inactive'
    WHEN v_grant.mode='read_write' AND (v_lock.status IS DISTINCT FROM 'held'
         OR v_lock.owner_run_id IS DISTINCT FROM v_grant.run_id
         OR v_lock.lease_expires_at<=clock_timestamp()
         OR v_lock.fencing_token IS DISTINCT FROM v_grant.fencing_token) THEN 'grant_lock_not_held'
    WHEN v_grant.mode='read_only' AND workspace_has_foreign_writer(v_grant.project_id, v_grant.run_id)
      THEN 'grant_writer_active'
  END;
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'the workspace access grant does not hold: %',v_reason USING ERRCODE='55000',
      DETAIL=v_reason;
  END IF;

  SELECT rp.runtime_type INTO v_runtime
  FROM project_agent_assignments pa JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
  WHERE pa.id=v_grant.assignment_id;

  RETURN jsonb_build_object('grant_id',v_grant.id,'project_id',v_grant.project_id,
    'job_id',v_grant.job_id,'run_id',v_grant.run_id,'assignment_id',v_grant.assignment_id,
    'runtime_type',v_runtime,'mode',v_grant.mode,'fencing_token',v_grant.fencing_token,
    'expires_at',v_grant.expires_at);
END $$;

-- A grant does not outlive its run: when a run reaches any end, its live grant is
-- revoked in the same transaction. resolve would refuse it anyway; revoking says
-- why, on the row, for whoever reads it afterwards.
CREATE OR REPLACE FUNCTION revoke_workspace_grants_of_ended_run()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE workspace_access_grants SET revoked_at=clock_timestamp(), revoke_reason='run_'||NEW.status
  WHERE run_id=NEW.id AND revoked_at IS NULL;
  RETURN NULL;
END $$;

CREATE TRIGGER task_runs_revoke_workspace_grants
AFTER UPDATE OF status ON task_runs
FOR EACH ROW
WHEN (NEW.status NOT IN ('queued','starting','running') AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION revoke_workspace_grants_of_ended_run();


-- claim_codex_chat_jobs, redefined from 0019 with one condition added: the job
-- waits while a writer holds the workspace.
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
      -- The job waits while a writer holds the workspace. Before 0060 nothing
      -- here asked, and the turn this claim led to chowned the tree out from
      -- under a live implementation (A1). A skipped job stays pending, in
      -- order, and is claimed once the lock is released.
      AND NOT workspace_has_foreign_writer(j.project_id, NULL)
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

ALTER FUNCTION claim_codex_chat_jobs(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION workspace_has_foreign_writer(uuid,uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION workspace_grant_assignment(task_runs)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION issue_workspace_access_grant(bigint,text,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION resolve_workspace_access_grant(text,uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION revoke_workspace_grants_of_ended_run()
  SET search_path=control_plane,public,extensions,pg_temp;

REVOKE EXECUTE ON FUNCTION workspace_has_foreign_writer(uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION workspace_grant_assignment(task_runs) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION issue_workspace_access_grant(bigint,text,interval) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_workspace_access_grant(text,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION revoke_workspace_grants_of_ended_run() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace_has_foreign_writer(uuid,uuid) TO infra_worker;
GRANT EXECUTE ON FUNCTION workspace_grant_assignment(task_runs) TO infra_worker;
GRANT EXECUTE ON FUNCTION issue_workspace_access_grant(bigint,text,interval) TO infra_worker;
GRANT EXECUTE ON FUNCTION resolve_workspace_access_grant(text,uuid) TO infra_worker;
GRANT EXECUTE ON FUNCTION revoke_workspace_grants_of_ended_run() TO infra_worker;
