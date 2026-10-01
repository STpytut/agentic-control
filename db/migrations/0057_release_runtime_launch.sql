-- Stage 11.1: a finished launch stops holding the slot.
--
-- The first executor run on the VPS failed, and its two retries were refused
-- with "runtime launch reservation already exists" — so the job dead-lettered
-- without ever trying again.
--
-- `reserve_runtime_launch` re-reserves a run only when the previous reservation
-- is `cancelled`. There are three states, and the one a finished launch is left
-- in is `completed`:
--
--   state=completed  expires=09:03:58  expired=true  job=5  pid_ref=runtime-supervisor:93686
--
-- `cancel_runtime_launch` cannot help: it updates rows in `reserved` and returns
-- `not_reserved` for anything else. So `completed` is terminal in the only sense
-- that matters — nothing can ever reserve that run again, and every retry of a
-- failed run is refused by the record of the attempt that failed.
--
-- Retries exist for runs that fail. A design where the first failure makes the
-- next attempt impossible is one where they do not.
--
-- Why a new state rather than reusing `cancelled`
-- -----------------------------------------------
-- `cancelled` says the launch was called off; this one ran and ended. Writing
-- the second as the first would make the reservation table lie about what
-- happened, and the table is what the expired-launch reaper reads when it
-- decides whether a process should still be alive.
--
-- `released` says what it is: the supervisor watched the child exit and gave the
-- slot back. Only the supervisor can say it — the database cannot see a process
-- — which is why this is a function it calls and not a rule the database applies
-- on its own.

SET search_path TO control_plane, public, extensions;

ALTER TABLE runtime_launch_reservations DROP CONSTRAINT runtime_launch_reservations_state_check;
ALTER TABLE runtime_launch_reservations ADD CONSTRAINT runtime_launch_reservations_state_check
  CHECK (state = ANY (ARRAY['reserved','completed','cancelled','released']));

-- The supervisor saying the child is gone.
--
-- Token-checked like every other transition, so a stale supervisor cannot
-- release a launch that a newer one owns. `not_released` is not an error: a run
-- whose reservation was already cancelled, reaped or re-reserved is a run this
-- caller no longer speaks for.
CREATE OR REPLACE FUNCTION release_runtime_launch(
  p_run_id uuid, p_job_id bigint, p_supervisor_id text, p_token text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_reservation runtime_launch_reservations%ROWTYPE;
BEGIN
  UPDATE runtime_launch_reservations SET state='released', updated_at=clock_timestamp()
  WHERE run_id=p_run_id AND job_id=p_job_id AND token=p_token
    AND supervisor_id=p_supervisor_id AND state IN ('reserved','completed')
  RETURNING * INTO v_reservation;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('run_id',p_run_id,'status','not_released');
  END IF;
  RETURN jsonb_build_object('run_id',v_reservation.run_id,'status','released');
END $$;

-- 0033's body, with one condition widened: a run may be reserved again once the
-- previous reservation is `cancelled` **or** `released`. Everything else — the
-- project lock, the deletion guard, the lease binding, the token — is unchanged,
-- because none of it was wrong.
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
  SELECT * INTO v_project FROM projects WHERE id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project is unavailable' USING ERRCODE='55000'; END IF;
  IF v_project.status IN ('deleting','deletion_failed','deleted') THEN
    RAISE EXCEPTION 'project is being deleted' USING ERRCODE='55000';
  ELSIF v_project.status NOT IN ('active','needs_attention') THEN
    RAISE EXCEPTION 'project is not operable' USING ERRCODE='55000';
  END IF;
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
  WHERE runtime_launch_reservations.state IN ('cancelled','released')
  RETURNING * INTO v_reservation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime launch reservation already exists' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object(
    'run_id',v_reservation.run_id,'status','reserved',
    'token',v_reservation.token,'expires_at',v_reservation.expires_at
  );
END $$;

ALTER FUNCTION release_runtime_launch(uuid,bigint,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION reserve_runtime_launch(uuid,uuid,bigint,text,interval)
  SET search_path=control_plane,public,extensions,pg_temp;

REVOKE EXECUTE ON FUNCTION release_runtime_launch(uuid,bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_runtime_launch(uuid,bigint,text,text) TO infra_worker;

-- The supervisor runs as infra_worker and the web tier has no business here.
DO $assert$
BEGIN
  IF has_function_privilege('infra_web',
       'control_plane.release_runtime_launch(uuid,bigint,text,text)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'infra_web can execute release_runtime_launch' USING ERRCODE='42501';
  END IF;
END $assert$;
