-- Telegram notifications: the panel tells the operator when it waits for them.
--
-- A task waited six hours in "needs your approval" on 2026-10-07 because
-- nothing said so outside the panel. The operator connects a Telegram bot of
-- their own (made with @BotFather); the notifier service sends a message when a
-- task needs their approval, an agent asks a question, a job stops for good, a
-- pull request opens or a publish fails.
--
-- The bot token is a secret and is handled as OpenCode API keys are (0026):
-- the browser encrypts it into a hybrid envelope under the VPS broker's public
-- key, and only that ciphertext reaches PostgreSQL. The notifier runs as the
-- broker's user and decrypts it on the VPS when it calls Telegram. Neither the
-- web process nor infra_web ever reads the envelope back.
--
-- Linking the chat: the notifier checks the token with getMe, records the bot's
-- username and a one-time code, and the panel shows t.me/<bot>?start=<code>.
-- The first /start <code> the bot receives names the chat it sends to.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('telegram_envelope_invalid','invalid_argument','the bot token envelope is not the browser''s encrypted form'),
  ('telegram_not_connected','conflict','no Telegram bot is connected for this operator'),
  ('telegram_not_held','lease_lost','this worker does not hold the Telegram connection')
ON CONFLICT (reason) DO NOTHING;

CREATE TABLE telegram_connections (
  operator_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL
    CHECK (status IN ('verifying','awaiting_chat','connected','failed','disconnected')),
  token_envelope jsonb,
  bot_username text CHECK (bot_username IS NULL OR bot_username ~ '^[A-Za-z0-9_]{3,64}$'),
  link_code text CHECK (link_code IS NULL OR link_code ~ '^[A-Za-z0-9]{16,64}$'),
  chat_id bigint,
  chat_label text CHECK (chat_label IS NULL OR char_length(chat_label) <= 128),
  failure_message text CHECK (failure_message IS NULL OR char_length(failure_message) <= 500),
  leased_by text,
  leased_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'disconnected') = (token_envelope IS NULL)),
  CHECK ((status = 'connected') = (chat_id IS NOT NULL)),
  CHECK (status <> 'awaiting_chat' OR (bot_username IS NOT NULL AND link_code IS NOT NULL))
);

CREATE TABLE notification_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('approval','question','stopped','pull_request','publish_failed','health','test')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 1500),
  link_path text CHECK (link_path IS NULL OR link_path ~ '^/[A-Za-z0-9/_?=&.-]*$'),
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  leased_by text,
  leased_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  UNIQUE (operator_id, dedupe_key)
);
CREATE INDEX notification_outbox_pending ON notification_outbox(created_at) WHERE status = 'pending';

-- --------------------------------------------------------------- the panel

-- The operator's token, as the browser encrypted it: a new connection, or a new
-- bot in place of the old one. The chat is linked again for the new bot.
CREATE FUNCTION set_telegram_bot(p_owner_id uuid, p_envelope jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF p_envelope IS NULL OR jsonb_typeof(p_envelope) <> 'object'
     OR NOT (p_envelope ?& ARRAY['ciphertext','iv','tag','key_wrap'])
     OR (SELECT bool_or(jsonb_typeof(p_envelope->k) <> 'string' OR length(p_envelope->>k) NOT BETWEEN 8 AND 8192)
         FROM unnest(ARRAY['ciphertext','iv','tag','key_wrap']) k) THEN
    PERFORM refuse('telegram_envelope_invalid', 'the bot token must arrive encrypted by the panel', '22023');
  END IF;
  INSERT INTO telegram_connections(operator_id, status, token_envelope)
  VALUES (p_owner_id, 'verifying', jsonb_build_object('ciphertext',p_envelope->>'ciphertext','iv',p_envelope->>'iv',
      'tag',p_envelope->>'tag','key_wrap',p_envelope->>'key_wrap'))
  ON CONFLICT (operator_id) DO UPDATE SET status='verifying', token_envelope=EXCLUDED.token_envelope,
    bot_username=NULL, link_code=NULL, chat_id=NULL, chat_label=NULL, failure_message=NULL,
    leased_by=NULL, leased_until=NULL, updated_at=clock_timestamp();
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_owner_id::text,'telegram.bot_set',
    'telegram_connection',p_owner_id::text,'allowed',NULL,'{}'::jsonb,'telegram:'||p_owner_id);
  RETURN jsonb_build_object('status','verifying');
END $$;

-- What the panel shows: never the envelope.
CREATE FUNCTION get_telegram_connection(p_owner_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE((SELECT jsonb_build_object('status',c.status,'bot_username',c.bot_username,
      'link_code',CASE WHEN c.status='awaiting_chat' THEN c.link_code END,
      'chat_label',c.chat_label,'failure_message',c.failure_message,'updated_at',c.updated_at,
      'last_sent_at',(SELECT max(o.sent_at) FROM notification_outbox o WHERE o.operator_id=c.operator_id))
    FROM telegram_connections c WHERE c.operator_id=p_owner_id), jsonb_build_object('status','none'));
$$;

CREATE FUNCTION disconnect_telegram(p_owner_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  UPDATE telegram_connections SET status='disconnected', token_envelope=NULL, link_code=NULL, chat_id=NULL,
    chat_label=NULL, failure_message=NULL, leased_by=NULL, leased_until=NULL, updated_at=clock_timestamp()
  WHERE operator_id=p_owner_id;
  UPDATE notification_outbox SET status='failed', last_error='Telegram was disconnected'
  WHERE operator_id=p_owner_id AND status='pending';
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_owner_id::text,'telegram.disconnected',
    'telegram_connection',p_owner_id::text,'allowed',NULL,'{}'::jsonb,'telegram:'||p_owner_id);
  RETURN jsonb_build_object('status','disconnected');
END $$;

CREATE FUNCTION send_telegram_test(p_owner_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM telegram_connections WHERE operator_id=p_owner_id AND status='connected') THEN
    PERFORM refuse('telegram_not_connected', 'connect a Telegram chat before sending a test');
  END IF;
  INSERT INTO notification_outbox(operator_id, kind, title, body, link_path, dedupe_key)
  VALUES (p_owner_id, 'test', 'Test from Agentic Control', 'Notifications reach this chat.', '/projects',
    'test:'||gen_random_uuid()) RETURNING id INTO v_id;
  RETURN jsonb_build_object('notification_id', v_id);
END $$;

-- --------------------------------------------------------------- the notifier

-- Every connection the notifier acts on: a token to check, a chat to link, a
-- chat to send to. The envelope goes to the notifier only.
CREATE FUNCTION telegram_connections_to_serve()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('operator_id',c.operator_id,'status',c.status,'envelope',c.token_envelope,
    'bot_username',c.bot_username,'link_code',c.link_code,'chat_id',c.chat_id) ORDER BY c.updated_at), '[]'::jsonb)
  FROM telegram_connections c WHERE c.status IN ('verifying','awaiting_chat','connected');
$$;

-- The token works: the bot is named, and a code links the chat.
CREATE FUNCTION record_telegram_bot(p_owner_id uuid, p_bot_username text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_code text := encode(gen_random_bytes(16), 'hex');
BEGIN
  UPDATE telegram_connections SET status='awaiting_chat', bot_username=p_bot_username, link_code=v_code,
    failure_message=NULL, updated_at=clock_timestamp()
  WHERE operator_id=p_owner_id AND status='verifying';
  IF NOT FOUND THEN PERFORM refuse('telegram_not_held', 'the Telegram connection is no longer being verified'); END IF;
  RETURN jsonb_build_object('status','awaiting_chat','link_code',v_code);
END $$;

CREATE FUNCTION fail_telegram_bot(p_owner_id uuid, p_message text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  -- From any live state, a connected one included (a token revoked in
  -- @BotFather, a bot the operator blocked): the chat goes with it, so the
  -- panel says what failed instead of "Connected".
  UPDATE telegram_connections SET status='failed', failure_message=left(COALESCE(p_message,'Telegram refused the bot token'),500),
    chat_id=NULL, chat_label=NULL, link_code=NULL, updated_at=clock_timestamp()
  WHERE operator_id=p_owner_id AND status IN ('verifying','awaiting_chat','connected');
  RETURN jsonb_build_object('status','failed');
END $$;

-- The chat that sent /start <code> is the one notifications go to.
CREATE FUNCTION record_telegram_chat(p_owner_id uuid, p_link_code text, p_chat_id bigint, p_chat_label text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  UPDATE telegram_connections SET status='connected', chat_id=p_chat_id, chat_label=left(p_chat_label,128),
    link_code=NULL, updated_at=clock_timestamp()
  WHERE operator_id=p_owner_id AND status='awaiting_chat' AND link_code=p_link_code;
  IF NOT FOUND THEN PERFORM refuse('telegram_not_held', 'the link code does not match a chat waiting to be linked'); END IF;
  PERFORM write_audit_event(NULL,NULL,NULL,'system','telegram-notifier','telegram.chat_linked',
    'telegram_connection',p_owner_id::text,'allowed',NULL,jsonb_build_object('chat_label',left(p_chat_label,128)),'telegram:'||p_owner_id);
  RETURN jsonb_build_object('status','connected');
END $$;

CREATE FUNCTION claim_notifications(p_worker_id text, p_limit integer DEFAULT 10, p_lease interval DEFAULT interval '2 minutes')
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
    'link_path',l.link_path,'attempts',l.attempts,'chat_id',c.chat_id,'envelope',c.token_envelope) ORDER BY l.id), '[]'::jsonb)
  INTO v_result
  FROM leased l JOIN telegram_connections c ON c.operator_id=l.operator_id;
  RETURN v_result;
END $$;

CREATE FUNCTION complete_notification(p_id bigint, p_worker_id text)
RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  UPDATE notification_outbox SET status='sent', sent_at=clock_timestamp(), leased_by=NULL, leased_until=NULL, last_error=NULL
  WHERE id=p_id AND leased_by=p_worker_id;
$$;

-- A send that failed is tried again later, five times in all.
CREATE FUNCTION fail_notification(p_id bigint, p_worker_id text, p_message text)
RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  UPDATE notification_outbox SET status=CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
    last_error=left(COALESCE(p_message,'send failed'),500), leased_by=NULL,
    leased_until=clock_timestamp() + make_interval(secs => 30 * attempts)
  WHERE id=p_id AND leased_by=p_worker_id;
$$;

-- --------------------------------------------------------------- what is sent

-- One message, for the project's owner, if they have a chat connected or being
-- linked. Without one nothing is queued: notifications start with the link.
CREATE FUNCTION enqueue_notification(p_project_id uuid, p_task_id uuid, p_kind text, p_title text, p_body text,
  p_dedupe_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_owner uuid; v_project text; v_task text;
BEGIN
  SELECT p.owner_id, p.name INTO v_owner, v_project FROM projects p WHERE p.id=p_project_id;
  IF v_owner IS NULL OR NOT EXISTS (SELECT 1 FROM telegram_connections c WHERE c.operator_id=v_owner
      AND c.status IN ('awaiting_chat','connected')) THEN RETURN; END IF;
  SELECT t.title INTO v_task FROM tasks t WHERE t.id=p_task_id;
  INSERT INTO notification_outbox(operator_id, kind, title, body, link_path, dedupe_key)
  VALUES (v_owner, p_kind, left(p_title,300),
    left(concat_ws(E'\n', v_project || COALESCE(' · ' || v_task, ''), NULLIF(p_body,'')),1500),
    '/projects/' || p_project_id || COALESCE('?task=' || p_task_id, ''), p_dedupe_key)
  ON CONFLICT (operator_id, dedupe_key) DO NOTHING;
END $$;

CREATE FUNCTION notify_task_awaiting_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  PERFORM enqueue_notification(NEW.project_id, NEW.id, 'approval', 'Needs your approval',
    'The orchestrator reviewed the changes.', 'approval:' || NEW.id || ':' || NEW.version);
  RETURN NULL;
END $$;

CREATE TRIGGER tasks_notify_awaiting_approval
  AFTER UPDATE OF status ON tasks
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'awaiting_review')
  EXECUTE FUNCTION notify_task_awaiting_approval();

CREATE FUNCTION notify_domain_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF NEW.project_id IS NULL THEN RETURN NULL; END IF;
  IF NEW.event_type = 'run.input_requested' THEN
    PERFORM enqueue_notification(NEW.project_id, NEW.task_id, 'question', 'An agent asked you a question',
      left(COALESCE(NEW.payload->>'question',''),600), 'event:' || NEW.id);
  ELSIF NEW.event_type = 'runtime_job.dead_lettered' THEN
    PERFORM enqueue_notification(NEW.project_id, NEW.task_id, 'stopped', 'A job stopped and needs you',
      left(COALESCE(NEW.payload->>'message',''),600), 'event:' || NEW.id);
  ELSIF NEW.event_type = 'publish.pull_request_opened' THEN
    PERFORM enqueue_notification(NEW.project_id, NEW.task_id, 'pull_request', 'Pull request opened',
      left(COALESCE(NEW.payload->>'message',''),600), 'event:' || NEW.id);
  ELSIF NEW.event_type IN ('publish.failed','publish.refused') THEN
    PERFORM enqueue_notification(NEW.project_id, NEW.task_id, 'publish_failed', 'Publishing stopped',
      left(COALESCE(NEW.payload->>'message',''),600), 'event:' || NEW.id);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER domain_events_notify
  AFTER INSERT ON domain_events
  FOR EACH ROW
  WHEN (NEW.event_type IN ('run.input_requested','runtime_job.dead_lettered','publish.pull_request_opened',
    'publish.failed','publish.refused'))
  EXECUTE FUNCTION notify_domain_event();

-- The host's health, from the snapshot the health timer takes every minute:
-- what needs the operator — a critical alert (a stopped service, a stale
-- backup or restore drill), a disk filling up (it filled on 2026-10-01), an
-- agent signed out (Claude's token expired on 2026-10-07 and teams stopped).
-- Each distinct alert is sent at most once a day, to every owner with Telegram.
CREATE FUNCTION notify_health_alerts(p_alerts jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_alert jsonb; v_owner uuid; v_count integer := 0; v_day text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
BEGIN
  IF p_alerts IS NULL OR jsonb_typeof(p_alerts) <> 'array' THEN RETURN 0; END IF;
  FOR v_alert IN SELECT a FROM jsonb_array_elements(p_alerts) a
    WHERE a->>'severity' = 'critical' OR a->>'code' IN ('disk_usage_high','runtime_not_authenticated')
  LOOP
    FOR v_owner IN SELECT c.operator_id FROM telegram_connections c WHERE c.status IN ('awaiting_chat','connected') LOOP
      INSERT INTO notification_outbox(operator_id, kind, title, body, link_path, dedupe_key)
      VALUES (v_owner, 'health',
        CASE v_alert->>'code'
          WHEN 'disk_usage_high' THEN 'The server''s disk is filling up'
          WHEN 'runtime_not_authenticated' THEN 'An agent is signed out'
          WHEN 'service_inactive' THEN 'A service on the server stopped'
          WHEN 'backup_stale' THEN 'The backup is out of date'
          WHEN 'restore_drill_stale' THEN 'The restore drill is out of date'
          ELSE 'The server needs attention' END,
        left(COALESCE(v_alert->>'message',''),600),
        CASE WHEN v_alert->>'code' = 'runtime_not_authenticated' THEN '/settings/connections' ELSE '/settings/runtimes' END,
        'health:' || COALESCE(v_alert->>'code','') || ':' || md5(COALESCE(v_alert->>'message','')) || ':' || v_day)
      ON CONFLICT (operator_id, dedupe_key) DO NOTHING;
      IF FOUND THEN v_count := v_count + 1; END IF;
    END LOOP;
  END LOOP;
  RETURN v_count;
END $$;

-- --------------------------------------------------------------- grants

REVOKE ALL ON telegram_connections, notification_outbox FROM PUBLIC;
REVOKE ALL ON FUNCTION set_telegram_bot(uuid,jsonb), get_telegram_connection(uuid), disconnect_telegram(uuid),
  send_telegram_test(uuid), telegram_connections_to_serve(), record_telegram_bot(uuid,text),
  fail_telegram_bot(uuid,text), record_telegram_chat(uuid,text,bigint,text), claim_notifications(text,integer,interval),
  complete_notification(bigint,text), fail_notification(bigint,text,text),
  enqueue_notification(uuid,uuid,text,text,text,text), notify_task_awaiting_approval(), notify_domain_event(),
  notify_health_alerts(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_telegram_bot(uuid,jsonb), get_telegram_connection(uuid), disconnect_telegram(uuid),
  send_telegram_test(uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION telegram_connections_to_serve(), record_telegram_bot(uuid,text), fail_telegram_bot(uuid,text),
  record_telegram_chat(uuid,text,bigint,text), claim_notifications(text,integer,interval),
  complete_notification(bigint,text), fail_notification(bigint,text,text), notify_health_alerts(jsonb) TO infra_worker;
