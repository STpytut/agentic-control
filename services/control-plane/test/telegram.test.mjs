import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync, publicEncrypt, constants, randomBytes } from "node:crypto";
import { decisionKeyboard, decisionPress, decryptBrokerEnvelope, linkedChat, looksLikeBotToken, nextOffset, notificationText, startsWithoutCode } from "../telegram.mjs";

const TOKEN = "123456789:AAH-fake_token_for_tests_only_0123456789";

// The envelope as the browser makes it (opencode-crypto.ts): AES-256-GCM under
// a fresh key, the key wrapped with the broker's RSA-OAEP public key.
function envelopeFor(text, publicKey) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
    key_wrap: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key).toString("base64"),
  };
}

test("the bot token is read back only with the broker's private key", () => {
  const broker = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const envelope = envelopeFor(TOKEN, broker.publicKey);
  assert.equal(decryptBrokerEnvelope(envelope, broker.privateKey), TOKEN);
  assert.throws(() => decryptBrokerEnvelope(envelope, other.privateKey));
  assert.throws(() => decryptBrokerEnvelope({ ...envelope, tag: Buffer.alloc(16).toString("base64") }, broker.privateKey));
});

test("a bot token looks as @BotFather prints it", () => {
  assert.ok(looksLikeBotToken(TOKEN));
  assert.ok(!looksLikeBotToken("not a token"));
  assert.ok(!looksLikeBotToken("123:short"));
});

test("only /start with the panel's code links a chat", () => {
  const updates = [
    { update_id: 10, message: { text: "/start", chat: { id: 1, username: "someone" } } },
    { update_id: 11, message: { text: "/start wrongcode", chat: { id: 2, username: "stranger" } } },
    { update_id: 12, message: { text: "/start abc123abc123abc1", chat: { id: 42, first_name: "Alex" } } },
  ];
  assert.deepEqual(linkedChat(updates, "abc123abc123abc1"), { chatId: 42, label: "Alex" });
  assert.equal(linkedChat(updates, "zzz"), null);
  assert.equal(linkedChat(updates, null), null);
  assert.equal(nextOffset(updates, 0), 13);
  assert.equal(nextOffset([], 7), 7);
});

test("a notification is plain text with a link to the chat", () => {
  const text = notificationText({ kind: "approval", title: "Needs your approval", body: "Focus Timer · Add a reset_today button",
    link_path: "/projects/p?task=t" }, "panel.example");
  assert.equal(text, "🟡 Needs your approval\n\nFocus Timer · Add a reset_today button\n\nhttps://panel.example/projects/p?task=t");
  assert.equal(notificationText({ kind: "test", title: "Hi", body: "" }, ""), "✅ Hi");
});

test("a /start without the code is answered once per chat; the right one is not", () => {
  const updates = [
    { update_id: 1, message: { text: "/start", chat: { id: 7 } } },
    { update_id: 2, message: { text: "/start", chat: { id: 7 } } },
    { update_id: 3, message: { text: "/start@acpmybot", chat: { id: 8 } } },
    { update_id: 4, message: { text: "/start abc123abc123abc1", chat: { id: 9 } } },
    { update_id: 5, message: { text: "hello", chat: { id: 10 } } },
  ];
  assert.deepEqual(startsWithoutCode(updates, "abc123abc123abc1"), [7, 8]);
});

test("an approval message carries its decision buttons; a press counts only from the linked chat", () => {
  const item = { kind: "approval", decision_token: "Abc123Abc123Abc123Ab", can_publish: true, link_path: "/projects/p?task=t" };
  assert.deepEqual(decisionKeyboard(item, "panel.example"), { inline_keyboard: [
    [{ text: "✅ Approve & open PR", callback_data: "ap:Abc123Abc123Abc123Ab" }, { text: "Approve only", callback_data: "ao:Abc123Abc123Abc123Ab" }],
    [{ text: "Open chat", url: "https://panel.example/projects/p?task=t" }],
  ] });
  assert.deepEqual(decisionKeyboard({ ...item, can_publish: false }, "").inline_keyboard, [[{ text: "✅ Approve", callback_data: "ao:Abc123Abc123Abc123Ab" }]]);
  assert.equal(decisionKeyboard({ kind: "question", link_path: "/x" }, "panel.example"), undefined);

  const press = (chat, data) => ({ update_id: 1, callback_query: { id: "q1", data, message: { message_id: 5, text: "🟡 Needs your approval", chat: { id: chat } } } });
  assert.deepEqual(decisionPress(press(42, "ap:Abc123Abc123Abc123Ab"), 42),
    { queryId: "q1", choice: "approve_publish", token: "Abc123Abc123Abc123Ab", chatId: 42, messageId: 5, text: "🟡 Needs your approval" });
  assert.deepEqual(decisionPress(press(99, "ap:Abc123Abc123Abc123Ab"), 42), { queryId: "q1", ignored: true });
  assert.deepEqual(decisionPress(press(42, "rm:everything"), 42), { queryId: "q1", ignored: true });
  assert.equal(decisionPress({ update_id: 2, message: { text: "hi" } }, 42), null);
});
