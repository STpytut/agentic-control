// Codex/ChatGPT account broker.
//
// The web process can request device authorization and read safe status
// metadata, but it never talks to app-server and never receives native account
// tokens. This worker reaches app-server only through the Runtime Supervisor's
// account-only protocol channel, running as codex-worker against its native
// CODEX_HOME credential store.

import { isMain } from "./entrypoint.mjs";
import readline from "node:readline";
import { queryJson, closePool } from "./db.mjs";
import { RuntimeSupervisorClient, cancelThrough, retryWhileRuntimeBusy } from "../runtime-supervisor/client.mjs";
import { redactError, runPollLoop, shutdownSignal } from "./worker-loop.mjs";
import { codexRateLimits } from "../runtime-supervisor/usage-limits.mjs";

const workerId = process.env.CODEX_ACCOUNT_WORKER_ID ?? `codex-account-worker-${process.pid}`;
const pollMs = Number(process.env.CODEX_ACCOUNT_POLL_MS ?? 60_000);
// How often an idle ChatGPT connection's windows are read (Stage 12). A run's
// own stream keeps them current while it runs, and then nothing is due.
const usageReadMs = Math.max(Number(process.env.CODEX_USAGE_READ_MS ?? 5 * 60_000), 60_000);

// The redaction and the bounds live in worker-loop.mjs; this names the
// fallback sentence for this service.
const safeError = (error, fallback = "Codex account operation failed.", transientValues = []) =>
  redactError(error, fallback, transientValues);

class AccountAppServer {
  constructor(processHandle) {
    this.processHandle = processHandle;
    this.pending = new Map();
    this.waiters = new Set();
    this.messages = [];
    this.nextId = 1;
    this.stderr = "";
    this.lines = readline.createInterface({ input: processHandle.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    processHandle.stderr.setEncoding("utf8");
    processHandle.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    processHandle.once("close", (code, signal) => {
      this.failAll(new Error(`Codex account app-server closed (code=${code}, signal=${signal})`));
    });
  }

  send(message) {
    this.processHandle.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    const message = params === undefined ? { method, id } : { method, id, params };
    this.send(message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
    });
  }

  waitFor(predicate, description, timeoutMs) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${description}`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    this.messages.push(message);
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(String(message.id));
        if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  close() {
    this.lines.close();
    this.processHandle.stdin.end();
  }
}

async function openAccountSession(leaseExpiresAt = null) {
  const supervisor = new RuntimeSupervisorClient();
  await supervisor.connect();
  // Opened before the session exists, so the close has to be arranged here.
  // Every failure between `connect` and the session being handed over — a
  // refused admission is the ordinary one — used to leave the socket open: in
  // `once` mode that alone can keep the process alive, and in a long-running
  // worker they accumulate.
  let processHandle;
  try {
    processHandle = await retryWhileRuntimeBusy(
      () => supervisor.open({ runtime: "codex", surface: "account" }),
      { leaseExpiresAt,
        onExpiry: () => cancelThrough(supervisor),
        onWait: ({ attempt, remainingMs }) => process.stderr.write(`${JSON.stringify({
        type: "codex-account.waiting-for-runtime", attempt, remaining_ms: remainingMs,
      })}\n`) },
    );
  } catch (error) {
    supervisor.close();
    throw error;
  }
  const appServer = new AccountAppServer(processHandle);
  try {
    await appServer.request("initialize", {
      clientInfo: {
        name: "infra_cod",
        title: "infra_cod Codex account broker",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    appServer.send({ method: "initialized" });
    return { supervisor, appServer };
  } catch (error) {
    appServer.close();
    supervisor.close();
    throw error;
  }
}

function accountMetadata(response) {
  const account = response?.account;
  if (!account || account.type !== "chatgpt") {
    throw new Error("Codex native credential store is not authenticated with ChatGPT.");
  }
  return {
    accountLabel: String(account.email ?? ""),
    planType: String(account.planType ?? "unknown"),
  };
}

async function processLogin(item, leaseExpiresAt = null) {
  let session;
  let loginId = "";
  let userCode = "";
  try {
    session = await openAccountSession(leaseExpiresAt);
    const result = await session.appServer.request(
      "account/login/start",
      { type: "chatgptDeviceCode" },
      60_000,
    );
    if (
      result?.type !== "chatgptDeviceCode"
      || !result.loginId
      || !result.verificationUrl
      || !result.userCode
    ) {
      throw new Error("Codex app-server returned an invalid device authorization response.");
    }
    loginId = String(result.loginId);
    userCode = String(result.userCode);
    await queryJson(
      `SELECT publish_codex_device_code(
        :'session_id'::uuid,:'worker_id',:'login_id',:'verification_url',:'user_code'
      )::text;`,
      {
        session_id: item.session_id,
        worker_id: workerId,
        login_id: loginId,
        verification_url: String(result.verificationUrl),
        user_code: userCode,
      },
    );
    const remainingMs = Math.max(
      1000,
      Math.min(16 * 60_000, new Date(item.expires_at).getTime() - Date.now()),
    );
    const completed = await session.appServer.waitFor(
      (message) => message.method === "account/login/completed"
        && message.params?.loginId === loginId,
      `account/login/completed for ${loginId}`,
      remainingMs,
    );
    if (!completed.params?.success) {
      throw new Error(completed.params?.error || "Codex device authorization was not completed.");
    }
    const metadata = accountMetadata(
      await session.appServer.request("account/read", { refreshToken: false }),
    );
    return await queryJson(
      `SELECT complete_codex_device_login(
        :'session_id'::uuid,:'worker_id',:'account_label',:'plan_type'
      )::text;`,
      {
        session_id: item.session_id,
        worker_id: workerId,
        account_label: metadata.accountLabel,
        plan_type: metadata.planType,
      },
    );
  } catch (error) {
    if (session && loginId) {
      await session.appServer.request(
        "account/login/cancel",
        { loginId },
        5000,
      ).catch(() => undefined);
    }
    const message = safeError(
      error,
      "Codex device authorization failed.",
      [loginId, userCode],
    );
    // An outcome nobody knows is not a failure.
    //
    // The lease ran out mid-call and the work could not be confirmed stopped, so
    // it may have succeeded a moment before the connection went. Writing a
    // terminal failure for that records a lie about the operator's account —
    // and the reviewer's reproduction showed exactly this: the connection
    // closed, the effect completed, and the worker still called `fail_*`.
    //
    // The claim is left to lapse instead. Nothing is recorded, and the next
    // reader sees the state the runtime is actually in.
    if (error.outcomeUnknown === true || error.cancelled === true) {
      await queryJson(`SELECT defer_codex_login_session(:'session_id'::uuid,:'worker_id')::text;`,
        { session_id: item.session_id, worker_id: workerId }).catch(() => undefined);
      process.stderr.write(`${JSON.stringify({
        type: "codex-account.deferred", session_id: item.session_id,
        outcome: error.cancelled ? "cancelled" : "unknown", reason: message,
      })}\n`);
      return { session_id: item.session_id, status: "deferred", failure_code: null };
    }

    const code = /timed out|expired/i.test(message)
      ? "device_code_expired"
      : /not authenticated/i.test(message)
        ? "not_authenticated"
        : "codex_login_failed";
    try {
      return await queryJson(
        `SELECT fail_codex_device_login(
          :'session_id'::uuid,:'worker_id',:'failure_code',:'failure_message'
        )::text;`,
        {
          session_id: item.session_id,
          worker_id: workerId,
          failure_code: code,
          failure_message: message,
        },
      );
    } catch {
      return { session_id: item.session_id, status: "lease_lost", failure_code: code };
    }
  } finally {
    session?.appServer.close();
    session?.supervisor.close();
  }
}

async function processConnectionWork(item, leaseExpiresAt = null) {
  let session;
  try {
    session = await openAccountSession(leaseExpiresAt);
    if (item.work_kind === "disconnect") {
      await session.appServer.request("account/logout", undefined, 30_000);
      return await queryJson(
        `SELECT complete_codex_connection_work(
          :'connection_id'::uuid,:'worker_id','',''
        )::text;`,
        { connection_id: item.connection_id, worker_id: workerId },
      );
    }
    if (item.work_kind !== "verify") throw new Error("Unsupported Codex account work kind.");
    const metadata = accountMetadata(
      await session.appServer.request("account/read", { refreshToken: true }),
    );
    return await queryJson(
      `SELECT complete_codex_connection_work(
        :'connection_id'::uuid,:'worker_id',:'account_label',:'plan_type'
      )::text;`,
      {
        connection_id: item.connection_id,
        worker_id: workerId,
        account_label: metadata.accountLabel,
        plan_type: metadata.planType,
      },
    );
  } catch (error) {
    const message = safeError(error);
    // An outcome nobody knows is not a failure.
    //
    // The lease ran out mid-call and the work could not be confirmed stopped, so
    // it may have succeeded a moment before the connection went. Writing a
    // terminal failure for that records a lie about the operator's account —
    // and the reviewer's reproduction showed exactly this: the connection
    // closed, the effect completed, and the worker still called `fail_*`.
    //
    // The claim is left to lapse instead. Nothing is recorded, and the next
    // reader sees the state the runtime is actually in.
    if (error.outcomeUnknown === true || error.cancelled === true) {
      await queryJson(`SELECT defer_provider_connection_work(:'connection_id'::uuid,:'worker_id')::text;`,
        { connection_id: item.connection_id, worker_id: workerId }).catch(() => undefined);
      process.stderr.write(`${JSON.stringify({
        type: "codex-account.deferred", connection_id: item.connection_id,
        outcome: error.cancelled ? "cancelled" : "unknown", reason: message,
      })}\n`);
      return { connection_id: item.connection_id, status: "deferred", failure_code: null };
    }

    const code = /not authenticated|requires.*auth/i.test(message)
      ? "not_authenticated"
      : "codex_account_error";
    try {
      return await queryJson(
        `SELECT fail_codex_connection_work(
          :'connection_id'::uuid,:'worker_id',:'failure_code',:'failure_message'
        )::text;`,
        {
          connection_id: item.connection_id,
          worker_id: workerId,
          failure_code: code,
          failure_message: message,
        },
      );
    } catch {
      return { connection_id: item.connection_id, status: "lease_lost", failure_code: code };
    }
  } finally {
    session?.appServer.close();
    session?.supervisor.close();
  }
}

// The subscription's windows for the panel (Stage 12), read with
// account/rateLimits/read — no model call, and nothing of the credential leaves
// the runtime's user — for the ChatGPT connections nobody has read for five
// minutes. At most one attempt per interval, whatever it found: a runtime that
// is busy or signed out is not asked again at every poll. The channel is opened
// once, not waited for; a run in progress reports the windows itself.
let lastUsageRead = 0;
export async function readUsageWindows({ now = Date.now() } = {}) {
  if (now - lastUsageRead < usageReadMs) return null;
  const due = await queryJson(`SELECT codex_usage_reads_due(:'every'::interval)::text;`,
    { every: `${Math.round(usageReadMs / 1000)} seconds` });
  if (!Array.isArray(due) || !due.length) return null;
  lastUsageRead = now;
  const supervisor = new RuntimeSupervisorClient();
  await supervisor.connect();
  let appServer = null;
  try {
    appServer = new AccountAppServer(await supervisor.open({ runtime: "codex", surface: "account" }));
    await appServer.request("initialize", {
      clientInfo: { name: "infra_cod", title: "infra_cod Codex usage windows", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, 30_000);
    appServer.send({ method: "initialized" });
    const reading = codexRateLimits(await appServer.request("account/rateLimits/read", undefined, 30_000));
    if (!reading) return { kind: "usage_read", status: "nothing_usable" };
    for (const item of due) {
      await queryJson(`SELECT record_provider_usage_reading(:'connection_id'::uuid,'runtime_read',:'reading'::jsonb)::text;`,
        { connection_id: item.connection_id, reading: JSON.stringify(reading) });
    }
    return { kind: "usage_read", status: "recorded", connections: due.length };
  } finally {
    appServer?.close();
    supervisor.close();
  }
}

// The lease comes from the claim, as an absolute moment the database computed —
// not `Date.now()` plus the interval we asked for, measured after the answer
// arrived.

export async function runOnce() {
  const results = [];
  const loginWork = await queryJson(
    `SELECT claim_codex_login_sessions(:'worker_id',1,interval '16 minutes')::text;`,
    { worker_id: workerId },
  );
  for (const item of Array.isArray(loginWork) ? loginWork : []) {
    // Whichever runs out first: the lease the database granted, or the device
    // code the operator is typing in.
    const lease = item.lease_expires_at ?? null;
    const bound = item.expires_at && lease && new Date(item.expires_at) < new Date(lease)
      ? item.expires_at
      : lease;
    results.push({ kind: "login", result: await processLogin(item, bound) });
  }
  const connectionWork = await queryJson(
    `SELECT claim_codex_connection_work(:'worker_id',3,interval '90 seconds')::text;`,
    { worker_id: workerId },
  );
  for (const item of Array.isArray(connectionWork) ? connectionWork : []) {
    results.push({ kind: item.work_kind, result: await processConnectionWork(item, item.lease_expires_at) });
  }
  // Last, and never in the way of a login: a failure here is logged and the
  // next interval tries again.
  try {
    const usage = await readUsageWindows();
    if (usage) results.push(usage);
  } catch (error) {
    results.push({ kind: "usage_read", status: "failed", error: safeError(error, "The usage windows could not be read.") });
  }
  return results;
}

async function main() {
  if (process.argv[2] === "once") {
    process.stdout.write(`${JSON.stringify({
      type: "codex-account-broker.once",
      results: await runOnce(),
    })}\n`);
    return;
  }
  await runPollLoop({
    name: "codex-account-broker", pollMs, signal: shutdownSignal(),
    fallbackMessage: "Codex account operation failed.",
    tick: async () => {
      const results = await runOnce();
      return results.length ? results : undefined;
    },
  });
}

if (isMain(import.meta.url)) {
  try { await main(); } finally { await closePool(); }
}
