// OpenCode account broker.
//
// The web process never sees an OpenCode Go API key: the browser encrypts it
// into a hybrid envelope with the VPS broker's public key and only ciphertext
// reaches PostgreSQL. This worker claims the enrollment, decrypts the key on
// the VPS with the broker private key, hands it to the official `opencode` auth
// flow over stdin (through the Runtime Supervisor), verifies the connection and
// scrubs every buffer. The plaintext key never appears in argv, environment,
// database, events, journal or chat.

import { isMain } from "./entrypoint.mjs";
import { readFileSync } from "node:fs";
import { constants, createDecipheriv, privateDecrypt } from "node:crypto";
import { queryJson, closePool } from "./db.mjs";
import { RuntimeSupervisorClient, cancelThrough, retryWhileRuntimeBusy } from "../runtime-supervisor/client.mjs";
import { openCodeProviderFor } from "../runtime-supervisor/opencode-account-channel.mjs";
import { redactError, runPollLoop, shutdownSignal } from "./worker-loop.mjs";

const workerId = process.env.OPENCODE_ACCOUNT_WORKER_ID ?? `opencode-account-worker-${process.pid}`;
const pollMs = Number(process.env.OPENCODE_ACCOUNT_POLL_MS ?? 60_000);
const privateKeyPath = process.env.OPENCODE_BROKER_PRIVATE_KEY_PATH ?? "/etc/infra-cod/opencode/broker-private.pem";

// The redaction and the bounds live in worker-loop.mjs; this names the
// fallback sentence for this service.
const safeError = (error, fallback = "OpenCode account operation failed.", transientValues = []) =>
  redactError(error, fallback, transientValues);

function brokerPrivateKey() {
  return readFileSync(privateKeyPath, "utf8");
}

function decryptEnvelope(envelope) {
  const aesKey = privateDecrypt(
    { key: brokerPrivateKey(), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(envelope.key_wrap, "base64"),
  );
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      aesKey,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } finally {
    aesKey.fill(0);
  }
}

// The supervisor names the account of the provider it was asked about.
function accountLabelFromStatus(output) {
  try {
    const status = JSON.parse(output);
    return status.connected ? String(status.account_label ?? "") : "";
  } catch {
    return "";
  }
}

async function openAccountSession() {
  const supervisor = new RuntimeSupervisorClient();
  await supervisor.connect();
  return supervisor;
}

async function processEnrollment(item, leaseExpiresAt = null) {
  let key = null;
  let supervisor = null;
  try {
    supervisor = await openAccountSession();
    key = decryptEnvelope(item);
    // The provider is the enrollment's gateway's, not anything the browser sent.
    const provider = openCodeProviderFor(item.access_gateway);
    const login = await retryWhileRuntimeBusy(() => supervisor.account({ runtime: "opencode", operation: "login", provider, key }), { leaseExpiresAt, onExpiry: () => cancelThrough(supervisor) });
    if (login?.exit_code !== 0) {
      throw new Error(`opencode login exited ${login?.exit_code ?? "unknown"}: ${login?.stderr || login?.stdout || ""}`);
    }
    const status = await retryWhileRuntimeBusy(() => supervisor.account({ runtime: "opencode", operation: "status", provider }), { leaseExpiresAt, onExpiry: () => cancelThrough(supervisor) });
    if (status?.exit_code !== 0) {
      throw new Error(`OpenCode ${provider} verification exited ${status?.exit_code ?? "unknown"}`);
    }
    const accountLabel = accountLabelFromStatus(status?.stdout ?? "");
    return await queryJson(
      `SELECT complete_opencode_enrollment(
        :'enrollment_id'::uuid,:'worker_id',:'account_label'
      )::text;`,
      { enrollment_id: item.enrollment_id, worker_id: workerId, account_label: accountLabel },
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
    // Handed back, not failed. `defer_*` returns the work to the state a claim
    // selects; leaving the lease to lapse did not, because an enrollment stays
    // `claimed` and the picker only takes `provisioned`.
    if (error.outcomeUnknown === true || error.cancelled === true) {
      await queryJson(`SELECT defer_opencode_enrollment(:'enrollment_id'::uuid,:'worker_id')::text;`,
        { enrollment_id: item.enrollment_id, worker_id: workerId }).catch(() => undefined);
      process.stderr.write(`${JSON.stringify({
        type: "opencode-account.deferred", enrollment_id: item.enrollment_id,
        outcome: error.cancelled ? "cancelled" : "unknown", reason: message,
      })}\n`);
      return { enrollment_id: item.enrollment_id, status: "deferred", failure_code: null };
    }

    const code = /not authenticated|requires.*auth|invalid.*key|revoked/i.test(message)
      ? "invalid_api_key"
      : "opencode_enrollment_failed";
    try {
      return await queryJson(
        `SELECT fail_opencode_enrollment(
          :'enrollment_id'::uuid,:'worker_id',:'failure_code',:'failure_message'
        )::text;`,
        {
          enrollment_id: item.enrollment_id,
          worker_id: workerId,
          failure_code: code,
          failure_message: message,
        },
      );
    } catch {
      return { enrollment_id: item.enrollment_id, status: "lease_lost", failure_code: code };
    }
  } finally {
    if (key) key = null;
    supervisor?.close();
  }
}

async function processConnectionWork(item, leaseExpiresAt = null) {
  let supervisor = null;
  try {
    supervisor = await openAccountSession();
    const provider = openCodeProviderFor(item.access_gateway);
    if (item.work_kind === "disconnect") {
      await retryWhileRuntimeBusy(() => supervisor.account({ runtime: "opencode", operation: "logout", provider }), { leaseExpiresAt, onExpiry: () => cancelThrough(supervisor) });
      return await queryJson(
        `SELECT complete_opencode_connection_work(
          :'connection_id'::uuid,:'worker_id',''
        )::text;`,
        { connection_id: item.connection_id, worker_id: workerId },
      );
    }
    if (item.work_kind !== "verify") throw new Error("Unsupported OpenCode account work kind.");
    const status = await retryWhileRuntimeBusy(() => supervisor.account({ runtime: "opencode", operation: "status", provider }), { leaseExpiresAt, onExpiry: () => cancelThrough(supervisor) });
    if (status?.exit_code !== 0) {
      throw new Error(`opencode status exited ${status?.exit_code ?? "unknown"}`);
    }
    const accountLabel = accountLabelFromStatus(status?.stdout ?? "");
    return await queryJson(
      `SELECT complete_opencode_connection_work(
        :'connection_id'::uuid,:'worker_id',:'account_label'
      )::text;`,
      { connection_id: item.connection_id, worker_id: workerId, account_label: accountLabel },
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
        type: "opencode-account.deferred", connection_id: item.connection_id,
        outcome: error.cancelled ? "cancelled" : "unknown", reason: message,
      })}\n`);
      return { connection_id: item.connection_id, status: "deferred", failure_code: null };
    }

    const code = /not authenticated|requires.*auth|revoked/i.test(message)
      ? "key_revoked"
      : "opencode_account_error";
    try {
      return await queryJson(
        `SELECT fail_opencode_connection_work(
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
    supervisor?.close();
  }
}

// The lease comes from the claim, as an absolute moment the database computed.
//
// It used to be `Date.now()` plus the interval we had asked for, taken after the
// claim returned: the response time went uncounted and the worker's clock stood
// in for the database's. Both extend the worker's authority silently.

// OpenCode Go's subscription windows for the panel (ADR-0019): the supervisor
// runs the release's probe as opencode-worker, which reads the Go key itself;
// what comes back is a schema-checked line of numbers. At most one attempt per
// interval, for the connected Go connections nobody has read in that time.
const goUsageReadMs = Number(process.env.OPENCODE_GO_USAGE_READ_MS ?? 5 * 60_000);
let lastGoUsageRead = 0;
export async function readGoUsage({ now = Date.now(), connect = null } = {}) {
  if (now - lastGoUsageRead < goUsageReadMs) return null;
  const due = await queryJson(`SELECT opencode_go_usage_reads_due(:'every'::interval)::text;`,
    { every: `${Math.round(goUsageReadMs / 1000)} seconds` });
  if (!Array.isArray(due) || !due.length) return null;
  lastGoUsageRead = now;
  const supervisor = connect ? await connect() : new RuntimeSupervisorClient();
  if (!connect) await supervisor.connect();
  try {
    const answer = await supervisor.probeProviderUsage();
    if (answer?.status !== "recorded" || !answer.reading) return { kind: "go_usage", status: answer?.status ?? "no_answer" };
    for (const item of due) {
      await queryJson(`SELECT record_provider_usage_reading(:'connection_id'::uuid,'probe',:'reading'::jsonb)::text;`,
        { connection_id: item.connection_id, reading: JSON.stringify(answer.reading) });
    }
    return { kind: "go_usage", status: "recorded", connections: due.length };
  } finally {
    supervisor.close();
  }
}

export async function runOnce() {
  const results = [];
  const goUsage = await readGoUsage().catch((error) => ({ kind: "go_usage", status: "failed", error: safeError(error) }));
  if (goUsage) results.push(goUsage);
  const enrollmentWork = await queryJson(
    `SELECT claim_opencode_enrollments(:'worker_id',1,interval '90 seconds')::text;`,
    { worker_id: workerId },
  );
  for (const item of Array.isArray(enrollmentWork) ? enrollmentWork : []) {
    results.push({ kind: "enrollment", result: await processEnrollment(item, item.lease_expires_at) });
  }
  const connectionWork = await queryJson(
    `SELECT claim_opencode_connection_work(:'worker_id',3,interval '90 seconds')::text;`,
    { worker_id: workerId },
  );
  for (const item of Array.isArray(connectionWork) ? connectionWork : []) {
    results.push({ kind: item.work_kind, result: await processConnectionWork(item, item.lease_expires_at) });
  }
  return results;
}

async function main() {
  if (process.argv[2] === "once") {
    process.stdout.write(`${JSON.stringify({
      type: "opencode-account-broker.once",
      results: await runOnce(),
    })}\n`);
    return;
  }
  await runPollLoop({
    name: "opencode-account-broker", pollMs, signal: shutdownSignal(),
    fallbackMessage: "OpenCode account operation failed.",
    tick: async () => {
      const results = await runOnce();
      return results.length ? results : undefined;
    },
  });
}

if (isMain(import.meta.url)) {
  try { await main(); } finally { await closePool(); }
}
