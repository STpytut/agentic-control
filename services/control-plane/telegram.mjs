// Telegram notifications (0140): the parts with no network and no database,
// so they are tested on their own — the broker envelope, the message text, and
// reading the chat that sent /start <code> out of getUpdates.

import { readFileSync } from "node:fs";
import { constants, createDecipheriv, privateDecrypt } from "node:crypto";

export const TELEGRAM_API = "https://api.telegram.org";

// The bot token, decrypted on the VPS from the envelope the browser made with
// the broker's public key (the same hybrid form as OpenCode keys, 0026).
export function decryptBrokerEnvelope(envelope, privateKeyPem) {
  const aesKey = privateDecrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(String(envelope?.key_wrap ?? ""), "base64"),
  );
  try {
    const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(String(envelope.iv), "base64"));
    decipher.setAuthTag(Buffer.from(String(envelope.tag), "base64"));
    return Buffer.concat([decipher.update(Buffer.from(String(envelope.ciphertext), "base64")), decipher.final()])
      .toString("utf8").trim();
  } finally {
    aesKey.fill(0);
  }
}

export function readPrivateKey(path) {
  return readFileSync(path, "utf8");
}

// A token as @BotFather prints it: the bot's id, a colon, the secret.
export function looksLikeBotToken(token) {
  return /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(String(token ?? ""));
}

const ICONS = { approval: "🟡", question: "❓", stopped: "🔴", pull_request: "🟢", publish_failed: "🔴", health: "🛠", test: "✅" };

// Plain text, not Markdown: a project name or an agent's question with an
// underscore would otherwise break the message.
export function notificationText(item, domain) {
  const link = domain && item.link_path ? `https://${domain}${item.link_path}` : "";
  return [`${ICONS[item.kind] ?? "•"} ${item.title}`, item.body, link].filter(Boolean).join("\n\n").slice(0, 4000);
}

// The chat that sent /start <code> to the bot, from a getUpdates answer: the
// code the panel showed, and nothing else, links a chat.
export function linkedChat(updates, linkCode) {
  if (!linkCode) return null;
  for (const update of Array.isArray(updates) ? updates : []) {
    const message = update?.message;
    const text = String(message?.text ?? "").trim();
    if (text !== `/start ${linkCode}`) continue;
    const chat = message?.chat;
    if (!Number.isSafeInteger(chat?.id)) continue;
    const label = chat.username ? `@${chat.username}` : [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.title || "chat";
    return { chatId: chat.id, label: String(label).slice(0, 128) };
  }
  return null;
}

// The chats that sent /start without the panel's code — the bot opened
// directly, or a chat that had started it before — so the bot can say where
// the right link is. Each chat once.
export function startsWithoutCode(updates, linkCode) {
  const chats = new Set();
  for (const update of Array.isArray(updates) ? updates : []) {
    const text = String(update?.message?.text ?? "").trim();
    const chatId = update?.message?.chat?.id;
    if (!Number.isSafeInteger(chatId) || !/^\/start(@\w+)?(\s|$)/.test(text)) continue;
    if (linkCode && text === `/start ${linkCode}`) continue;
    chats.add(chatId);
  }
  return [...chats];
}

// The next getUpdates offset: one past the last update seen.
export function nextOffset(updates, current = 0) {
  return (Array.isArray(updates) ? updates : []).reduce((offset, update) =>
    Number.isSafeInteger(update?.update_id) ? Math.max(offset, update.update_id + 1) : offset, current);
}

// The approval message's buttons (0142): approve and open the pull request
// (for a repository the platform can publish), approve only, and the chat.
// callback_data stays far under Telegram's 64 bytes: "ap:" or "ao:" and the
// 20-character token.
export function decisionKeyboard(item, domain) {
  const rows = [];
  if (item.decision_token) {
    rows.push([
      ...(item.can_publish ? [{ text: "✅ Approve & open PR", callback_data: `ap:${item.decision_token}` }] : []),
      { text: item.can_publish ? "Approve only" : "✅ Approve", callback_data: `ao:${item.decision_token}` },
    ]);
  }
  if (rows.length && domain && item.link_path) rows.push([{ text: "Open chat", url: `https://${domain}${item.link_path}` }]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

const CHOICES = { ap: "approve_publish", ao: "approve" };

// A button press from getUpdates, if it is one of ours and came from the
// linked chat; anything else is ignored.
export function decisionPress(update, chatId) {
  const query = update?.callback_query;
  if (!query?.id) return null;
  const match = /^(ap|ao):([A-Za-z0-9]{20})$/.exec(String(query.data ?? ""));
  const fromChat = query.message?.chat?.id;
  if (!match || fromChat !== Number(chatId)) return { queryId: query.id, ignored: true };
  return { queryId: query.id, choice: CHOICES[match[1]], token: match[2], chatId: fromChat,
    messageId: query.message?.message_id, text: String(query.message?.text ?? "") };
}
