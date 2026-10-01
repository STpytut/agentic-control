-- A run waits for memory instead of being OOM-killed (sprint C K3; exit
-- criterion 12).
--
-- The supervisor refuses a launch the host or its unit has no memory for, as
-- runtime_capacity, before anything is spawned, owned or reserved
-- (runtime-capacity.mjs). An orchestrator's job is then handed back to the
-- queue like one refused for a runtime installation: its attempt given back,
-- its place kept, the panel saying why it waits. An implementation already
-- holds its workspace and waits in its worker instead. The refusals here now
-- name their reasons (the rule since 0067).

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('runtime_capacity','unavailable','the host has no memory for another run right now; it waits for one to finish'),
  ('defer_reason_not_transient','invalid_argument','a job may be deferred only for a reason that clears on its own'),
  ('defer_job_not_leased','lease_lost','the job is not actively leased by the worker deferring it'),
  ('defer_job_type','invalid_argument','only an orchestrator job is handed back to the queue')
ON CONFLICT (reason) DO NOTHING;

CREATE OR REPLACE FUNCTION defer_runtime_job(p_job_id bigint, p_worker_id text, p_reason text, p_delay interval DEFAULT '00:00:30'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('grant_writer_active','runtime_paused','runtime_capacity') THEN
    RAISE EXCEPTION 'a job may be deferred only for a reason that clears on its own'
      USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','defer_reason_not_transient')::text;
  END IF;
  IF p_delay IS NULL OR p_delay < interval '1 second' OR p_delay > interval '10 minutes' THEN
    RAISE EXCEPTION 'defer delay must be between one second and ten minutes' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','defer_delay_invalid')::text;
  END IF;

  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'in_flight' OR v_job.leased_by IS DISTINCT FROM p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'the job is not actively leased by this worker' USING ERRCODE='55000',
      DETAIL=jsonb_build_object('reason','defer_job_not_leased')::text;
  END IF;
  IF v_job.job_type NOT IN ('orchestrator_turn','resume_orchestrator') THEN
    RAISE EXCEPTION 'only an orchestrator job can be deferred' USING ERRCODE='55000',
      DETAIL=jsonb_build_object('reason','defer_job_type')::text;
  END IF;

  UPDATE runtime_jobs SET
    status='pending', leased_by=NULL, leased_until=NULL,
    available_at=clock_timestamp()+p_delay,
    attempt_count=GREATEST(attempt_count-1,0),
    last_error=left('deferred: '||p_reason,4000),
    -- As a freshly queued job: the next claim writes its own phase and detail.
    activity_phase='queued',
    activity_detail=CASE WHEN p_reason='runtime_capacity' THEN 'Waiting for memory on the host: another run is using it'
      ELSE 'Waiting for an available runtime worker' END
  WHERE id=p_job_id RETURNING * INTO v_job;

  RETURN jsonb_build_object('job_id',v_job.id,'status','deferred','reason',p_reason,
    'available_at',v_job.available_at,'attempt_count',v_job.attempt_count);
END $function$;
