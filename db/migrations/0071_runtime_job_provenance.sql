-- A job records what was selected, and every launch what ran (WP-9c, prework A7).
--
-- The panel reconstructed runtime identity from names and job types: usage was
-- attributed by `CASE WHEN job_type='start_implementation' THEN 'opencode' ELSE
-- 'codex' END`, the Stop button by `runtime_profiles.capabilities->>'interrupt'`,
-- and a delegation was always "Codex delegated implementation to OpenCode."
-- After neutral jobs every one of those becomes silently wrong; one already was:
-- on rc.38 a running Codex turn showed no Stop, because Codex's profile row did
-- not say `interrupt` while its driver declares it in the mandatory core.
--
-- Two layers, because one mutable group of columns on runtime_jobs would lose
-- its history on the first retry, and a retry is when "what actually ran" is
-- asked — 11.1 had three runs of one task with one job row describing the last:
--
-- runtime_job_selections — written once
--   The assignment, the runtime and its adapter and runtime version, the
--   capability verification, the driver's declared capabilities, the session
--   and the access mode. The first launch of a job records it and every retry
--   reuses it. A launch for another assignment, runtime or access mode is
--   refused (runtime_selection_changed): that is a new job's decision. A
--   runtime or driver that moved between attempts supersedes the selection with
--   a row naming the one it replaces and what changed; the replaced row stays.
--   Reselecting is never an update.
--
-- runtime_dispatch_attempts — appended per launch
--   The selection it ran under, the attempt number, the run, the driver and its
--   executable, the runtime and adapter version, the capability verification,
--   the session, the grant and its mode, the worker, and — once, at the end —
--   the native result. Nothing else about an attempt ever changes.
--
-- What the database derives, and what the launcher says
--   The assignment, the access mode and the grant come from the grant the run
--   holds (0060), the session from the run, the runtime from the assignment: the
--   launcher cannot claim them. What only the launcher knows — the driver's
--   declaration and the version the host runs — it says, and a runtime that is
--   not the assignment's is refused (runtime_selection_mismatch).
--
-- What the panel reads
--   runtime_job_can_interrupt(job): whether the job's recorded driver declares
--   `interrupt`. The panel's Stop and request_runtime_interrupt ask the same
--   function; runtime_profiles is no longer consulted by either.
--   conversation_runtime_usage(...): usage by the runtime that ran, attempts by
--   the selection each job recorded.
--
-- Existing jobs get a backfilled selection, marked `source='backfill'`, with the
-- runtime their run's session or their assignment names and no versions or
-- capabilities — which is the truth about what was recorded when they ran.
--
-- No BEGIN/COMMIT: migrate.mjs owns the transaction (0039 onwards).
SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('runtime_selection_invalid','invalid_argument','a launch description outside what a driver declares'),
  ('runtime_selection_mismatch','conflict','the launcher names a runtime other than the one the assignment selected'),
  ('runtime_selection_changed','conflict','a retry would run under a different selection than the job recorded; reselecting supersedes, it does not update'),
  ('runtime_selection_no_grant','conflict','the run holds no workspace grant to take the assignment and access mode from'),
  ('runtime_dispatch_attempt_immutable','conflict','an attempt records its native result once and nothing else changes'),
  ('runtime_dispatch_not_found','not_found','no attempt of this job by this worker')
ON CONFLICT (reason) DO NOTHING;

CREATE TABLE runtime_job_selections (
  id bigserial PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES runtime_jobs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  source text NOT NULL CHECK (source IN ('launch','backfill','supersede')),
  supersedes bigint UNIQUE REFERENCES runtime_job_selections(id),
  supersede_reason text CHECK (supersede_reason IS NULL OR length(supersede_reason) BETWEEN 3 AND 500),
  assignment_id uuid REFERENCES project_agent_assignments(id),
  agent_id uuid REFERENCES agents(id),
  runtime_type text NOT NULL CHECK (runtime_type IN ('codex','opencode','antigravity')),
  adapter_version text,
  runtime_version text,
  verified_runtime_version text,
  capability_verification text CHECK (capability_verification IN ('verified','unverified')),
  capabilities text[] NOT NULL DEFAULT '{}',
  session_id uuid REFERENCES agent_sessions(id),
  access_mode text NOT NULL CHECK (access_mode IN ('none','read_only','read_write')),
  model text,
  selected_by text NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((source='supersede') = (supersedes IS NOT NULL)),
  CHECK ((supersedes IS NULL) = (supersede_reason IS NULL)),
  -- A launch knows its driver; only a backfill may not.
  CHECK (source='backfill' OR (adapter_version IS NOT NULL AND capability_verification IS NOT NULL
                               AND assignment_id IS NOT NULL AND cardinality(capabilities) > 0))
);
-- One first selection per job; later ones supersede.
CREATE UNIQUE INDEX runtime_job_selections_first ON runtime_job_selections(job_id) WHERE supersedes IS NULL;

CREATE TABLE runtime_dispatch_attempts (
  id bigserial PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES runtime_jobs(id) ON DELETE CASCADE,
  selection_id bigint NOT NULL REFERENCES runtime_job_selections(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  run_id uuid REFERENCES task_runs(id),
  runtime_type text NOT NULL,
  executable text NOT NULL CHECK (length(executable) BETWEEN 1 AND 200),
  adapter_version text NOT NULL,
  runtime_version text,
  capability_verification text NOT NULL CHECK (capability_verification IN ('verified','unverified')),
  session_id uuid REFERENCES agent_sessions(id),
  native_session_id text,
  grant_id uuid REFERENCES workspace_access_grants(id),
  access_mode text NOT NULL CHECK (access_mode IN ('none','read_only','read_write')),
  worker_id text NOT NULL,
  surface text NOT NULL CHECK (length(surface) BETWEEN 1 AND 40),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  native_result jsonb CHECK (native_result IS NULL
    OR (jsonb_typeof(native_result)='object' AND octet_length(native_result::text)<=8192)),
  CHECK ((finished_at IS NULL) = (native_result IS NULL))
);
CREATE INDEX runtime_dispatch_attempts_by_job ON runtime_dispatch_attempts(job_id, id);

GRANT SELECT, INSERT, UPDATE ON runtime_job_selections, runtime_dispatch_attempts TO infra_worker;
GRANT USAGE ON SEQUENCE runtime_job_selections_id_seq, runtime_dispatch_attempts_id_seq TO infra_worker;
GRANT SELECT ON runtime_job_selections, runtime_dispatch_attempts TO infra_web;

-- A selection never changes; an attempt changes once, when it ends, and only
-- in the two columns that say how.
CREATE OR REPLACE FUNCTION guard_runtime_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM runtime_jobs WHERE id=OLD.job_id) THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME='runtime_dispatch_attempts' AND TG_OP='UPDATE' THEN
    IF OLD.native_result IS NULL AND NEW.native_result IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['native_result','finished_at','native_session_id'])
           = (to_jsonb(OLD) - ARRAY['native_result','finished_at','native_session_id'])
       AND (OLD.native_session_id IS NULL OR NEW.native_session_id IS NOT DISTINCT FROM OLD.native_session_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  PERFORM refuse(CASE WHEN TG_TABLE_NAME='runtime_dispatch_attempts' THEN 'runtime_dispatch_attempt_immutable'
                      ELSE 'runtime_selection_changed' END,
    format('%s rows are append-only (%s refused)', TG_TABLE_NAME, TG_OP));
  RETURN NULL;
END $$;
CREATE TRIGGER runtime_job_selections_immutable BEFORE UPDATE OR DELETE ON runtime_job_selections
  FOR EACH ROW EXECUTE FUNCTION guard_runtime_provenance();
CREATE TRIGGER runtime_dispatch_attempts_append_only BEFORE UPDATE OR DELETE ON runtime_dispatch_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_runtime_provenance();

-- The selection a job currently runs under: the one nothing supersedes.
CREATE OR REPLACE FUNCTION current_runtime_job_selection(p_job_id bigint)
RETURNS runtime_job_selections LANGUAGE sql STABLE AS $$
  SELECT s.* FROM runtime_job_selections s
  WHERE s.job_id=p_job_id
    AND NOT EXISTS (SELECT 1 FROM runtime_job_selections later WHERE later.supersedes=s.id)
  ORDER BY s.id DESC LIMIT 1;
$$;

-- Whether the driver recorded for a job declares `interrupt`. The one answer
-- the panel's Stop and request_runtime_interrupt share.
CREATE OR REPLACE FUNCTION runtime_job_can_interrupt(p_job_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE((SELECT 'interrupt' = ANY(s.capabilities) FROM current_runtime_job_selection(p_job_id) s
                   WHERE s.id IS NOT NULL), false);
$$;

-- A launch: the job's selection, recorded on its first launch and reused on
-- every later one, and an attempt appended. Called by whoever launches — the
-- Codex chat worker after its channel opens, the supervisor before an
-- executor's spawn — while it holds the job's lease.
CREATE OR REPLACE FUNCTION record_runtime_dispatch(p_job_id bigint, p_worker_id text, p_launch jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_job runtime_jobs%ROWTYPE; v_run task_runs%ROWTYPE; v_grant workspace_access_grants%ROWTYPE;
  v_assignment project_agent_assignments%ROWTYPE; v_runtime text; v_selection runtime_job_selections%ROWTYPE;
  v_capabilities text[]; v_attempt runtime_dispatch_attempts%ROWTYPE; v_reused boolean := true;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'in_flight' OR v_job.leased_by IS DISTINCT FROM p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    PERFORM refuse('run_command_not_leased', format('job %s is not leased by %s', p_job_id, p_worker_id));
  END IF;
  -- Every term IS DISTINCT FROM, not <>: a missing key is NULL, and one NULL
  -- term makes the whole OR NULL, which IF reads as false — the hole 0068
  -- closed in a guard and f519986 in a test.
  IF p_launch IS NULL OR jsonb_typeof(p_launch) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_launch->'capabilities') IS DISTINCT FROM 'array'
     OR COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p_launch->'capabilities')='array' THEN p_launch->'capabilities' END),0)=0
     OR COALESCE(p_launch->>'runtime','')='' OR COALESCE(p_launch->>'adapter_version','')=''
     OR COALESCE(p_launch->>'executable','')='' OR COALESCE(p_launch->>'surface','')=''
     OR COALESCE(p_launch->>'capability_verification','') NOT IN ('verified','unverified') THEN
    PERFORM refuse('runtime_selection_invalid', 'a launch names its runtime, adapter version, executable, surface, capabilities and verification', '22023');
  END IF;
  SELECT array_agg(value ORDER BY value) INTO v_capabilities FROM jsonb_array_elements_text(p_launch->'capabilities');

  v_run.id:=active_run_of_job(v_job);
  IF v_run.id IS NOT NULL THEN SELECT * INTO v_run FROM task_runs WHERE id=v_run.id; END IF;
  SELECT * INTO v_grant FROM workspace_access_grants
  WHERE run_id=v_run.id ORDER BY (revoked_at IS NULL) DESC, issued_at DESC LIMIT 1;
  IF v_grant.id IS NULL THEN
    PERFORM refuse('runtime_selection_no_grant', format('run %s of job %s holds no workspace grant', v_run.id, p_job_id));
  END IF;
  SELECT * INTO v_assignment FROM project_agent_assignments WHERE id=v_grant.assignment_id;
  SELECT rp.runtime_type INTO v_runtime FROM runtime_profiles rp WHERE rp.id=v_assignment.runtime_profile_id;
  IF v_runtime IS DISTINCT FROM p_launch->>'runtime' THEN
    PERFORM refuse('runtime_selection_mismatch',
      format('job %s selected %s through its assignment, and the launch is %s', p_job_id, v_runtime, p_launch->>'runtime'));
  END IF;

  v_selection:=current_runtime_job_selection(p_job_id);
  IF v_selection.id IS NULL OR v_selection.source='backfill' THEN
    INSERT INTO runtime_job_selections(job_id,project_id,task_id,source,supersedes,supersede_reason,
      assignment_id,agent_id,runtime_type,adapter_version,runtime_version,verified_runtime_version,
      capability_verification,capabilities,session_id,access_mode,model,selected_by)
    VALUES(v_job.id,v_job.project_id,v_job.task_id,
      CASE WHEN v_selection.id IS NULL THEN 'launch' ELSE 'supersede' END,
      v_selection.id, CASE WHEN v_selection.id IS NULL THEN NULL ELSE 'the first launch recorded under 0071 replaces a backfilled selection' END,
      v_assignment.id,v_assignment.agent_id,v_runtime,p_launch->>'adapter_version',p_launch->>'runtime_version',
      p_launch->>'verified_runtime_version',p_launch->>'capability_verification',v_capabilities,
      v_run.session_id,v_grant.mode,NULLIF(p_launch->>'model',''),p_worker_id)
    RETURNING * INTO v_selection;
    v_reused:=false;
  ELSIF v_selection.assignment_id IS DISTINCT FROM v_assignment.id
     OR v_selection.runtime_type IS DISTINCT FROM v_runtime
     OR v_selection.access_mode IS DISTINCT FROM v_grant.mode THEN
    -- A retry that would run for another assignment, on another runtime or
    -- with other access. Recording it over the first selection is exactly the
    -- history this table exists to keep, and choosing it is not a launcher's.
    PERFORM refuse('runtime_selection_changed',
      format('job %s was selected as %s for assignment %s with %s access, and this launch is %s for %s with %s',
        p_job_id, v_selection.runtime_type, v_selection.assignment_id, v_selection.access_mode,
        v_runtime, v_assignment.id, v_grant.mode));
  ELSIF v_selection.adapter_version IS DISTINCT FROM p_launch->>'adapter_version'
     OR v_selection.runtime_version IS DISTINCT FROM p_launch->>'runtime_version'
     OR v_selection.capabilities IS DISTINCT FROM v_capabilities THEN
    -- The same selection on a host whose runtime or driver moved between
    -- attempts (a `runtime install`, a release). Not an update: a superseding
    -- selection that names the old one and says what changed.
    INSERT INTO runtime_job_selections(job_id,project_id,task_id,source,supersedes,supersede_reason,
      assignment_id,agent_id,runtime_type,adapter_version,runtime_version,verified_runtime_version,
      capability_verification,capabilities,session_id,access_mode,model,selected_by)
    VALUES(v_job.id,v_job.project_id,v_job.task_id,'supersede',v_selection.id,
      left(format('the runtime moved between attempts: adapter %s -> %s, runtime %s -> %s%s',
        v_selection.adapter_version, p_launch->>'adapter_version',
        COALESCE(v_selection.runtime_version,'unknown'), COALESCE(p_launch->>'runtime_version','unknown'),
        CASE WHEN v_selection.capabilities IS DISTINCT FROM v_capabilities THEN ', declared capabilities changed' ELSE '' END),500),
      v_assignment.id,v_assignment.agent_id,v_runtime,p_launch->>'adapter_version',p_launch->>'runtime_version',
      p_launch->>'verified_runtime_version',p_launch->>'capability_verification',v_capabilities,
      v_selection.session_id,v_grant.mode,COALESCE(NULLIF(p_launch->>'model',''),v_selection.model),p_worker_id)
    RETURNING * INTO v_selection;
    v_reused:=false;
  END IF;

  INSERT INTO runtime_dispatch_attempts(job_id,selection_id,attempt_number,run_id,runtime_type,executable,
    adapter_version,runtime_version,capability_verification,session_id,native_session_id,grant_id,access_mode,
    worker_id,surface)
  VALUES(v_job.id,v_selection.id,GREATEST(v_job.attempt_count,1),v_run.id,v_runtime,p_launch->>'executable',
    p_launch->>'adapter_version',p_launch->>'runtime_version',p_launch->>'capability_verification',
    v_run.session_id,NULLIF(p_launch->>'native_session_id',''),v_grant.id,v_grant.mode,p_worker_id,p_launch->>'surface')
  RETURNING * INTO v_attempt;

  RETURN jsonb_build_object('selection_id',v_selection.id,'selection_reused',v_reused,'attempt_id',v_attempt.id,
    'attempt_number',v_attempt.attempt_number,'runtime_type',v_runtime,'access_mode',v_grant.mode,
    'assignment_id',v_assignment.id,'grant_id',v_grant.id);
END $$;

-- The attempt's end: the runtime's own result, once.
CREATE OR REPLACE FUNCTION finish_runtime_dispatch_attempt(
  p_attempt_id bigint, p_worker_id text, p_native_result jsonb, p_native_session_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_attempt runtime_dispatch_attempts%ROWTYPE;
BEGIN
  SELECT * INTO v_attempt FROM runtime_dispatch_attempts WHERE id=p_attempt_id AND worker_id=p_worker_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('runtime_dispatch_not_found', format('no attempt %s by %s', p_attempt_id, p_worker_id));
  END IF;
  IF v_attempt.native_result IS NOT NULL THEN
    IF v_attempt.native_result=p_native_result THEN
      RETURN jsonb_build_object('attempt_id',v_attempt.id,'repeat',true);
    END IF;
    PERFORM refuse('runtime_dispatch_attempt_immutable', format('attempt %s already recorded its result', p_attempt_id));
  END IF;
  IF p_native_result IS NULL OR jsonb_typeof(p_native_result)<>'object' OR octet_length(p_native_result::text)>8192 THEN
    PERFORM refuse('runtime_selection_invalid', 'a native result is a JSON object of at most 8 KiB', '22023');
  END IF;
  UPDATE runtime_dispatch_attempts SET native_result=p_native_result,finished_at=clock_timestamp(),
    native_session_id=COALESCE(native_session_id,NULLIF(p_native_session_id,''))
  WHERE id=p_attempt_id RETURNING * INTO v_attempt;
  RETURN jsonb_build_object('attempt_id',v_attempt.id,'repeat',false);
END $$;

-- Reselection, deliberately: a new selection naming the one it replaces and
-- why. The job's attempts after it run under the new one.
CREATE OR REPLACE FUNCTION supersede_runtime_job_selection(p_job_id bigint, p_actor text, p_reason text, p_selection jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_old runtime_job_selections%ROWTYPE; v_new runtime_job_selections%ROWTYPE; v_capabilities text[];
BEGIN
  v_old:=current_runtime_job_selection(p_job_id);
  IF v_old.id IS NULL THEN
    PERFORM refuse('runtime_dispatch_not_found', format('job %s has no selection to supersede', p_job_id));
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    PERFORM refuse('runtime_selection_invalid', 'a superseding selection says why', '22023');
  END IF;
  SELECT array_agg(value ORDER BY value) INTO v_capabilities FROM jsonb_array_elements_text(p_selection->'capabilities');
  INSERT INTO runtime_job_selections(job_id,project_id,task_id,source,supersedes,supersede_reason,
    assignment_id,agent_id,runtime_type,adapter_version,runtime_version,verified_runtime_version,
    capability_verification,capabilities,session_id,access_mode,model,selected_by)
  SELECT v_old.job_id,v_old.project_id,v_old.task_id,'supersede',v_old.id,left(trim(p_reason),500),
    COALESCE((p_selection->>'assignment_id')::uuid,v_old.assignment_id),
    COALESCE((SELECT agent_id FROM project_agent_assignments WHERE id=(p_selection->>'assignment_id')::uuid),v_old.agent_id),
    COALESCE(p_selection->>'runtime',v_old.runtime_type),COALESCE(p_selection->>'adapter_version',v_old.adapter_version),
    COALESCE(p_selection->>'runtime_version',v_old.runtime_version),
    COALESCE(p_selection->>'verified_runtime_version',v_old.verified_runtime_version),
    COALESCE(p_selection->>'capability_verification',v_old.capability_verification),
    COALESCE(v_capabilities,v_old.capabilities),v_old.session_id,
    COALESCE(p_selection->>'access_mode',v_old.access_mode),COALESCE(p_selection->>'model',v_old.model),p_actor
  RETURNING * INTO v_new;
  RETURN jsonb_build_object('selection_id',v_new.id,'supersedes',v_old.id);
END $$;

-- Usage in a conversation, attributed by what ran. Tokens are the runtime's own
-- step events, which carry the runtime that emitted them; attempts are counted
-- per job under the runtime its selection recorded. Nothing is inferred from a
-- job type. The owner check is the panel's, kept here with the query.
CREATE OR REPLACE FUNCTION conversation_runtime_usage(p_project_id uuid, p_task_id uuid, p_owner_id uuid)
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH lineage AS (
    SELECT member.id
    FROM tasks t JOIN projects p ON p.id=t.project_id
    JOIN tasks member ON member.conversation_id=t.conversation_id
    WHERE t.id=p_task_id AND t.project_id=p_project_id AND p.owner_id=p_owner_id
  ), usage AS (
    SELECT e.runtime_type,
      COALESCE(sum((e.details#>>'{tokens,input}')::bigint),0) AS input_tokens,
      COALESCE(sum((e.details#>>'{tokens,output}')::bigint),0) AS output_tokens,
      COALESCE(sum((e.details#>>'{tokens,reasoning}')::bigint),0) AS reasoning_tokens,
      COALESCE(sum((e.details#>>'{tokens,cache,read}')::bigint),0) AS cache_read_tokens,
      COALESCE(sum((e.details#>>'{tokens,cache,write}')::bigint),0) AS cache_write_tokens,
      COALESCE(sum((e.details#>>'{tokens,total}')::bigint),0) AS total_tokens,
      count(*) AS model_steps,COALESCE(sum((e.details->>'cost')::numeric),0) AS cost,
      max(e.occurred_at) AS updated_at
    FROM runtime_activity_events e
    WHERE e.task_id IN (SELECT id FROM lineage) AND e.event_type='runtime.turn.usage'
    GROUP BY e.runtime_type
  ), attempts AS (
    SELECT s.runtime_type, sum(j.attempt_count) AS attempts
    FROM runtime_jobs j
    CROSS JOIN LATERAL current_runtime_job_selection(j.id) s
    WHERE j.task_id IN (SELECT id FROM lineage) AND s.id IS NOT NULL
    GROUP BY s.runtime_type
  )
  SELECT jsonb_build_object('runtime_type',COALESCE(u.runtime_type,a.runtime_type),
    'input_tokens',COALESCE(u.input_tokens,0),'output_tokens',COALESCE(u.output_tokens,0),
    'reasoning_tokens',COALESCE(u.reasoning_tokens,0),'cache_read_tokens',COALESCE(u.cache_read_tokens,0),
    'cache_write_tokens',COALESCE(u.cache_write_tokens,0),'total_tokens',COALESCE(u.total_tokens,0),
    'model_steps',COALESCE(u.model_steps,0),'attempts',COALESCE(a.attempts,0),
    'cost',COALESCE(u.cost,0),'updated_at',u.updated_at)
  FROM usage u FULL JOIN attempts a ON a.runtime_type=u.runtime_type
  ORDER BY COALESCE(u.runtime_type,a.runtime_type);
$$;

-- Backfill: every existing job gets the runtime its run's session or its
-- assignment names — the same joins the panel used to make at read time — and
-- nothing it cannot know.
INSERT INTO runtime_job_selections(job_id,project_id,task_id,source,assignment_id,agent_id,runtime_type,
  session_id,access_mode,selected_by,selected_at)
SELECT j.id,j.project_id,j.task_id,'backfill',
  COALESCE(epa.id,opa.id),COALESCE(epa.agent_id,opa.agent_id),
  COALESCE(srp.runtime_type,erp.runtime_type,orp.runtime_type),
  CASE WHEN tr.id IS NOT NULL THEN tr.session_id END,
  CASE WHEN j.job_type='start_implementation' THEN 'read_write' ELSE 'read_only' END,
  '0071',j.created_at
FROM runtime_jobs j
JOIN tasks t ON t.id=j.task_id
JOIN project_agent_assignments opa ON opa.id=t.orchestrator_assignment_id
JOIN runtime_profiles orp ON orp.id=opa.runtime_profile_id
LEFT JOIN task_runs tr ON tr.id=j.run_id
  AND ((j.job_type='start_implementation' AND tr.write_capable) OR (j.job_type<>'start_implementation' AND NOT tr.write_capable))
LEFT JOIN agent_sessions ss ON ss.id=tr.session_id
LEFT JOIN runtime_profiles srp ON srp.id=ss.runtime_profile_id
LEFT JOIN domain_events se ON se.id=j.source_event_id AND j.job_type='start_implementation'
LEFT JOIN handoffs h ON h.id=NULLIF(se.payload->>'handoff_id','')::uuid
LEFT JOIN project_agent_assignments epa ON epa.id=h.executor_assignment_id
LEFT JOIN runtime_profiles erp ON erp.id=epa.runtime_profile_id
WHERE NOT EXISTS (SELECT 1 FROM runtime_job_selections s WHERE s.job_id=j.id);

-- request_runtime_interrupt, redefined from 0070 under the same signature,
-- grant and SECURITY DEFINER: a job whose recorded driver does not declare
-- `interrupt` is refused before anything is written. A job not yet launched
-- has no record, and its request waits on the job as 0070 made it.
CREATE OR REPLACE FUNCTION request_runtime_interrupt(
  p_project_id uuid,p_task_id uuid,p_actor_id text,p_reason text,p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_runtime text; v_task tasks%ROWTYPE; v_event domain_events%ROWTYPE;
  v_command jsonb; v_selection runtime_job_selections%ROWTYPE;
BEGIN
  SELECT j.* INTO v_job FROM runtime_jobs j
  WHERE j.project_id=p_project_id AND j.task_id=p_task_id AND j.status='in_flight'
  ORDER BY j.id DESC LIMIT 1 FOR UPDATE;
  IF v_job.id IS NULL THEN
    PERFORM refuse('run_command_no_active_run', 'no active runtime job is available');
  END IF;
  v_selection:=current_runtime_job_selection(v_job.id);
  IF v_selection.source IN ('launch','supersede') AND NOT ('interrupt' = ANY(v_selection.capabilities)) THEN
    PERFORM refuse('run_command_unsupported',
      format('%s''s driver, as recorded for job %s, does not declare interrupt', v_selection.runtime_type, v_job.id));
  END IF;
  v_runtime:=v_selection.runtime_type;
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

ALTER FUNCTION guard_runtime_provenance() SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION current_runtime_job_selection(bigint) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION runtime_job_can_interrupt(bigint) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION record_runtime_dispatch(bigint,text,jsonb) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION finish_runtime_dispatch_attempt(bigint,text,jsonb,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION supersede_runtime_job_selection(bigint,text,text,jsonb) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION conversation_runtime_usage(uuid,uuid,uuid) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION request_runtime_interrupt(uuid,uuid,text,text,text) SET search_path=control_plane,public,extensions,pg_temp;

REVOKE EXECUTE ON FUNCTION guard_runtime_provenance() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION current_runtime_job_selection(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime_job_can_interrupt(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_runtime_dispatch(bigint,text,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finish_runtime_dispatch_attempt(bigint,text,jsonb,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION supersede_runtime_job_selection(bigint,text,text,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION conversation_runtime_usage(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guard_runtime_provenance() TO infra_worker;
GRANT EXECUTE ON FUNCTION current_runtime_job_selection(bigint) TO infra_worker;
GRANT EXECUTE ON FUNCTION runtime_job_can_interrupt(bigint) TO infra_worker;
GRANT EXECUTE ON FUNCTION record_runtime_dispatch(bigint,text,jsonb) TO infra_worker;
GRANT EXECUTE ON FUNCTION finish_runtime_dispatch_attempt(bigint,text,jsonb,text) TO infra_worker;
-- Read-only, for the panel: the Stop button's answer and the usage card, both
-- definers like every web-facing function (0062), the usage one checking the
-- owner itself. A deliberate widening of infra_web's surface, listed in 0026's
-- allowlist.
GRANT EXECUTE ON FUNCTION runtime_job_can_interrupt(bigint) TO infra_web;
GRANT EXECUTE ON FUNCTION conversation_runtime_usage(uuid,uuid,uuid) TO infra_web;
