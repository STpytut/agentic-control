-- Operator administration for `infra-cod admin`.
--
-- The bootstrap and password functions already exist (0037). What was missing is
-- the ability to switch an account off without deleting the row that owns every
-- project, and a listing the CLI can print without reaching into `users`
-- directly.
--
-- These are operator-invoked, not web-invoked: nothing here is granted to
-- infra_web, because a panel that can disable the account it is running as is a
-- foot-gun with no upside. The CLI runs as the migrating role (or as a
-- superuser in development), which owns them.

SET search_path TO control_plane, public, extensions;

-- Disabling is deliberately not a delete: `users` owns projects, agents and
-- audit history, and `web_sessions` and `auth_attempts` reference it. Setting
-- `disabled_at` is enough — `touch_web_session` already refuses a disabled
-- operator and revokes the session it was presented with.
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

  PERFORM write_audit_event(NULL,NULL,NULL,'system','infra-cod-admin',
    CASE WHEN p_disabled THEN 'operator.disabled' ELSE 'operator.enabled' END,
    'operator',v_user.id::text,'allowed',NULL,
    jsonb_build_object('username',v_user.username,'sessions_revoked',v_revoked),'');

  RETURN jsonb_build_object('user_id',v_user.id,'username',v_user.username,
                            'disabled',v_user.disabled_at IS NOT NULL,
                            'sessions_revoked',v_revoked);
END $$;

ALTER FUNCTION set_local_operator_disabled(uuid,boolean)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION set_local_operator_disabled(uuid,boolean) FROM PUBLIC;

-- One row per local account, with only what an operator needs to see. The
-- password hash is not returned: the CLI cannot print what it cannot read, and
-- a hash on stdout is a hash in a shell history or a journal.
CREATE OR REPLACE FUNCTION list_local_operators()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_operators jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(row_value ORDER BY username),'[]'::jsonb) INTO v_operators
  FROM (
    SELECT jsonb_build_object(
             'user_id',u.id,
             'username',u.username,
             'display_name',u.display_name,
             'role',u.role,
             'disabled',u.disabled_at IS NOT NULL,
             'must_change_password',u.must_change_password,
             'password_changed_at',u.password_changed_at,
             'last_login_at',u.last_login_at,
             'created_at',u.created_at,
             'active_sessions',(SELECT count(*) FROM web_sessions s
                                WHERE s.user_id=u.id AND s.revoked_at IS NULL
                                  AND s.expires_at>clock_timestamp()
                                  AND s.absolute_expires_at>clock_timestamp())) AS row_value,
           u.username
    FROM users u
  ) listed;
  RETURN jsonb_build_object('operators',v_operators);
END $$;

ALTER FUNCTION list_local_operators()
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION list_local_operators() FROM PUBLIC;

-- Looks up a single account the way the CLI names it: by username, case
-- insensitively. Returns NULL for an unknown name so the CLI can print a
-- message instead of a stack trace.
CREATE OR REPLACE FUNCTION find_local_operator(p_username text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user users%ROWTYPE;
BEGIN
  SELECT * INTO v_user FROM users u WHERE u.username=lower(p_username) AND u.role='owner';
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'user_id',v_user.id,'username',v_user.username,
    'display_name',v_user.display_name,
    'disabled',v_user.disabled_at IS NOT NULL,
    'must_change_password',v_user.must_change_password,
    'password_hash',v_user.password_hash);
END $$;

ALTER FUNCTION find_local_operator(text)
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE ALL ON FUNCTION find_local_operator(text) FROM PUBLIC;
