-- Decisions from Telegram (rc.130).
--
-- The approval message (0140) said a task waited and linked to it; deciding
-- still meant opening the panel. Now it carries buttons: Approve & open PR,
-- Approve only, and Open chat. Request changes stays in the panel — it needs
-- the operator's words.
--
-- Each message's buttons name a one-time decision token bound to the task at
-- the version that asked; the notifier passes a press on only from the chat
-- linked to the owner, and the decision is made by approve_task_review and
-- request_publish_on_approval exactly as the panel makes it, with the owner as
-- the actor. A press after the task moved on is answered, not applied.

SET search_path TO control_plane, public, extensions;

CREATE TABLE telegram_decisions (
  token text PRIMARY KEY CHECK (token ~ '^[A-Za-z0-9]{20}$'),
  operator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '7 days',
  used_at timestamptz,
  outcome text CHECK (outcome IS NULL OR char_length(outcome) <= 300)
);

ALTER TABLE notification_outbox ADD COLUMN decision_token text REFERENCES telegram_decisions(token) ON DELETE SET NULL;

-- The approval message, now with its decision token: one per task version.
CREATE OR REPLACE FUNCTION notify_task_awaiting_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_owner uuid; v_key text := 'approval:' || NEW.id || ':' || NEW.version; v_token text;
BEGIN
  PERFORM enqueue_notification(NEW.project_id, NEW.id, 'approval', 'Needs your approval',
    'The orchestrator reviewed the changes.', v_key);
  SELECT owner_id INTO v_owner FROM projects WHERE id=NEW.project_id;
  IF EXISTS (SELECT 1 FROM notification_outbox WHERE operator_id=v_owner AND dedupe_key=v_key AND decision_token IS NULL) THEN
    v_token := substr(regexp_replace(encode(gen_random_bytes(24),'base64'),'[^A-Za-z0-9]','','g'),1,20);
    IF length(v_token) = 20 THEN
      INSERT INTO telegram_decisions(token, operator_id, project_id, task_id, task_version)
      VALUES (v_token, v_owner, NEW.project_id, NEW.id, NEW.version);
      UPDATE notification_outbox SET decision_token=v_token WHERE operator_id=v_owner AND dedupe_key=v_key;
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- The claim, as 0140's, with what the buttons need: the token, and whether the
-- project is one the platform can publish (a GitHub App repository).
CREATE OR REPLACE FUNCTION claim_notifications(p_worker_id text, p_limit integer DEFAULT 10, p_lease interval DEFAULT interval '2 minutes')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_result jsonb;
BEGIN
  WITH picked AS (
    SELECT o.id FROM notification_outbox o
    JOIN telegram_connections c ON c.operator_id=o.operator_id AND c.status='connected'
    WHERE o.status='pending' AND (o.leased_until IS NULL OR o.leased_until < clock_timestamp())
    ORDER BY o.created_at LIMIT p_limit FOR UPDATE OF o SKIP LOCKED
  ), leased AS (
    UPDATE notification_outbox o SET leased_by=p_worker_id, leased_until=clock_timestamp()+p_lease, attempts=o.attempts+1
    FROM picked WHERE o.id=picked.id RETURNING o.*
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',l.id,'operator_id',l.operator_id,'kind',l.kind,'title',l.title,'body',l.body,
    'link_path',l.link_path,'attempts',l.attempts,'chat_id',c.chat_id,'envelope',c.token_envelope,
    'decision_token',d.token,
    'can_publish',COALESCE(p.credential_mode='github_app',false)) ORDER BY l.id), '[]'::jsonb)
  INTO v_result
  FROM leased l JOIN telegram_connections c ON c.operator_id=l.operator_id
  LEFT JOIN telegram_decisions d ON d.token=l.decision_token AND d.used_at IS NULL AND d.expires_at > clock_timestamp()
  LEFT JOIN projects p ON p.id=d.project_id;
  RETURN v_result;
END $$;

-- A button pressed in the linked chat. Answers what happened in one sentence,
-- never raises: a refusal is the message the operator sees.
CREATE FUNCTION telegram_decide(p_owner_id uuid, p_chat_id bigint, p_token text, p_choice text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_decision telegram_decisions%ROWTYPE; v_task tasks%ROWTYPE; v_publish jsonb; v_outcome text;
BEGIN
  IF p_choice NOT IN ('approve_publish','approve') THEN
    RETURN jsonb_build_object('outcome','refused','message','That button is not one this bot knows.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM telegram_connections WHERE operator_id=p_owner_id AND status='connected' AND chat_id=p_chat_id) THEN
    RETURN jsonb_build_object('outcome','refused','message','This chat is not the one linked to the panel.');
  END IF;
  SELECT * INTO v_decision FROM telegram_decisions WHERE token=p_token AND operator_id=p_owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome','refused','message','This button is not valid any more.');
  END IF;
  IF v_decision.used_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','done','message',COALESCE(v_decision.outcome,'Already decided.'));
  END IF;
  IF v_decision.expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('outcome','refused','message','This button has expired. Decide in the panel.');
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id=v_decision.task_id;
  IF v_task.status <> 'awaiting_review' OR v_task.version <> v_decision.task_version THEN
    UPDATE telegram_decisions SET used_at=clock_timestamp(), outcome='The task had already moved on.' WHERE token=p_token;
    RETURN jsonb_build_object('outcome','moved_on','message','The task has already moved on. Open the chat to see where it is.');
  END IF;
  BEGIN
    PERFORM approve_task_review(v_decision.project_id, v_decision.task_id, p_owner_id::text, 'Approved from Telegram',
      'telegram-approve:' || v_decision.task_id || ':' || v_decision.task_version, v_decision.task_version, 'telegram:' || p_token);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('outcome','refused','message',left('The approval was refused: ' || SQLERRM, 300));
  END;
  v_outcome := 'Approved.';
  IF p_choice = 'approve_publish' THEN
    v_publish := request_publish_on_approval(v_decision.project_id, v_decision.task_id, p_owner_id, p_owner_id::text, 'telegram:' || p_token);
    v_outcome := CASE WHEN v_publish ? 'refused' THEN left('Approved. The pull request was not requested: ' || (v_publish->>'refused'), 300)
      ELSE 'Approved. The pull request opens once the server has prepared the commit.' END;
  END IF;
  UPDATE telegram_decisions SET used_at=clock_timestamp(), outcome=v_outcome WHERE token=p_token;
  RETURN jsonb_build_object('outcome','approved','message',v_outcome);
END $$;

REVOKE ALL ON telegram_decisions FROM PUBLIC;
REVOKE ALL ON FUNCTION telegram_decide(uuid,bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION telegram_decide(uuid,bigint,text,text) TO infra_worker;
