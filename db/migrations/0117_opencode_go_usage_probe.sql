-- OpenCode Go's usage probe (ADR-0019): what it may report, and when it is due.
--
-- The probe runs as opencode-worker and reads the Go key itself; the platform
-- sees one line of numbers, which the supervisor checks and this function checks
-- again. A 403 from the endpoint means the key has no Go subscription — a state
-- the panel says in words, so it gets its own class.

SET search_path TO control_plane, public, extensions;

ALTER TABLE provider_usage_readings DROP CONSTRAINT IF EXISTS provider_usage_readings_error_class_check;
ALTER TABLE provider_usage_readings ADD CONSTRAINT provider_usage_readings_error_class_check
  CHECK (error_class IN ('unauthorized','unavailable','malformed','timeout','not_subscribed'));

CREATE OR REPLACE FUNCTION usage_reading_clean(p_reading jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  WITH r AS (SELECT CASE WHEN jsonb_typeof(p_reading) = 'object' THEN p_reading ELSE '{}'::jsonb END AS v),
  w AS (
    SELECT e.value AS v, e.ordinality AS n
    FROM r, jsonb_array_elements(CASE WHEN jsonb_typeof(r.v->'windows') = 'array' THEN r.v->'windows' ELSE '[]'::jsonb END)
      WITH ORDINALITY e
    WHERE e.ordinality <= 8 AND jsonb_typeof(e.value) = 'object'
      AND e.value->>'key' ~ '^[a-z0-9_]{1,40}$'
      AND jsonb_typeof(e.value->'used_percent') = 'number'
      AND (e.value->>'used_percent')::numeric BETWEEN 0 AND 100
  ),
  c AS (SELECT CASE WHEN jsonb_typeof(r.v->'credits') = 'object' THEN r.v->'credits' END AS v FROM r)
  SELECT jsonb_build_object(
    'windows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'key', w.v->>'key',
        'used_percent', trim_scale(round((w.v->>'used_percent')::numeric, 1)),
        'resets_at', CASE WHEN jsonb_typeof(w.v->'resets_at') = 'number'
                            AND (w.v->>'resets_at')::numeric BETWEEN 1600000000 AND 4100000000
                          THEN floor((w.v->>'resets_at')::numeric)::bigint END,
        'window_minutes', CASE WHEN jsonb_typeof(w.v->'window_minutes') = 'number'
                                 AND (w.v->>'window_minutes')::numeric BETWEEN 1 AND 527040
                               THEN floor((w.v->>'window_minutes')::numeric)::integer END) ORDER BY w.n) FROM w), '[]'::jsonb),
    'plan', CASE WHEN r.v->>'plan' ~ '^[a-z0-9_]{1,40}$' THEN r.v->>'plan' END,
    'credits', CASE WHEN c.v IS NOT NULL THEN jsonb_build_object(
        'has_credits', CASE WHEN jsonb_typeof(c.v->'has_credits') = 'boolean' THEN c.v->'has_credits' END,
        'unlimited', CASE WHEN jsonb_typeof(c.v->'unlimited') = 'boolean' THEN c.v->'unlimited' END,
        'balance', CASE WHEN c.v->>'balance' ~ '^-?[0-9]{1,12}([.][0-9]{1,6})?$' THEN c.v->>'balance' END) END,
    'status', CASE WHEN r.v->>'status' IN ('allowed','allowed_warning','rejected') THEN r.v->>'status' END,
    'error_class', CASE WHEN r.v->>'error_class' IN ('unauthorized','unavailable','malformed','timeout','not_subscribed') THEN r.v->>'error_class' END)
  FROM r, c;
$$;

-- The OpenCode Go connections nobody has read within the interval, for the
-- account worker that asks the supervisor to run the probe. At most one reading
-- per connection per interval, whatever the last one found.
CREATE FUNCTION opencode_go_usage_reads_due(p_every interval)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('connection_id', c.id) ORDER BY c.created_at), '[]'::jsonb)
  FROM provider_connections c
  WHERE c.access_gateway = 'opencode_go' AND c.status = 'connected'
    AND NOT EXISTS (SELECT 1 FROM provider_usage_readings r
                    WHERE r.connection_id = c.id AND r.source = 'probe'
                      AND r.read_at > clock_timestamp() - GREATEST(p_every, interval '5 minutes'));
$$;

REVOKE EXECUTE ON FUNCTION usage_reading_clean(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION opencode_go_usage_reads_due(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION opencode_go_usage_reads_due(interval) TO infra_worker;
