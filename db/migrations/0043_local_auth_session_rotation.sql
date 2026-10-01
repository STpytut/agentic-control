-- Atomic session rotation for the local operator account.
--
-- `set_user_password` (0037) and `create_web_session` (0037) are each correct on
-- their own, but a password change needs both plus the revocation of every
-- other session to land together. Driving that from the application across
-- three round trips leaves windows where the password is new while the old
-- token is still live, or where the caller's own session was revoked before a
-- replacement existed.
--
-- Every function here derives the account from the presented session digest
-- instead of accepting a user id. The web role can therefore change the
-- password of exactly one account — the one that is holding the cookie — and
-- cannot name somebody else even if the web process is fully compromised.
-- Ownership follows the migrating role, as in 0037.

SET search_path TO control_plane, public, extensions;

-- Resolves a presented digest to a session that is live in every sense:
-- present, not revoked, inside both deadlines, and belonging to an enabled
-- operator. Locks the row so the callers below can mutate it safely.
--
-- Deliberately not granted to anyone. It exists so the exported functions do
-- not each grow their own copy of this check, which is exactly where a missing
-- clause would hide.
CREATE OR REPLACE FUNCTION live_session(p_token_digest bytea)
RETURNS web_sessions LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_session web_sessions%ROWTYPE;
BEGIN
  IF p_token_digest IS NULL OR length(p_token_digest)<>32 THEN
    RAISE EXCEPTION 'the session is not valid' USING ERRCODE='55000';
  END IF;

  SELECT * INTO v_session FROM web_sessions s
  WHERE s.token_digest=p_token_digest FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the session is not valid' USING ERRCODE='55000';
  END IF;

  IF v_session.revoked_at IS NOT NULL
     OR v_session.expires_at<=clock_timestamp()
     OR v_session.absolute_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'the session is not valid' USING ERRCODE='55000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM users u
                 WHERE u.id=v_session.user_id AND u.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'the session is not valid' USING ERRCODE='55000';
  END IF;

  RETURN v_session;
END $$;

ALTER FUNCTION live_session(bytea)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION live_session(bytea) FROM PUBLIC;

-- The forced-password-change path, atomically.
--
-- One transaction: verify the caller, replace the hash, revoke every other
-- session, rotate the caller's own token, and create the replacement session.
-- The old token is revoked with reason 'rotated' rather than deleted, so an
-- operator can see in the audit trail that it was replaced and not abused.
CREATE OR REPLACE FUNCTION change_local_password(
  p_token_digest bytea,
  p_new_password_hash text,
  p_new_token_digest bytea,
  p_new_csrf_digest bytea,
  p_idle interval DEFAULT interval '12 hours',
  p_absolute interval DEFAULT interval '30 days',
  p_ip_hash bytea DEFAULT NULL,
  p_user_agent_hash bytea DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_session web_sessions%ROWTYPE;
  v_new web_sessions%ROWTYPE;
  v_revoked integer;
BEGIN
  v_session := live_session(p_token_digest);

  IF p_new_password_hash IS NULL OR p_new_password_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'the password hash is not an Argon2id encoding' USING ERRCODE='22023';
  END IF;
  IF p_new_token_digest IS NULL OR length(p_new_token_digest)<>32
     OR p_new_csrf_digest IS NULL OR length(p_new_csrf_digest)<>32 THEN
    RAISE EXCEPTION 'a session digest must be 32 bytes' USING ERRCODE='22023';
  END IF;

  UPDATE users SET
    password_hash=p_new_password_hash,
    password_changed_at=v_now,
    must_change_password=false
  WHERE id=v_session.user_id;

  -- Every other session dies. A token issued against the old password must not
  -- outlive it.
  WITH others AS (
    UPDATE web_sessions SET revoked_at=v_now, revoked_reason='password_change'
    WHERE user_id=v_session.user_id AND revoked_at IS NULL AND id<>v_session.id
    RETURNING id
  ) SELECT count(*) INTO v_revoked FROM others;

  UPDATE web_sessions SET revoked_at=v_now, revoked_reason='rotated'
  WHERE id=v_session.id;

  INSERT INTO web_sessions(user_id,token_digest,csrf_digest,
                           expires_at,absolute_expires_at,ip_hash,user_agent_hash)
  VALUES (v_session.user_id,p_new_token_digest,p_new_csrf_digest,
          least(v_now+p_idle,v_now+p_absolute),v_now+p_absolute,
          p_ip_hash,p_user_agent_hash)
  RETURNING * INTO v_new;

  RETURN jsonb_build_object(
    'session_id',v_new.id,
    'user_id',v_session.user_id,
    'sessions_revoked',v_revoked,
    'expires_at',v_new.expires_at,
    'absolute_expires_at',v_new.absolute_expires_at);
END $$;

ALTER FUNCTION change_local_password(bytea,text,bytea,bytea,interval,interval,bytea,bytea)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION change_local_password(bytea,text,bytea,bytea,interval,interval,bytea,bytea) FROM PUBLIC;

-- Active sessions for the account holding the presented token. Timestamps only:
-- the address and user-agent are stored as peppered digests, which are enough to
-- compare two sessions and not enough to show an operator.
CREATE OR REPLACE FUNCTION list_web_sessions(p_token_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_session web_sessions%ROWTYPE;
  v_sessions jsonb;
BEGIN
  v_session := live_session(p_token_digest);

  SELECT COALESCE(jsonb_agg(row_value ORDER BY current_session DESC, created_at DESC),'[]'::jsonb)
  INTO v_sessions
  FROM (
    SELECT jsonb_build_object(
             'session_id',s.id,
             'created_at',s.created_at,
             'last_seen_at',s.last_seen_at,
             'expires_at',s.expires_at,
             'absolute_expires_at',s.absolute_expires_at,
             'is_current',s.id=v_session.id) AS row_value,
           s.id=v_session.id AS current_session,
           s.created_at
    FROM web_sessions s
    WHERE s.user_id=v_session.user_id AND s.revoked_at IS NULL
      AND s.expires_at>clock_timestamp()
      AND s.absolute_expires_at>clock_timestamp()
  ) listed;

  RETURN jsonb_build_object('sessions',v_sessions,'current_session_id',v_session.id);
END $$;

ALTER FUNCTION list_web_sessions(bytea)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION list_web_sessions(bytea) FROM PUBLIC;

-- Revokes one session, but only one belonging to the caller. Returns NULL when
-- the id is not the caller's, so the caller cannot probe for other accounts'
-- session ids.
CREATE OR REPLACE FUNCTION revoke_web_session_by_id(
  p_token_digest bytea, p_session_id uuid, p_reason text DEFAULT 'admin_revoke'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_session web_sessions%ROWTYPE;
  v_revoked uuid;
BEGIN
  v_session := live_session(p_token_digest);

  UPDATE web_sessions SET revoked_at=clock_timestamp(), revoked_reason=p_reason
  WHERE id=p_session_id AND user_id=v_session.user_id AND revoked_at IS NULL
  RETURNING id INTO v_revoked;

  IF v_revoked IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('session_id',v_revoked,'revoked',true,
                            'is_current',v_revoked=v_session.id);
END $$;

ALTER FUNCTION revoke_web_session_by_id(bytea,uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION revoke_web_session_by_id(bytea,uuid,text) FROM PUBLIC;

-- Revokes every session except the caller's. The caller's own row is taken from
-- the presented token, not from a parameter, so "all others" cannot be widened
-- into "everyone".
CREATE OR REPLACE FUNCTION revoke_other_web_sessions(
  p_token_digest bytea, p_reason text DEFAULT 'admin_revoke'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_session web_sessions%ROWTYPE;
  v_revoked integer;
BEGIN
  v_session := live_session(p_token_digest);

  WITH others AS (
    UPDATE web_sessions SET revoked_at=clock_timestamp(), revoked_reason=p_reason
    WHERE user_id=v_session.user_id AND revoked_at IS NULL AND id<>v_session.id
    RETURNING id
  ) SELECT count(*) INTO v_revoked FROM others;

  RETURN jsonb_build_object('sessions_revoked',v_revoked,
                            'current_session_id',v_session.id);
END $$;

ALTER FUNCTION revoke_other_web_sessions(bytea,text)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION revoke_other_web_sessions(bytea,text) FROM PUBLIC;

-- Renames the account and ends every session, including the caller's.
--
-- A rename is not an ordinary profile edit: the username is the login
-- identifier, and the operator is about to start typing a different one. Ending
-- every session forces exactly one re-authentication under the new name, which
-- is the cheapest way to be sure nothing is still holding an old identity.
CREATE OR REPLACE FUNCTION change_local_username(
  p_token_digest bytea, p_username text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_session web_sessions%ROWTYPE;
  v_revoked integer;
BEGIN
  v_session := live_session(p_token_digest);

  UPDATE users SET username=lower(p_username)
  WHERE id=v_session.user_id AND role='owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator is unavailable' USING ERRCODE='55000';
  END IF;

  WITH revoked AS (
    UPDATE web_sessions SET revoked_at=clock_timestamp(), revoked_reason='username_change'
    WHERE user_id=v_session.user_id AND revoked_at IS NULL
    RETURNING id
  ) SELECT count(*) INTO v_revoked FROM revoked;

  RETURN jsonb_build_object('user_id',v_session.user_id,
                            'username',lower(p_username),
                            'sessions_revoked',v_revoked);
END $$;

ALTER FUNCTION change_local_username(bytea,text)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION change_local_username(bytea,text) FROM PUBLIC;

-- Grant surface. infra_worker already reaches every function through the
-- default privileges set in 0038; infra_web gets exactly these six, and
-- live_session stays reachable only from the definer functions above.
GRANT EXECUTE ON FUNCTION change_local_password(bytea,text,bytea,bytea,interval,interval,bytea,bytea) TO infra_web;
GRANT EXECUTE ON FUNCTION list_web_sessions(bytea) TO infra_web;
GRANT EXECUTE ON FUNCTION revoke_web_session_by_id(bytea,uuid,text) TO infra_web;
GRANT EXECUTE ON FUNCTION revoke_other_web_sessions(bytea,text) TO infra_web;
GRANT EXECUTE ON FUNCTION change_local_username(bytea,text) TO infra_web;
