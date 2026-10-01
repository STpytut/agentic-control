-- Narrowing `infra_web` to the surface the web tier actually uses.
--
-- The review found that deleting the TypeScript `createSession` helper did not
-- remove the capability it wrapped. `infra_web` could still call
-- `create_web_session` directly, with an owner id and digests of its own
-- choosing, and mint a fully valid session with no password, no auth attempt, no
-- `complete_local_login`, no credential fence and no `auth.login` row. The same
-- was true of the older user-id-addressed administration functions:
--
--   * `set_user_password`  — install an arbitrary hash for the owner. A
--                            compromised web process owns the account, and the
--                            login fence is irrelevant to it.
--   * `set_user_username`  — rename the account.
--   * `revoke_user_sessions` — end sessions without holding one.
--
-- Each of these was superseded by a token-derived function in 0043/0047, and
-- none is referenced from `apps/web/src` any more. Removing the caller is not
-- removing the permission: a grant is the capability, and it outlives the code
-- that used it.
--
-- Four more grants go with them, for the same reason — reachable, but never
-- called from the web tier:
--
--   * `record_auth_attempt` — the login path reserves and resolves attempts
--                             through begin/finish_auth_attempt. This one writes
--                             an outcome with no reservation, which is a way to
--                             pollute the lockout budget.
--   * `request_catalog_verification` and both `capture_task_runtime_snapshot`
--                             overloads — these are called *inside*
--                             `request_catalog_gate_allowlist`,
--                             `create_task_with_executors` and
--                             `create_project_with_roster`, all SECURITY DEFINER,
--                             so the web role needs no direct grant. Leaving them
--                             reachable would let the web tier capture a runtime
--                             snapshot or queue verification work without the
--                             ownership checks those wrappers perform.
--
-- Ownership of the functions is unchanged; this only removes one grantee. The
-- migrator (and therefore `infra-cod admin`) keeps every one of them, and
-- `infra_worker` keeps its full surface.

SET search_path TO control_plane, public, extensions;

REVOKE EXECUTE ON FUNCTION create_web_session(uuid,bytea,bytea,interval,interval,bytea,bytea) FROM infra_web;
REVOKE EXECUTE ON FUNCTION revoke_user_sessions(uuid,text,uuid) FROM infra_web;
REVOKE EXECUTE ON FUNCTION set_user_password(uuid,text,boolean,uuid) FROM infra_web;
REVOKE EXECUTE ON FUNCTION set_user_username(uuid,text) FROM infra_web;
REVOKE EXECUTE ON FUNCTION record_auth_attempt(text,bytea,text,bytea) FROM infra_web;
REVOKE EXECUTE ON FUNCTION request_catalog_verification(uuid,uuid,text,text) FROM infra_web;
REVOKE EXECUTE ON FUNCTION capture_task_runtime_snapshot(uuid,uuid) FROM infra_web;
REVOKE EXECUTE ON FUNCTION capture_task_runtime_snapshot(uuid,uuid,uuid[]) FROM infra_web;

-- Defence in depth: the revoke above names signatures, and a future
-- `CREATE OR REPLACE` cannot re-grant. An explicit assertion fails the migration
-- rather than the next audit if one of them is still reachable.
DO $assert$
DECLARE v_leaked text;
BEGIN
  SELECT string_agg(signature, ', ' ORDER BY signature) INTO v_leaked
  FROM (VALUES
    ('create_web_session(uuid,bytea,bytea,interval,interval,bytea,bytea)'),
    ('revoke_user_sessions(uuid,text,uuid)'),
    ('set_user_password(uuid,text,boolean,uuid)'),
    ('set_user_username(uuid,text)'),
    ('record_auth_attempt(text,bytea,text,bytea)'),
    ('request_catalog_verification(uuid,uuid,text,text)'),
    ('capture_task_runtime_snapshot(uuid,uuid)'),
    ('capture_task_runtime_snapshot(uuid,uuid,uuid[])')
  ) AS revoked(signature)
  WHERE has_function_privilege(
    'infra_web', ('control_plane.'||signature)::regprocedure, 'EXECUTE');

  IF v_leaked IS NOT NULL THEN
    RAISE EXCEPTION 'infra_web can still execute: %', v_leaked USING ERRCODE='42501';
  END IF;
END $assert$;
