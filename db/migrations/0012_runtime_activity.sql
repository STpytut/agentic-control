BEGIN;

SET search_path TO control_plane, public;

ALTER TABLE runtime_jobs
  ADD COLUMN activity_phase text NOT NULL DEFAULT 'queued',
  ADD COLUMN activity_detail text,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN heartbeat_at timestamptz;

UPDATE runtime_jobs
SET activity_phase = CASE status
      WHEN 'pending' THEN CASE WHEN attempt_count > 0 THEN 'retrying' ELSE 'queued' END
      WHEN 'in_flight' THEN 'working'
      WHEN 'completed' THEN 'completed'
      WHEN 'dead_letter' THEN 'failed'
    END,
    started_at = CASE WHEN status IN ('in_flight','completed','dead_letter')
      THEN COALESCE(completed_at,created_at) END,
    heartbeat_at = CASE WHEN status='in_flight' THEN clock_timestamp() END;

CREATE OR REPLACE FUNCTION update_runtime_job_activity(
  p_job_id bigint,
  p_worker_id text,
  p_phase text,
  p_detail text DEFAULT NULL
)
RETURNS timestamptz
LANGUAGE plpgsql
AS $$
DECLARE v_heartbeat timestamptz;
BEGIN
  IF p_phase NOT IN (
    'queued','retrying','starting_runtime','opening_session','running_turn',
    'finalizing','waiting_for_input','blocked','completed','failed'
  ) THEN
    RAISE EXCEPTION 'unsupported runtime activity phase %',p_phase USING ERRCODE='22023';
  END IF;
  UPDATE runtime_jobs
  SET activity_phase=p_phase,
      activity_detail=NULLIF(left(COALESCE(p_detail,''),500),''),
      started_at=COALESCE(started_at,clock_timestamp()),
      heartbeat_at=clock_timestamp()
  WHERE id=p_job_id AND status='in_flight' AND leased_by=p_worker_id
    AND leased_until>clock_timestamp()
  RETURNING heartbeat_at INTO v_heartbeat;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime job % is not actively leased by worker %',p_job_id,p_worker_id
      USING ERRCODE='55000';
  END IF;
  RETURN v_heartbeat;
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
DECLARE v_until timestamptz;
BEGIN
  UPDATE runtime_jobs
  SET leased_until=clock_timestamp()+p_lease,heartbeat_at=clock_timestamp(),
      started_at=COALESCE(started_at,clock_timestamp())
  WHERE id=p_job_id AND status='in_flight' AND leased_by=p_supervisor_id
    AND leased_until>clock_timestamp()
  RETURNING leased_until INTO v_until;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime job % is not actively leased by supervisor %',p_job_id,p_supervisor_id
      USING ERRCODE='55000';
  END IF;
  RETURN v_until;
END;
$$;

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
    WHERE j.job_type='codex_chat_turn' AND j.available_at<=clock_timestamp()
      AND (j.status='pending' OR (j.status='in_flight' AND j.leased_until<=clock_timestamp()))
      AND NOT EXISTS (
        SELECT 1 FROM runtime_jobs earlier
        WHERE earlier.job_type='codex_chat_turn' AND earlier.task_id=j.task_id
          AND earlier.id<j.id AND earlier.status IN ('pending','in_flight')
      )
    ORDER BY j.available_at,j.id FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(p_limit,0)
  )
  UPDATE runtime_jobs j
  SET status='in_flight',attempt_count=j.attempt_count+1,leased_by=p_worker_id,
      leased_until=clock_timestamp()+p_lease,last_error=NULL,
      activity_phase='starting_runtime',activity_detail='Preparing the Codex runtime',
      started_at=COALESCE(j.started_at,clock_timestamp()),heartbeat_at=clock_timestamp()
  FROM candidates c WHERE j.id=c.id RETURNING j.*;
$$;

ALTER FUNCTION update_runtime_job_activity(bigint,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION heartbeat_runtime_job(bigint,text,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_codex_chat_jobs(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
