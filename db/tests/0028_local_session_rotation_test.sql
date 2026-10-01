\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

-- Atomic session rotation (0043).
--
-- The application used to drive a password change as three statements —
-- set_user_password, then create_web_session, with a revocation in between —
-- which left windows where the password was new while the old token was still
-- live. 0043 replaces that with one transaction that derives the account from
-- the presented token. This pins the invariants it has to hold, including the
-- one that matters most: the caller cannot name somebody else's account.

DO $$
DECLARE
  v_owner uuid;
  v_intruder uuid;
  v_old_token bytea := decode(repeat('a1',32),'hex');
  v_other_token bytea := decode(repeat('b2',32),'hex');
  v_new_token bytea := decode(repeat('c3',32),'hex');
  v_new_csrf bytea := decode(repeat('d4',32),'hex');
  v_second_new_token bytea := decode(repeat('e5',32),'hex');
  v_second_new_csrf bytea := decode(repeat('f6',32),'hex');
  v_hash text := '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaA';
  v_replacement text := '$argon2id$v=19$m=19456,t=2,p=1$b3RoZXJzYWx0c2FsdAThiYXNoaGFzaGhhc2g';
  v_result jsonb;
  v_sessions jsonb;
  v_current uuid;
  v_before integer;
BEGIN
  DELETE FROM web_sessions;
  DELETE FROM auth_attempts;
  UPDATE users SET username=NULL, password_hash=NULL, password_changed_at=NULL,
                   must_change_password=false, disabled_at=NULL;

  v_result := bootstrap_local_owner('admin-rotate', v_hash, 'Owner');
  v_owner := (v_result->>'user_id')::uuid;

  -- A second operator, to prove the token-derived scoping. Removed again before
  -- the username assertions, because change_local_username only ever renames the
  -- caller and `users` is intentionally a one-owner table.
  INSERT INTO users(display_name,timezone,role,username,password_hash,password_changed_at)
  VALUES('Intruder','UTC','owner','admin-intruder',v_hash,clock_timestamp())
  RETURNING id INTO v_intruder;

  -- Two live sessions for the owner.
  PERFORM create_web_session(v_owner, v_old_token, v_new_csrf,
                             interval '12 hours', interval '30 days');
  PERFORM create_web_session(v_owner, v_other_token, v_new_csrf,
                             interval '12 hours', interval '30 days');
  -- And one for the other account, which must be untouched.
  PERFORM create_web_session(v_intruder, decode(repeat('99',32),'hex'), v_new_csrf,
                             interval '12 hours', interval '30 days');

  -- ------------------------------------------------ rotation is atomic ----

  v_result := change_local_password(v_old_token, v_replacement, v_new_token, v_new_csrf);

  IF (SELECT password_hash FROM users WHERE id=v_owner) <> v_replacement THEN
    RAISE EXCEPTION 'the password hash was not replaced';
  END IF;
  IF (SELECT must_change_password FROM users WHERE id=v_owner) THEN
    RAISE EXCEPTION 'the forced password change was not cleared';
  END IF;
  IF (SELECT password_changed_at FROM users WHERE id=v_owner) IS NULL THEN
    RAISE EXCEPTION 'password_changed_at was not recorded';
  END IF;

  IF (v_result->>'sessions_revoked')::integer <> 1 THEN
    RAISE EXCEPTION 'expected exactly one other session to be revoked, got %',
      v_result->>'sessions_revoked';
  END IF;

  -- The old token is gone, with the reason that says why.
  IF (SELECT revoked_reason FROM web_sessions WHERE token_digest=v_old_token) <> 'rotated' THEN
    RAISE EXCEPTION 'the presented session was not revoked as rotated';
  END IF;
  IF (SELECT revoked_reason FROM web_sessions WHERE token_digest=v_other_token) <> 'password_change' THEN
    RAISE EXCEPTION 'the sibling session was not revoked by the password change';
  END IF;
  -- The other account's session is untouched: the rotation is scoped to the
  -- account the token belongs to, not to "all sessions".
  IF (SELECT revoked_at FROM web_sessions WHERE user_id=v_intruder) IS NOT NULL THEN
    RAISE EXCEPTION 'rotation reached an account that did not present the token';
  END IF;

  -- The replacement session is live and usable.
  v_result := touch_web_session(v_new_token);
  IF v_result->>'valid' <> 'true' OR (v_result->>'user_id')::uuid <> v_owner THEN
    RAISE EXCEPTION 'the rotated session is not usable';
  END IF;

  -- Replaying the rotation with the spent token is refused rather than silently
  -- rotating again, because live_session no longer accepts it.
  BEGIN
    PERFORM change_local_password(v_old_token, v_replacement, v_second_new_token, v_second_new_csrf);
    RAISE EXCEPTION 'a revoked token was accepted for rotation';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;

  -- ------------------------------------------ rotated token is really dead --

  v_result := touch_web_session(v_old_token);
  IF v_result->>'valid' <> 'false' OR v_result->>'reason' <> 'revoked' THEN
    RAISE EXCEPTION 'the rotated token still validates';
  END IF;

  -- ------------------------------------------------------- live_session ----

  BEGIN
    PERFORM live_session(decode(repeat('00',32),'hex'));
    RAISE EXCEPTION 'an unknown token was accepted';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;
  BEGIN
    PERFORM live_session(decode(repeat('11',16),'hex'));
    RAISE EXCEPTION 'a short digest was accepted';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;

  -- A disabled operator's session is refused even though the row is live.
  UPDATE users SET disabled_at=clock_timestamp() WHERE id=v_owner;
  BEGIN
    PERFORM live_session(v_new_token);
    RAISE EXCEPTION 'a disabled operator kept a usable session';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;
  UPDATE users SET disabled_at=NULL WHERE id=v_owner;

  -- An expired session is refused on both deadlines.
  UPDATE web_sessions SET expires_at=clock_timestamp()-interval '1 minute'
  WHERE token_digest=v_new_token;
  BEGIN
    PERFORM live_session(v_new_token);
    RAISE EXCEPTION 'an idle-expired session was accepted';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;
  UPDATE web_sessions SET
    expires_at=clock_timestamp()-interval '2 minutes',
    absolute_expires_at=clock_timestamp()-interval '1 minute'
  WHERE token_digest=v_new_token;
  BEGIN
    PERFORM live_session(v_new_token);
    RAISE EXCEPTION 'an absolutely-expired session was accepted';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;
  UPDATE web_sessions SET
    expires_at=clock_timestamp()+interval '12 hours',
    absolute_expires_at=clock_timestamp()+interval '30 days'
  WHERE token_digest=v_new_token;

  -- ------------------------------------------------- session management ----

  v_sessions := list_web_sessions(v_new_token);
  v_current := (v_sessions->>'current_session_id')::uuid;
  IF v_current NOT IN (SELECT id FROM web_sessions WHERE token_digest=v_new_token) THEN
    RAISE EXCEPTION 'the listed current session is not the presented one';
  END IF;
  IF jsonb_array_length(v_sessions->'sessions') <> 1 THEN
    RAISE EXCEPTION 'only one live session was expected, got %',
      jsonb_array_length(v_sessions->'sessions');
  END IF;
  -- The listing is for a human: it must never carry a digest.
  IF (v_sessions->'sessions'->0) ?| ARRAY['token_digest','csrf_digest','ip_hash','user_agent_hash'] THEN
    RAISE EXCEPTION 'the session listing leaked a secret column';
  END IF;

  -- One of the caller's own sessions can be revoked by id; somebody else's
  -- cannot be found at all.
  IF revoke_web_session_by_id(v_new_token, (SELECT id FROM web_sessions WHERE user_id=v_intruder))
     IS NOT NULL THEN
    RAISE EXCEPTION 'a session belonging to another account was revoked';
  END IF;

  -- A fresh digest: revocation keeps the row, so a spent token cannot be reused
  -- — which is itself the property the unique constraint enforces.
  PERFORM create_web_session(v_owner, decode(repeat('77',32),'hex'), v_new_csrf,
                             interval '12 hours', interval '30 days');
  v_result := revoke_other_web_sessions(v_new_token);
  IF (v_result->>'sessions_revoked')::integer <> 1 THEN
    RAISE EXCEPTION 'revoke_other_web_sessions did not revoke exactly one session';
  END IF;
  IF (SELECT revoked_at FROM web_sessions WHERE token_digest=v_new_token) IS NOT NULL THEN
    RAISE EXCEPTION 'revoke_other_web_sessions revoked the caller';
  END IF;
  IF (SELECT revoked_at FROM web_sessions WHERE user_id=v_intruder) IS NOT NULL THEN
    RAISE EXCEPTION 'revoke_other_web_sessions reached another account';
  END IF;

  -- ---------------------------------------------------------- username ----

  DELETE FROM web_sessions WHERE user_id=v_intruder;
  DELETE FROM users WHERE id=v_intruder;

  v_before := (SELECT count(*) FROM web_sessions
               WHERE user_id=v_owner AND revoked_at IS NULL);
  v_result := change_local_username(v_new_token, 'Admin-Renamed');
  IF v_result->>'username' <> 'admin-renamed' THEN
    RAISE EXCEPTION 'the username was not normalised to lowercase';
  END IF;
  IF (SELECT username FROM users WHERE id=v_owner) <> 'admin-renamed' THEN
    RAISE EXCEPTION 'the rename did not reach the row';
  END IF;
  IF v_before = 0 OR (SELECT count(*) FROM web_sessions
                      WHERE user_id=v_owner AND revoked_at IS NULL) <> 0 THEN
    RAISE EXCEPTION 'a rename left a session alive';
  END IF;
  IF (SELECT count(*) FROM web_sessions
      WHERE user_id=v_owner AND revoked_reason='username_change') <> v_before THEN
    RAISE EXCEPTION 'the rename did not record why the sessions ended';
  END IF;

  -- -------------------------------------------------------- definition ----

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='control_plane'
      AND p.proname IN ('live_session','change_local_password','list_web_sessions',
                        'revoke_web_session_by_id','revoke_other_web_sessions',
                        'change_local_username')
      AND (NOT p.prosecdef
           OR p.proconfig IS NULL
           OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'))
  ) THEN
    RAISE EXCEPTION 'a rotation function is not SECURITY DEFINER with a pinned search_path';
  END IF;

  -- live_session is the choke point every other function goes through. infra_web
  -- must not be able to call it directly: it locks a row and, unlike the others,
  -- returns the row itself.
  IF has_function_privilege('infra_web','control_plane.live_session(bytea)','EXECUTE') THEN
    RAISE EXCEPTION 'infra_web can call live_session directly';
  END IF;
  IF NOT has_function_privilege('infra_web','control_plane.change_local_password(bytea,text,bytea,bytea,interval,interval,bytea,bytea)','EXECUTE') THEN
    RAISE EXCEPTION 'infra_web cannot change a password';
  END IF;

  RAISE NOTICE 'local session rotation assertions passed';
END $$;

ROLLBACK;
