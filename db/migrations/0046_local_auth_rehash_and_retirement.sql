-- What the local-auth review turned up: three gaps in the operator surface.
--
--   1. `set_local_operator_disabled` wrote its own audit row with a hardcoded
--      `system` / `infra-cod-admin` actor, so the trail could not say who ran it.
--      The actor is now the CLI's to supply, in the same transaction as the
--      change, because the OS user is not something the database can see.
--   2. A password hash left behind by an older cost profile was never upgraded.
--      `rehash_local_password` is the narrow write that does it: it touches the
--      encoding and nothing else — not `password_changed_at`, not
--      `must_change_password`, and no session is revoked.
--   3. Nothing could tell a root-owned helper whether the generated password in
--      /etc/infra-cod/initial-credentials was still needed. That question is
--      answered here rather than by the caller guessing at timestamps.

SET search_path TO control_plane, public, extensions;

-- ------------------------------------------------- disable, without a lie ----

-- Identical signature, so CREATE OR REPLACE keeps the OID and every grant. The
-- only change is that the audit row is gone: `infra-cod admin` writes it, in the
-- same transaction, with the real OS user as the actor.
CREATE OR REPLACE FUNCTION set_local_operator_disabled(
  p_user_id uuid, p_disabled boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user users%ROWTYPE;
  v_revoked integer;
BEGIN
  UPDATE users SET disabled_at = CASE WHEN p_disabled THEN clock_timestamp() END
  WHERE id=p_user_id AND role='owner'
  RETURNING * INTO v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator is unavailable' USING ERRCODE='55000';
  END IF;

  IF p_disabled THEN
    WITH revoked AS (
      UPDATE web_sessions SET revoked_at=clock_timestamp(), revoked_reason='admin_revoke'
      WHERE user_id=v_user.id AND revoked_at IS NULL
      RETURNING id
    ) SELECT count(*) INTO v_revoked FROM revoked;
  ELSE
    v_revoked := 0;
  END IF;

  RETURN jsonb_build_object('user_id',v_user.id,'username',v_user.username,
                            'disabled',v_user.disabled_at IS NOT NULL,
                            'sessions_revoked',v_revoked);
END $$;

ALTER FUNCTION set_local_operator_disabled(uuid,boolean)
  SET search_path=control_plane,public,extensions,pg_temp;

-- ------------------------------------------------------------- rehashing ----

-- Replaces the stored encoding of a password that has already been verified.
--
-- Deliberately narrower than `set_user_password`: it does not clear
-- `must_change_password`, does not move `password_changed_at` (the password did
-- not change, its encoding did), and does not end a single session. Wiring this
-- through `set_user_password` instead would log the operator out of every other
-- device as a side effect of a routine upgrade.
--
-- It takes a user id, which `set_user_password` already does — so this widens
-- nothing: the web role could already replace any owner's hash. What it removes
-- is the blast radius of doing so, not the ability.
CREATE OR REPLACE FUNCTION rehash_local_password(
  p_user_id uuid, p_password_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user users%ROWTYPE;
BEGIN
  IF p_password_hash IS NULL OR p_password_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'the password hash is not an Argon2id encoding' USING ERRCODE='22023';
  END IF;

  UPDATE users SET password_hash=p_password_hash
  WHERE id=p_user_id AND role='owner'
  RETURNING * INTO v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator is unavailable' USING ERRCODE='55000';
  END IF;

  -- Recorded, because a credential changed. This is the one row a rehash
  -- produces, and it is what makes "when did this hash move" answerable.
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',v_user.id::text,
    'auth.password_rehashed','operator',v_user.id::text,'allowed',NULL,
    jsonb_build_object('username',v_user.username),'');

  RETURN jsonb_build_object('user_id',v_user.id,'rehashed',true);
END $$;

ALTER FUNCTION rehash_local_password(uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION rehash_local_password(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rehash_local_password(uuid,text) TO infra_web;

-- --------------------------------------------------- credential retirement ----

-- Answers the question the root-owned helper has to ask before it deletes a
-- plaintext password: is this file still anybody's way in?
--
-- The condition is strictly "the generated password is retired", not merely
-- "somebody signed in once". The file is the only copy of that password, and an
-- operator who signed in and then walked away from the forced change would be
-- locked out by its removal. So it takes a successful sign-in *and* the forced
-- change being complete.
--
-- Not granted to infra_web: the web process must never be the thing that decides
-- a root-only file may be deleted.
CREATE OR REPLACE FUNCTION initial_credentials_status()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user users%ROWTYPE;
  v_exists boolean;
BEGIN
  SELECT * INTO v_user FROM users u WHERE u.role='owner' ORDER BY u.created_at LIMIT 1;
  v_exists := FOUND;

  RETURN jsonb_build_object(
    'operator_exists',v_exists,
    'username',CASE WHEN v_exists THEN v_user.username END,
    'must_change_password',CASE WHEN v_exists THEN v_user.must_change_password END,
    'last_login_at',CASE WHEN v_exists THEN v_user.last_login_at END,
    'password_changed_at',CASE WHEN v_exists THEN v_user.password_changed_at END,
    -- The exact predicate the helper acts on, so it cannot drift from the
    -- reasoning above by being re-derived in another language.
    'generated_password_retired',
      v_exists AND NOT v_user.must_change_password AND v_user.last_login_at IS NOT NULL);
END $$;

ALTER FUNCTION initial_credentials_status()
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION initial_credentials_status() FROM PUBLIC;
