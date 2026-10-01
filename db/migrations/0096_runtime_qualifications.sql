-- Qualifications of runtime versions on this host (Stage 12 W3,
-- docs/RUNTIMES_AND_MODELS_DESIGN.md §3.2, §5.2).
--
-- `infra-cod runtime qualify <name> --version <exact>` installs a candidate
-- beside the active version — never instead of it — and runs a fixed list of
-- checks, one row each. A qualification is `passed` only when it is complete
-- (every check in the suite ran) and every check passed; a lost lease, a limit
-- or a check not yet built makes it `incomplete`, never `passed`. Only a
-- passed qualification may later promote a version (W4). Append-only: the
-- evidence is the audit.

SET search_path TO control_plane, public, extensions;

CREATE TABLE runtime_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_type text NOT NULL CHECK (runtime_type IN ('codex','opencode','claude','antigravity')),
  version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  adapter_version text NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 32),
  release_version text NOT NULL CHECK (length(release_version) BETWEEN 1 AND 64),
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 120),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  -- running → passed | failed | incomplete. `refused` is a qualification that
  -- stopped before installing anything (a host requirement not met).
  result text NOT NULL DEFAULT 'running' CHECK (result IN ('running','passed','failed','incomplete','refused')),
  summary text NOT NULL DEFAULT '' CHECK (length(summary) <= 1000),
  -- Facts about the host the result depends on (kernel LSMs, the userns
  -- sysctl) — facts, never secrets; bounded.
  host_facts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(host_facts) = 'object' AND length(host_facts::text) <= 4096),
  CHECK ((result = 'running') = (finished_at IS NULL))
);
CREATE INDEX runtime_qualifications_by_version ON runtime_qualifications(runtime_type, version, started_at DESC);

CREATE TABLE runtime_qualification_checks (
  qualification_id uuid NOT NULL REFERENCES runtime_qualifications(id),
  check_key text NOT NULL CHECK (check_key ~ '^[a-z][a-z0-9_.]{1,63}$'),
  capability text NOT NULL DEFAULT '' CHECK (length(capability) <= 64),
  result text NOT NULL CHECK (result IN ('passed','failed','skipped','inconclusive')),
  -- The evals taxonomy (Paperclip survey §8): what kind of thing failed.
  failure_class text NOT NULL DEFAULT '' CHECK (failure_class IN ('','runtime','host','infrastructure','harness')),
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 1000),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object' AND length(evidence::text) <= 8192),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (qualification_id, check_key),
  CHECK (result <> 'failed' OR failure_class <> '')
);

CREATE FUNCTION begin_runtime_qualification(p_runtime_type text, p_version text, p_adapter_version text, p_release_version text, p_requested_by text, p_host_facts jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  -- One at a time per runtime: a qualification still running is either alive
  -- or was killed, and a second one beside it would share the scratch state.
  IF EXISTS (SELECT 1 FROM runtime_qualifications WHERE runtime_type = p_runtime_type AND result = 'running'
             AND started_at > clock_timestamp() - interval '2 hours') THEN
    RAISE EXCEPTION 'a qualification of % is already running', p_runtime_type USING ERRCODE='55006',
      DETAIL=jsonb_build_object('reason','runtime_qualification_running')::text;
  END IF;
  -- One left running for two hours was killed; it is closed as incomplete.
  UPDATE runtime_qualifications SET result = 'incomplete', finished_at = clock_timestamp(),
    summary = 'abandoned: still running after two hours'
  WHERE runtime_type = p_runtime_type AND result = 'running';
  INSERT INTO runtime_qualifications(runtime_type, version, adapter_version, release_version, requested_by, host_facts)
  VALUES (p_runtime_type, p_version, p_adapter_version, p_release_version, p_requested_by, COALESCE(p_host_facts, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION record_qualification_check(p_qualification_id uuid, p_check_key text, p_capability text, p_result text, p_failure_class text, p_duration_ms integer, p_detail text, p_evidence jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM runtime_qualifications WHERE id = p_qualification_id AND result = 'running') THEN
    RAISE EXCEPTION 'qualification % is not running', p_qualification_id USING ERRCODE='55000',
      DETAIL=jsonb_build_object('reason','runtime_qualification_not_running')::text;
  END IF;
  INSERT INTO runtime_qualification_checks(qualification_id, check_key, capability, result, failure_class, duration_ms, detail, evidence)
  VALUES (p_qualification_id, p_check_key, COALESCE(p_capability,''), p_result, COALESCE(p_failure_class,''),
    GREATEST(COALESCE(p_duration_ms,0),0), left(COALESCE(p_detail,''),1000), COALESCE(p_evidence,'{}'::jsonb));
END $$;

-- The result is derived here, not taken from the caller: passed only when the
-- suite is complete and nothing failed.
CREATE FUNCTION finish_runtime_qualification(p_qualification_id uuid, p_suite text[], p_refused boolean DEFAULT false, p_summary text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_failed int; v_missing int; v_open int; v_result text;
BEGIN
  SELECT count(*) FILTER (WHERE c.result = 'failed'),
         count(*) FILTER (WHERE c.result IN ('skipped','inconclusive'))
    INTO v_failed, v_open
  FROM runtime_qualification_checks c WHERE c.qualification_id = p_qualification_id;
  SELECT count(*) INTO v_missing FROM unnest(COALESCE(p_suite, ARRAY[]::text[])) s(key)
  WHERE NOT EXISTS (SELECT 1 FROM runtime_qualification_checks c WHERE c.qualification_id = p_qualification_id AND c.check_key = s.key);
  v_result := CASE WHEN p_refused THEN 'refused' WHEN v_failed > 0 THEN 'failed'
                   WHEN v_missing > 0 OR v_open > 0 OR COALESCE(array_length(p_suite,1),0) = 0 THEN 'incomplete'
                   ELSE 'passed' END;
  UPDATE runtime_qualifications SET result = v_result, finished_at = clock_timestamp(), summary = left(COALESCE(p_summary,''),1000)
  WHERE id = p_qualification_id AND result = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'qualification % is not running', p_qualification_id USING ERRCODE='55000',
      DETAIL=jsonb_build_object('reason','runtime_qualification_not_running')::text;
  END IF;
  RETURN jsonb_build_object('id', p_qualification_id, 'result', v_result, 'failed', v_failed, 'open', v_open, 'missing', v_missing);
END $$;

-- For the panel: the latest qualification of each version the watch knows or
-- the host qualified, with its checks.
CREATE FUNCTION get_runtime_qualifications()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', q.id, 'runtime', q.runtime_type, 'version', q.version, 'result', q.result,
    'started_at', q.started_at, 'finished_at', q.finished_at, 'summary', q.summary,
    'checks', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'check', c.check_key, 'result', c.result, 'failure_class', NULLIF(c.failure_class,''),
        'detail', c.detail, 'duration_ms', c.duration_ms) ORDER BY c.recorded_at)
      FROM runtime_qualification_checks c WHERE c.qualification_id = q.id), '[]'::jsonb)
  ) ORDER BY q.runtime_type, q.started_at DESC), '[]'::jsonb)
  FROM (
    SELECT DISTINCT ON (runtime_type, version) *
    FROM runtime_qualifications ORDER BY runtime_type, version, started_at DESC
  ) q;
$$;

REVOKE ALL ON runtime_qualifications, runtime_qualification_checks FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION begin_runtime_qualification(text,text,text,text,text,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_qualification_check(uuid,text,text,text,text,integer,text,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finish_runtime_qualification(uuid,text[],boolean,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_runtime_qualifications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION begin_runtime_qualification(text,text,text,text,text,jsonb) TO infra_worker;
GRANT EXECUTE ON FUNCTION record_qualification_check(uuid,text,text,text,text,integer,text,jsonb) TO infra_worker;
GRANT EXECUTE ON FUNCTION finish_runtime_qualification(uuid,text[],boolean,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION get_runtime_qualifications() TO infra_web;
