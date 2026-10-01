\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

-- 0049: whose audit row is it?
--
-- `write_operator_audit` took the actor as a parameter and was granted to
-- `infra_web`, which checked only that the id belonged to an owner — not that the
-- caller was that owner. The web role could append an `auth.login` naming the
-- owner, with a session id and details of its choosing. A comment claimed the
-- opposite; this file is what makes the claim true and keeps it true.
--
-- Two halves: the forgery is refused, and every operation that legitimately
-- writes an audit row still does so, attributed to the account the function read
-- off the session token rather than to anything the caller supplied.

DO $$
DECLARE
  v_owner uuid;
  v_username text;
  v_hash text := '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaA';
  v_reset text := '$argon2id$v=19$m=19456,t=2,p=1$cmVzZXRzYWx0cmVzZXRzYQ$aGFzaGhhc2hoYXNoaGFzaA';
  v_attempt bigint;
  v_login jsonb;
  v_result jsonb;
  v_token_a bytea := decode(repeat('11',32),'hex');
  v_csrf_a bytea := decode(repeat('12',32),'hex');
  v_token_b bytea := decode(repeat('21',32),'hex');
  v_csrf_b bytea := decode(repeat('22',32),'hex');
  -- A revoked session keeps its row, so every new session needs a fresh digest:
  -- token_digest is unique, which is what stops a spent token being reused.
  v_token_c bytea := decode(repeat('23',32),'hex');
  v_token_d bytea := decode(repeat('24',32),'hex');
  v_token_e bytea := decode(repeat('25',32),'hex');
  v_actor text;
  v_before bigint;
  v_after bigint;
  v_outcome text;
BEGIN
  DELETE FROM web_sessions;
  DELETE FROM auth_attempts;
  UPDATE users SET username=NULL, password_hash=NULL, must_change_password=false,
                   disabled_at=NULL, last_login_at=NULL;
  v_owner := (bootstrap_local_owner('admin-audit', v_hash, 'Owner')->>'user_id')::uuid;
  v_username := 'admin-audit';

  -- ------------------------------------------- the sign-in writes its own row --

  v_before := (SELECT count(*) FROM audit_events WHERE action='auth.login');
  v_attempt := (begin_auth_attempt(v_username, decode(repeat('31',32),'hex'))->>'attempt_id')::bigint;
  v_login := complete_local_login(v_attempt, v_owner, v_username, v_hash,
    v_token_a, v_csrf_a, decode(repeat('31',32),'hex'), NULL, interval '12 hours', interval '30 days');
  IF v_login->>'completed' <> 'true' THEN
    RAISE EXCEPTION 'the sign-in did not complete: %', v_login;
  END IF;
  v_after := (SELECT count(*) FROM audit_events WHERE action='auth.login');
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'the sign-in was not audited exactly once';
  END IF;
  SELECT actor_id INTO v_actor FROM audit_events
  WHERE action='auth.login' AND target_id=(v_login->>'session_id') ORDER BY occurred_at DESC LIMIT 1;
  IF v_actor <> v_owner::text THEN
    RAISE EXCEPTION 'the sign-in was attributed to % rather than the operator', v_actor;
  END IF;

  -- ----------------------------------------------- the external writer -------

  -- A second live session, so the rename and revocation paths have something to
  -- act on. Created directly: this test is about attribution, not about issuance.
  PERFORM create_web_session(v_owner, v_token_b, v_csrf_b, interval '12 hours', interval '30 days');

  -- The token-derived writer attributes to the session holder...
  v_result := write_session_audit(v_token_a, 'operator.audit_probe', 'project', 'probe-target',
                                  'allowed', jsonb_build_object('probe', true), NULL, 'probe-1');
  IF v_result->>'audit_event_id' IS NULL THEN
    RAISE EXCEPTION 'write_session_audit did not write anything';
  END IF;
  SELECT actor_id INTO v_actor FROM audit_events WHERE correlation_id='probe-1';
  IF v_actor <> v_owner::text THEN
    RAISE EXCEPTION 'write_session_audit attributed the row to %', v_actor;
  END IF;

  -- ...and takes no user id at all, so there is no parameter to point elsewhere.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='control_plane' AND p.proname='write_session_audit'
      AND pg_get_function_identity_arguments(p.oid) LIKE '%user_id%'
  ) THEN
    RAISE EXCEPTION 'write_session_audit takes a caller-supplied actor';
  END IF;

  -- A digest with no live session behind it is refused, because a row for a
  -- session that does not exist is the forgery being prevented.
  BEGIN
    PERFORM write_session_audit(decode(repeat('ff',32),'hex'), 'auth.login', 'session', 'forged');
    RAISE EXCEPTION 'write_session_audit accepted a digest with no live session';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;

  -- A revoked session is no better.
  PERFORM revoke_web_session(v_token_b, 'admin_revoke');
  BEGIN
    PERFORM write_session_audit(v_token_b, 'auth.login', 'session', 'forged');
    RAISE EXCEPTION 'write_session_audit accepted a revoked session';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;

  -- The namespaces remain constrained. `operator.*` is the caller's to name;
  -- `auth.*` is not, because asserting that a credential changed when it did not
  -- is a lie regardless of which session signs it.
  BEGIN
    PERFORM write_session_audit(v_token_a, 'system.forged', 'x', 'y');
    RAISE EXCEPTION 'an out-of-namespace audit action was accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;

  BEGIN
    PERFORM write_session_audit(v_token_a, 'auth.password_changed', 'session', 'forged');
    RAISE EXCEPTION 'a credential event was forged through the operator writer';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;

  -- ----------------------------------------------- the operations -----------
  --
  -- Each of these used to be written by the web tier with a user id it supplied.
  -- They are checked by action and actor, so a row that is merely present but
  -- attributed to the wrong account still fails.

  PERFORM create_web_session(v_owner, v_token_c, v_csrf_b, interval '12 hours', interval '30 days');

  v_before := (SELECT count(*) FROM audit_events WHERE action='auth.session_revoked');
  v_result := revoke_web_session_by_id(v_token_a, (SELECT id FROM web_sessions WHERE token_digest=v_token_c), 'admin_revoke');
  IF v_result->>'revoked' <> 'true' THEN
    RAISE EXCEPTION 'the session was not revoked: %', v_result;
  END IF;
  SELECT actor_id INTO v_actor FROM audit_events
  WHERE action='auth.session_revoked' ORDER BY occurred_at DESC LIMIT 1;
  IF (SELECT count(*) FROM audit_events WHERE action='auth.session_revoked') <> v_before + 1
     OR v_actor <> v_owner::text THEN
    RAISE EXCEPTION 'the single-session revocation was not audited once against the operator';
  END IF;

  -- A revocation that finds nothing writes nothing: no row for something that
  -- did not happen.
  v_before := (SELECT count(*) FROM audit_events WHERE action='auth.session_revoked');
  IF revoke_web_session_by_id(v_token_a, (SELECT id FROM web_sessions WHERE token_digest=v_token_c), 'admin_revoke') IS NOT NULL THEN
    RAISE EXCEPTION 'a spent session was revoked twice';
  END IF;
  IF (SELECT count(*) FROM audit_events WHERE action='auth.session_revoked') <> v_before THEN
    RAISE EXCEPTION 'a no-op revocation wrote an audit row';
  END IF;

  PERFORM create_web_session(v_owner, v_token_d, v_csrf_b, interval '12 hours', interval '30 days');
  v_result := revoke_other_web_sessions(v_token_a, 'admin_revoke');
  IF (v_result->>'sessions_revoked')::integer <> 1 THEN
    RAISE EXCEPTION 'the bulk revocation did not end exactly one session: %', v_result;
  END IF;
  SELECT actor_id INTO v_actor FROM audit_events
  WHERE action='auth.sessions_revoked' ORDER BY occurred_at DESC LIMIT 1;
  IF v_actor <> v_owner::text THEN
    RAISE EXCEPTION 'the bulk revocation was attributed to %', v_actor;
  END IF;

  -- The password change carries its own row, and the actor is the token holder.
  v_before := (SELECT count(*) FROM audit_events WHERE action='auth.password_changed');
  v_result := change_local_password(v_token_a, v_reset, decode(repeat('41',32),'hex'),
                                    decode(repeat('42',32),'hex'));
  SELECT actor_id INTO v_actor FROM audit_events
  WHERE action='auth.password_changed' ORDER BY occurred_at DESC LIMIT 1;
  IF (SELECT count(*) FROM audit_events WHERE action='auth.password_changed') <> v_before + 1
     OR v_actor <> v_owner::text THEN
    RAISE EXCEPTION 'the password change was not audited once against the operator';
  END IF;

  -- The rename, likewise.
  v_before := (SELECT count(*) FROM audit_events WHERE action='auth.username_changed');
  v_result := change_local_username(decode(repeat('41',32),'hex'), 'admin-renamed');
  SELECT actor_id INTO v_actor FROM audit_events
  WHERE action='auth.username_changed' ORDER BY occurred_at DESC LIMIT 1;
  IF (SELECT count(*) FROM audit_events WHERE action='auth.username_changed') <> v_before + 1
     OR v_actor <> v_owner::text THEN
    RAISE EXCEPTION 'the rename was not audited once against the operator';
  END IF;
  IF v_result->>'username' <> 'admin-renamed' THEN
    RAISE EXCEPTION 'the rename did not take effect: %', v_result;
  END IF;

  -- Logout is named for what it is; a second logout on the same token writes
  -- nothing, because the token is already spent.
  PERFORM create_web_session(v_owner, v_token_e, v_csrf_b, interval '12 hours', interval '30 days');
  v_before := (SELECT count(*) FROM audit_events WHERE action='auth.logout');
  v_result := revoke_web_session(v_token_e, 'logout');
  IF v_result->>'revoked' <> 'true' THEN
    RAISE EXCEPTION 'the logout did not revoke: %', v_result;
  END IF;
  SELECT actor_id INTO v_actor FROM audit_events
  WHERE action='auth.logout' ORDER BY occurred_at DESC LIMIT 1;
  IF (SELECT count(*) FROM audit_events WHERE action='auth.logout') <> v_before + 1
     OR v_actor <> v_owner::text THEN
    RAISE EXCEPTION 'the logout was not audited once against the operator';
  END IF;
  v_result := revoke_web_session(v_token_e, 'logout');
  IF (v_result->>'revoked') <> 'false'
     OR (SELECT count(*) FROM audit_events WHERE action='auth.logout') <> v_before + 1 THEN
    RAISE EXCEPTION 'a repeated logout wrote a second audit row';
  END IF;

  RAISE NOTICE 'audit binding assertions passed';
END $$;

-- ------------------------------------------------- the web role, again -------

-- Behavioural, under the role itself: the trusted-actor API is refused and the
-- token-derived one is reachable.
DO $$
DECLARE v_outcome text;
BEGIN
  EXECUTE 'SET ROLE infra_web';
  BEGIN
    PERFORM write_operator_audit(
      (SELECT id FROM control_plane.users WHERE role='owner' LIMIT 1),
      'auth.login','session','forged-session');
    v_outcome := 'ACCEPTED';
  EXCEPTION
    WHEN insufficient_privilege THEN v_outcome := 'denied';
    WHEN OTHERS THEN v_outcome := 'reached the body:'||SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';

  IF v_outcome <> 'denied' THEN
    RAISE EXCEPTION 'infra_web can supply its own audit actor (%)', v_outcome;
  END IF;

  RAISE NOTICE 'audit attribution denial passed';
END $$;

RESET ROLE;

ROLLBACK;
