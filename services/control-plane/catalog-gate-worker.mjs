// The model check lane (Stage 12 W6; docs/RUNTIMES_AND_MODELS_DESIGN.md §2.4,
// §2.6, §2.8, decisions R2, R4, R5). It replaced the capability gate in this
// file, and keeps its unit, its user and its scratch root.
//
// A model check is one short turn at the model — "Reply with exactly the word
// PARITY_OK" — through the runtime's gate surface, in a scratch workspace under
// RUNTIME_GATE_WORKSPACE_ROOT, against the exact (connection, provider, model)
// at the active runtime version. It proves the credential reaches the
// provider, the plan includes the model, the runtime accepts the id and its
// stream parses, and for Claude which model the alias resolved to. What the
// old gate also proved — interrupt, resume, streaming — belongs to the runtime
// version and is proven once per version by its qualification (R4), so a
// check is one model call instead of two.
//
// The lane is its own: one check at a time for the host, claimed from
// model_checks in the order pick, pin and check again, in-use, whole small
// lists (claim_model_checks). It is woken by NOTIFY model_checks within a
// second of a check being asked for; the 60 s poll is the fallback, and each
// poll also asks the database for the automatic checks that are due. A check
// is a background run: the supervisor admits it only with room left for a task
// run after it (runtime-capacity.mjs), and a refusal for memory is handed back
// as "waiting: memory", costing nothing.
//
// Before an automatic check on a Codex connection the subscription's windows
// are read through the account channel (account/rateLimits/read, no model
// call); above 80 % of the primary window the check waits for the window.
// Claude's window is not read — that would need its token outside the runtime —
// so a limit answer there is inconclusive and backs off like any other.

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { queryJson, closePool, listen } from "./db.mjs";
import { isMain } from "./entrypoint.mjs";
import { RuntimeSupervisorClient, cancelThrough, retryWhileRuntimeBusy } from "../runtime-supervisor/client.mjs";
import { CodexGateSession } from "./codex-gate-session.mjs";
import { parseGateThreadResult, parseGateTurnResult, parseGateTurnCompleted, collectGateAgentText } from "./codex-gate-transcript.mjs";
import { redactError, runPollLoop, shutdownSignal } from "./worker-loop.mjs";
import { createWake } from "./poll-wait.mjs";
import { INSTALLATION_LAYOUT } from "../operations/installation-layout.mjs";
import { assertCapability } from "../runtime-supervisor/drivers/capabilities.mjs";
import { driverFor } from "../runtime-supervisor/drivers/index.mjs";
import { CHECK_PROMPT, judgeError, judgeTurn, parseRateLimits, windowDeferral } from "./model-check-outcome.mjs";
import { codexRateLimits, summarizeUsage } from "../runtime-supervisor/usage-limits.mjs";

const workerId = process.env.CATALOG_GATE_WORKER_ID ?? `model-check-worker-${process.pid}`;
const pollMs = Number(process.env.CATALOG_GATE_POLL_MS ?? 60_000);
const gateRoot = process.env.RUNTIME_GATE_WORKSPACE_ROOT ?? INSTALLATION_LAYOUT.gateSmokeRoot.path;
const checkLease = process.env.CATALOG_GATE_LEASE ?? "10 minutes";
const turnTimeoutMs = Number(process.env.CATALOG_GATE_SMOKE_TIMEOUT_MS ?? 120_000);
// The hour (UTC) the month-old in-use checks are re-run at; "off" turns it off.
const quietHour = process.env.MODEL_CHECK_QUIET_HOUR === "off" ? null : Number(process.env.MODEL_CHECK_QUIET_HOUR ?? 4);
const codexWindowLimit = Number(process.env.MODEL_CHECK_CODEX_WINDOW_PERCENT ?? 80);
// One tick drains the queue up to this many checks, so a burst after a
// reconnect is not spread over minutes of polls.
const checksPerTick = Number(process.env.MODEL_CHECK_BATCH ?? 20);

const safeError = (error, fallback = "The model check failed.") => redactError(error, fallback);

function textInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}

function onWait(kind) {
  return ({ attempt, remainingMs }) => process.stderr.write(`${JSON.stringify({
    type: `model-check.waiting-for-${kind}`, attempt, remaining_ms: remainingMs,
  })}\n`);
}

// Codex: one thread, one turn, on the gate channel.
async function codexTurn(driver, check, workspace) {
  const supervisor = new RuntimeSupervisorClient();
  await supervisor.connect();
  let processHandle;
  try {
    processHandle = await retryWhileRuntimeBusy(
      () => supervisor.open({ runtime: driver.name, surface: "gate", gateWorkspace: workspace }),
      { leaseExpiresAt: check.lease_expires_at, onExpiry: () => cancelThrough(supervisor), onWait: onWait("runtime") },
    );
  } catch (error) {
    supervisor.close();
    throw error;
  }
  const session = new CodexGateSession(processHandle);
  try {
    await session.request("initialize", {
      clientInfo: { name: "infra_cod", title: "infra_cod model check", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, 30_000);
    session.send({ method: "initialized", params: {} });
    const threadId = parseGateThreadResult(await session.request("thread/start", { model: check.model_id }, 60_000));
    if (!threadId) return { answer: "", failure: "thread/start named no thread", exited: true };
    const turnId = parseGateTurnResult(await session.request("turn/start", { threadId, input: textInput(CHECK_PROMPT) }, 30_000));
    if (!turnId) return { answer: "", failure: "turn/start named no turn", exited: true };
    const completed = parseGateTurnCompleted(await session.waitFor((message) => {
      const parsed = parseGateTurnCompleted(message);
      return parsed !== null && parsed.threadId === threadId && parsed.turnId === turnId;
    }, "turn/completed", turnTimeoutMs));
    const answer = completed?.agentText || collectGateAgentText(session.messages, threadId, turnId);
    return { answer, failure: codexTurnFailure(session.messages, turnId, completed?.status), exited: false,
      usage: usageOf(driver, session.messages) };
  } finally {
    session.close();
    supervisor.close();
  }
}

// Why a Codex turn did not answer: a turn the provider refused completes with
// an error, which the app-server also sends as a notification of its own.
export function codexTurnFailure(messages, turnId, status) {
  const said = (Array.isArray(messages) ? messages : [])
    .map((message) => (message?.method === "error" ? message.params?.error?.message ?? message.params?.message : null)
      ?? (message?.method === "turn/completed" && message.params?.turn?.id === turnId ? message.params?.turn?.error?.message : null))
    .filter((text) => typeof text === "string" && text);
  if (said.length) return [...new Set(said)].join("; ");
  return status === "completed" ? "" : `the turn ended ${status ?? "without a status"}`;
}

// OpenCode and Claude Code: one batch run on the gate surface.
async function batchTurn(driver, check, workspace) {
  const supervisor = new RuntimeSupervisorClient();
  await supervisor.connect();
  try {
    // The driver's qualification of the id, as a task uses it: an OpenRouter id
    // carries a slash of its own and is not already qualified (rc.46).
    const run = await retryWhileRuntimeBusy(() => supervisor.run({
      runtime: driver.name, surface: "gate", gateWorkspace: workspace,
      model: driver.run.qualifyModel(check.provider_id, check.model_id), prompt: CHECK_PROMPT,
    }), { leaseExpiresAt: check.lease_expires_at, onExpiry: () => cancelThrough(supervisor), onWait: onWait("runtime") });
    return batchOutcome(driver, run);
  } finally {
    supervisor.close();
  }
}

// What a batch run said: its answer, what went wrong, and for Claude the model
// the alias resolved to.
export function batchOutcome(driver, run) {
  const stdout = typeof run?.stdout === "string" ? run.stdout : "";
  const answer = typeof driver.stream?.answer === "function" ? driver.stream.answer(stdout) : stdout;
  const stderrLine = run?.exit_code === 0 ? "" : String(run?.stderr ?? "").trim().split("\n").at(-1) ?? "";
  const failure = [driver.stream?.failure?.(stdout) ?? "", stderrLine].filter(Boolean).join(" — ");
  return {
    answer: String(answer ?? ""),
    failure, exited: run?.exit_code !== 0,
    resolved: typeof driver.stream?.resolvedModel === "function" ? resolvedModelOf(driver, stdout) : "",
    memoryMb: Number.isFinite(run?.memory?.sampled_peak_rss_mb) ? run.memory.sampled_peak_rss_mb : null,
    usage: usageOf(driver, stdout.split("\n").map((line) => driver.stream.parse(line)?.raw).filter(Boolean)),
  };
}

// What a check's turn used, from the same normalised events a task run's
// activity carries (Stage 12): counted as a check, apart from task runs.
export function usageOf(driver, rawEvents) {
  const events = (Array.isArray(rawEvents) ? rawEvents : []).map((raw) => {
    try { return driver.normalizeEvent(raw); } catch { return null; }
  }).filter(Boolean);
  return summarizeUsage(events);
}

// Best effort, while the check is held: accounting never decides a verdict.
async function recordCheckUsage(check, usage) {
  if (!usage || (!usage.steps && !usage.rate_limits)) return;
  try {
    await queryJson(`SELECT record_model_check_usage(:'check_id'::uuid,:'worker_id',:'usage'::jsonb,:'limits'::jsonb)::text;`, {
      check_id: check.check_id, worker_id: workerId,
      usage: JSON.stringify({ tokens: usage.tokens, cost: usage.cost ?? undefined, cost_basis: usage.cost_basis, steps: usage.steps }),
      limits: usage.rate_limits ? JSON.stringify(usage.rate_limits) : null,
    });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ type: "model-check.usage_unrecorded", check_id: check.check_id, error: safeError(error) })}\n`);
  }
}

// An alias names a family, not a model: the check records which model it
// resolved to, as the runtime's first event reported it — read by the driver,
// the same reading the supervisor gives a task run's stream.
function resolvedModelOf(driver, stdout) {
  for (const line of String(stdout ?? "").split("\n")) {
    const parsed = driver.stream.parse(line);
    const model = parsed ? driver.stream.resolvedModel(parsed.raw) : null;
    if (model) return model;
  }
  return "";
}

export function resolvedClaudeModel(stdout) {
  return resolvedModelOf(driverFor("claude"), stdout);
}

const TURNS = Object.freeze({ codex: codexTurn, opencode: batchTurn, claude: batchTurn });

// The subscription's windows, read at most every five minutes: every automatic
// Codex check of a reconnect would otherwise open the account channel again.
// The whole reading is kept too, for the panel's Limits (Stage 12).
let codexWindow = { at: 0, value: null, reading: null };
async function readCodexWindow() {
  if (Date.now() - codexWindow.at < 5 * 60_000) return codexWindow.value;
  const supervisor = new RuntimeSupervisorClient();
  await supervisor.connect();
  try {
    const handle = await supervisor.open({ runtime: "codex", surface: "account" });
    const session = new CodexGateSession(handle);
    try {
      await session.request("initialize", {
        clientInfo: { name: "infra_cod", title: "infra_cod model check", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      }, 30_000);
      session.send({ method: "initialized" });
      const result = await session.request("account/rateLimits/read", undefined, 30_000);
      const value = parseRateLimits(result);
      codexWindow = { at: Date.now(), value, reading: codexRateLimits(result) };
      return value;
    } finally {
      session.close();
    }
  } finally {
    supervisor.close();
  }
}

async function complete(check, verdict, extra = {}) {
  return await queryJson(
    `SELECT complete_model_check(:'check_id'::uuid,:'worker_id',:'result',:'failure_class',:'detail',:'resolved',:'memory'::integer,true)::text;`,
    { check_id: check.check_id, worker_id: workerId, result: verdict.result, failure_class: verdict.failureClass ?? null,
      detail: verdict.detail ?? "", resolved: extra.resolved ?? "", memory: extra.memoryMb ?? null },
  );
}

async function defer(check, detail, { modelCalled, retryAt = null }) {
  return await queryJson(
    `SELECT defer_model_check(:'check_id'::uuid,:'worker_id',:'detail',:'called'::boolean,:'retry_at'::timestamptz)::text;`,
    { check_id: check.check_id, worker_id: workerId, detail, called: String(Boolean(modelCalled)), retry_at: retryAt },
  );
}

// One check, start to verdict. Whatever happens, the check is left either
// with its verdict or handed back — never held until its lease runs out.
async function processCheck(check) {
  const driver = driverFor(check.runtime_type);
  if (check.automatic && driver.name === "codex") {
    let window = null;
    // A window that cannot be read is not a reason to hold every check: a
    // limit answer to the check itself is inconclusive and backs off.
    try { window = await readCodexWindow(); } catch (error) {
      process.stderr.write(`${JSON.stringify({ type: "model-check.window_unread", error: safeError(error) })}\n`);
    }
    // The same reading, as the connection's windows for the panel; a repeat
    // within ten minutes only moves its time.
    if (codexWindow.reading) {
      await queryJson(`SELECT record_provider_usage_reading(:'connection_id'::uuid,'runtime_read',:'reading'::jsonb,:'read_at'::timestamptz)::text;`,
        { connection_id: check.connection_id, reading: JSON.stringify(codexWindow.reading), read_at: new Date(codexWindow.at).toISOString() })
        .catch((error) => process.stderr.write(`${JSON.stringify({ type: "model-check.window_unrecorded", error: safeError(error) })}\n`));
    }
    const wait = windowDeferral(window, { limitPercent: codexWindowLimit });
    if (wait) return await defer(check, wait.detail, { modelCalled: false, retryAt: wait.retryAt });
  }
  const workspace = path.join(gateRoot, check.check_id);
  try {
    assertCapability(driver, "gate.smoke");
    const turn = TURNS[driver.name];
    if (!turn) throw new Error(`a model check is unsupported for runtime ${check.runtime_type}`);
    await mkdir(workspace, { recursive: true, mode: 0o2770 });
    const outcome = await turn(driver, check, workspace);
    await recordCheckUsage(check, outcome.usage);
    const verdict = judgeTurn(outcome);
    if (verdict.result === "inconclusive") return await defer(check, verdict.detail, { modelCalled: true });
    return await complete(check, verdict, outcome);
  } catch (error) {
    const verdict = judgeError(error);
    try {
      if (verdict.result === "wait") {
        return await defer(check, verdict.detail, { modelCalled: false, retryAt: new Date(Date.now() + verdict.retryMs).toISOString() });
      }
      if (verdict.result === "inconclusive") return await defer(check, verdict.detail, { modelCalled: true });
      return await complete(check, verdict);
    } catch (reportError) {
      // The lease went while the check ran: the next claim puts it back.
      return { check_id: check.check_id, status: "lease_lost", error: safeError(reportError) };
    }
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

async function checkOnce(signal = null) {
  const results = [];
  try {
    const due = await queryJson(`SELECT request_model_checks_due(:'hour'::integer, interval '30 days')::text;`,
      { hour: Number.isInteger(quietHour) ? quietHour : null });
    if (due?.queued || due?.aged) results.push({ kind: "model_checks_due", ...due });
  } catch (error) {
    results.push({ kind: "scheduler_failed", error: safeError(error) });
  }
  for (let i = 0; i < checksPerTick && !signal?.aborted; i += 1) {
    const claims = await queryJson(`SELECT claim_model_checks(:'worker_id',:'lease'::interval)::text;`,
      { worker_id: workerId, lease: checkLease });
    const check = Array.isArray(claims) ? claims[0] : null;
    if (!check) break;
    const result = await processCheck(check);
    results.push({ kind: "model_check", check_id: check.check_id, model_id: check.model_id, trigger: check.trigger, result });
  }
  return results;
}

// LISTEN, kept alive across database restarts: a listener that went away is
// replaced at the next tick, and meanwhile the poll still runs.
function keepListening(wake) {
  let handle = null;
  return async () => {
    if (handle && !handle.ended) return;
    try {
      handle = await listen("model_checks", () => wake.notify(), {
        onError: (error) => process.stderr.write(`${JSON.stringify({ type: "model-check.listen_lost", error: safeError(error) })}\n`),
      });
    } catch (error) {
      handle = null;
      process.stderr.write(`${JSON.stringify({ type: "model-check.listen_failed", error: safeError(error) })}\n`);
    }
  };
}

async function main() {
  if (process.argv.includes("once")) {
    const results = await checkOnce();
    process.stdout.write(`${JSON.stringify({ type: "model-check.once", results })}\n`);
    return;
  }
  const signal = shutdownSignal();
  const wake = createWake();
  const ensureListening = keepListening(wake);
  await runPollLoop({
    name: "model-check", pollMs, signal, wake,
    fallbackMessage: "The model check failed.",
    tick: async () => {
      await ensureListening();
      const results = await checkOnce(signal);
      return results.length ? results : undefined;
    },
  });
}

if (isMain(import.meta.url)) {
  main()
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ type: "model-check.fatal", error: safeError(error) })}\n`);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
