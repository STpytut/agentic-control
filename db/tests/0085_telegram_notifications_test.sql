-- Migration 0140: Telegram notifications. The token is stored only as an
-- envelope the panel cannot read back; a link code links one chat; tasks and
-- events queue a message only for an owner with Telegram set up.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE
  v_owner uuid; v_project uuid; v_task uuid; v_code text; v_conn jsonb; v_claimed jsonb;
  v_envelope jsonb := '{"ciphertext":"Y2lwaGVydGV4dA==","iv":"aXZpdml2aXZpdg==","tag":"dGFndGFndGFndGFn","key_wrap":"a2V5d3JhcGtleXdyYXA="}';
BEGIN
  IF has_table_privilege('infra_web','telegram_connections','SELECT')
     OR has_function_privilege('infra_web','telegram_connections_to_serve()','EXECUTE')
     OR has_function_privilege('infra_web','claim_notifications(text,integer,interval)','EXECUTE')
     OR NOT has_function_privilege('infra_worker','claim_notifications(text,integer,interval)','EXECUTE') THEN
    RAISE EXCEPTION 'the envelope is readable by the panel, or the notifier cannot claim';
  END IF;

  INSERT INTO users(display_name,role) VALUES('Telegram owner','owner') RETURNING id INTO v_owner;
  INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch,credential_mode)
    VALUES(v_owner,'Telegram project','telegram-project','/srv/infra-cod/workspaces/telegram-project','main','empty') RETURNING id INTO v_project;
  INSERT INTO tasks(project_id,title,objective,status,created_by,acceptance_criteria)
    VALUES(v_project,'Ship the widget','Make it.','implementing','test','["done"]') RETURNING id INTO v_task;

  -- Without Telegram nothing is queued.
  UPDATE tasks SET status='awaiting_review' WHERE id=v_task;
  IF EXISTS (SELECT 1 FROM notification_outbox WHERE operator_id=v_owner) THEN RAISE EXCEPTION 'queued without Telegram'; END IF;
  UPDATE tasks SET status='implementing' WHERE id=v_task;

  -- A plaintext token is refused: only the envelope is stored.
  BEGIN
    PERFORM set_telegram_bot(v_owner, '{"token":"123:abc"}');
    RAISE EXCEPTION 'a plaintext token was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  PERFORM set_telegram_bot(v_owner, v_envelope);
  v_conn := get_telegram_connection(v_owner);
  IF v_conn->>'status' <> 'verifying' OR v_conn ? 'envelope' OR v_conn::text LIKE '%Y2lwaGVydGV4dA%' THEN
    RAISE EXCEPTION 'the panel read: %', v_conn;
  END IF;

  v_code := record_telegram_bot(v_owner, 'agentic_test_bot')->>'link_code';
  IF (get_telegram_connection(v_owner)->>'link_code') <> v_code THEN RAISE EXCEPTION 'the link code is not shown'; END IF;
  BEGIN
    PERFORM record_telegram_chat(v_owner, 'notthecode0000000000', 99, 'stranger');
    RAISE EXCEPTION 'a wrong code linked a chat';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  PERFORM record_telegram_chat(v_owner, v_code, 42, '@owner');
  IF (get_telegram_connection(v_owner)->>'status') <> 'connected' THEN RAISE EXCEPTION 'not connected'; END IF;

  -- The executor finishing is not the operator's turn yet: the review is.
  UPDATE tasks SET status='awaiting_review' WHERE id=v_task;
  IF EXISTS (SELECT 1 FROM notification_outbox WHERE operator_id=v_owner AND kind='approval') THEN
    RAISE EXCEPTION 'an approval message before the review';
  END IF;
  -- The review approving it is: one message.
  UPDATE tasks SET status='reviewing' WHERE id=v_task;
  UPDATE tasks SET status='awaiting_review' WHERE id=v_task;
  IF (SELECT count(*) FROM notification_outbox WHERE operator_id=v_owner AND kind='approval') <> 1 THEN
    RAISE EXCEPTION 'approval messages: %', (SELECT count(*) FROM notification_outbox WHERE operator_id=v_owner);
  END IF;
  IF (SELECT link_path FROM notification_outbox WHERE operator_id=v_owner AND kind='approval')
     <> '/projects/' || v_project || '?task=' || v_task THEN RAISE EXCEPTION 'the link is wrong'; END IF;

  UPDATE notification_outbox SET status='sent' WHERE operator_id <> v_owner AND status='pending';
  v_claimed := claim_notifications('notifier-test', 10);
  IF jsonb_array_length(v_claimed) <> 1 OR (v_claimed->0->>'chat_id')::bigint <> 42 OR v_claimed->0->'envelope' IS NULL THEN
    RAISE EXCEPTION 'claimed: %', v_claimed;
  END IF;
  PERFORM complete_notification((v_claimed->0->>'id')::bigint, 'notifier-test');
  IF (SELECT status FROM notification_outbox WHERE id=(v_claimed->0->>'id')::bigint) <> 'sent' THEN RAISE EXCEPTION 'not sent'; END IF;

  -- Health: a critical alert and a disk filling up are sent, once a day each;
  -- a warning the operator cannot act on is not.
  IF notify_health_alerts('[{"severity":"critical","code":"service_inactive","message":"infra-cod-web.service is inactive"},
      {"severity":"warning","code":"disk_usage_high","message":"root filesystem is 91% full"},
      {"severity":"warning","code":"runtime_not_provisioned","message":"opencode is not provisioned"}]') <> 2
     OR notify_health_alerts('[{"severity":"critical","code":"service_inactive","message":"infra-cod-web.service is inactive"}]') <> 0 THEN
    RAISE EXCEPTION 'health notifications: %', (SELECT jsonb_agg(title) FROM notification_outbox WHERE operator_id=v_owner AND kind='health');
  END IF;

  -- A connected bot whose token was revoked fails without breaking a CHECK,
  -- and setting a new token starts over.
  PERFORM fail_telegram_bot(v_owner, 'revoked');
  IF (get_telegram_connection(v_owner)->>'status') <> 'failed' THEN RAISE EXCEPTION 'a revoked bot is not failed'; END IF;
  PERFORM set_telegram_bot(v_owner, v_envelope);
  v_code := record_telegram_bot(v_owner, 'agentic_test_bot')->>'link_code';
  PERFORM record_telegram_chat(v_owner, v_code, 42, '@owner');

  -- Disconnecting drops the envelope and what was still to send.
  PERFORM send_telegram_test(v_owner);
  PERFORM disconnect_telegram(v_owner);
  IF (SELECT token_envelope FROM telegram_connections WHERE operator_id=v_owner) IS NOT NULL
     OR EXISTS (SELECT 1 FROM notification_outbox WHERE operator_id=v_owner AND status='pending') THEN
    RAISE EXCEPTION 'disconnect left the token or pending messages';
  END IF;
  RAISE NOTICE 'telegram notification assertions passed';
END $$;

ROLLBACK;
