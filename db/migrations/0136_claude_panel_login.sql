-- Claude Code signs in from the panel (rc.123).
--
-- The first install on a clean server signed Claude in with
-- `infra-cod runtime login claude` over ssh, the one step after installation
-- that still needed a terminal. `claude auth login` needs none: without a TTY
-- it prints an authorize URL and reads the code from stdin. The account worker
-- runs it as claude-worker through the supervisor's account surface, shows the
-- URL here, and passes the code the owner pastes back to that process.
--
-- The code is an OAuth authorization code under PKCE: only the process that
-- printed the URL holds the verifier that redeems it. It is kept here only from
-- the paste until the worker takes it, and the take clears it.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('claude_login_unknown','not_found','no Claude sign-in with that id belongs to this owner'),
  ('claude_login_not_waiting','conflict','the sign-in is not waiting for a code: it has not shown its link yet, or it ended'),
  ('claude_login_code_invalid','invalid_argument','the code is the text Claude shows after signing in, without spaces'),
  ('claude_login_not_held','lease_lost','this worker does not hold the sign-in'),
  ('claude_login_step_unknown','invalid_argument','the account worker recorded a step the sign-in does not have')
ON CONFLICT (reason) DO NOTHING;

CREATE TABLE claude_login_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','awaiting_code','verifying','succeeded','failed','cancelled','expired')),
  authorize_url text,
  auth_code text CHECK (auth_code IS NULL OR char_length(auth_code) <= 512),
  failure text,
  leased_by text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '15 minutes',
  -- A code is held only while the session waits for the worker to take it.
  CHECK (auth_code IS NULL OR status = 'awaiting_code')
);
CREATE INDEX claude_login_sessions_open ON claude_login_sessions(operator_id, created_at)
  WHERE status IN ('requested','awaiting_code','verifying');

-- What the panel shows: never the code.
CREATE OR REPLACE FUNCTION claude_login_view(s claude_login_sessions) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id', s.id, 'status', s.status, 'authorize_url', s.authorize_url,
    'code_submitted', s.auth_code IS NOT NULL, 'failure', s.failure,
    'created_at', s.created_at, 'expires_at', s.expires_at)
$$;

-- The driver's new capability, as the registry check reads it.
INSERT INTO runtime_capabilities(runtime_type, capability) VALUES ('claude','account.login')
ON CONFLICT DO NOTHING;

-- The panel ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION start_claude_login(p_owner_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp AS $$
DECLARE v_session claude_login_sessions%ROWTYPE;
BEGIN
  -- One sign-in at a time: a new one replaces any still open.
  UPDATE claude_login_sessions SET status = 'cancelled', auth_code = NULL, updated_at = clock_timestamp()
  WHERE operator_id = p_owner_id AND status IN ('requested','awaiting_code','verifying');
  INSERT INTO claude_login_sessions(operator_id) VALUES (p_owner_id) RETURNING * INTO v_session;
  PERFORM pg_notify('claude_login', v_session.id::text);
  RETURN claude_login_view(v_session);
END $$;

CREATE OR REPLACE FUNCTION get_claude_login(p_owner_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp AS $$
DECLARE v_session claude_login_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_session FROM claude_login_sessions
  WHERE operator_id = p_owner_id ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN claude_login_view(v_session);
END $$;

CREATE OR REPLACE FUNCTION submit_claude_login_code(p_owner_id uuid, p_session_id uuid, p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp AS $$
DECLARE v_session claude_login_sessions%ROWTYPE; v_code text := btrim(COALESCE(p_code, ''));
BEGIN
  SELECT * INTO v_session FROM claude_login_sessions
  WHERE id = p_session_id AND operator_id = p_owner_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM refuse('claude_login_unknown', 'no such Claude sign-in', '42501'); END IF;
  IF v_session.status <> 'awaiting_code' OR v_session.expires_at <= clock_timestamp() THEN
    PERFORM refuse('claude_login_not_waiting', 'this sign-in is not waiting for a code; start it again');
  END IF;
  IF v_code !~ '^[A-Za-z0-9_#.~-]+$' OR char_length(v_code) NOT BETWEEN 8 AND 512 THEN
    PERFORM refuse('claude_login_code_invalid', 'paste the code Claude shows after signing in, as it is', '22023');
  END IF;
  UPDATE claude_login_sessions SET auth_code = v_code, updated_at = clock_timestamp()
  WHERE id = p_session_id RETURNING * INTO v_session;
  PERFORM pg_notify('claude_login', v_session.id::text);
  RETURN claude_login_view(v_session);
END $$;

-- The account worker -------------------------------------------------------------

CREATE OR REPLACE FUNCTION claim_claude_logins(p_worker_id text, p_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  UPDATE claude_login_sessions SET status = 'expired', auth_code = NULL, leased_by = NULL, lease_until = NULL,
    failure = 'The sign-in link expired. Start it again.', updated_at = clock_timestamp()
  WHERE status IN ('requested','awaiting_code','verifying') AND expires_at <= clock_timestamp();
  WITH candidates AS (
    SELECT id FROM claude_login_sessions
    WHERE status = 'requested' AND (lease_until IS NULL OR lease_until <= clock_timestamp())
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit, 0)
  ), claimed AS (
    UPDATE claude_login_sessions s SET leased_by = p_worker_id, lease_until = s.expires_at,
      updated_at = clock_timestamp()
    FROM candidates c WHERE s.id = c.id RETURNING s.*
  )
  SELECT jsonb_agg(jsonb_build_object('id', id, 'expires_at', expires_at)) INTO v_result FROM claimed;
  RETURN COALESCE(v_result, '[]'::jsonb);
END $$;

-- The worker's record of each step; it refuses a worker that lost the session.
CREATE OR REPLACE FUNCTION record_claude_login(
  p_session_id uuid, p_worker_id text, p_step text, p_value text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp AS $$
DECLARE v_session claude_login_sessions%ROWTYPE; v_code text;
BEGIN
  SELECT * INTO v_session FROM claude_login_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.leased_by IS DISTINCT FROM p_worker_id
     OR v_session.status IN ('succeeded','failed','cancelled','expired') THEN
    PERFORM refuse('claude_login_not_held', 'this worker does not hold the sign-in');
  END IF;
  IF p_step = 'url' THEN
    UPDATE claude_login_sessions SET status = 'awaiting_code', authorize_url = p_value, updated_at = clock_timestamp()
    WHERE id = p_session_id;
    RETURN jsonb_build_object('status', 'awaiting_code');
  ELSIF p_step = 'take_code' THEN
    -- The code leaves the database here, once.
    v_code := v_session.auth_code;
    IF v_code IS NULL THEN RETURN jsonb_build_object('code', NULL); END IF;
    UPDATE claude_login_sessions SET status = 'verifying', auth_code = NULL, updated_at = clock_timestamp()
    WHERE id = p_session_id;
    RETURN jsonb_build_object('code', v_code);
  ELSIF p_step = 'succeeded' THEN
    UPDATE claude_login_sessions SET status = 'succeeded', leased_by = NULL, lease_until = NULL,
      updated_at = clock_timestamp() WHERE id = p_session_id;
    RETURN jsonb_build_object('status', 'succeeded');
  ELSIF p_step = 'failed' THEN
    UPDATE claude_login_sessions SET status = 'failed', auth_code = NULL, failure = left(COALESCE(p_value, 'The sign-in failed.'), 500),
      leased_by = NULL, lease_until = NULL, updated_at = clock_timestamp() WHERE id = p_session_id;
    RETURN jsonb_build_object('status', 'failed');
  END IF;
  PERFORM refuse('claude_login_step_unknown', format('no sign-in step %s', p_step), '22023');
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION start_claude_login(uuid), get_claude_login(uuid), submit_claude_login_code(uuid,uuid,text),
  claim_claude_logins(text,integer), record_claude_login(uuid,text,text,text), claude_login_view(claude_login_sessions)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_claude_login(uuid), get_claude_login(uuid), submit_claude_login_code(uuid,uuid,text)
  TO infra_web;
GRANT EXECUTE ON FUNCTION claim_claude_logins(text,integer), record_claude_login(uuid,text,text,text) TO infra_worker;
GRANT SELECT, UPDATE ON claude_login_sessions TO infra_worker;
