import test from "node:test";
import assert from "node:assert/strict";
import { validateCodexAccountInput } from "../codex-account-channel.mjs";

test("account channel accepts only the ChatGPT device-code flow", () => {
  assert.doesNotThrow(() => validateCodexAccountInput([
    JSON.stringify({ method: "initialize", id: 1, params: { clientInfo: { name: "test", version: "1" } } }),
    JSON.stringify({ method: "initialized" }),
    JSON.stringify({ method: "account/login/start", id: 2, params: { type: "chatgptDeviceCode" } }),
    JSON.stringify({ method: "account/read", id: 3, params: { refreshToken: true } }),
    JSON.stringify({ method: "account/logout", id: 4 }),
    JSON.stringify({ method: "model/list", id: 5, params: {} }),
  ].join("\n")));
});

test("account channel rejects parameterized model list and direct credentials", () => {
  assert.throws(
    () => validateCodexAccountInput(JSON.stringify({ method: "model/list", id: 1, params: { origin: "x" } })),
    /does not accept parameters/,
  );
  assert.throws(
    () => validateCodexAccountInput(JSON.stringify({
      method: "model/list",
      id: 2,
      params: { accountId: "someone-else" },
    })),
    /does not accept parameters/,
  );
});

test("account channel rejects runtime methods and direct credentials", () => {
  assert.throws(
    () => validateCodexAccountInput(JSON.stringify({ method: "thread/start", id: 1, params: {} })),
    /does not permit thread\/start/,
  );
  assert.throws(
    () => validateCodexAccountInput(JSON.stringify({
      method: "account/login/start",
      id: 2,
      params: { type: "apiKey", apiKey: "sk-not-allowed" },
    })),
    /only permits ChatGPT device-code login/,
  );
  assert.throws(
    () => validateCodexAccountInput(JSON.stringify({
      method: "account/login/start",
      id: 3,
      params: { type: "chatgptDeviceCode", accessToken: "not-allowed" },
    })),
    /only permits ChatGPT device-code login/,
  );
});

// Stage 12 W6: the check lane reads the subscription's windows before an
// automatic Codex check — read-only, and with nothing to parameterise.
test("account channel reads the usage windows, and only without parameters", () => {
  assert.doesNotThrow(() => validateCodexAccountInput(JSON.stringify({ method: "account/rateLimits/read", id: 6 })));
  assert.doesNotThrow(() => validateCodexAccountInput(JSON.stringify({ method: "account/rateLimits/read", id: 7, params: {} })));
  assert.throws(
    () => validateCodexAccountInput(JSON.stringify({ method: "account/rateLimits/read", id: 8, params: { accountId: "x" } })),
    /does not accept parameters/,
  );
});
