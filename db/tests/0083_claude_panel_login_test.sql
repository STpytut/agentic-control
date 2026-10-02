-- Claude Code signs in from the panel (0136).
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_owner uuid; v_other uuid; v_first jsonb; v_session jsonb; v_claim jsonb; v_taken jsonb;
  v_reason text; v_row claude_login_sessions%ROWTYPE;
BEGIN
  INSERT INTO users(display_name) VALUES('Claude sign-in') RETURNING id INTO v_owner;
  INSERT INTO users(display_name) VALUES('Someone else') RETURNING id INTO v_other;

  -- A second start replaces the first.
  v_first := start_claude_login(v_owner);
  v_session := start_claude_login(v_owner);
  IF (SELECT status FROM claude_login_sessions WHERE id = (v_first->>'id')::uuid) <> 'cancelled' THEN
    RAISE EXCEPTION 'a new sign-in left the previous one open';
  END IF;

  -- A code before the link is shown is refused.
  BEGIN
    PERFORM submit_claude_login_code(v_owner, (v_session->>'id')::uuid, 'abcdefgh#ijklmnop');
    RAISE EXCEPTION 'a code was taken before the sign-in showed its link';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_reason = MESSAGE_TEXT;
    IF v_reason NOT LIKE '%not waiting%' THEN RAISE; END IF;
  END;

  v_claim := claim_claude_logins('account-worker-test', 5);
  IF jsonb_array_length(v_claim) <> 1 OR v_claim->0->>'id' <> v_session->>'id' THEN
    RAISE EXCEPTION 'the worker did not claim the open sign-in: %', v_claim;
  END IF;
  PERFORM record_claude_login((v_session->>'id')::uuid, 'account-worker-test', 'url', 'https://claude.com/cai/oauth/authorize?x');

  -- Another owner cannot paste into it, and a malformed code is refused.
  BEGIN
    PERFORM submit_claude_login_code(v_other, (v_session->>'id')::uuid, 'abcdefgh#ijklmnop');
    RAISE EXCEPTION 'another owner pasted a code into this sign-in';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM submit_claude_login_code(v_owner, (v_session->>'id')::uuid, 'two words');
    RAISE EXCEPTION 'a malformed code was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  v_session := submit_claude_login_code(v_owner, (v_session->>'id')::uuid, '  abcdefgh#ijklmnop ');
  IF NOT (v_session->>'code_submitted')::boolean OR v_session ? 'auth_code' THEN
    RAISE EXCEPTION 'the panel''s view either lost the submission or shows the code: %', v_session;
  END IF;

  -- Another worker cannot take it; the holder takes it once, and it is gone.
  BEGIN
    PERFORM record_claude_login((v_session->>'id')::uuid, 'someone-else', 'take_code');
    RAISE EXCEPTION 'a worker that does not hold the sign-in took its code';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_reason = MESSAGE_TEXT;
    IF v_reason NOT LIKE '%does not hold%' THEN RAISE; END IF;
  END;
  v_taken := record_claude_login((v_session->>'id')::uuid, 'account-worker-test', 'take_code');
  IF v_taken->>'code' <> 'abcdefgh#ijklmnop' THEN RAISE EXCEPTION 'the worker got %', v_taken; END IF;
  SELECT * INTO v_row FROM claude_login_sessions WHERE id = (v_session->>'id')::uuid;
  IF v_row.auth_code IS NOT NULL OR v_row.status <> 'verifying' THEN
    RAISE EXCEPTION 'the code stayed in the database after the worker took it';
  END IF;

  PERFORM record_claude_login((v_session->>'id')::uuid, 'account-worker-test', 'succeeded');
  IF get_claude_login(v_owner)->>'status' <> 'succeeded' THEN RAISE EXCEPTION 'the sign-in did not end'; END IF;
END $$;

-- The web role can run all three, and cannot read the table.
SET LOCAL ROLE infra_web;
DO $$
BEGIN
  PERFORM 1 FROM claude_login_sessions;
  RAISE EXCEPTION 'the web role read claude_login_sessions directly';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;

ROLLBACK;
