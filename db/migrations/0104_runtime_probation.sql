-- Probation after a runtime promotion (Stage 12 W4b,
-- docs/RUNTIMES_AND_MODELS_DESIGN.md §3.4, decision R11).
--
-- A promoted version is on probation for its first three task runs or 24
-- hours, whichever is later. A run on it that fails in a way the qualification
-- suite checks — the runtime crashed, its sandbox refused, its stream could not
-- be read, a resume was refused — is a runtime-class failure, and the probation
-- timer rolls the runtime back by itself. A model's or a provider's failure, a
-- limit, a timeout or an operator's interrupt never does: those say nothing
-- about the version.
--
-- The classification is deliberately narrow. A false rollback takes a working
-- version away from every team on the host; a missed one leaves a failing
-- version the operator can still roll back by hand. So an exit code alone is
-- not evidence — a provider refusing a model exits non-zero too.

SET search_path TO control_plane, public, extensions;

ALTER TABLE runtime_activations
  ADD COLUMN probation_until timestamptz,
  ADD COLUMN probation_runs integer CHECK (probation_runs IS NULL OR probation_runs BETWEEN 0 AND 100),
  ADD COLUMN probation_ended_at timestamptz,
  ADD COLUMN probation_result text CHECK (probation_result IN ('passed','rolled_back','superseded')),
  ADD COLUMN probation_detail text NOT NULL DEFAULT '' CHECK (length(probation_detail) <= 500),
  ADD CONSTRAINT runtime_activations_probation_ends_once CHECK ((probation_ended_at IS NULL) = (probation_result IS NULL));

-- A promotion opens a probation; any later activation of the same runtime
-- closes the one still open — a rollback as rolled back, a promotion as
-- superseded.
CREATE FUNCTION runtime_activation_probation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  UPDATE runtime_activations
  SET probation_ended_at = NEW.activated_at,
      probation_result = CASE WHEN NEW.kind = 'rollback' THEN 'rolled_back' ELSE 'superseded' END,
      probation_detail = CASE WHEN NEW.kind = 'rollback' AND probation_detail = '' THEN left(COALESCE(NEW.reason,''),500) ELSE probation_detail END
  WHERE runtime_type = NEW.runtime_type AND kind = 'promote' AND probation_ended_at IS NULL AND id <> NEW.id;
  IF NEW.kind = 'promote' THEN
    NEW.probation_until := NEW.activated_at + interval '24 hours';
    NEW.probation_runs := 3;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER runtime_activations_probation BEFORE INSERT ON runtime_activations
FOR EACH ROW EXECUTE FUNCTION runtime_activation_probation();

-- What kind of failure a finished dispatch attempt was, from what the worker
-- recorded (0071's native_result). 'runtime' only on evidence the suite would
-- have caught; 'none' for a run that ended well; 'other' for everything else.
CREATE FUNCTION runtime_dispatch_failure_class(p_result jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT CASE
    WHEN p_result IS NULL THEN 'other'
    WHEN COALESCE((p_result->>'interrupted')::boolean, false) OR COALESCE((p_result->>'timed_out')::boolean, false)
      OR p_result->>'status' IN ('interrupted','not_reported') THEN 'other'
    WHEN p_result->>'status' = 'completed' OR (p_result->>'status' = 'exited' AND p_result->>'exit_code' = '0') THEN 'none'
    -- A limit or a model refusal is the provider's answer, whatever else the
    -- message says.
    WHEN COALESCE(p_result->>'error','') ~* '(usage limit|rate limit|quota|too many requests|\m429\M|insufficient (credit|balance|funds)|model[_ ]not[_ ]found|not in your plan|unsupported model|does not exist|no endpoint)' THEN 'other'
    -- The process died of a signal it did not ask for.
    WHEN p_result->>'status' = 'exited' AND p_result->>'signal' IN ('SIGSEGV','SIGABRT','SIGBUS','SIGILL','SIGFPE','SIGTRAP','SIGSYS') THEN 'runtime'
    -- What the qualification suite checks: the sandbox, the stream, resume,
    -- the executable itself.
    WHEN p_result->>'status' IN ('failed','launch_failed','exited')
      AND COALESCE(p_result->>'error','') ~* '(panicked at|bubblewrap|bwrap|landlock|sandbox (error|denied|failed)|could not parse|unparsable|unparsed|unexpected token|invalid json|thread/resume|no rollout found|session not found|exec format error|ENOEXEC|cannot execute|GLIBC_)' THEN 'runtime'
    ELSE 'other'
  END;
$$;

-- The verdict on the open probation of one runtime, from the dispatch
-- attempts made at the promoted version since it was activated.
CREATE FUNCTION runtime_probation_verdict(p_runtime_type text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_activation runtime_activations%ROWTYPE; v_runs integer; v_failures jsonb;
BEGIN
  SELECT * INTO v_activation FROM runtime_activations
  WHERE runtime_type = p_runtime_type AND kind = 'promote' AND probation_ended_at IS NULL
  ORDER BY activated_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('runtime', p_runtime_type, 'state', 'none');
  END IF;
  SELECT count(*) FILTER (WHERE a.finished_at IS NOT NULL),
         COALESCE(jsonb_agg(jsonb_build_object('attempt_id', a.id, 'job_id', a.job_id, 'at', a.finished_at,
           'status', a.native_result->>'status', 'signal', a.native_result->>'signal',
           'error', left(COALESCE(a.native_result->>'error',''), 200)) ORDER BY a.id)
           FILTER (WHERE runtime_dispatch_failure_class(a.native_result) = 'runtime'), '[]'::jsonb)
    INTO v_runs, v_failures
  FROM runtime_dispatch_attempts a
  WHERE a.runtime_type = p_runtime_type AND a.runtime_version = v_activation.version
    AND a.started_at >= v_activation.activated_at;
  RETURN jsonb_build_object(
    'runtime', p_runtime_type, 'activation_id', v_activation.id,
    'version', v_activation.version, 'from', v_activation.from_version,
    'until', v_activation.probation_until, 'runs_seen', v_runs, 'runs_required', v_activation.probation_runs,
    'failures', v_failures,
    'state', CASE
      WHEN jsonb_array_length(v_failures) > 0 THEN 'failing'
      WHEN v_runs >= v_activation.probation_runs AND clock_timestamp() >= v_activation.probation_until THEN 'passed'
      ELSE 'running' END);
END $$;

-- Closes a probation that passed. A rollback closes its own through the
-- trigger, when the rollback is recorded.
CREATE FUNCTION end_runtime_probation(p_activation_id uuid, p_detail text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_verdict jsonb; v_runtime text;
BEGIN
  SELECT runtime_type INTO v_runtime FROM runtime_activations WHERE id = p_activation_id AND probation_ended_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activation % has no open probation', p_activation_id USING ERRCODE='55000',
      DETAIL=jsonb_build_object('reason','runtime_probation_not_open')::text;
  END IF;
  v_verdict := runtime_probation_verdict(v_runtime);
  IF v_verdict->>'state' <> 'passed' OR (v_verdict->>'activation_id')::uuid <> p_activation_id THEN
    RAISE EXCEPTION 'the probation of % has not passed: %', v_runtime, v_verdict->>'state' USING ERRCODE='55000',
      DETAIL=jsonb_build_object('reason','runtime_probation_not_passed')::text;
  END IF;
  UPDATE runtime_activations SET probation_ended_at = clock_timestamp(), probation_result = 'passed',
    probation_detail = left(COALESCE(p_detail,''),500)
  WHERE id = p_activation_id;
  RETURN v_verdict || jsonb_build_object('state', 'passed', 'ended', true);
END $$;

-- The panel's view gains the probation; the keys it had are unchanged.
CREATE OR REPLACE FUNCTION get_runtime_activations()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'runtime', a.runtime_type, 'kind', a.kind, 'version', a.version, 'from', a.from_version,
    'qualification_id', a.qualification_id, 'accepted_unqualified', a.accepted_unqualified,
    'reason', NULLIF(a.reason,''), 'actor', a.actor, 'at', a.activated_at,
    'probation', CASE WHEN a.kind = 'promote' THEN jsonb_build_object(
      'until', a.probation_until, 'runs_required', a.probation_runs,
      'ended_at', a.probation_ended_at, 'result', a.probation_result, 'detail', NULLIF(a.probation_detail,''),
      'verdict', CASE WHEN a.probation_ended_at IS NULL THEN runtime_probation_verdict(a.runtime_type) END) END
  ) ORDER BY a.activated_at DESC), '[]'::jsonb)
  FROM (SELECT * FROM runtime_activations ORDER BY activated_at DESC LIMIT 50) a;
$$;

-- The promotion recorded before this migration (rc.82, OpenCode 1.18.32) is on
-- probation from when it happened.
UPDATE runtime_activations SET probation_until = activated_at + interval '24 hours', probation_runs = 3
WHERE kind = 'promote' AND probation_until IS NULL
  AND id = (SELECT id FROM runtime_activations r2 WHERE r2.runtime_type = runtime_activations.runtime_type
            ORDER BY activated_at DESC LIMIT 1);
UPDATE runtime_activations SET probation_ended_at = activated_at, probation_result = 'superseded'
WHERE kind = 'promote' AND probation_until IS NULL;

REVOKE EXECUTE ON FUNCTION runtime_activation_probation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime_probation_verdict(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION end_runtime_probation(uuid,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime_dispatch_failure_class(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runtime_probation_verdict(text) TO infra_worker;
GRANT EXECUTE ON FUNCTION end_runtime_probation(uuid,text) TO infra_worker;
