-- Binding audit rows to the session that produced them.
--
-- `write_operator_audit(p_user_id, ...)` takes the actor as a parameter. It
-- checked only that the id belonged to an owner, never that the caller *was*
-- that owner, and it was granted to `infra_web`. So the web role — any code
-- running in it, or anything that compromised it — could append events saying
-- the owner signed in, changed a password or acted, with a target and details of
-- its choosing. Confirmed under `SET ROLE infra_web`: a forged `auth.login` row
-- with `actor_id` set to the owner was accepted.
--
-- A comment in 0038 claimed the opposite ("an audit entry cannot be forged").
-- The flaw is subtle enough to be worth naming: validating *that the actor
-- exists* is not validating *that the caller is the actor*, and the two look
-- identical at the call site.
--
-- The fix has two halves, because the web tier writes audit rows for two
-- different reasons:
--
--   1. Rows about the caller's own credential actions — sign-in, password
--      change, rename, session revocation, logout — belong to the operation, not
--      to the caller. They are written inside the SECURITY DEFINER function that
--      performed the change, which already knows the account from the token it
--      validated. The web tier stops supplying a user id at all.
--
--   2. Rows about control-plane actions are the one thing the web tier genuinely
--      originates. `write_session_audit` takes the session digest and derives the
--      actor from the session row, so the caller can no longer name anybody: the
--      worst a compromised web process can do is attribute an action to the
--      session it is already holding.
--
-- `write_operator_audit` itself stays, because `complete_local_login` (0047)
-- calls it and it is the right shape for a definer function that has already
-- established the actor. What goes away is the grant: it becomes internal-only,
-- and the full allowlist in 0026 is what keeps it that way.

SET search_path TO control_plane, public, extensions;

-- ============================================ the external entry point ======

-- Writes an operator audit row attributed to whoever holds the presented session.
--
-- There is deliberately no user-id parameter. The actor is read from the session
-- row, so a caller cannot name one; an invalid, revoked or expired session is
-- refused outright, because an audit row for a session that does not exist is
-- exactly the forgery this replaces.
CREATE OR REPLACE FUNCTION write_session_audit(
  p_token_digest bytea,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_decision text DEFAULT 'allowed',
  p_details jsonb DEFAULT '{}'::jsonb,
  p_project_id uuid DEFAULT NULL,
  p_correlation text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_session web_sessions%ROWTYPE;
BEGIN
  -- live_session raises for an unknown, revoked, expired or disabled session, so
  -- this cannot be used with a digest the caller invented.
  v_session := live_session(p_token_digest);

  IF p_action !~ '^(auth|operator)[.][a-z0-9_]+$' THEN
    RAISE EXCEPTION 'unsupported operator audit action: %', p_action USING ERRCODE='22023';
  END IF;
  IF p_decision NOT IN ('allowed','denied','not_required') THEN
    RAISE EXCEPTION 'unsupported audit decision: %', p_decision USING ERRCODE='22023';
  END IF;

  RETURN jsonb_build_object('audit_event_id', write_audit_event(
    p_project_id, NULL, NULL, 'operator', v_session.user_id::text, p_action,
    p_target_type, p_target_id, p_decision, NULL, p_details, p_correlation));
END $$;

ALTER FUNCTION write_session_audit(bytea,text,text,text,text,jsonb,uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION write_session_audit(bytea,text,text,text,text,jsonb,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION write_session_audit(bytea,text,text,text,text,jsonb,uuid,text) TO infra_web;

-- ==================================== audit inside the operations ===========
--
-- Same signatures as 0043, so CREATE OR REPLACE keeps the OIDs and the grants.
-- The only change in each is the audit row, written from the account the function
-- already derived from the presented token.

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

  -- Actor from the session, in the same transaction as the change it describes.
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',v_session.user_id::text,
    'auth.password_changed','session',v_new.id::text,'allowed',NULL,
    jsonb_build_object('sessions_revoked',v_revoked),'');

  RETURN jsonb_build_object(
    'session_id',v_new.id,
    'user_id',v_session.user_id,
    'sessions_revoked',v_revoked,
    'expires_at',v_new.expires_at,
    'absolute_expires_at',v_new.absolute_expires_at);
END $$;

ALTER FUNCTION change_local_password(bytea,text,bytea,bytea,interval,interval,bytea,bytea)
  SET search_path=control_plane,public,extensions,pg_temp;

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

  PERFORM write_audit_event(NULL,NULL,NULL,'operator',v_session.user_id::text,
    'auth.username_changed','operator',v_session.user_id::text,'allowed',NULL,
    jsonb_build_object('sessions_revoked',v_revoked),'');

  RETURN jsonb_build_object('user_id',v_session.user_id,
                            'username',lower(p_username),
                            'sessions_revoked',v_revoked);
END $$;

ALTER FUNCTION change_local_username(bytea,text)
  SET search_path=control_plane,public,extensions,pg_temp;

-- The actor here is the owner of the session being revoked, read from the row
-- that was actually revoked.
CREATE OR REPLACE FUNCTION revoke_web_session(
  p_token_digest bytea, p_reason text DEFAULT 'logout'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id uuid; v_user_id uuid;
BEGIN
  UPDATE web_sessions SET revoked_at=clock_timestamp(), revoked_reason=p_reason
  WHERE token_digest=p_token_digest AND revoked_at IS NULL
  RETURNING id, user_id INTO v_id, v_user_id;

  IF v_id IS NULL THEN
    -- Nothing was revoked, so there is nothing to record. Repeating a logout must
    -- not append a second row saying it happened again.
    RETURN jsonb_build_object('revoked', false, 'session_id', null);
  END IF;

  PERFORM write_audit_event(NULL,NULL,NULL,'operator',v_user_id::text,
    CASE WHEN p_reason='logout' THEN 'auth.logout' ELSE 'auth.session_revoked' END,
    'session',v_id::text,'allowed',NULL,jsonb_build_object('reason',p_reason),'');

  RETURN jsonb_build_object('revoked', true, 'session_id', v_id);
END $$;

ALTER FUNCTION revoke_web_session(bytea,text)
  SET search_path=control_plane,public,extensions,pg_temp;

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

  PERFORM write_audit_event(NULL,NULL,NULL,'operator',v_session.user_id::text,
    'auth.session_revoked','session',v_revoked::text,'allowed',NULL,
    jsonb_build_object('is_current',v_revoked=v_session.id),'');

  RETURN jsonb_build_object('session_id',v_revoked,'revoked',true,
                            'is_current',v_revoked=v_session.id);
END $$;

ALTER FUNCTION revoke_web_session_by_id(bytea,uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;

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

  PERFORM write_audit_event(NULL,NULL,NULL,'operator',v_session.user_id::text,
    'auth.sessions_revoked','operator',v_session.user_id::text,'allowed',NULL,
    jsonb_build_object('sessions_revoked',v_revoked),'');

  RETURN jsonb_build_object('sessions_revoked',v_revoked,
                            'current_session_id',v_session.id);
END $$;

ALTER FUNCTION revoke_other_web_sessions(bytea,text)
  SET search_path=control_plane,public,extensions,pg_temp;

-- ============================================ revoke the trusted-actor API ===
--
-- Still called by `complete_local_login`, so it stays as an internal helper for
-- definer functions that have established the actor themselves. What it must
-- never be again is reachable by the role whose identity it takes on trust.
REVOKE EXECUTE ON FUNCTION write_operator_audit(uuid,text,text,text,text,jsonb,uuid,text) FROM infra_web;

DO $assert$
BEGIN
  IF has_function_privilege('infra_web',
       'control_plane.write_operator_audit(uuid,text,text,text,text,jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'infra_web can still supply its own audit actor' USING ERRCODE='42501';
  END IF;
  IF NOT has_function_privilege('infra_web',
       'control_plane.write_session_audit(bytea,text,text,text,text,jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'infra_web cannot write a token-derived audit row' USING ERRCODE='42501';
  END IF;
END $assert$;
