-- Runtime updates without a terminal (Stage 12, after Pocket Ledger).
--
-- The routine (W1–W8) ran by hand twice — OpenCode 1.18.32, Codex 0.158.0 —
-- and R9 said the panel gets buttons once it had. Two changes the owner chose
-- on 2026-10-01:
--
--   1. A version newer than the active one is qualified by the host on its own
--      (`infra-cod runtime updates --apply`, every five minutes, root): beside
--      the active version, changing nothing, and only while the subscription it
--      spends is under 80 %. A failed qualification is not retried by itself.
--   2. Qualify and Promote are buttons. The panel asks; the same root unit does
--      it, through the same code the CLI runs, and says how it went here.
--
-- And no waiting: a release is offered as soon as it is published (R8 had 48
-- hours). The registry's signature is still checked by every qualification.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('runtime_update_invalid','invalid_argument','a runtime update names a known runtime, an exact version and qualify or promote'),
  ('runtime_update_open','conflict','this runtime already has an update requested or running; wait for it'),
  ('runtime_update_unqualified','conflict','only a version whose latest qualification passed can be promoted'),
  ('runtime_update_operator_unknown','not_found','no operator with that id')
ON CONFLICT (reason) DO NOTHING;

CREATE TABLE IF NOT EXISTS runtime_update_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_type text NOT NULL CHECK (runtime_type IN ('codex','opencode','claude','antigravity')),
  version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  kind text NOT NULL CHECK (kind IN ('qualify','promote')),
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','running','done','failed')),
  message text NOT NULL DEFAULT '' CHECK (length(message) <= 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  CHECK ((status IN ('done','failed')) = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_update_requests_one_open
  ON runtime_update_requests(runtime_type) WHERE status IN ('requested','running');

CREATE OR REPLACE FUNCTION request_runtime_update(p_operator_id uuid, p_runtime_type text, p_version text, p_kind text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = control_plane, public, extensions, pg_temp
AS $$
DECLARE v_id uuid; v_latest text;
BEGIN
  -- A runtime the registry knows, not a list of names here (0050 holds that).
  IF NOT EXISTS (SELECT 1 FROM runtime_roles r WHERE r.runtime_type = p_runtime_type) OR p_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
     OR p_kind NOT IN ('qualify','promote') THEN
    PERFORM refuse('runtime_update_invalid', format('%s %s %s', p_kind, p_runtime_type, p_version), '22023');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_operator_id) THEN
    PERFORM refuse('runtime_update_operator_unknown', format('no operator %s', p_operator_id), '42501');
  END IF;
  IF p_kind = 'promote' THEN
    SELECT result INTO v_latest FROM runtime_qualifications
    WHERE runtime_type = p_runtime_type AND version = p_version ORDER BY started_at DESC LIMIT 1;
    IF v_latest IS DISTINCT FROM 'passed' THEN
      PERFORM refuse('runtime_update_unqualified',
        format('%s %s: its latest qualification is %s', p_runtime_type, p_version, COALESCE(v_latest, 'none')));
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM runtime_update_requests WHERE runtime_type = p_runtime_type AND status IN ('requested','running')) THEN
    PERFORM refuse('runtime_update_open', format('%s has an update requested or running', p_runtime_type));
  END IF;
  INSERT INTO runtime_update_requests(runtime_type, version, kind, requested_by)
  VALUES (p_runtime_type, p_version, p_kind, 'operator:'||p_operator_id) RETURNING id INTO v_id;
  PERFORM write_audit_event(NULL, NULL, NULL, 'operator', p_operator_id::text, 'runtime.'||p_kind||'_requested',
    'runtime', p_runtime_type, 'allowed', NULL, jsonb_build_object('version', p_version), v_id::text);
  RETURN jsonb_build_object('request_id', v_id, 'status', 'requested');
END $$;

-- The root unit's side. A request left `running` by a unit that died is
-- requested again after an hour: a qualification runs for minutes, not hours.
CREATE OR REPLACE FUNCTION claim_runtime_update_request()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = control_plane, public, extensions, pg_temp
AS $$
DECLARE v_row runtime_update_requests%ROWTYPE;
BEGIN
  UPDATE runtime_update_requests SET status = 'requested', started_at = NULL
  WHERE status = 'running' AND started_at < clock_timestamp() - interval '1 hour';
  SELECT * INTO v_row FROM runtime_update_requests WHERE status = 'requested'
  ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF v_row.id IS NULL THEN RETURN 'null'::jsonb; END IF;
  UPDATE runtime_update_requests SET status = 'running', started_at = clock_timestamp() WHERE id = v_row.id;
  RETURN jsonb_build_object('id', v_row.id, 'runtime', v_row.runtime_type, 'version', v_row.version,
    'kind', v_row.kind, 'requested_by', v_row.requested_by);
END $$;

CREATE OR REPLACE FUNCTION finish_runtime_update_request(p_id uuid, p_ok boolean, p_message text)
RETURNS jsonb
LANGUAGE sql
SET search_path = control_plane, public, extensions, pg_temp
AS $$
  UPDATE runtime_update_requests SET status = CASE WHEN p_ok THEN 'done' ELSE 'failed' END,
    message = left(COALESCE(p_message, ''), 1000), finished_at = clock_timestamp()
  WHERE id = p_id AND status = 'running'
  RETURNING jsonb_build_object('id', id, 'status', status);
$$;

-- A request put back, untouched, when the host was busy (another update holds
-- the host lock): it is tried on the next pass.
CREATE OR REPLACE FUNCTION defer_runtime_update_request(p_id uuid)
RETURNS jsonb
LANGUAGE sql
SET search_path = control_plane, public, extensions, pg_temp
AS $$
  UPDATE runtime_update_requests SET status = 'requested', started_at = NULL
  WHERE id = p_id AND status = 'running'
  RETURNING jsonb_build_object('id', id, 'status', status);
$$;

-- What the panel shows per runtime: the open request and the last finished one.
CREATE OR REPLACE FUNCTION get_runtime_update_requests()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'runtime', r.runtime_type, 'version', r.version,
      'kind', r.kind, 'status', r.status, 'message', r.message, 'requested_by', r.requested_by,
      'created_at', r.created_at, 'finished_at', r.finished_at) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM (
    SELECT DISTINCT ON (runtime_type, status IN ('requested','running')) *
    FROM runtime_update_requests
    ORDER BY runtime_type, status IN ('requested','running'), created_at DESC
  ) r
  WHERE r.status IN ('requested','running') OR r.finished_at > clock_timestamp() - interval '7 days';
$$;

-- Offered when published: R8's 48 hours are gone (see the head of this file).
CREATE OR REPLACE FUNCTION get_runtime_versions()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'runtime', r.runtime_type,
    'active_version', COALESCE(w.active_version, NULLIF(b.active_version, '')),
    'checked_at', w.checked_at,
    'error', NULLIF(w.error, ''),
    'baseline_version', b.baseline_version,
    'verified_by', CASE WHEN b.runtime_type IS NULL THEN NULL
      WHEN b.active_version = COALESCE(w.active_version, b.active_version) THEN NULLIF(b.active_verified_by, '') END,
    'newer', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'version', v.version,
        'published_at', v.published_at,
        'offered_from', v.published_at,
        'offered', v.published_at IS NOT NULL
      ) ORDER BY string_to_array(v.version, '.')::int[] DESC)
      FROM runtime_versions v
      WHERE v.runtime_type = r.runtime_type AND v.state = 'available'
        AND (w.active_version IS NULL
          OR string_to_array(v.version, '.')::int[] > string_to_array(w.active_version, '.')::int[])
    ), '[]'::jsonb)
  ) ORDER BY r.runtime_type), '[]'::jsonb)
  FROM (SELECT runtime_type FROM runtime_watch_state UNION SELECT runtime_type FROM runtime_baselines) r
  LEFT JOIN runtime_watch_state w ON w.runtime_type = r.runtime_type
  LEFT JOIN runtime_baselines b ON b.runtime_type = r.runtime_type;
$$;

REVOKE EXECUTE ON FUNCTION request_runtime_update(uuid, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_runtime_update_request() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finish_runtime_update_request(uuid, boolean, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION defer_runtime_update_request(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_runtime_update_requests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_runtime_update(uuid, text, text, text) TO infra_web;
GRANT EXECUTE ON FUNCTION get_runtime_update_requests() TO infra_web;
GRANT SELECT, INSERT, UPDATE ON runtime_update_requests TO infra_worker;
GRANT EXECUTE ON FUNCTION claim_runtime_update_request() TO infra_worker;
GRANT EXECUTE ON FUNCTION finish_runtime_update_request(uuid, boolean, text) TO infra_worker;
GRANT EXECUTE ON FUNCTION defer_runtime_update_request(uuid) TO infra_worker;
