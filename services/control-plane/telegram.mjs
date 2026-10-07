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

// The next getUpdates offset: one past the last update seen.
export function nextOffset(updates, current = 0) {
  return (Array.isArray(updates) ? updates : []).reduce((offset, update) =>
    Number.isSafeInteger(update?.update_id) ? Math.max(offset, update.update_id + 1) : offset, current);
}
