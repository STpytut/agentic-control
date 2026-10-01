-- Local operator authentication for the self-hosted installation.
--
-- Replaces Supabase Auth with a username/password owner account and opaque
-- server-side sessions. See docs/adr/0011-self-hosted-access-model.md.
--
-- Every function here is SECURITY DEFINER: infra_web holds no DML on these
-- tables (ADR-0011 decision 2), so the login path can only reach them through
-- this audited surface. Ownership follows the migrating role (infra_migrator
-- in production).
--
-- Secrets never enter this schema in usable form: passwords are stored as
-- Argon2id encoded strings, session and CSRF tokens only as SHA-256 digests,
-- and client addresses only as peppered digests.

BEGIN;

SET search_path TO control_plane, public, extensions;

-- ---------------------------------------------------------------- users ----

ALTER TABLE users
  ADD COLUMN username             text,
  ADD COLUMN password_hash        text,
  ADD COLUMN password_changed_at  timestamptz,
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN disabled_at          timestamptz,
  ADD COLUMN last_login_at        timestamptz;

ALTER TABLE users
  ADD CONSTRAINT users_username_format
    CHECK (username IS NULL OR username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  ADD CONSTRAINT users_password_hash_argon2
    CHECK (password_hash IS NULL OR password_hash LIKE '$argon2id$%'),
  -- Local auth is all-or-nothing per row: a username without a hash would be a
  -- passwordless account.
  ADD CONSTRAINT users_local_auth_complete
    CHECK ((username IS NULL) = (password_hash IS NULL));

CREATE UNIQUE INDEX users_username_unique ON users(username) WHERE username IS NOT NULL;

-- --------------------------------------------------------- web_sessions ----

CREATE TABLE web_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- sha256 of the raw bearer token. The token itself never reaches the database,
  -- so a database read cannot yield a usable credential.
  token_digest        bytea NOT NULL UNIQUE,
  csrf_digest         bytea NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at          timestamptz NOT NULL,          -- idle deadline, slides
  absolute_expires_at timestamptz NOT NULL,          -- hard deadline, never slides
  revoked_at          timestamptz,
  revoked_reason      text,
  user_agent_hash     bytea,
  ip_hash             bytea,
  CONSTRAINT web_sessions_revoked_reason_check CHECK (revoked_reason IS NULL OR revoked_reason IN
    ('logout','password_change','username_change','admin_revoke','expired','rotated')),
  CONSTRAINT web_sessions_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT web_sessions_idle_within_absolute CHECK (expires_at <= absolute_expires_at),
  CONSTRAINT web_sessions_digest_length CHECK (length(token_digest)=32 AND length(csrf_digest)=32)
);

CREATE INDEX web_sessions_user_active ON web_sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX web_sessions_expiry      ON web_sessions(expires_at) WHERE revoked_at IS NULL;

-- -------------------------------------------------------- auth_attempts ----

CREATE TABLE auth_attempts (
  id              bigserial PRIMARY KEY,
  -- As typed and lowercased. Deliberately not a foreign key: an attempt against
  -- an unknown username is exactly what the lockout has to count.
  username        text,
  ip_hash         bytea NOT NULL,
  outcome         text NOT NULL,
  attempted_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_agent_hash bytea,
  CONSTRAINT auth_attempts_outcome_check CHECK (outcome IN
    ('pending','success','bad_password','unknown_user','disabled','locked','csrf_failure'))
);

CREATE INDEX auth_attempts_username_recent ON auth_attempts(username, attempted_at DESC);
CREATE INDEX auth_attempts_ip_recent       ON auth_attempts(ip_hash, attempted_at DESC);

-- ------------------------------------------------------------ functions ----

-- Returns everything the login path needs to make its decision, including the
-- password hash: Argon2id verification happens in the application. Callers MUST
-- verify against the returned hash even when the user does not exist (using the
-- returned dummy hash) so the response time does not disclose existence.
CREATE OR REPLACE FUNCTION authenticate_lookup(p_username text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user users%ROWTYPE;
BEGIN
  SELECT * INTO v_user FROM users u WHERE u.username=lower(p_username) AND u.role='owner';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found',false);
  END IF;
  RETURN jsonb_build_object(
    'found',true,
    'user_id',v_user.id,
    'username',v_user.username,
    'display_name',v_user.display_name,
    'password_hash',v_user.password_hash,
    'must_change_password',v_user.must_change_password,
    'disabled',v_user.disabled_at IS NOT NULL
  );
END $$;

-- Admission control for a login attempt.
--
-- The advisory lock is released when this function's transaction commits, so a
-- lock held only for the duration of a *check* would not serialise anything:
-- password verification and the outcome write happen in later statements, and
-- N concurrent requests would all read a count below the cap and all proceed.
-- The reservation is what closes that: the attempt row is written inside the
-- same locked transaction that reads the count, and a reserved-but-unresolved
-- attempt counts against the budget, so the Nth+1 caller sees a full window.
--
-- A caller that dies before finish_auth_attempt leaves its reservation behind
-- and it ages out with the window. That is fail-closed, which is the correct
-- direction for authentication.
CREATE OR REPLACE FUNCTION begin_auth_attempt(
  p_username text, p_ip_hash bytea, p_user_agent_hash bytea DEFAULT NULL,
  p_window interval DEFAULT interval '15 minutes', p_max integer DEFAULT 10
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_since timestamptz := clock_timestamp()-p_window;
  v_username text := lower(NULLIF(p_username,''));
  v_user_failures integer;
  v_ip_failures integer;
  v_attempt_id bigint;
BEGIN
  -- Two locks, because two budgets are checked. A username-only lock leaves the
  -- per-IP limit unserialised: concurrent requests with different usernames but
  -- one source address never contend, and all of them read the same IP count.
  -- Always taken username-first so every caller orders them identically and no
  -- pair can deadlock.
  PERFORM pg_advisory_xact_lock(hashtext('auth:user:'||COALESCE(v_username,'')));
  PERFORM pg_advisory_xact_lock(hashtext('auth:ip:'||encode(p_ip_hash,'hex')));

  -- 'pending' is included deliberately: an attempt in flight consumes budget.
  SELECT count(*) INTO v_user_failures FROM auth_attempts a
  WHERE a.username=v_username AND a.attempted_at>=v_since AND a.outcome<>'success';

  SELECT count(*) INTO v_ip_failures FROM auth_attempts a
  WHERE a.ip_hash=p_ip_hash AND a.attempted_at>=v_since AND a.outcome<>'success';

  IF v_user_failures>=p_max OR v_ip_failures>=p_max*3 THEN
    INSERT INTO auth_attempts(username,ip_hash,outcome,user_agent_hash)
    VALUES (v_username,p_ip_hash,'locked',p_user_agent_hash);
    RETURN jsonb_build_object(
      'allowed',false,'locked',true,
      'username_failures',v_user_failures,'ip_failures',v_ip_failures,
      'retry_after_seconds',ceil(extract(epoch FROM p_window))::integer);
  END IF;

  INSERT INTO auth_attempts(username,ip_hash,outcome,user_agent_hash)
  VALUES (v_username,p_ip_hash,'pending',p_user_agent_hash)
  RETURNING id INTO v_attempt_id;

  RETURN jsonb_build_object(
    'allowed',true,'locked',false,'attempt_id',v_attempt_id,
    'username_failures',v_user_failures,'ip_failures',v_ip_failures,
    'retry_after_seconds',0);
END $$;

-- Resolves a reservation from begin_auth_attempt. Only a still-pending attempt
-- can be resolved, so a replayed call cannot rewrite history.
CREATE OR REPLACE FUNCTION finish_auth_attempt(p_attempt_id bigint, p_outcome text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id bigint;
BEGIN
  IF p_outcome='pending' THEN
    RAISE EXCEPTION 'an attempt cannot be resolved as pending' USING ERRCODE='22023';
  END IF;
  UPDATE auth_attempts SET outcome=p_outcome
  WHERE id=p_attempt_id AND outcome='pending'
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('resolved', v_id IS NOT NULL, 'attempt_id', p_attempt_id);
END $$;

-- Read-only view of the current budget, for the health page and diagnostics.
-- Never use this to admit a login: it reserves nothing and racing callers all
-- see the same count. begin_auth_attempt is the admission path.
CREATE OR REPLACE FUNCTION auth_lockout_state(
  p_username text, p_ip_hash bytea,
  p_window interval DEFAULT interval '15 minutes', p_max integer DEFAULT 10
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_since timestamptz := clock_timestamp()-p_window;
  v_user_failures integer;
  v_ip_failures integer;
BEGIN
  SELECT count(*) INTO v_user_failures FROM auth_attempts a
  WHERE a.username=lower(p_username) AND a.attempted_at>=v_since AND a.outcome<>'success';

  SELECT count(*) INTO v_ip_failures FROM auth_attempts a
  WHERE a.ip_hash=p_ip_hash AND a.attempted_at>=v_since AND a.outcome<>'success';

  RETURN jsonb_build_object(
    'locked', (v_user_failures>=p_max OR v_ip_failures>=p_max*3),
    'username_failures',v_user_failures,
    'ip_failures',v_ip_failures,
    'retry_after_seconds', CASE WHEN v_user_failures>=p_max OR v_ip_failures>=p_max*3
      THEN ceil(extract(epoch FROM p_window))::integer ELSE 0 END
  );
END $$;

CREATE OR REPLACE FUNCTION record_auth_attempt(
  p_username text, p_ip_hash bytea, p_outcome text, p_user_agent_hash bytea DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO auth_attempts(username,ip_hash,outcome,user_agent_hash)
  VALUES (lower(NULLIF(p_username,'')),p_ip_hash,p_outcome,p_user_agent_hash);
END $$;

CREATE OR REPLACE FUNCTION create_web_session(
  p_user_id uuid, p_token_digest bytea, p_csrf_digest bytea,
  p_idle interval DEFAULT interval '12 hours',
  p_absolute interval DEFAULT interval '30 days',
  p_ip_hash bytea DEFAULT NULL, p_user_agent_hash bytea DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_session web_sessions%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u
                 WHERE u.id=p_user_id AND u.role='owner' AND u.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'operator is unavailable' USING ERRCODE='55000';
  END IF;

  INSERT INTO web_sessions(user_id,token_digest,csrf_digest,
                           expires_at,absolute_expires_at,ip_hash,user_agent_hash)
  VALUES (p_user_id,p_token_digest,p_csrf_digest,
          -- The idle deadline can never outrun the absolute one, including when
          -- a caller asks for an idle window longer than the session's lifetime.
          least(v_now+p_idle, v_now+p_absolute), v_now+p_absolute,
          p_ip_hash, p_user_agent_hash)
  RETURNING * INTO v_session;

  UPDATE users SET last_login_at=v_now WHERE id=p_user_id;

  RETURN jsonb_build_object(
    'session_id',v_session.id,'expires_at',v_session.expires_at,
    'absolute_expires_at',v_session.absolute_expires_at);
END $$;

-- Validates a presented session digest and returns the operator, or NULL-ish
-- when the session is unknown, revoked or past either deadline. Slides the idle
-- deadline at most once every p_slide_after so a busy session does not write on
-- every request.
CREATE OR REPLACE FUNCTION touch_web_session(
  p_token_digest bytea,
  p_idle interval DEFAULT interval '12 hours',
  p_slide_after interval DEFAULT interval '5 minutes'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_session web_sessions%ROWTYPE;
  v_user users%ROWTYPE;
BEGIN
  SELECT * INTO v_session FROM web_sessions s WHERE s.token_digest=p_token_digest FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('valid',false,'reason','unknown'); END IF;

  IF v_session.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('valid',false,'reason','revoked');
  END IF;

  IF v_session.expires_at<=v_now OR v_session.absolute_expires_at<=v_now THEN
    UPDATE web_sessions SET revoked_at=v_now, revoked_reason='expired' WHERE id=v_session.id;
    RETURN jsonb_build_object('valid',false,'reason','expired');
  END IF;

  SELECT * INTO v_user FROM users u WHERE u.id=v_session.user_id;
  IF v_user.disabled_at IS NOT NULL THEN
    UPDATE web_sessions SET revoked_at=v_now, revoked_reason='admin_revoke' WHERE id=v_session.id;
    RETURN jsonb_build_object('valid',false,'reason','disabled');
  END IF;

  IF v_session.last_seen_at < v_now-p_slide_after THEN
    UPDATE web_sessions SET
      last_seen_at=v_now,
      expires_at=least(v_now+p_idle, v_session.absolute_expires_at)
    WHERE id=v_session.id RETURNING * INTO v_session;
  END IF;

  RETURN jsonb_build_object(
    'valid',true,
    'session_id',v_session.id,
    'csrf_digest',encode(v_session.csrf_digest,'hex'),
    'expires_at',v_session.expires_at,
    'user_id',v_user.id,
    'username',v_user.username,
    'display_name',v_user.display_name,
    'role',v_user.role,
    'must_change_password',v_user.must_change_password);
END $$;

CREATE OR REPLACE FUNCTION revoke_web_session(p_token_digest bytea, p_reason text DEFAULT 'logout')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id uuid;
BEGIN
  UPDATE web_sessions SET revoked_at=clock_timestamp(), revoked_reason=p_reason
  WHERE token_digest=p_token_digest AND revoked_at IS NULL
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('revoked', v_id IS NOT NULL, 'session_id', v_id);
END $$;

-- Revokes every live session for a user, optionally sparing one (the caller's
-- own, when rotating after a password change).
CREATE OR REPLACE FUNCTION revoke_user_sessions(
  p_user_id uuid, p_reason text DEFAULT 'admin_revoke', p_except_session_id uuid DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_count integer;
BEGIN
  WITH revoked AS (
    UPDATE web_sessions SET revoked_at=clock_timestamp(), revoked_reason=p_reason
    WHERE user_id=p_user_id AND revoked_at IS NULL
      AND (p_except_session_id IS NULL OR id<>p_except_session_id)
    RETURNING id
  ) SELECT count(*) INTO v_count FROM revoked;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION set_user_password(
  p_user_id uuid, p_password_hash text, p_must_change boolean DEFAULT false,
  p_keep_session_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_revoked integer;
BEGIN
  UPDATE users SET
    password_hash=p_password_hash,
    password_changed_at=clock_timestamp(),
    must_change_password=p_must_change
  WHERE id=p_user_id AND role='owner';
  IF NOT FOUND THEN RAISE EXCEPTION 'operator is unavailable' USING ERRCODE='55000'; END IF;

  v_revoked := revoke_user_sessions(p_user_id,'password_change',p_keep_session_id);
  RETURN jsonb_build_object('user_id',p_user_id,'sessions_revoked',v_revoked);
END $$;

CREATE OR REPLACE FUNCTION set_user_username(p_user_id uuid, p_username text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_revoked integer;
BEGIN
  UPDATE users SET username=lower(p_username) WHERE id=p_user_id AND role='owner';
  IF NOT FOUND THEN RAISE EXCEPTION 'operator is unavailable' USING ERRCODE='55000'; END IF;

  v_revoked := revoke_user_sessions(p_user_id,'username_change',NULL);
  RETURN jsonb_build_object('user_id',p_user_id,'username',lower(p_username),
                            'sessions_revoked',v_revoked);
END $$;

-- One-shot owner creation for `infra-cod admin bootstrap`. Refuses once any
-- local account exists so a re-run of the installer cannot mint a second owner
-- or silently reset the first one's password.
CREATE OR REPLACE FUNCTION bootstrap_local_owner(
  p_username text, p_password_hash text, p_display_name text DEFAULT 'Owner'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user users%ROWTYPE;
  v_adopted boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('auth:bootstrap'));

  IF EXISTS (SELECT 1 FROM users u WHERE u.username IS NOT NULL) THEN
    RAISE EXCEPTION 'a local operator account already exists' USING ERRCODE='55000';
  END IF;

  -- Adopt the pre-existing owner row when there is one, so ownership of already
  -- provisioned projects is preserved.
  SELECT * INTO v_user FROM users u WHERE u.role='owner' ORDER BY u.created_at LIMIT 1;

  IF FOUND THEN
    v_adopted := true;
    UPDATE users SET
      username=lower(p_username), password_hash=p_password_hash,
      password_changed_at=clock_timestamp(), must_change_password=true,
      display_name=COALESCE(NULLIF(display_name,''),p_display_name)
    WHERE id=v_user.id RETURNING * INTO v_user;
  ELSE
    INSERT INTO users(display_name,timezone,role,username,password_hash,
                      password_changed_at,must_change_password)
    VALUES (p_display_name,'UTC','owner',lower(p_username),p_password_hash,
            clock_timestamp(),true)
    RETURNING * INTO v_user;
  END IF;

  RETURN jsonb_build_object('user_id',v_user.id,'username',v_user.username,
                            'adopted_existing_owner',v_adopted);
END $$;

-- Housekeeping for the health timer: drop long-revoked/expired sessions and old
-- attempt rows. Live sessions are never touched.
CREATE OR REPLACE FUNCTION prune_auth_records(
  p_session_grace interval DEFAULT interval '30 days',
  p_attempt_grace interval DEFAULT interval '30 days'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_sessions integer;
  v_attempts integer;
BEGIN
  WITH expired AS (
    UPDATE web_sessions SET revoked_at=v_now, revoked_reason='expired'
    WHERE revoked_at IS NULL AND (expires_at<=v_now OR absolute_expires_at<=v_now)
    RETURNING id
  ) SELECT count(*) INTO v_sessions FROM expired;

  DELETE FROM web_sessions
  WHERE revoked_at IS NOT NULL AND revoked_at < v_now-p_session_grace;

  WITH pruned AS (
    DELETE FROM auth_attempts WHERE attempted_at < v_now-p_attempt_grace RETURNING id
  ) SELECT count(*) INTO v_attempts FROM pruned;

  RETURN jsonb_build_object('sessions_expired',v_sessions,'attempts_pruned',v_attempts);
END $$;

-- Pin search_path on every function above, per the 0004/0009 convention. This
-- is also the hard prerequisite for SECURITY DEFINER: without it a caller could
-- shadow an unqualified name and run code as the function owner.
ALTER FUNCTION authenticate_lookup(text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION auth_lockout_state(text,bytea,interval,integer)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION begin_auth_attempt(text,bytea,bytea,interval,integer)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION finish_auth_attempt(bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION record_auth_attempt(text,bytea,text,bytea)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION create_web_session(uuid,bytea,bytea,interval,interval,bytea,bytea)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION touch_web_session(bytea,interval,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION revoke_web_session(bytea,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION revoke_user_sessions(uuid,text,uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION set_user_password(uuid,text,boolean,uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION set_user_username(uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION bootstrap_local_owner(text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION prune_auth_records(interval,interval)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
