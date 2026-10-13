// The Google Antigravity CLI driver, `agy` (rc.150).
//
// Driven as a batch, like Claude Code, whose headless interface it mirrors:
// `agy -p "<prompt>" --output-format stream-json`, one process per run, one
// JSON object per stdout line (`init`, `step_update`, `result`). A
// conversation is named by the runtime in its init event (`conversation_id`)
// and resumed by `--conversation <id>`.
//
// An analyst only (docs/ANTIGRAVITY.md). agy has no flag that adds an MCP
// server, so the platform's tools — the orchestrator's commands, an executor's
// reports — cannot reach it, and the two roles that need them stay closed. The
// analyst's run (0147) needs none: it reads a snapshot and answers once, held
// read-only by the kernel (the read-only launch) with its own state writable.
// There is no system-prompt flag either: a role's instructions head the prompt,
// as OpenCode's do, and nothing is invented for it.
//
// What this release does not hold back: agy downloads helper binaries at
// runtime into `~/.gemini/antigravity-cli/bin` (agentapi, webm_encoder) —
// inside its own writable state, outside the workspace. Doctor says when they
// are there; blocking them is a follow-up.
//
// Pure: both sides import it.

import { adapterFor } from "../../operations/runtime-adapters.mjs";
import { ANTIGRAVITY_LOGIN, antigravityAccountState, validateAntigravityAccountInput } from "../antigravity-account-channel.mjs";
import { ANALYST_REPORT_SCHEMA, renderAnalystReport } from "../analyst-report.mjs";
import { normalizeAntigravityEvent } from "../runtime-events.mjs";
import { launchReasoningLevel } from "./reasoning.mjs";

const adapter = adapterFor("antigravity");

// agy's effort levels, as `--help` lists them at 1.3.4. Whether a given model
// takes one is not known per model (some ids carry a level in their name,
// gemini-3.8-flash-high), so the catalog offers none yet: a level reaches a
// launch only when a member was given one, and then only one of these.
const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

// The sign-in (account surface): one headless prompt in the runtime's home.
// Signed out, agy prints the Google authorize link on stderr and reads the
// code from stdin; signed in, it answers and exits 0. Nothing of the workspace
// is involved — the cwd is the home — and the prompt asks for a word.
const LOGIN_PROMPT = "Reply with the single word OK and nothing else.";

// The native event kept with the normalised one; a step's type is in the
// event's summary (the tool's name, the response).
function normalizeEvent(raw) {
  const event = normalizeAntigravityEvent(raw);
  if (!event) return null;
  return { ...event, details: { ...event.details, native_type: String(raw.event).slice(0, 80) } };
}

function parse(line) {
  if (!line.trim()) return null;
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.event !== "string") return null;
  return { raw, event: normalizeEvent(raw) };
}

function objects(stdout) {
  return String(stdout ?? "").split("\n").map(parse).filter(Boolean).map((parsed) => parsed.raw);
}

const resultOf = (raws) => raws.findLast((raw) => raw.event === "result" && raw.result && typeof raw.result === "object")?.result ?? null;

// The turn's answer: a run held to the report's schema (an analyst's) answers
// with `structured_output`, rendered as the report; otherwise the result's
// response; otherwise what the agent wrote, joined from its deltas.
function answer(stdout) {
  const raws = objects(stdout);
  const result = resultOf(raws);
  const report = result && result.status === "SUCCESS" ? renderAnalystReport(result.structured_output) : "";
  if (report) return report;
  if (result?.status === "SUCCESS" && typeof result.response === "string") return result.response.trim();
  return raws.filter((raw) => raw.event === "step_update" && raw.step_update?.step_type === "agent_response")
    .map((raw) => String(raw.step_update.text_delta ?? "")).join("").trim();
}

// Why the run failed, when the stream or stderr says: "" for a run that
// succeeded. A model or agent error exits 3 and prints `AGY_ERROR: {json}` on
// stderr; a sign-in that failed or timed out ends with a result whose status
// is ERROR; a result other than SUCCESS carries its error.
const AGY_ERROR = /^AGY_ERROR:\s*(\S.*?)\s*$/m;
function failure(stdout, stderr = "") {
  const result = resultOf(objects(stdout));
  const agyError = AGY_ERROR.exec(String(stderr ?? ""));
  if (agyError) {
    let said = null;
    try { said = JSON.parse(agyError[1]); } catch {}
    const text = String(said?.message ?? said?.error ?? agyError[1]).trim().slice(0, 300);
    return `Antigravity ${/auth/i.test(text) ? "not signed in" : "failed"}: ${text}`.slice(0, 500);
  }
  if (!result) return "";
  if (result.status === "SUCCESS") return "";
  const text = String(result.error ?? result.response ?? "").trim().slice(0, 300);
  const cls = /authentication/i.test(text) ? "not signed in"
    : /rate limit|quota|429|too many requests/i.test(text) ? "rate limited"
      : /model/i.test(text) && /not (found|available)|unknown/i.test(text) ? "model not available"
        : "failed";
  return `Antigravity ${cls}${text ? `: ${text}` : ` (${String(result.status ?? "no status")})`}`.slice(0, 500);
}

// The model the run started with, as the init event names it.
function resolvedModel(raw) {
  if (raw?.event !== "init" || typeof raw.init?.model !== "string") return null;
  return raw.init.model.trim().slice(0, 200) || null;
}

const conversationId = (raw) => {
  for (const value of [raw?.conversation_id, raw?.result?.conversation_id, raw?.step_update?.conversation_id]) {
    if (typeof value === "string" && value.length > 0 && value.length <= 200) return value;
  }
  return null;
};

// `agy models`: one model per line, `id<TAB>Display name`.
export function parseAntigravityModels(stdout) {
  const models = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const [id, ...rest] = line.split("\t");
    const modelId = String(id ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(modelId) || models.some((model) => model.id === modelId)) continue;
    const displayName = rest.join(" ").replace(/[^\p{L}\p{N} .()/-]/gu, "").trim().slice(0, 100);
    models.push({ id: modelId, display_name: displayName || modelId });
    if (models.length >= 100) break;
  }
  return models;
}

const SURFACES = new Set(["consult", "gate", "account"]);

export const antigravityDriver = Object.freeze({
  name: "antigravity",
  executable: adapter.executable,

  verified: Object.freeze({
    adapterVersion: "1.0.0",
    runtimeVersion: "1.3.4",
    evidence: Object.freeze({
      "sessions.create": "spike on the host, agy 1.3.4 (2026-10-13): the init event carries conversation_id before the first step; antigravity-driver.test.mjs reads it",
      "sessions.resume": "spike on the host, agy 1.3.4: `--conversation <id>` continues a conversation from a new process; antigravity-driver.test.mjs builds it",
      "run.read_only": "spike on the host, agy 1.3.4: under the read-only launch with .gemini, .config/antigravity and .cache writable agy ran and a workspace write was EACCES",
      "stream.structured": "spike on the host, agy 1.3.4: `--output-format stream-json` with stdout redirected, one object per line; antigravity-driver.test.mjs parses the recorded shapes",
      "interrupt": "run-cgroup.test.mjs: the run's cgroup is killed whatever process group a helper is in",
      "events.raw": "antigravity-driver.test.mjs: every stdout line is parsed as { raw, event } with its native type",
      "usage.report": "antigravity-driver.test.mjs: the result event's usage becomes runtime.turn.usage tokens",
      "gate.smoke": "catalog-gate-worker.mjs: the batch smoke on the gate surface, like Claude Code's",
      "account.login": "spike on the host, agy 1.3.4: signed out, a headless run prints the accounts.google.com link on stderr and reads the code from stdin (60 s); the token lands in ~/.gemini/antigravity-cli/antigravity-oauth-token",
      "catalog.models": "spike on the host, agy 1.3.4: `agy models` lists `id<TAB>name` lines; antigravity-driver.test.mjs parses them",
    }),
  }),

  capabilities: Object.freeze({
    "sessions.create": { by: "sessions", native: "the init event's conversation_id, before the first step" },
    "sessions.resume": { by: "sessions", native: "`--conversation <id>`" },
    "run.read_only": { by: "run", native: "`-p` under a Landlock ruleset: the snapshot readable, only the runtime's own state writable" },
    "stream.structured": { by: "stream", native: "`--output-format stream-json`, one object per line: init, step_update, result" },
    "interrupt": { by: "interrupt", native: "the run's cgroup: SIGTERM, then cgroup.kill" },
    "events.raw": { by: "normalizeEvent", native: "each object kept with its event as native_type" },
    "usage.report": { by: "normalizeEvent", native: "the result event's usage" },
    "gate.smoke": { by: "run", native: "the gate surface: a batch run in a scratch workspace" },
    "account.login": { by: "input", native: "a headless prompt in the home: the Google authorize link on stderr, the pasted code on stdin" },
    "catalog.models": { by: "input", native: "`agy models`, one `id<TAB>name` line per model (the driver's `catalog` member)" },
  }),

  surfaces: Object.freeze({
    // An analyst's run (0147): the snapshot read, nothing written, answered
    // once in the report's shape.
    consult: Object.freeze({ transport: "batch", workspace: "snapshot", capability: "run.read_only" }),
    gate: Object.freeze({ transport: "batch", workspace: "gate", capability: "gate.smoke" }),
    // The sign-in from the panel, in the runtime's own home.
    account: Object.freeze({ transport: "channel", workspace: "home", capability: "account.login" }),
  }),

  sessions: Object.freeze({
    // Named by the runtime: the supervisor reads it from the init event.
    args: (sessionId) => (sessionId ? ["--conversation", sessionId] : []),
    idFromEvent: conversationId,
  }),

  run: Object.freeze({
    // `-p <prompt>` first, as the spike ran it, then the options. A role's
    // instructions (rc.143) head the prompt: agy keeps no system prompt of the
    // platform's. --effort only when the member has a level. An analyst's
    // answer is held to the report's shape (`--json-schema`, parsed by agy
    // into result.structured_output), and the prompt's slash commands are off:
    // a snapshot nobody vetted is what the run reads.
    argv: ({ model, sessionId = null, prompt, surface = "gate", reasoningEffort = null, systemPrompt = null }) => {
      if (!SURFACES.has(surface)) throw new Error(`Antigravity has no ${JSON.stringify(surface)} surface`);
      if (surface === "account") return ["-p", LOGIN_PROMPT, "--output-format", "stream-json", "--disable-slash-commands"];
      const effort = launchReasoningLevel(antigravityDriver, reasoningEffort);
      const text = systemPrompt && surface === "consult" ? `${systemPrompt}\n\n${prompt}` : prompt;
      return [
        "-p", text, "--output-format", "stream-json", "--model", model,
        ...antigravityDriver.sessions.args(sessionId),
        ...(effort ? ["--effort", effort] : []),
        ...(surface === "consult" ? ["--json-schema", JSON.stringify(ANALYST_REPORT_SCHEMA), "--disable-slash-commands"] : []),
      ];
    },
    // Nothing of the adapter's travels in the environment: the self-update
    // control is the directory (runtime-adapters.mjs), and no tool bridge runs.
    environment: ({ toolBridge = [] } = {}) => [...toolBridge],
    readOnlyWritable: Object.freeze([...adapter.writableState, "/tmp", "/dev/null"]),
    // The flags these launches pass; a candidate whose `--help` lacks one
    // fails qualification (config.keys) instead of failing runs once promoted.
    flags: Object.freeze(["--print", "--output-format", "--model", "--conversation", "--effort", "--json-schema", "--disable-slash-commands"]),
    // The catalog holds agy's own ids.
    qualifyModel: (_provider, model) => model,
  }),

  stream: Object.freeze({
    framing: "jsonl",
    parse,
    answer,
    failure,
    resolvedModel,
  }),

  reasoning: Object.freeze({
    applied: "`--effort <level>` per process, one process per run; not persisted",
    levels: EFFORT_LEVELS,
    accepts: (level) => EFFORT_LEVELS.includes(level),
    discovery: "none: `agy --help` lists the levels; which models take one is not known per model, and the catalog offers none yet",
    source: "agy --help at 1.3.4 (--effort low|medium|high|xhigh|max)",
    verifiedAgainst: "1.3.4 (the host, 2026-10-13)",
  }),

  input: Object.freeze({
    // A run takes no stdin. The sign-in takes one line: the code. agy does
    // take `--input-format stream-json`, but the surface it would serve (an
    // executor's live input, rc.146) is not one this runtime has.
    channelState: (surface) => (surface === "account" ? antigravityAccountState() : null),
    validate: (surface, data, state) => {
      if (surface === "account") return validateAntigravityAccountInput(data, state);
      throw new Error(`Antigravity has no channel on its ${surface} surface`);
    },
    observes: () => false,
    login: ANTIGRAVITY_LOGIN,
  }),

  // The model list, read by the supervisor as the runtime's user and by a
  // qualification from the candidate's executable.
  catalog: Object.freeze({
    argv: Object.freeze(["models"]),
    parse: parseAntigravityModels,
  }),

  interrupt: Object.freeze({
    mechanism: "cgroup",
    // The sign-in channel runs no turn: it ends with its cgroup.
    channel: "cgroup",
  }),

  // No bridge: no tool of the platform's reaches this runtime (see the top).
  toolBridge: Object.freeze({
    transport: "none",
    tools: Object.freeze([]),
    platformTools: Object.freeze([]),
    environment: () => [],
  }),

  normalizeEvent,
});
