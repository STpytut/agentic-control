-- The external audit writer may only describe operator actions.
--
-- 0049 bound the actor to a live session, which stopped one account being
-- impersonated as another. It left the *action* forgeable: the accepted namespace
-- was `^(auth|operator)[.]`, so a compromised web process holding a live digest
-- could append `auth.password_changed` with no password change, `auth.login` with
-- no sign-in, or `auth.session_revoked` with nothing revoked, each with a target,
-- decision and details of its choosing.
--
-- That contradicts the split the ADR describes and this file enforces: credential
-- events belong to the operation that performed them, and every one of those
-- writes its own row inside its own SECURITY DEFINER function. Nothing outside
-- those functions has any business asserting that a credential event happened.
--
-- So the external writer is narrowed to `operator.*`, which is the only class of
-- event the web tier genuinely originates. The untrusted half of that name — the
-- `<kind>` suffix — is still the caller's, which is fine: it names which UI action
-- was taken, and the action itself is recorded independently by the database
-- function that performed it.
--
-- Same signature as 0049, so the OID and the grants survive.

SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION write_session_audit(
  p_token_digest bytea,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_decision text DEFAULT 'allowed',
  p_details jsonb DEFAULT '{}'::jsonb,
  p_project_id uuid DEFAULT NULL,
  p_correlation text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_session web_sessions%ROWTYPE;
BEGIN
  -- live_session raises for an unknown, revoked, expired or disabled session, so
  -- this cannot be used with a digest the caller invented.
  v_session := live_session(p_token_digest);

  -- `operator.` only. An `auth.*` row from here would be a claim that a
  -- credential changed, made by something that did not change one.
  IF p_action !~ '^operator[.][a-z0-9_]+$' THEN
    RAISE EXCEPTION
      'write_session_audit only records operator actions; credential events are written by the operation that performed them (got %)',
      p_action USING ERRCODE='22023';
  END IF;
  IF p_decision NOT IN ('allowed','denied','not_required') THEN
    RAISE EXCEPTION 'unsupported audit decision: %', p_decision USING ERRCODE='22023';
  END IF;

  RETURN jsonb_build_object('audit_event_id', write_audit_event(
    p_project_id, NULL, NULL, 'operator', v_session.user_id::text, p_action,
    p_target_type, p_target_id, p_decision, NULL, p_details, p_correlation));
END $$;

ALTER FUNCTION write_session_audit(bytea,text,text,text,text,jsonb,uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;

DO $assert$
BEGIN
  IF NOT has_function_privilege('infra_web',
       'control_plane.write_session_audit(bytea,text,text,text,text,jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'infra_web cannot write a token-derived audit row' USING ERRCODE='42501';
  END IF;
  IF has_function_privilege('infra_web',
       'control_plane.write_operator_audit(uuid,text,text,text,text,jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'infra_web can still supply its own audit actor' USING ERRCODE='42501';
  END IF;
END $assert$;
