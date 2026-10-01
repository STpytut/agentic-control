\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_owner uuid;
  v_session_a uuid;
  v_session_b uuid;
  v_result jsonb;
  v_revoked integer;
  v_attempt bigint;
  v_hash text := '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA';
BEGIN
  -- ---------------------------------------------------------- bootstrap ----

  -- Runs against an installation that may already hold a local account. The
  -- whole test rolls back, so clearing them here is safe and keeps the
  -- bootstrap assertions meaningful on a live database.
  DELETE FROM web_sessions;
  DELETE FROM auth_attempts;
  UPDATE users SET username=NULL, password_hash=NULL, password_changed_at=NULL,
                   must_change_password=false, disabled_at=NULL;

  v_result := bootstrap_local_owner('admin-k7m2xq', v_hash, 'Owner');
  v_owner := (v_result->>'user_id')::uuid;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'bootstrap did not return an owner'; END IF;
  IF NOT (SELECT must_change_password FROM users WHERE id=v_owner) THEN
    RAISE EXCEPTION 'bootstrap must force a password change';
  END IF;

  -- A second bootstrap must never mint another owner or reset the first.
  BEGIN
    PERFORM bootstrap_local_owner('admin-other', v_hash, 'Other');
    RAISE EXCEPTION 'second bootstrap was allowed';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;

  -- ------------------------------------------------------- constraints ----

  BEGIN
    UPDATE users SET username='AB' WHERE id=v_owner;
    RAISE EXCEPTION 'username format constraint did not fire';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE users SET password_hash='plaintext' WHERE id=v_owner;
    RAISE EXCEPTION 'argon2 hash prefix constraint did not fire';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A username without a hash would be a passwordless account.
  BEGIN
    UPDATE users SET password_hash=NULL WHERE id=v_owner;
    RAISE EXCEPTION 'local auth completeness constraint did not fire';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ---------------------------------------------------------- sessions ----

  v_result := create_web_session(v_owner, sha256('token-a'::bytea), sha256('csrf-a'::bytea));
  v_session_a := (v_result->>'session_id')::uuid;

  IF NOT (touch_web_session(sha256('token-a'::bytea))->>'valid')::boolean THEN
    RAISE EXCEPTION 'a fresh session did not validate';
  END IF;
  IF (touch_web_session(sha256('token-unknown'::bytea))->>'reason')<>'unknown' THEN
    RAISE EXCEPTION 'an unknown digest did not report unknown';
  END IF;

  -- The raw token must never be recoverable from the row.
  IF EXISTS (SELECT 1 FROM web_sessions WHERE token_digest='token-a'::bytea) THEN
    RAISE EXCEPTION 'a raw token was stored instead of its digest';
  END IF;

  -- Digests are fixed width, so a truncated or oversized value cannot be stored.
  BEGIN
    INSERT INTO web_sessions(user_id,token_digest,csrf_digest,expires_at,absolute_expires_at)
    VALUES (v_owner,'\x00'::bytea,sha256('c'::bytea),
            clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day');
    RAISE EXCEPTION 'digest length constraint did not fire';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- The idle deadline may never outrun the absolute deadline.
  BEGIN
    INSERT INTO web_sessions(user_id,token_digest,csrf_digest,expires_at,absolute_expires_at)
    VALUES (v_owner,sha256('token-bad'::bytea),sha256('csrf-bad'::bytea),
            clock_timestamp()+interval '2 days',clock_timestamp()+interval '1 day');
    RAISE EXCEPTION 'idle-within-absolute constraint did not fire';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Idle expiry is self-healing: touching an idled-out session revokes it.
  UPDATE web_sessions SET expires_at=clock_timestamp()-interval '1 second'
  WHERE id=v_session_a;
  IF (touch_web_session(sha256('token-a'::bytea))->>'reason')<>'expired' THEN
    RAISE EXCEPTION 'an idled-out session still validated';
  END IF;
  IF (SELECT revoked_reason FROM web_sessions WHERE id=v_session_a)<>'expired' THEN
    RAISE EXCEPTION 'an idled-out session was not revoked';
  END IF;

  -- The absolute deadline is independent of the idle one.
  v_result := create_web_session(v_owner, sha256('token-b'::bytea), sha256('csrf-b'::bytea));
  v_session_b := (v_result->>'session_id')::uuid;
  UPDATE web_sessions SET absolute_expires_at=clock_timestamp()-interval '1 second',
                          expires_at=clock_timestamp()-interval '1 second'
  WHERE id=v_session_b;
  IF (touch_web_session(sha256('token-b'::bytea))->>'valid')::boolean THEN
    RAISE EXCEPTION 'a session past its absolute deadline still validated';
  END IF;

  -- Sliding must never push the idle deadline past the absolute one.
  PERFORM create_web_session(v_owner, sha256('token-c'::bytea), sha256('csrf-c'::bytea),
                             interval '12 hours', interval '1 hour');
  UPDATE web_sessions SET last_seen_at=clock_timestamp()-interval '1 hour'
  WHERE token_digest=sha256('token-c'::bytea);
  PERFORM touch_web_session(sha256('token-c'::bytea), interval '12 hours');
  IF (SELECT expires_at>absolute_expires_at FROM web_sessions
      WHERE token_digest=sha256('token-c'::bytea)) THEN
    RAISE EXCEPTION 'sliding pushed the idle deadline past the absolute deadline';
  END IF;

  -- A revoked session stays revoked.
  PERFORM revoke_web_session(sha256('token-c'::bytea),'logout');
  IF (touch_web_session(sha256('token-c'::bytea))->>'reason')<>'revoked' THEN
    RAISE EXCEPTION 'a revoked session still validated';
  END IF;

  -- --------------------------------------------- credential rotation ----

  PERFORM create_web_session(v_owner, sha256('keep'::bytea), sha256('keep-csrf'::bytea));
  PERFORM create_web_session(v_owner, sha256('drop-1'::bytea), sha256('drop-1-csrf'::bytea));
  PERFORM create_web_session(v_owner, sha256('drop-2'::bytea), sha256('drop-2-csrf'::bytea));

  v_result := set_user_password(v_owner, v_hash, false,
    (SELECT id FROM web_sessions WHERE token_digest=sha256('keep'::bytea)));

  IF (v_result->>'sessions_revoked')::integer <> 2 THEN
    RAISE EXCEPTION 'password change revoked % sibling sessions, expected 2',
      v_result->>'sessions_revoked';
  END IF;
  IF NOT (touch_web_session(sha256('keep'::bytea))->>'valid')::boolean THEN
    RAISE EXCEPTION 'password change revoked the caller''s own session';
  END IF;
  IF (touch_web_session(sha256('drop-1'::bytea))->>'reason')<>'revoked' THEN
    RAISE EXCEPTION 'password change did not revoke a sibling session';
  END IF;
  IF (SELECT password_changed_at FROM users WHERE id=v_owner) IS NULL THEN
    RAISE EXCEPTION 'password change did not stamp password_changed_at';
  END IF;

  -- A username change revokes everything, including the caller's own session.
  v_result := set_user_username(v_owner,'admin-renamed');
  IF (v_result->>'sessions_revoked')::integer < 1 THEN
    RAISE EXCEPTION 'username change did not revoke live sessions';
  END IF;
  IF (touch_web_session(sha256('keep'::bytea))->>'valid')::boolean THEN
    RAISE EXCEPTION 'username change left a live session behind';
  END IF;
  IF NOT (authenticate_lookup('ADMIN-RENAMED')->>'found')::boolean THEN
    RAISE EXCEPTION 'username lookup is not case-insensitive';
  END IF;

  -- --------------------------------------------------- disabled owner ----

  UPDATE users SET disabled_at=clock_timestamp() WHERE id=v_owner;
  BEGIN
    PERFORM create_web_session(v_owner, sha256('nope'::bytea), sha256('nope-csrf'::bytea));
    RAISE EXCEPTION 'a disabled operator was granted a session';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;
  IF NOT (authenticate_lookup('admin-renamed')->>'disabled')::boolean THEN
    RAISE EXCEPTION 'lookup did not report the disabled state';
  END IF;
  UPDATE users SET disabled_at=NULL WHERE id=v_owner;

  -- ------------------------------------------------------ rate limiting ----

  -- begin_auth_attempt reserves: the attempt row is written inside the same
  -- locked transaction that reads the count, so a request in flight consumes
  -- budget. That is what makes concurrent logins safe, and it is testable
  -- sequentially by simply never resolving the reservations.
  IF (begin_auth_attempt('admin-renamed', sha256('ip-1'::bytea))->>'allowed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'a clean history refused the first attempt';
  END IF;

  -- One reservation is already outstanding; nine more exhaust the window.
  FOR i IN 1..9 LOOP
    PERFORM begin_auth_attempt('admin-renamed', sha256('ip-1'::bytea));
  END LOOP;

  v_result := begin_auth_attempt('admin-renamed', sha256('ip-1'::bytea));
  IF (v_result->>'allowed')::boolean THEN
    RAISE EXCEPTION 'the 11th attempt was admitted despite 10 unresolved reservations';
  END IF;
  IF NOT (v_result->>'locked')::boolean THEN
    RAISE EXCEPTION 'the refused attempt did not report a lockout';
  END IF;
  IF (v_result->>'retry_after_seconds')::integer <= 0 THEN
    RAISE EXCEPTION 'lockout reported no retry delay';
  END IF;

  -- A refusal is itself recorded, so probing cannot be free.
  IF NOT EXISTS (SELECT 1 FROM auth_attempts
                 WHERE username='admin-renamed' AND outcome='locked') THEN
    RAISE EXCEPTION 'a locked-out attempt was not recorded';
  END IF;

  -- A different account is unaffected.
  IF NOT (begin_auth_attempt('someone-else', sha256('ip-2'::bytea))->>'allowed')::boolean THEN
    RAISE EXCEPTION 'lockout leaked across accounts';
  END IF;

  -- finish_auth_attempt resolves exactly once.
  v_result := begin_auth_attempt('resolve-probe', sha256('ip-4'::bytea));
  v_attempt := (v_result->>'attempt_id')::bigint;
  IF NOT (finish_auth_attempt(v_attempt,'success')->>'resolved')::boolean THEN
    RAISE EXCEPTION 'a pending attempt could not be resolved';
  END IF;
  IF (finish_auth_attempt(v_attempt,'bad_password')->>'resolved')::boolean THEN
    RAISE EXCEPTION 'an already-resolved attempt was rewritten';
  END IF;
  IF (SELECT outcome FROM auth_attempts WHERE id=v_attempt) <> 'success' THEN
    RAISE EXCEPTION 'replaying finish_auth_attempt changed the recorded outcome';
  END IF;

  BEGIN
    PERFORM finish_auth_attempt(v_attempt,'pending');
    RAISE EXCEPTION 'an attempt was resolved back to pending';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;

  -- A resolved success stops counting against the budget; failures do not.
  IF (auth_lockout_state('resolve-probe', sha256('ip-4'::bytea))->>'username_failures')::integer <> 0 THEN
    RAISE EXCEPTION 'a successful attempt still counted as a failure';
  END IF;

  -- Attempts outside the window stop counting.
  UPDATE auth_attempts SET attempted_at=clock_timestamp()-interval '1 hour'
  WHERE username='admin-renamed';
  IF NOT (begin_auth_attempt('admin-renamed', sha256('ip-1'::bytea))->>'allowed')::boolean THEN
    RAISE EXCEPTION 'lockout counted attempts outside the window';
  END IF;

  -- An unknown username is still recorded, or the lockout could be bypassed by
  -- probing names that do not exist.
  v_result := begin_auth_attempt('ghost', sha256('ip-3'::bytea));
  PERFORM finish_auth_attempt((v_result->>'attempt_id')::bigint,'unknown_user');
  IF NOT EXISTS (SELECT 1 FROM auth_attempts WHERE username='ghost') THEN
    RAISE EXCEPTION 'an unknown-user attempt was not recorded';
  END IF;

  -- ------------------------------------------------------------ pruning ----

  PERFORM create_web_session(v_owner, sha256('stale'::bytea), sha256('stale-csrf'::bytea));
  UPDATE web_sessions SET expires_at=clock_timestamp()-interval '1 second'
  WHERE token_digest=sha256('stale'::bytea);
  UPDATE web_sessions SET revoked_at=clock_timestamp()-interval '90 days'
  WHERE token_digest=sha256('drop-1'::bytea);
  UPDATE auth_attempts SET attempted_at=clock_timestamp()-interval '90 days'
  WHERE username='ghost';

  v_result := prune_auth_records();
  IF (v_result->>'sessions_expired')::integer < 1 THEN
    RAISE EXCEPTION 'pruning did not expire an idled-out session';
  END IF;
  IF (v_result->>'attempts_pruned')::integer < 1 THEN
    RAISE EXCEPTION 'pruning did not drop an aged attempt row';
  END IF;
  IF EXISTS (SELECT 1 FROM web_sessions WHERE token_digest=sha256('drop-1'::bytea)) THEN
    RAISE EXCEPTION 'pruning kept a long-revoked session';
  END IF;
  -- Live sessions must survive pruning.
  PERFORM create_web_session(v_owner, sha256('live'::bytea), sha256('live-csrf'::bytea));
  PERFORM prune_auth_records();
  IF NOT (touch_web_session(sha256('live'::bytea))->>'valid')::boolean THEN
    RAISE EXCEPTION 'pruning revoked a live session';
  END IF;

  -- --------------------------------------------------- definer surface ----

  -- Every function the web role reaches must be SECURITY DEFINER with a pinned
  -- search_path; ADR-0011 makes that the only way infra_web can touch these
  -- tables at all.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='control_plane'
      AND p.proname IN ('authenticate_lookup','auth_lockout_state','record_auth_attempt',
                        'create_web_session','touch_web_session','revoke_web_session',
                        'revoke_user_sessions','set_user_password','set_user_username',
                        'bootstrap_local_owner','prune_auth_records')
      AND (NOT p.prosecdef
           OR p.proconfig IS NULL
           OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'))
  ) THEN
    RAISE EXCEPTION 'a local-auth function is not SECURITY DEFINER with a pinned search_path';
  END IF;

  RAISE NOTICE 'local operator auth assertions passed';
END $$;

ROLLBACK;
