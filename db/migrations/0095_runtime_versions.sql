-- Upstream versions of the agent runtimes, as the host's daily watch sees them
-- (Stage 12 W2, docs/RUNTIMES_AND_MODELS_DESIGN.md §3.1).
--
-- The watch reads the npm registry's metadata for each runtime's platform
-- package — nothing is downloaded, nothing is installed — and records every
-- exact version newer than the one the host runs, with its publish time. The
-- panel shows them; a version younger than 48 hours is shown as not yet
-- offered, because upstream hotfixes land in that window. Qualifying, promoting
-- and rolling back (W3, W4) will add their states to the same rows.

SET search_path TO control_plane, public, extensions;

CREATE TABLE runtime_versions (
  runtime_type text NOT NULL CHECK (runtime_type IN ('codex','opencode','claude','antigravity')),
  version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  published_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- `available` while the registry lists it; `withdrawn` once it is deprecated.
  state text NOT NULL DEFAULT 'available' CHECK (state IN ('available','withdrawn')),
  PRIMARY KEY (runtime_type, version)
);

-- One row per runtime: what the host ran when it last looked, and whether the
-- look worked. A watch that fails says so here instead of leaving yesterday's
-- answer looking current.
CREATE TABLE runtime_watch_state (
  runtime_type text PRIMARY KEY CHECK (runtime_type IN ('codex','opencode','claude','antigravity')),
  active_version text,
  checked_at timestamptz NOT NULL,
  error text NOT NULL DEFAULT '' CHECK (length(error) <= 500)
);

-- Called by the watch (root, as infra_worker). Bounded: at most 50 versions per
-- call, each an exact x.y.z; anything else is refused rather than stored.
CREATE FUNCTION record_runtime_watch(p_runtime_type text, p_active_version text, p_versions jsonb, p_error text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_seen int := 0;
BEGIN
  IF jsonb_typeof(p_versions) <> 'array' OR jsonb_array_length(p_versions) > 50 THEN
    RAISE EXCEPTION 'runtime versions must be an array of at most 50' USING ERRCODE='22023',
      DETAIL=jsonb_build_object('reason','runtime_watch_invalid')::text;
  END IF;
  IF COALESCE(p_error,'') = '' THEN
    INSERT INTO runtime_versions(runtime_type, version, published_at, state)
    SELECT p_runtime_type, v->>'version', (v->>'published_at')::timestamptz,
      CASE WHEN (v->>'deprecated')::boolean THEN 'withdrawn' ELSE 'available' END
    FROM jsonb_array_elements(p_versions) v
    ON CONFLICT (runtime_type, version) DO UPDATE SET
      last_seen_at = clock_timestamp(),
      published_at = COALESCE(EXCLUDED.published_at, runtime_versions.published_at),
      state = EXCLUDED.state;
    GET DIAGNOSTICS v_seen = ROW_COUNT;
  END IF;
  INSERT INTO runtime_watch_state(runtime_type, active_version, checked_at, error)
  VALUES (p_runtime_type, NULLIF(p_active_version,''), clock_timestamp(), left(COALESCE(p_error,''), 500))
  ON CONFLICT (runtime_type) DO UPDATE SET
    active_version = EXCLUDED.active_version, checked_at = EXCLUDED.checked_at, error = EXCLUDED.error;
  RETURN jsonb_build_object('runtime', p_runtime_type, 'recorded', v_seen);
END $$;

-- What the panel shows: per runtime, the active version at the last look, when
-- that was, and the newer versions — each with whether it is offered yet.
CREATE FUNCTION get_runtime_versions()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'runtime', w.runtime_type,
    'active_version', w.active_version,
    'checked_at', w.checked_at,
    'error', NULLIF(w.error, ''),
    'newer', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'version', v.version,
        'published_at', v.published_at,
        'offered_from', v.published_at + interval '48 hours',
        'offered', v.published_at IS NOT NULL AND v.published_at + interval '48 hours' <= clock_timestamp()
      ) ORDER BY string_to_array(v.version, '.')::int[] DESC)
      FROM runtime_versions v
      WHERE v.runtime_type = w.runtime_type AND v.state = 'available'
        AND (w.active_version IS NULL
          OR string_to_array(v.version, '.')::int[] > string_to_array(w.active_version, '.')::int[])
    ), '[]'::jsonb)
  ) ORDER BY w.runtime_type), '[]'::jsonb)
  FROM runtime_watch_state w;
$$;

REVOKE ALL ON runtime_versions, runtime_watch_state FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_runtime_watch(text,text,jsonb,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_runtime_versions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_runtime_watch(text,text,jsonb,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION get_runtime_versions() TO infra_web;
