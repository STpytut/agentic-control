\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

-- 0047: the credential fence.
--
-- These are the two sequences the review reproduced, written down so they cannot
-- come back:
--
--   * a login that verified a password, then a reset that ended every session,
--     and then the in-flight login creating a new one from the old password;
--   * a rehash decided from a hash that had already been replaced, installing a
--     new encoding of the old password over the new one.
--
-- Both are simulated in order rather than concurrently, which is exactly how the
-- race manifests: the interleaving is what matters, not the parallelism.

DO $$
DECLARE
  v_owner uuid;
  v_attempt bigint;
  v_result jsonb;
  v_live integer;
  v_old text := '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaA';
  v_reset text := '$argon2id$v=19$m=19456,t=2,p=1$cmVzZXRzYWx0cmVzZXRzYQ$aGFzaGhhc2hoYXNoaGFzaA';
  v_rehash text := '$argon2id$v=19$m=19456,t=2,p=1$cmVoYXNoc2FsdHJoYXNoc2E$aGFzaGhhc2hoYXNoaGFzaA';
  v_ip bytea := decode(repeat('aa',32),'hex');
  -- audit_events is append-only, so every audit assertion is a delta against the
  -- counts this transaction started with.
  v_login_before bigint;
  v_rehash_before bigint;
  v_token bytea := decode(repeat('bb',32),'hex');
  v_csrf bytea := decode(repeat('cc',32),'hex');
BEGIN
  DELETE FROM web_sessions;
  DELETE FROM auth_attempts;
  DELETE FROM credential_retirements;
  UPDATE users SET username=NULL,password_hash=NULL,must_change_password=false,disabled_at=NULL,last_login_at=NULL;
  v_owner := (bootstrap_local_owner('admin-fence', v_old, 'Owner')->>'user_id')::uuid;
  v_login_before := (SELECT count(*) FROM audit_events WHERE action='auth.login');
  v_rehash_before := (SELECT count(*) FROM audit_events WHERE action='auth.password_rehashed');

  -- ============================================ the login/reset race ========

  -- 1. A login reserves its slot and reads the hash it will verify.
  v_attempt := (begin_auth_attempt('admin-fence', v_ip)->>'attempt_id')::bigint;

  -- 2. A reset lands while Argon2id is running.
  PERFORM set_user_password(v_owner, v_reset, true, NULL);
  SELECT count(*) INTO v_live FROM web_sessions WHERE revoked_at IS NULL;
  IF v_live <> 0 THEN RAISE EXCEPTION 'the reset left a live session'; END IF;

  -- 3. The in-flight login completes with the credentials it verified. Before
  --    0047 this created a session; now it must refuse.
  v_result := complete_local_login(v_attempt, v_owner, 'admin-fence', v_old, v_token, v_csrf, v_ip);
  IF v_result->>'completed' <> 'false' THEN
    RAISE EXCEPTION 'a session was issued for a password that had already been reset';
  END IF;
  IF v_result->>'reason' <> 'password_changed' THEN
    RAISE EXCEPTION 'the refusal did not name the changed password: %', v_result->>'reason';
  END IF;
  SELECT count(*) INTO v_live FROM web_sessions;
  IF v_live <> 0 THEN RAISE EXCEPTION 'the refused login still created a session'; END IF;
  -- The reset stands: the old login did not put the old password back.
  IF (SELECT password_hash FROM users WHERE id=v_owner) <> v_reset THEN
    RAISE EXCEPTION 'the refused login disturbed the password';
  END IF;
  -- And no login was recorded, because none happened.
  IF (SELECT count(*) FROM audit_events WHERE action='auth.login') <> v_login_before THEN
    RAISE EXCEPTION 'a refused login was audited as a success';
  END IF;

  -- ============================================ the login/rename race =======

  PERFORM set_user_password(v_owner, v_old, true, NULL);
  v_attempt := (begin_auth_attempt('admin-fence', v_ip)->>'attempt_id')::bigint;
  PERFORM set_user_username(v_owner, 'admin-renamed');

  v_result := complete_local_login(v_attempt, v_owner, 'admin-fence', v_old, v_token, v_csrf, v_ip);
  IF v_result->>'completed' <> 'false' THEN
    RAISE EXCEPTION 'a session was issued for a username that had already been changed';
  END IF;
  IF v_result->>'reason' NOT IN ('username_changed','unknown_user') THEN
    RAISE EXCEPTION 'the refusal did not name the rename: %', v_result->>'reason';
  END IF;

  -- ============================================ the login/disable race =====

  v_attempt := (begin_auth_attempt('admin-renamed', v_ip)->>'attempt_id')::bigint;
  PERFORM set_local_operator_disabled(v_owner, true);
  v_result := complete_local_login(v_attempt, v_owner, 'admin-renamed', v_old, v_token, v_csrf, v_ip);
  IF v_result->>'completed' <> 'false' OR v_result->>'reason' <> 'disabled' THEN
    RAISE EXCEPTION 'a disabled operator completed a login: %', v_result;
  END IF;
  PERFORM set_local_operator_disabled(v_owner, false);

  -- ============================================ the quiet path still works ==

  -- Nothing moved, so the same call succeeds — otherwise the fence would just be
  -- a way of refusing every login.
  v_attempt := (begin_auth_attempt('admin-renamed', v_ip)->>'attempt_id')::bigint;
  v_result := complete_local_login(v_attempt, v_owner, 'admin-renamed', v_old, v_token, v_csrf, v_ip);
  IF v_result->>'completed' <> 'true' THEN
    RAISE EXCEPTION 'a login with unchanged credentials was refused: %', v_result;
  END IF;
  IF v_result->>'must_change_password' <> 'true' THEN
    RAISE EXCEPTION 'the completion did not report the forced password change';
  END IF;
  SELECT count(*) INTO v_live FROM web_sessions WHERE revoked_at IS NULL;
  IF v_live <> 1 THEN RAISE EXCEPTION 'the successful login did not create exactly one session'; END IF;
  IF (SELECT count(*) FROM audit_events WHERE action='auth.login') <> v_login_before + 1 THEN
    RAISE EXCEPTION 'the successful login was not audited exactly once';
  END IF;
  IF (SELECT last_login_at FROM users WHERE id=v_owner) IS NULL THEN
    RAISE EXCEPTION 'the completion did not record the sign-in';
  END IF;
  -- The reservation was resolved, not left pending.
  IF (SELECT outcome FROM auth_attempts WHERE id=v_attempt) <> 'success' THEN
    RAISE EXCEPTION 'the completion did not resolve its own reservation';
  END IF;

  -- An attempt that is not pending cannot be completed twice.
  v_result := complete_local_login(v_attempt, v_owner, 'admin-renamed', v_old, v_token, v_csrf, v_ip);
  IF v_result->>'completed' <> 'false' OR v_result->>'reason' <> 'attempt_not_reserved' THEN
    RAISE EXCEPTION 'a spent reservation was completed twice: %', v_result;
  END IF;
  SELECT count(*) INTO v_live FROM web_sessions WHERE revoked_at IS NULL;
  IF v_live <> 1 THEN RAISE EXCEPTION 'the replayed completion created a second session'; END IF;

  -- ============================================ the rehash CAS ==============

  -- The swap wins when the hash is still the verified one.
  v_result := rehash_local_password(v_owner, v_old, v_rehash);
  IF v_result->>'rehashed' <> 'true' THEN
    RAISE EXCEPTION 'a rehash against the current hash did not apply';
  END IF;
  IF (SELECT password_hash FROM users WHERE id=v_owner) <> v_rehash THEN
    RAISE EXCEPTION 'the applied rehash did not replace the encoding';
  END IF;

  -- And loses when it is not. This is the review's second reproduction.
  PERFORM set_user_password(v_owner, v_reset, true, NULL);
  v_result := rehash_local_password(v_owner, v_rehash, v_old);
  IF v_result->>'rehashed' <> 'false' THEN
    RAISE EXCEPTION 'a stale rehash overwrote a newer password';
  END IF;
  IF (SELECT password_hash FROM users WHERE id=v_owner) <> v_reset THEN
    RAISE EXCEPTION 'the losing rehash wrote anyway';
  END IF;
  -- A swap that did not happen is not a credential change and must not be audited.
  IF (SELECT count(*) FROM audit_events WHERE action='auth.password_rehashed') <> v_rehash_before + 1 THEN
    RAISE EXCEPTION 'the losing rehash wrote an audit row';
  END IF;
  -- Nothing else moved either: this is an encoding upgrade, never a credential one.
  IF NOT (SELECT must_change_password FROM users WHERE id=v_owner) THEN
    RAISE EXCEPTION 'the rehash cleared the forced password change';
  END IF;

  -- ============================================ retirement state machine ====

  v_result := begin_credential_retirement('/etc/infra-cod/initial-credentials','cli:tester',true);
  IF v_result->>'state' <> 'requested' THEN
    RAISE EXCEPTION 'the retirement did not start at requested: %', v_result;
  END IF;
  DECLARE v_id uuid := (v_result->>'id')::uuid;
  BEGIN
    -- Resuming before anything happened returns the same row, not a second one.
    IF (begin_credential_retirement('/etc/infra-cod/initial-credentials','cli:tester',true)->>'id')::uuid <> v_id THEN
      RAISE EXCEPTION 'a resumed retirement opened a second row';
    END IF;
    IF NOT (begin_credential_retirement('/etc/infra-cod/initial-credentials','cli:tester',true)->>'resumed')::boolean THEN
      RAISE EXCEPTION 'the resumed retirement did not report itself as resumed';
    END IF;

    -- The audit row cannot be written before the file removal is on record.
    BEGIN
      PERFORM advance_credential_retirement(v_id,'recorded');
      RAISE EXCEPTION 'the audit row was written before the removal';
    EXCEPTION WHEN sqlstate '55000' THEN NULL;
    END;

    PERFORM advance_credential_retirement(v_id,'file_removed', jsonb_build_object('mode',384));
    PERFORM advance_credential_retirement(v_id,'recorded');

    IF (SELECT count(*) FROM audit_events
        WHERE action='operator.credentials_retired'
          AND actor_id='cli:tester'
          AND correlation_id='credential-retirement:'||v_id) <> 1 THEN
      RAISE EXCEPTION 'the retirement was not audited exactly once';
    END IF;

    -- Repeat both steps: a rerun after a crash must not double anything.
    PERFORM advance_credential_retirement(v_id,'file_removed');
    PERFORM advance_credential_retirement(v_id,'recorded');
    IF (SELECT count(*) FROM audit_events
        WHERE action='operator.credentials_retired'
          AND correlation_id='credential-retirement:'||v_id) <> 1 THEN
      RAISE EXCEPTION 'a repeated retirement step wrote a second audit row';
    END IF;
    IF (SELECT state FROM credential_retirements WHERE id=v_id) <> 'recorded' THEN
      RAISE EXCEPTION 'the retirement did not reach its terminal state';
    END IF;

    -- A terminal row is not open, so a new file opens a new retirement.
    IF (begin_credential_retirement('/etc/infra-cod/initial-credentials','cli:tester',true)->>'id')::uuid = v_id THEN
      RAISE EXCEPTION 'a recorded retirement was reopened';
    END IF;
    DELETE FROM credential_retirements WHERE state <> 'recorded';
  END;

  -- Only one open retirement per path.
  PERFORM begin_credential_retirement('/tmp/creds','cli:a',true);
  IF (begin_credential_retirement('/tmp/creds','cli:b',true)->>'id')
     <> (SELECT id::text FROM credential_retirements WHERE path='/tmp/creds' AND state<>'recorded') THEN
    RAISE EXCEPTION 'two open retirements were created for one path';
  END IF;
  -- Reporting no file and resuming the same path must not open anything new.
  IF (begin_credential_retirement('/tmp/creds','cli:b',false)->>'resumed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'a path with an open retirement was not resumed';
  END IF;
  IF (begin_credential_retirement('/tmp/never-existed','cli:b',false)->>'nothing_to_do')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'a retirement was opened for a file that does not exist';
  END IF;

  -- A file that reappears under an open retirement resets it to requested: the
  -- state must not be allowed to claim a removal that has been undone.
  UPDATE credential_retirements SET state='file_removed', file_removed_at=clock_timestamp()
  WHERE path='/tmp/creds';
  IF (begin_credential_retirement('/tmp/creds','cli:b',true)->>'state') <> 'requested' THEN
    RAISE EXCEPTION 'a reappeared file did not reset the retirement';
  END IF;

  SELECT jsonb_array_length(open_credential_retirements()->'retirements') INTO v_live;
  IF v_live <> 1 THEN
    RAISE EXCEPTION 'open_credential_retirements reported % rows, expected 1', v_live;
  END IF;

  -- ============================================ definition and grants ======

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='control_plane'
      AND p.proname IN ('complete_local_login','rehash_local_password',
                        'begin_credential_retirement','advance_credential_retirement',
                        'open_credential_retirements')
      AND (NOT p.prosecdef
           OR p.proconfig IS NULL
           OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'))
  ) THEN
    RAISE EXCEPTION 'a 0047 function is not SECURITY DEFINER with a pinned search_path';
  END IF;

  -- The unsafe overload is gone, not merely superseded.
  IF to_regprocedure('control_plane.rehash_local_password(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'the id-only rehash is still callable';
  END IF;
  IF NOT has_function_privilege('infra_web',
       'control_plane.complete_local_login(bigint,uuid,text,text,bytea,bytea,bytea,bytea,interval,interval)','EXECUTE') THEN
    RAISE EXCEPTION 'infra_web cannot complete a login';
  END IF;
  -- The web process must not be able to drive the retirement of a root-only file.
  IF has_function_privilege('infra_web','control_plane.begin_credential_retirement(text,text,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'infra_web can start a credential retirement';
  END IF;

  RAISE NOTICE 'local credential fence assertions passed';
END $$;

ROLLBACK;
