import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { processClaudeLogin } from "../claude-login.mjs";
import { validateClaudeAccountInput, claudeAccountState } from "../../runtime-supervisor/claude-account-channel.mjs";

const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y";

// A stand-in for `claude auth login` as the supervisor's channel hands it over.
function fakeLogin({ accept = true } = {}) {
  const handle = new EventEmitter();
  handle.stdout = new PassThrough();
  handle.stderr = new PassThrough();
  handle.stdin = new PassThrough();
  handle.received = [];
  setImmediate(() => handle.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${URL}\nPaste code here if prompted > `));
  handle.stdin.on("data", (chunk) => {
    handle.received.push(String(chunk));
    handle.stdout.write(accept ? "Login successful.\n" : "Invalid code. Please make sure the full code was copied.\n");
    setImmediate(() => handle.emit("close", accept ? 0 : 1));
  });
  return handle;
}

function recorder(codeAfter = 1) {
  const steps = [];
  let asked = 0;
  return {
    steps,
    record: async ({ step, value }) => {
      steps.push(value === null || value === undefined ? step : `${step}:${value}`);
      if (step === "take_code") { asked += 1; return { code: asked > codeAfter ? "abcdefgh#ijklmnop" : null }; }
      return {};
    },
  };
}

const session = () => ({ id: "s1", expires_at: new Date(Date.now() + 60_000).toISOString() });

test("the link reaches the panel, the pasted code reaches the same process, and the sign-in ends", async () => {
  const handle = fakeLogin();
  const { steps, record } = recorder(2);
  const result = await processClaudeLogin(session(), { open: async () => handle, record, workerId: "w", codePollMs: 1 });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(handle.received, ["abcdefgh#ijklmnop\n"]);
  assert.deepEqual(steps.filter((s) => s !== "take_code"), [`url:${URL}`, "succeeded"]);
});

test("a code Claude Code refuses ends the sign-in as failed, saying so without the link", async () => {
  const { steps, record } = recorder(0);
  const result = await processClaudeLogin(session(), { open: async () => fakeLogin({ accept: false }), record, workerId: "w", codePollMs: 1 });
  assert.equal(result.status, "failed");
  assert.match(result.error, /did not accept the code: Invalid code/);
  assert.ok(steps.at(-1).startsWith("failed:"));
});

test("an expired sign-in fails without writing anything to the process", async () => {
  const handle = fakeLogin();
  const { record } = recorder(Infinity);
  const result = await processClaudeLogin({ id: "s1", expires_at: new Date(Date.now() + 50).toISOString() },
    { open: async () => handle, record, workerId: "w", codePollMs: 5 });
  assert.equal(result.status, "failed");
  assert.match(result.error, /expired/);
  assert.deepEqual(handle.received, []);
});

test("the account surface's stdin takes one code on one line, and nothing else", () => {
  const state = claudeAccountState();
  assert.throws(() => validateClaudeAccountInput("/logout\n", claudeAccountState()), /only the code/);
  assert.throws(() => validateClaudeAccountInput("abcdefgh#ijkl", claudeAccountState()), /only the code/);
  validateClaudeAccountInput("abcdefgh#ijkl\n", state);
  assert.throws(() => validateClaudeAccountInput("abcdefgh#ijkl\n", state), /one code/);
});

// rc.150: the same flow signs Antigravity in. Its link is Google's, on stderr;
// a run that ends well without asking was signed in already; and it waits a
// minute for the code, which is the panel's deadline too.
import { processRuntimeLogin } from "../claude-login.mjs";
import { driverFor } from "../../runtime-supervisor/drivers/index.mjs";

const GOOGLE_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=y&code_challenge=z";
const antigravityLogin = driverFor("antigravity").input.login;

function fakeAgy({ signedIn = false, accept = true } = {}) {
  const handle = new EventEmitter();
  handle.stdout = new PassThrough();
  handle.stderr = new PassThrough();
  handle.stdin = new PassThrough();
  handle.received = [];
  setImmediate(() => {
    if (signedIn) {
      handle.stdout.write('{"event":"init","conversation_id":"c"}\n{"event":"result","result":{"status":"SUCCESS","response":"OK"}}\n');
      setImmediate(() => handle.emit("close", 0));
      return;
    }
    handle.stderr.write(`Authentication required. Please visit the URL to log in:\n${GOOGLE_URL}\n\nOr, paste the authorization code here and press Enter: `);
  });
  handle.stdin.on("data", (chunk) => {
    handle.received.push(String(chunk));
    if (accept) handle.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"OK"}}\n');
    else handle.stdout.write('{"event":"result","result":{"status":"ERROR","error":"authentication failed or timed out"}}\n');
    setImmediate(() => handle.emit("close", accept ? 0 : 1));
  });
  return handle;
}

test("Antigravity's Google link reaches the panel from stderr, and the pasted code reaches the same process", async () => {
  const handle = fakeAgy();
  const { steps, record } = recorder(2);
  const result = await processRuntimeLogin(session(), { open: async () => handle, record, workerId: "w", codePollMs: 1, login: antigravityLogin });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(handle.received, ["abcdefgh#ijklmnop\n"]);
  assert.deepEqual(steps.filter((s) => s !== "take_code"), [`url:${GOOGLE_URL}`, "succeeded"]);
});

test("an Antigravity already signed in answers without a link, and the sign-in succeeds at once", async () => {
  const handle = fakeAgy({ signedIn: true });
  const { steps, record } = recorder(Infinity);
  const result = await processRuntimeLogin(session(), { open: async () => handle, record, workerId: "w", codePollMs: 1, login: antigravityLogin });
  assert.deepEqual(result, { status: "succeeded", already: true });
  assert.deepEqual(steps, ["succeeded"]);
  assert.deepEqual(handle.received, []);
});

test("a code Google refuses ends Antigravity's sign-in as failed, naming the runtime", async () => {
  const { steps, record } = recorder(0);
  const result = await processRuntimeLogin(session(), { open: async () => fakeAgy({ accept: false }), record, workerId: "w", codePollMs: 1, login: antigravityLogin });
  assert.equal(result.status, "failed");
  assert.match(result.error, /^Antigravity did not accept the code/);
  assert.ok(steps.at(-1).startsWith("failed:"));
});

test("Antigravity's minute for the code is the deadline, even inside the session's fifteen", async () => {
  const handle = fakeAgy();
  const { steps, record } = recorder(Infinity);
  let clock = Date.now();
  // The clock moves a third of a minute per poll once the link is shown.
  const shown = () => steps.some((step) => step.startsWith("url:"));
  const result = await processRuntimeLogin({ id: "s1", expires_at: new Date(clock + 15 * 60_000).toISOString() }, {
    open: async () => handle, record, workerId: "w", codePollMs: 1, login: antigravityLogin,
    now: () => clock, sleep: async () => { if (shown()) clock += 20_000; else await new Promise((resolve) => setTimeout(resolve, 2)); },
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /waits 60 seconds for the code/);
  assert.deepEqual(handle.received, []);
});
