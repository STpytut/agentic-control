-- Stage 11.1: the two things the panel's connect buttons needed and did not have.
--
-- Found by pressing them on the production host, which is the only place either
-- could have shown up: both are properties of a database, and the development
-- database has neither property.
--
-- 1. pgcrypto
-- -----------
-- `0001` creates it, the ledger says `0001` is applied, and `pg_extension` on the
-- host holds nothing but `plpgsql`. A database can lose an extension a migration
-- created — a restore that carried the schema and not the extension is the
-- ordinary way — and the ledger has no opinion about it, because a ledger records
-- what ran, not what survived.
--
-- What breaks is not obvious from the outside: `digest()` lives in pgcrypto, and
-- `submit_command` hashes its payload with it. So every command submission fails,
-- which in the panel reads as "function digest(text, unknown) does not exist"
-- under the Codex and OpenCode connect buttons, and nowhere else.
--
-- `IF NOT EXISTS` costs a healthy host nothing. It is re-asserted here rather
-- than by editing 0001, which is deployed and immutable, and by hand on the host,
-- which would leave the next restored database in the same state.
--
-- 2. The GitHub login session
-- ---------------------------
-- `start_provider_login_session` and `consume_provider_login_session` are called
-- by the web tier directly. Neither is SECURITY DEFINER and neither was granted
-- to `infra_web`, which has `SELECT` on `provider_login_sessions` and nothing
-- more — so the connect button answered "permission denied for function
-- start_provider_login_session" and the callback would have failed the same way.
--
-- Both halves are needed. A grant alone would let the function be called and then
-- fail on the INSERT; SECURITY DEFINER alone leaves it ungranted. And since
-- SECURITY DEFINER means the table check no longer applies, the operator is
-- checked here instead: 0049's lesson is that a caller-supplied id must not be
-- the thing that grants authority, so an id that does not name an enabled owner
-- is refused rather than trusted.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION start_provider_login_session(
  p_operator_id uuid, p_provider text, p_state_digest text, p_ttl interval DEFAULT interval '10 minutes'
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id uuid;
BEGIN
  IF p_state_digest !~ '^[0-9a-f]{64}$' OR p_ttl <= interval '0 seconds' THEN
    RAISE EXCEPTION 'invalid provider login session parameters' USING ERRCODE='22023';
  END IF;
  -- The definer rights start here, so the ownership check has to as well.
  IF NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id=p_operator_id AND u.role='owner' AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'not an enabled operator' USING ERRCODE='42501';
  END IF;
  INSERT INTO provider_login_sessions(operator_id, provider, state_digest, expires_at)
  VALUES(p_operator_id, p_provider, p_state_digest, clock_timestamp()+p_ttl)
  RETURNING id INTO v_id;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,'provider.connection_started',
    'provider_connection',v_id::text,'allowed',NULL,
    jsonb_build_object('provider',p_provider),v_id::text);
  RETURN v_id;
END; $$;

-- The other half of the same flow: the callback consumes what the button
-- started. Leaving it ungranted would move the failure from the first click to
-- the return from GitHub, which is a worse place to discover it.
--
-- The body is 0022's, unchanged to the character. Only `SECURITY DEFINER` is
-- added: this is a permissions fix, and a permissions fix that quietly alters
-- what a function does is two changes wearing one commit message. The operator
-- check `start` gained is not repeated here, because this function already
-- scopes every row it touches by operator, provider and a 64-hex state digest a
-- caller has to know, and raises when nothing matches.
CREATE OR REPLACE FUNCTION consume_provider_login_session(
  p_operator_id uuid, p_provider text, p_state_digest text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_session provider_login_sessions%ROWTYPE;
BEGIN
  IF p_state_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid login state' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_session FROM provider_login_sessions
  WHERE operator_id=p_operator_id AND provider=p_provider AND state_digest=p_state_digest
    AND status='pending' AND expires_at>clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,'provider.connection_callback_denied',
      'provider_login_session',COALESCE(p_state_digest,'invalid'),'denied',NULL,
      jsonb_build_object('provider',p_provider,'reason','state_not_found_or_expired'),p_operator_id::text);
    RAISE EXCEPTION 'GitHub login session is invalid, expired or already used' USING ERRCODE='55000';
  END IF;
  UPDATE provider_login_sessions SET status='consumed', consumed_at=clock_timestamp()
  WHERE id=v_session.id;
  RETURN jsonb_build_object('session_id',v_session.id,'provider',v_session.provider);
END; $$;

ALTER FUNCTION start_provider_login_session(uuid,text,text,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION consume_provider_login_session(uuid,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;

REVOKE EXECUTE ON FUNCTION start_provider_login_session(uuid,text,text,interval) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION consume_provider_login_session(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_provider_login_session(uuid,text,text,interval) TO infra_web;
GRANT EXECUTE ON FUNCTION consume_provider_login_session(uuid,text,text) TO infra_web;

-- What the panel needs is now reachable, and what it does not is still not.
DO $assert$
DECLARE v_missing text;
BEGIN
  IF to_regprocedure('digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'pgcrypto is not usable after CREATE EXTENSION; submit_command hashes its payload with digest()';
  END IF;

  SELECT string_agg(signature,', ' ORDER BY signature) INTO v_missing
  FROM (VALUES
    ('start_provider_login_session(uuid,text,text,interval)'),
    ('consume_provider_login_session(uuid,text,text)')
  ) AS needed(signature)
  WHERE NOT has_function_privilege('infra_web', ('control_plane.'||signature)::regprocedure, 'EXECUTE');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'infra_web still cannot execute: %', v_missing USING ERRCODE='42501';
  END IF;
END $assert$;
