// Telegram notifier (0140).
//
// Checks a bot token the operator set in the panel, links the chat that sends
// /start <code>, and sends the queued notifications: a task waiting for
// approval, an agent's question, a job that stopped, a pull request opened, a
// publish that failed.
//
// The token reaches this process only as the broker envelope the browser made;
// it is decrypted here, used in the Telegram API URL, and never written to the
// database, the journal or an error. It runs as the OpenCode broker's user,
// which alone can read the broker's private key.

import { isMain } from "./entrypoint.mjs";
import { queryJson, closePool } from "./db.mjs";
import { redactError, runPollLoop, shutdownSignal } from "./worker-loop.mjs";
import { TELEGRAM_API, decryptBrokerEnvelope, linkedChat, looksLikeBotToken, nextOffset, notificationText, readPrivateKey, startsWithoutCode } from "./telegram.mjs";

const workerId = process.env.TELEGRAM_NOTIFIER_ID ?? `telegram-notifier-${process.pid}`;
const pollMs = Number(process.env.TELEGRAM_NOTIFIER_POLL_MS ?? 5_000);
const privateKeyPath = process.env.OPENCODE_BROKER_PRIVATE_KEY_PATH ?? "/etc/infra-cod/opencode/broker-private.pem";
const domain = process.env.INFRA_COD_DOMAIN ?? "";

// getUpdates offsets, per bot, for this process's life. Telegram keeps an
// update for a day; one read twice only repeats a link that is already made.
const offsets = new Map();

async function telegram(token, method, body, timeoutMs = 15_000) {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const answer = await response.json().catch(() => ({}));
  if (!answer.ok) {
    const error = new Error(`Telegram ${method}: ${answer.description ?? `HTTP ${response.status}`}`);
    error.status = response.status;
    throw error;
  }
  return answer.result;
}

// A broker key the process cannot read is the host's to fix and is retried;
// an envelope it cannot open, or one that holds no bot token, will not get
// better and is the operator's to set again.
function permanent(message) {
  const error = new Error(message);
  error.permanent = true;
  return error;
}

function tokenOf(envelope) {
  const key = readPrivateKey(privateKeyPath);
  let token;
  try {
    token = decryptBrokerEnvelope(envelope, key);
  } catch {
    throw permanent("The saved token could not be read on the server. Paste it again.");
  }
  if (!looksLikeBotToken(token)) throw permanent("That is not a bot token: @BotFather shows it as digits, a colon and a key.");
  return token;
}

// Telegram's answer that the bot itself is gone for us: a revoked token (401),
// a bot the operator blocked or a chat that no longer exists (403).
const botRefused = (error) => error?.status === 401 || error?.status === 403 || error?.status === 404;

async function serveConnection(connection) {
  let token = "";
  try {
    token = tokenOf(connection.envelope);
    if (connection.status === "verifying") {
      const bot = await telegram(token, "getMe");
      await queryJson(`SELECT record_telegram_bot(:'owner'::uuid,:'bot')::text;`,
        { owner: connection.operator_id, bot: String(bot.username ?? "") });
      return { kind: "verified", bot: bot.username };
    }
    if (connection.status === "awaiting_chat") {
      const key = connection.bot_username;
      const updates = await telegram(token, "getUpdates", { offset: offsets.get(key) ?? 0, timeout: 0, allowed_updates: ["message"] });
      const next = nextOffset(updates, offsets.get(key) ?? 0);
      const chat = linkedChat(updates, connection.link_code);
      // The offset moves on only once the link is recorded: a moved offset
      // tells Telegram to drop the /start, and a failed write would lose it.
      if (!chat) {
        // A /start without the code links nothing; the bot says where the link
        // is instead of staying silent (the owner pressed Start on rc.128 and
        // nothing happened).
        for (const chatId of startsWithoutCode(updates, connection.link_code)) {
          await telegram(token, "sendMessage", { chat_id: chatId, text:
            "To link this chat, open the link in the panel: Settings → Notifications → Open the bot. It carries a one-time code; a plain /start does not." })
            .catch(() => undefined);
        }
        offsets.set(key, next);
        return undefined;
      }
      await queryJson(`SELECT record_telegram_chat(:'owner'::uuid,:'code',:'chat'::bigint,:'label')::text;`,
        { owner: connection.operator_id, code: connection.link_code, chat: String(chat.chatId), label: chat.label });
      offsets.set(key, next);
      await telegram(token, "sendMessage", { chat_id: chat.chatId, text: notificationText({ kind: "test",
        title: "Connected to Agentic Control", body: "You will get a message here when a task needs you." }, domain) });
      return { kind: "linked" };
    }
    return undefined;
  } catch (error) {
    const message = redactError(error, "Telegram could not be reached.", [token]);
    // A refused token or an unreadable envelope is the operator's to fix; a
    // network fault is retried.
    if (error.permanent || botRefused(error)) {
      await queryJson(`SELECT fail_telegram_bot(:'owner'::uuid,:'message')::text;`,
        { owner: connection.operator_id, message: error.permanent ? message : "Telegram refused this bot token. Copy it again from @BotFather." });
      return { kind: "refused" };
    }
    return { kind: "error", error: message };
  } finally {
    token = "";
  }
}

async function sendNotification(item) {
  let token = "";
  try {
    token = tokenOf(item.envelope);
    await telegram(token, "sendMessage", { chat_id: Number(item.chat_id), text: notificationText(item, domain),
      disable_web_page_preview: true });
    await queryJson(`SELECT complete_notification(:'id'::bigint,:'worker');`, { id: String(item.id), worker: workerId });
    return { kind: "sent", id: item.id };
  } catch (error) {
    const message = redactError(error, "The message was not sent.", [token]);
    await queryJson(`SELECT fail_notification(:'id'::bigint,:'worker',:'message');`,
      { id: String(item.id), worker: workerId, message }).catch(() => undefined);
    // The bot is gone for us: say so on the connection, so the panel shows it
    // rather than "Connected" while every message fails.
    if (error.permanent || botRefused(error)) {
      await queryJson(`SELECT fail_telegram_bot(:'owner'::uuid,:'message')::text;`, { owner: item.operator_id,
        message: error.permanent ? message : "Telegram refused the bot: its token was revoked, or the bot was blocked. Set it up again." })
        .catch(() => undefined);
    }
    return { kind: "send_failed", id: item.id, error: message };
  } finally {
    token = "";
  }
}

export async function runOnce() {
  const results = [];
  const connections = await queryJson(`SELECT telegram_connections_to_serve()::text;`);
  for (const connection of Array.isArray(connections) ? connections : []) {
    const result = await serveConnection(connection);
    if (result) results.push(result);
  }
  const items = await queryJson(`SELECT claim_notifications(:'worker',10)::text;`, { worker: workerId });
  for (const item of Array.isArray(items) ? items : []) results.push(await sendNotification(item));
  return results;
}

async function main() {
  await runPollLoop({
    name: "telegram-notifier", pollMs, signal: shutdownSignal(), once: process.argv[2] === "once",
    fallbackMessage: "Telegram notification failed.",
    tick: async () => {
      const results = await runOnce();
      return results.length ? results : undefined;
    },
  });
}

if (isMain(import.meta.url)) {
  try { await main(); } finally { await closePool(); }
}
