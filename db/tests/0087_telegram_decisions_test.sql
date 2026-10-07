-- Migration 0142: decisions from Telegram. The approval message carries a
-- one-time token; a press counts only from the linked chat, never raises, and
-- after the task moved on is answered, not applied.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE
  v_owner uuid; v_project uuid; v_task uuid; v_code text; v_token text; v_claimed jsonb; v_answer jsonb;
  v_envelope jsonb := '{"ciphertext":"Y2lwaGVydGV4dA==","iv":"aXZpdml2aXZpdg==","tag":"dGFndGFndGFndGFn","key_wrap":"a2V5d3JhcGtleXdyYXA="}';
BEGIN
  IF has_function_privilege('infra_web','telegram_decide(uuid,bigint,text,text)','EXECUTE')
     OR NOT has_function_privilege('infra_worker','telegram_decide(uuid,bigint,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'telegram_decide is the notifier''s alone';
  END IF;
  INSERT INTO users(display_name,role) VALUES('Decision owner','owner') RETURNING id INTO v_owner;
  INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch,credential_mode)
    VALUES(v_owner,'Decision project','decision-project','/srv/infra-cod/workspaces/decision-project','main','empty') RETURNING id INTO v_project;
  INSERT INTO tasks(project_id,title,objective,status,created_by,acceptance_criteria)
    VALUES(v_project,'Ship it','Make it.','implementing','test','["done"]') RETURNING id INTO v_task;
  PERFORM set_telegram_bot(v_owner, v_envelope);
  v_code := record_telegram_bot(v_owner, 'decision_test_bot')->>'link_code';
  PERFORM record_telegram_chat(v_owner, v_code, 4242, '@owner');
  UPDATE notification_outbox SET status='sent' WHERE status='pending';

  UPDATE tasks SET status='awaiting_review' WHERE id=v_task;
  SELECT decision_token INTO v_token FROM notification_outbox WHERE operator_id=v_owner AND kind='approval';
  IF v_token IS NULL OR v_token !~ '^[A-Za-z0-9]{20}$' THEN RAISE EXCEPTION 'the approval message has no decision token'; END IF;
  v_claimed := claim_notifications('decision-test', 10);
  IF v_claimed->0->>'decision_token' <> v_token OR (v_claimed->0->>'can_publish')::boolean THEN
    RAISE EXCEPTION 'claimed: %', v_claimed;
  END IF;

  -- Another chat is not the owner's.
  v_answer := telegram_decide(v_owner, 9999, v_token, 'approve');
  IF v_answer->>'outcome' <> 'refused' THEN RAISE EXCEPTION 'a foreign chat decided: %', v_answer; END IF;
  -- The approval's own refusal (no review evidence here) is answered, not raised.
  v_answer := telegram_decide(v_owner, 4242, v_token, 'approve');
  IF v_answer->>'outcome' <> 'refused' OR v_answer->>'message' NOT LIKE 'The approval was refused:%' THEN
    RAISE EXCEPTION 'refusal: %', v_answer;
  END IF;
  IF (SELECT status FROM tasks WHERE id=v_task) <> 'awaiting_review' THEN RAISE EXCEPTION 'a refused press moved the task'; END IF;

  -- A message written in the chat bumps the version but is not moving on: the
  -- press is still the approval of this round (refused here only for want of
  -- review evidence), not "moved on".
  UPDATE tasks SET version=version+1 WHERE id=v_task;
  v_answer := telegram_decide(v_owner, 4242, v_token, 'approve');
  IF v_answer->>'outcome' <> 'refused' OR v_answer->>'message' NOT LIKE 'The approval was refused:%' THEN
    RAISE EXCEPTION 'a version bump while waiting: %', v_answer;
  END IF;

  -- The task moves on: the press is answered and the token spent.
  UPDATE tasks SET status='implementing', version=version+1 WHERE id=v_task;
  v_answer := telegram_decide(v_owner, 4242, v_token, 'approve_publish');
  IF v_answer->>'outcome' <> 'moved_on' THEN RAISE EXCEPTION 'moved on: %', v_answer; END IF;
  v_answer := telegram_decide(v_owner, 4242, v_token, 'approve');
  IF v_answer->>'outcome' <> 'done' THEN RAISE EXCEPTION 'a spent token: %', v_answer; END IF;
  IF (telegram_decide(v_owner, 4242, 'NotARealTokenAtAll01', 'approve'))->>'outcome' <> 'refused' THEN
    RAISE EXCEPTION 'an unknown token was not refused';
  END IF;
  RAISE NOTICE 'telegram decision assertions passed';
END $$;

ROLLBACK;
