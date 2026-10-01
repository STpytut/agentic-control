BEGIN;

SET search_path TO control_plane, public;

-- Operator identity for the self-hosted installation.
--
-- This test used to assert the Supabase link (`users.auth_user_id` and its
-- unique constraint). Supabase is gone as of 0044, so what is worth pinning now
-- is the local shape: an operator row needs no external identity, the role
-- constraint still admits exactly one kind of account, and the audit path still
-- records an operator decision.

DO $$
DECLARE v_user users%ROWTYPE; v_audit uuid;
BEGIN
  INSERT INTO users(email,display_name,role)
  VALUES('owner-test@example.com','Owner test','owner') RETURNING * INTO v_user;

  IF v_user.role<>'owner' OR v_user.id IS NULL THEN
    RAISE EXCEPTION 'operator identity was not persisted';
  END IF;

  -- Contact details are optional in the local model: nothing about signing in
  -- depends on them any more.
  INSERT INTO users(display_name,role) VALUES('Contactless owner','owner');

  -- ADR-0011: the twelve unscoped operator functions are safe only while exactly
  -- one operator kind can exist. If this ever admits a second role, those
  -- functions need ownership checks before the constraint is relaxed.
  BEGIN
    INSERT INTO users(display_name,role) VALUES('Intruder','member');
    RAISE EXCEPTION 'a non-owner role was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  SELECT write_audit_event(NULL,NULL,NULL,'operator',v_user.id::text,
    'auth.login','session',v_user.id::text,'allowed',NULL,
    jsonb_build_object('authentication','local'),'operator-identity-test') INTO v_audit;
  IF NOT EXISTS (SELECT 1 FROM audit_events WHERE id=v_audit AND action='auth.login'
    AND actor_type='operator' AND policy_decision='allowed') THEN
    RAISE EXCEPTION 'operator login audit was not persisted';
  END IF;

  RAISE NOTICE 'local operator identity assertions passed';
END;
$$;

ROLLBACK;
