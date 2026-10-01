\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

-- 0046: rehashing, credential retirement, and the audit row the CLI now owns.
--
-- The audit assertions matter as much as the behaviour: the whole point of the
-- change is that a reader of audit_events can tell who disabled an operator and
-- when a hash moved. A function that writes its own row with a guessed actor is
-- worse than one that writes none, because it looks authoritative.

DO $$
DECLARE
  v_owner uuid;
  v_hash text := '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaA';
  v_old_hash text := '$argon2id$v=19$m=4096,t=1,p=1$b2xkc2FsdG9sZHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';
  v_result jsonb;
  v_status jsonb;
  v_before integer;
  v_during integer;
BEGIN
  DELETE FROM web_sessions;
  DELETE FROM auth_attempts;
  DELETE FROM audit_events WHERE action IN
    ('operator.disabled','operator.enabled','auth.password_rehashed');
  UPDATE users SET username=NULL, password_hash=NULL, password_changed_at=NULL,
                   must_change_password=false, disabled_at=NULL, last_login_at=NULL;

  -- ------------------------------------------ retirement, before anybody ----
  --
  -- The no-operator branch of the predicate is not asserted here: this file runs
  -- against whatever database DATABASE_URL names, which may well hold projects
  -- that make deleting `users` impossible. It is covered by the unit test for
  -- the credential helper, which can construct that state directly.

  v_result := bootstrap_local_owner('admin-rehash', v_hash, 'Owner');
  v_owner := (v_result->>'user_id')::uuid;

  -- ------------------------------------------------ disabled, no audit -----

  -- The CLI writes this row now, with the real OS user. The function must not
  -- write one at all: two rows per disable, one of them a lie, is the bug.
  SELECT count(*) INTO v_before FROM audit_events WHERE action IN ('operator.disabled','operator.enabled');
  PERFORM set_local_operator_disabled(v_owner, true);
  PERFORM set_local_operator_disabled(v_owner, false);
  SELECT count(*) INTO v_during FROM audit_events WHERE action IN ('operator.disabled','operator.enabled');
  IF v_during <> v_before THEN
    RAISE EXCEPTION 'set_local_operator_disabled still writes its own audit row';
  END IF;

  -- ------------------------------------------------------ rehash is narrow --

  UPDATE users SET password_hash=v_old_hash,
                   password_changed_at=clock_timestamp()-interval '400 days',
                   must_change_password=true
  WHERE id=v_owner;
  PERFORM create_web_session(v_owner, decode(repeat('a1',32),'hex'), decode(repeat('a2',32),'hex'),
                             interval '12 hours', interval '30 days');

  v_result := rehash_local_password(v_owner, v_old_hash, v_hash);

  IF (SELECT password_hash FROM users WHERE id=v_owner) <> v_hash THEN
    RAISE EXCEPTION 'the rehash did not replace the encoding';
  END IF;
  -- The password did not change, so the date it changed must not move, and a
  -- pending forced change must survive an encoding upgrade.
  IF (SELECT password_changed_at FROM users WHERE id=v_owner) > clock_timestamp()-interval '399 days' THEN
    RAISE EXCEPTION 'the rehash moved password_changed_at';
  END IF;
  IF NOT (SELECT must_change_password FROM users WHERE id=v_owner) THEN
    RAISE EXCEPTION 'the rehash cleared the forced password change';
  END IF;
  -- And it must not log anybody out: a routine upgrade is not a credential change.
  IF (SELECT count(*) FROM web_sessions WHERE user_id=v_owner AND revoked_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'the rehash ended a session';
  END IF;
  IF v_result->>'rehashed' <> 'true' THEN
    RAISE EXCEPTION 'the rehash did not report success';
  END IF;

  IF (SELECT count(*) FROM audit_events
      WHERE action='auth.password_rehashed' AND actor_id=v_owner::text
        AND actor_type='operator' AND target_id=v_owner::text) <> 1 THEN
    RAISE EXCEPTION 'the rehash was not recorded exactly once';
  END IF;

  -- A rehash must never be a way to install a plaintext or a foreign encoding.
  BEGIN
    PERFORM rehash_local_password(v_owner, v_old_hash, 'plaintext');
    RAISE EXCEPTION 'a non-Argon2 encoding was accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  -- An unknown account loses the swap rather than raising: the caller only ever
  -- learns that its verification no longer matches anything.
  IF (rehash_local_password(gen_random_uuid(), v_old_hash, v_hash)->>'rehashed') <> 'false' THEN
    RAISE EXCEPTION 'a rehash was applied to an unknown operator';
  END IF;

  -- -------------------------------------------- retirement, in sequence ----

  -- Signed in once, but the generated password is still the live credential.
  UPDATE users SET must_change_password=true, last_login_at=clock_timestamp() WHERE id=v_owner;
  v_status := initial_credentials_status();
  IF v_status->>'generated_password_retired' <> 'false' THEN
    RAISE EXCEPTION 'the credentials retired while the generated password was still live';
  END IF;

  -- Changed the password but never signed in: nothing in the file is confirmed.
  UPDATE users SET must_change_password=false, last_login_at=NULL WHERE id=v_owner;
  v_status := initial_credentials_status();
  IF v_status->>'generated_password_retired' <> 'false' THEN
    RAISE EXCEPTION 'the credentials retired with no recorded sign-in';
  END IF;

  -- Both: the generated password is genuinely retired.
  UPDATE users SET must_change_password=false, last_login_at=clock_timestamp() WHERE id=v_owner;
  v_status := initial_credentials_status();
  IF v_status->>'generated_password_retired' <> 'true' THEN
    RAISE EXCEPTION 'a retired credential was not reported as retired';
  END IF;
  IF v_status->>'username' <> 'admin-rehash' THEN
    RAISE EXCEPTION 'the status did not name the operator';
  END IF;

  -- ---------------------------------------------------------- definition ----

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='control_plane'
      AND p.proname IN ('set_local_operator_disabled','rehash_local_password','initial_credentials_status')
      AND (NOT p.prosecdef
           OR p.proconfig IS NULL
           OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'))
  ) THEN
    RAISE EXCEPTION 'a 0046 function is not SECURITY DEFINER with a pinned search_path';
  END IF;

  IF NOT has_function_privilege('infra_web','control_plane.rehash_local_password(uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'infra_web cannot rehash a password';
  END IF;
  -- The web process must never be what decides a root-only file may be deleted.
  IF has_function_privilege('infra_web','control_plane.initial_credentials_status()','EXECUTE') THEN
    RAISE EXCEPTION 'infra_web can read the credential retirement state';
  END IF;

  RAISE NOTICE 'local rehash and credential retirement assertions passed';
END $$;

ROLLBACK;
