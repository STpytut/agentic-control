-- Closing the credential race the review found.
--
-- Two windows, one shape: work that was decided from a value that could have
-- moved by the time it was acted on.
--
--   1. Login read the password hash, verified it, and *then* created a session in
--      a separate transaction. A reset-password or a rename landing in between
--      revoked every session, and the in-flight login immediately created a new
--      one from credentials that no longer existed. A reset that leaves a live
--      session behind is not a reset.
--   2. `rehash_local_password` matched on `user_id` alone. A reset landing
--      between the verification and the rehash was silently overwritten by a new
--      encoding of the *old* password — a credential change undone by a routine
--      upgrade, with no trace.
--
-- Both are fixed the same way the rest of this schema handles concurrent writes:
-- one narrow function that locks the row it is deciding about and acts on the
-- exact values the caller verified, refusing when they no longer match.
--
-- 0046 is already applied, so its checksums stand and this is a new file. The
-- two-argument `rehash_local_password` is dropped rather than overloaded: an
-- overload would leave the unsafe version callable, and a defaulted third
-- argument would make the two-argument call ambiguous.

SET search_path TO control_plane, public, extensions;

-- ======================================================= login fence ========

-- Completes a successful sign-in in one transaction: verify that the account is
-- still exactly what was checked, resolve the attempt, create the session, and
-- record it.
--
-- The row lock is the whole point. Every credential change — password, username,
-- disable — writes this row, so holding it here serialises the completion against
-- all of them. Two orders are possible and both are correct: either the change
-- commits first and this call refuses, or this call commits first and the change
-- then revokes the session it created.
--
-- A refusal deliberately leaves the reservation `pending`. The attempt row ages
-- out of the window on its own, and consuming budget for a login that could not
-- be completed is the fail-closed direction.
CREATE OR REPLACE FUNCTION complete_local_login(
  p_attempt_id bigint,
  p_user_id uuid,
  p_expected_username text,
  p_expected_password_hash text,
  p_token_digest bytea,
  p_csrf_digest bytea,
  p_ip_hash bytea DEFAULT NULL,
  p_user_agent_hash bytea DEFAULT NULL,
  p_idle interval DEFAULT interval '12 hours',
  p_absolute interval DEFAULT interval '30 days'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_user users%ROWTYPE;
  v_session web_sessions%ROWTYPE;
BEGIN
  IF p_token_digest IS NULL OR length(p_token_digest)<>32
     OR p_csrf_digest IS NULL OR length(p_csrf_digest)<>32 THEN
    RAISE EXCEPTION 'a session digest must be 32 bytes' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_user FROM users u WHERE u.id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('completed',false,'reason','unknown_user');
  END IF;

  -- The values the caller verified. If either moved while Argon2id was running,
  -- that verification says nothing about this row, and a session issued now would
  -- be a session for a credential that has been replaced.
  IF v_user.username IS DISTINCT FROM lower(NULLIF(p_expected_username,'')) THEN
    RETURN jsonb_build_object('completed',false,'reason','username_changed');
  END IF;
  IF v_user.password_hash IS DISTINCT FROM p_expected_password_hash THEN
    RETURN jsonb_build_object('completed',false,'reason','password_changed');
  END IF;
  IF v_user.disabled_at IS NOT NULL THEN
    RETURN jsonb_build_object('completed',false,'reason','disabled');
  END IF;

  -- The reservation must still belong to this username: an attempt id is not a
  -- token, and resolving somebody else's would rewrite their history.
  UPDATE auth_attempts SET outcome='success'
  WHERE id=p_attempt_id AND outcome='pending' AND username=v_user.username;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('completed',false,'reason','attempt_not_reserved');
  END IF;

  INSERT INTO web_sessions(user_id,token_digest,csrf_digest,
                           expires_at,absolute_expires_at,ip_hash,user_agent_hash)
  VALUES (v_user.id,p_token_digest,p_csrf_digest,
          least(v_now+p_idle,v_now+p_absolute),v_now+p_absolute,
          p_ip_hash,p_user_agent_hash)
  RETURNING * INTO v_session;

  UPDATE users SET last_login_at=v_now WHERE id=v_user.id;

  PERFORM write_operator_audit(v_user.id,'auth.login','session',v_session.id::text,
    'allowed',jsonb_build_object('authentication','local'),NULL,'');

  RETURN jsonb_build_object(
    'completed',true,
    'session_id',v_session.id,
    'user_id',v_user.id,
    'username',v_user.username,
    'display_name',v_user.display_name,
    'must_change_password',v_user.must_change_password,
    'expires_at',v_session.expires_at);
END $$;

ALTER FUNCTION complete_local_login(bigint,uuid,text,text,bytea,bytea,bytea,bytea,interval,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION complete_local_login(bigint,uuid,text,text,bytea,bytea,bytea,bytea,interval,interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_local_login(bigint,uuid,text,text,bytea,bytea,bytea,bytea,interval,interval) TO infra_web;

-- ======================================================= rehash CAS =========

DROP FUNCTION IF EXISTS rehash_local_password(uuid,text);

-- Replaces the stored encoding of a password that was verified a moment ago, but
-- only if the stored encoding is still the one that was verified.
--
-- Compare-and-swap, not a blind write: without the second predicate a password
-- reset that landed during the login is overwritten by a new encoding of the old
-- password. Losing the swap is a normal outcome and not an error — somebody else
-- changed the credential first, and their change is the one that stands. No audit
-- row is written for a swap that did not happen.
CREATE OR REPLACE FUNCTION rehash_local_password(
  p_user_id uuid, p_expected_old_hash text, p_new_password_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user users%ROWTYPE;
BEGIN
  IF p_new_password_hash IS NULL OR p_new_password_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'the password hash is not an Argon2id encoding' USING ERRCODE='22023';
  END IF;
  IF p_expected_old_hash IS NULL OR p_expected_old_hash = p_new_password_hash THEN
    RETURN jsonb_build_object('rehashed',false,'reason','nothing_to_do');
  END IF;

  UPDATE users SET password_hash=p_new_password_hash
  WHERE id=p_user_id AND role='owner' AND password_hash=p_expected_old_hash
  RETURNING * INTO v_user;

  IF NOT FOUND THEN
    -- Either the account is gone or its encoding moved. Both mean the caller's
    -- verification is stale, and neither is a reason to touch the row.
    RETURN jsonb_build_object('rehashed',false,'reason','hash_changed');
  END IF;

  PERFORM write_audit_event(NULL,NULL,NULL,'operator',v_user.id::text,
    'auth.password_rehashed','operator',v_user.id::text,'allowed',NULL,
    jsonb_build_object('username',v_user.username),'');

  RETURN jsonb_build_object('rehashed',true,'user_id',v_user.id);
END $$;

ALTER FUNCTION rehash_local_password(uuid,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION rehash_local_password(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rehash_local_password(uuid,text,text) TO infra_web;

-- ============================================ credential retirement =========

-- Removing a plaintext password touches a file and a database, and those two
-- cannot share a transaction. Instead of pretending they can, the operation is
-- durable: a row records how far it got, so a crash between the unlink and the
-- audit row is finished by the next run rather than leaving a deleted credential
-- with no record of why.
--
--   requested --(file unlinked)--> file_removed --(audit written)--> recorded
--
-- `recorded` is terminal and unique per path, which is what makes the audit row
-- exactly-once: the transition into it can only happen from `file_removed`,
-- under a row lock, once.
CREATE TABLE credential_retirements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path            text NOT NULL,
  state           text NOT NULL,
  actor_id        text NOT NULL,
  requested_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  file_removed_at timestamptz,
  recorded_at     timestamptz,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT credential_retirements_state_check
    CHECK (state IN ('requested','file_removed','recorded')),
  -- Each state carries exactly the timestamps it has reached, so a half-written
  -- row cannot claim to have done more than it did.
  CONSTRAINT credential_retirements_state_timestamps CHECK (
    (state='requested'    AND file_removed_at IS NULL     AND recorded_at IS NULL)
    OR (state='file_removed' AND file_removed_at IS NOT NULL AND recorded_at IS NULL)
    OR (state='recorded'     AND file_removed_at IS NOT NULL AND recorded_at IS NOT NULL))
);

-- One open retirement per path: a second concurrent run must resume the first,
-- not start a parallel one.
CREATE UNIQUE INDEX credential_retirements_open
  ON credential_retirements(path) WHERE state <> 'recorded';

-- Returns the open retirement for this path, or opens one. Idempotent: a rerun
-- after a crash gets the same row and the state it reached.
CREATE OR REPLACE FUNCTION begin_credential_retirement(
  p_path text, p_actor_id text, p_has_file boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row credential_retirements%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM credential_retirements c
  WHERE c.path=p_path AND c.state<>'recorded' FOR UPDATE;

  IF FOUND THEN
    -- The file came back — a re-run of bootstrap writes a new one. A row that
    -- says the file is gone must not be allowed to skip its removal.
    IF p_has_file AND v_row.state='file_removed' THEN
      UPDATE credential_retirements SET state='requested', file_removed_at=NULL
      WHERE id=v_row.id RETURNING * INTO v_row;
    END IF;
    RETURN jsonb_build_object('id',v_row.id,'state',v_row.state,'resumed',true);
  END IF;

  IF NOT p_has_file THEN
    RETURN jsonb_build_object('nothing_to_do',true,'state',NULL);
  END IF;

  INSERT INTO credential_retirements(path,state,actor_id)
  VALUES (p_path,'requested',p_actor_id) RETURNING * INTO v_row;
  RETURN jsonb_build_object('id',v_row.id,'state',v_row.state,'resumed',false);
END $$;

ALTER FUNCTION begin_credential_retirement(text,text,boolean)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION begin_credential_retirement(text,text,boolean) FROM PUBLIC;

-- Advances the state machine one step. Both steps are idempotent, so a run that
-- repeats a step it already completed is a no-op rather than an error.
CREATE OR REPLACE FUNCTION advance_credential_retirement(
  p_id uuid, p_state text, p_details jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row credential_retirements%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM credential_retirements c WHERE c.id=p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such credential retirement' USING ERRCODE='55000';
  END IF;

  IF p_state='file_removed' THEN
    -- Idempotent, including from `recorded`: a row that has already been audited
    -- has certainly had its file removed, and a caller replaying its steps from
    -- the top after a crash is doing the right thing.
    IF v_row.state IN ('file_removed','recorded') THEN
      RETURN jsonb_build_object('id',v_row.id,'state',v_row.state,'already',true);
    END IF;
    UPDATE credential_retirements
    SET state='file_removed', file_removed_at=clock_timestamp(), details=details||p_details
    WHERE id=p_id RETURNING * INTO v_row;
    RETURN jsonb_build_object('id',v_row.id,'state',v_row.state,'already',false);
  END IF;

  IF p_state='recorded' THEN
    IF v_row.state='recorded' THEN
      -- The audit row already exists; writing a second one would be the bug this
      -- table exists to prevent.
      RETURN jsonb_build_object('id',v_row.id,'state',v_row.state,'already',true);
    END IF;
    IF v_row.state<>'file_removed' THEN
      RAISE EXCEPTION 'a retirement must record the file removal before the audit row'
        USING ERRCODE='55000';
    END IF;
    PERFORM write_audit_event(NULL,NULL,NULL,'system',v_row.actor_id,
      'operator.credentials_retired','installation',v_row.path,'allowed',NULL,
      v_row.details||p_details,'credential-retirement:'||v_row.id);
    UPDATE credential_retirements
    SET state='recorded', recorded_at=clock_timestamp(), details=details||p_details
    WHERE id=p_id RETURNING * INTO v_row;
    RETURN jsonb_build_object('id',v_row.id,'state',v_row.state,'already',false);
  END IF;

  RAISE EXCEPTION 'unknown credential retirement state: %', p_state USING ERRCODE='22023';
END $$;

ALTER FUNCTION advance_credential_retirement(uuid,text,jsonb)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION advance_credential_retirement(uuid,text,jsonb) FROM PUBLIC;

-- Everything still owed an audit row, for the health helper to finish. Reads
-- only; it exists so a resumed run does not have to guess at the state.
CREATE OR REPLACE FUNCTION open_credential_retirements()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_rows jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',c.id,'path',c.path,'state',c.state,
           'actor_id',c.actor_id,'requested_at',c.requested_at,
           'file_removed_at',c.file_removed_at) ORDER BY c.requested_at),'[]'::jsonb)
  INTO v_rows
  FROM credential_retirements c WHERE c.state<>'recorded';
  RETURN jsonb_build_object('retirements',v_rows);
END $$;

ALTER FUNCTION open_credential_retirements()
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION open_credential_retirements() FROM PUBLIC;
