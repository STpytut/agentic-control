// The Claude Code runtime driver (Stage 11.6, sprint C K2).
//
// Driven as a batch, like OpenCode: `claude -p --output-format stream-json`,
// one process per turn, one JSON object per stdout line. The session is
// chosen by the supervisor and named on the first turn (`--session-id`), then
// resumed by that id (`--resume`); Claude Code keys it by the workspace path,
// which a project keeps. The platform's commands reach it as MCP tools served
// by claude-mcp/platform-bridge.mjs over the run's socket.
//
// An orchestrator's turn is held read-only three times: the kernel (the
// read-only launch, probe 08 on the host), the tool list (`--tools
// Read,Glob,Grep` takes Write, Edit and Bash out of the model's reach, probe
// 04), and the permission mode (`dontAsk` refuses whatever is not
// pre-approved). Since Stage 12 X1 it is an executor too: a task's run writes
// the workspace, and its Bash runs in the sandbox shell with the login covered
// (decision C2's reason, closed by M0). Nothing of the workspace's own
// configuration applies: `--setting-sources user` reads only the runtime
// user's settings, which this product owns, and `--strict-mcp-config` only the
// MCP server given here.
//
// Pure: both sides import it.

import { claudeAccountState, validateClaudeAccountInput } from "../claude-account-channel.mjs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { adapterFor } from "../../operations/runtime-adapters.mjs";
import { normalizeClaudeEvent } from "../runtime-events.mjs";
import { launchReasoningLevel } from "./reasoning.mjs";
import { PLATFORM_COMMAND_TOOL_NAMES, WORKER_REPORT_TOOLS } from "./tool-contracts.mjs";
import { sandboxShellEnvironment } from "../sandbox-shell.mjs";

const adapter = adapterFor("claude");

// The bridge of the release that launched the run, started by the Node that
// runs the supervisor: neither is a path this file guesses on the host.
const BRIDGE = fileURLToPath(new URL("../claude-mcp/platform-bridge.mjs", import.meta.url));
const MCP_SERVER = "platform";

// Claude Code names an MCP tool `mcp__<server>__<tool>`.
const PLATFORM_TOOLS = PLATFORM_COMMAND_TOOL_NAMES.map((name) => `mcp__${MCP_SERVER}__${name}`);
const REPORT_TOOLS = WORKER_REPORT_TOOLS.map((name) => `mcp__${MCP_SERVER}__${name}`);
const READ_TOOLS = "Read,Glob,Grep";
// An executor's tools (Stage 12 X1): it reads, edits, writes and runs commands
// in the workspace. Bash runs in the sandbox shell (environment below).
const WRITE_TOOLS = "Read,Glob,Grep,Edit,Write,Bash";

function mcpConfig(node = process.execPath) {
  return JSON.stringify({ mcpServers: { [MCP_SERVER]: { type: "stdio", command: node, args: [BRIDGE] } } });
}

// What no Claude Code tool may read: the runtime's own home state — the
// subscription's credential (`.credentials.json`), its sessions and its account
// file. Claude Code itself must read them, so the kernel cannot keep them from
// its tools (Landlock is per process); its permission rules can. Found on the
// host with rc.67: a turn's Read returned a canary placed beside the credential,
// verbatim. With these rules Read, Grep and Glob are refused there — including
// through `..` — shown on the host against the same canary before shipping.
const DENIED_READS = "Read(~/.claude/**),Read(~/.claude.json)";

// Each surface's tools and permissions. The gate asks for a word and needs no
// tool at all; a turn reads the workspace and calls the platform.
const SURFACE_ARGS = Object.freeze({
  project: () => [
    "--tools", READ_TOOLS,
    "--allowedTools", [READ_TOOLS, ...PLATFORM_TOOLS].join(","),
    "--disallowedTools", DENIED_READS,
    "--mcp-config", mcpConfig(),
    "--strict-mcp-config", "--permission-mode", "dontAsk",
  ],
  gate: () => ["--tools", "", "--disallowedTools", DENIED_READS, "--strict-mcp-config", "--permission-mode", "dontAsk"],
  // An analyst's run (0147): the snapshot read, nothing called, nothing written.
  consult: () => [
    "--tools", READ_TOOLS, "--allowedTools", READ_TOOLS, "--disallowedTools", DENIED_READS,
    "--strict-mcp-config", "--permission-mode", "dontAsk",
  ],
  // An executor's run (Stage 12 X1): the workspace granted read-write, its
  // tools pre-approved and nothing else (`dontAsk`), its terminal reports as
  // MCP tools of the same bridge (INFRA_BRIDGE_TOOLS=reports in its environment).
  task: () => [
    "--tools", WRITE_TOOLS,
    "--allowedTools", [WRITE_TOOLS, ...REPORT_TOOLS].join(","),
    "--disallowedTools", DENIED_READS,
    "--mcp-config", mcpConfig(),
    "--strict-mcp-config", "--permission-mode", "dontAsk",
  ],
});

// Claude Code's effort levels, and which model takes which. There is no API
// that lists them: this is the documented table, keyed on the model an alias
// resolved to (the check lane records it, 0098/0099), and the database holds
// the same table (claude_reasoning_levels, 0110) to fill the catalog —
// drivers.test.mjs keeps the two equal. `ultracode` is xhigh with a mode
// switched on, not a level, and is not offered. A model the table does not
// list (Haiku, the older families) takes no --effort at all.
const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
const FOUR_LEVELS = Object.freeze(["low", "medium", "high", "max"]);
const EFFORT_BY_MODEL = Object.freeze([
  Object.freeze({ family: "fable", version: "5", levels: EFFORT_LEVELS, default: "high" }),
  Object.freeze({ family: "fable", version: "5.1", levels: EFFORT_LEVELS, default: "high" }),
  Object.freeze({ family: "opus", version: "5.5", levels: EFFORT_LEVELS, default: "medium" }),
  Object.freeze({ family: "opus", version: "5", levels: EFFORT_LEVELS, default: "high" }),
  Object.freeze({ family: "sonnet", version: "5.5", levels: EFFORT_LEVELS, default: "medium" }),
  Object.freeze({ family: "sonnet", version: "5", levels: EFFORT_LEVELS, default: "high" }),
  Object.freeze({ family: "opus", version: "4.8", levels: EFFORT_LEVELS, default: "high" }),
  Object.freeze({ family: "opus", version: "4.7", levels: EFFORT_LEVELS, default: "xhigh" }),
  Object.freeze({ family: "opus", version: "4.6", levels: FOUR_LEVELS, default: "high" }),
  Object.freeze({ family: "sonnet", version: "4.6", levels: FOUR_LEVELS, default: "high" }),
]);

// `claude-<family>-<major>[-<minor>][-<date>]`: one or two digits after the
// major are the minor version, eight are a date (claude-opus-4-20250514 is Opus 4).
function effortForModel(resolvedModel) {
  const match = /^claude-(opus|sonnet|haiku|fable)-([0-9]+)(?:-([0-9]{1,2}))?(?:$|[^0-9])/.exec(String(resolvedModel ?? "").toLowerCase());
  const row = match && EFFORT_BY_MODEL.find((entry) => entry.family === match[1]
    && entry.version === `${match[2]}${match[3] !== undefined ? `.${match[3]}` : ""}`);
  return row ? { levels: [...row.levels], default: row.default } : { levels: [], default: "" };
}

function sessionArgs({ sessionId = null, newSessionId = null }) {
  if (sessionId) return ["--resume", sessionId];
  return ["--session-id", newSessionId ?? randomUUID()];
}

function normalizeEvent(raw) {
  const event = normalizeClaudeEvent(raw);
  if (!event) return null;
  return { ...event, details: { ...event.details, native_type: String(raw.type).slice(0, 80) } };
}

function parse(line) {
  if (!line.trim()) return null;
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.type !== "string") return null;
  return { raw, event: normalizeEvent(raw) };
}

function objects(stdout) {
  return String(stdout ?? "").split("\n").map(parse).filter(Boolean).map((parsed) => parsed.raw);
}

// The turn's answer: the result's text when the turn finished, else the last
// thing the model wrote.
function answer(stdout) {
  const raws = objects(stdout);
  const result = raws.findLast((raw) => raw.type === "result");
  if (!result?.is_error && typeof result?.result === "string") return result.result.trim();
  const assistant = raws.findLast((raw) => raw.type === "assistant"
    && Array.isArray(raw.message?.content) && raw.message.content.some((block) => block?.type === "text"));
  return assistant ? assistant.message.content.filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? "")).join("").trim() : "";
}

// Why the turn failed, when the stream says: "" for a turn that succeeded.
// A failed turn still reports `subtype: "success"` — `is_error` decides
// (probe 06) — and the class comes from the stream, not the exit code, which
// is only ever 0 or 1.
function failure(stdout) {
  const raws = objects(stdout);
  const result = raws.findLast((raw) => raw.type === "result");
  const assistantError = raws.filter((raw) => raw.type === "assistant").map((raw) => raw.error)
    .findLast((error) => typeof error === "string");
  const status = typeof result?.api_error_status === "number" ? result.api_error_status : null;
  if (result && !result.is_error && !assistantError) return "";
  if (!result && !assistantError) return "";
  const text = typeof result?.result === "string" ? result.result.trim().slice(0, 300) : "";
  // A CLI older than the model it was asked for: one sentence that says what
  // to do, not the API's paragraph twice over (the first clean install, whose
  // Claude Code 2.1.270 could not run Opus 5.5).
  const needs = /version (\d+\.\d+\.\d+) or newer is required/i.exec(text)?.[1];
  if (needs) return `Claude Code is too old for this model: it needs ${needs} or newer. Update it in Settings → Runtimes.`;
  const cls = assistantError === "authentication_failed" || status === 401 || status === 403 ? "not signed in"
    : assistantError === "rate_limit" || status === 429 ? "rate limited"
      : assistantError === "billing_error" ? "billing"
        : assistantError === "model_not_found" || status === 404 ? "model not available"
          : assistantError === "invalid_request" ? "invalid request"
            : result?.stop_reason === "refusal" ? "refused" : "failed";
  return `Claude Code ${cls}${text ? `: ${text}` : ""}`.slice(0, 500);
}

// Which model the alias resolved to, as the turn's first event reports it
// (`system`/`init` carries `model`): an alias names a family, and the catalog
// records the model a check saw so a run seeing another can say so (design
// §2.4, alias drift). Null for any other event.
function resolvedModel(raw) {
  if (raw?.type !== "system" || raw.subtype !== "init" || typeof raw.model !== "string") return null;
  return raw.model.trim().slice(0, 200) || null;
}

export const claudeDriver = Object.freeze({
  name: "claude",
  executable: adapter.executable,

  verified: Object.freeze({
    adapterVersion: "1.1.0",
    runtimeVersion: "2.1.270",
    evidence: Object.freeze({
      "sessions.create": "pocs/claude-runtime RESULTS §7, probe 01 on the host: every event carries the --session-id given",
      "sessions.resume": "pocs/claude-runtime RESULTS §7, probes 02 and 02r: --resume from a new process, and after a host reboot",
      "run.read_only": "pocs/claude-runtime RESULTS §7, probe 08: started under the product's read-only launch; the model's touch refused",
      "stream.structured": "pocs/claude-runtime RESULTS §1: stream-json, recorded fixtures; drivers.test.mjs parses them",
      "interrupt": "run-cgroup.test.mjs: the run's cgroup is killed whatever process group a tool is in (probe 03k's finding)",
      "tools.platform": "pocs/claude-runtime RESULTS §7, probe 04: one structured delegate_task through MCP, the capability in neither argv nor stream; claude-bridge.test.mjs",
      "events.raw": "drivers.test.mjs: every stdout line is parsed as { raw, event } with its native type",
      "usage.report": "drivers.test.mjs: the result event's usage becomes runtime.turn.usage tokens",
      "gate.smoke": "catalog-gate-worker.mjs: the batch smoke, a run and an interrupted run in a scratch workspace",
      "run.workspace_write": "Stage 12 X1 on the host: Bash in the sandbox shell ran a workspace script; the note beside the login was not there",
      "tools.worker_report": "claude-bridge.test.mjs: complete_task, report_blocker and request_user_input reach the run's socket in the gateway's shape",
      "account.login": "rc.123, 2.1.286 in a container: with no TTY `claude auth login` prints the authorize URL and reads the code from stdin; claude-account-channel.test.mjs",
    }),
  }),

  capabilities: Object.freeze({
    "sessions.create": { by: "sessions", native: "`--session-id <uuid>` chosen by the supervisor; session_id on every event" },
    "sessions.resume": { by: "sessions", native: "`--resume <id>`, keyed by the runtime's home and the workspace path" },
    "run.read_only": { by: "run", native: "`-p` under a Landlock ruleset, `--tools Read,Glob,Grep`, `--permission-mode dontAsk`" },
    "stream.structured": { by: "stream", native: "`--output-format stream-json --verbose`, one object per line" },
    "interrupt": { by: "interrupt", native: "the run's cgroup: SIGTERM, then cgroup.kill" },
    "tools.platform": { by: "toolBridge", native: "an MCP stdio server from `--mcp-config`, calling the run's socket" },
    "events.raw": { by: "normalizeEvent", native: "each object kept with its type as native_type" },
    "usage.report": { by: "normalizeEvent", native: "the result event's usage" },
    "gate.smoke": { by: "run", native: "the gate surface: a tool-less batch run in a scratch workspace" },
    "run.workspace_write": { by: "run", native: "`-p` with Read, Edit, Write and Bash pre-approved; Bash through CLAUDE_CODE_SHELL, the sandbox shell" },
    "tools.worker_report": { by: "toolBridge", native: "the MCP bridge's report tools (INFRA_BRIDGE_TOOLS=reports), calling the run's socket" },
    "account.login": { by: "input", native: "`claude auth login`: the authorize URL on stdout, the pasted code on stdin" },
  }),

  surfaces: Object.freeze({
    project: Object.freeze({ transport: "batch", workspace: "grant", grantMode: "read_only", capability: "run.read_only" }),
    consult: Object.freeze({ transport: "batch", workspace: "snapshot", capability: "run.read_only" }),
    gate: Object.freeze({ transport: "batch", workspace: "gate", capability: "gate.smoke" }),
    task: Object.freeze({ transport: "batch", workspace: "grant", grantMode: "read_write", capability: "run.workspace_write" }),
    // The sign-in from the panel (rc.123), in the runtime's own home.
    account: Object.freeze({ transport: "channel", workspace: "home", capability: "account.login" }),
  }),

  sessions: Object.freeze({
    // The supervisor chooses a new session's id, so the tool bridge knows it
    // before the runtime says it.
    newId: () => randomUUID(),
    args: sessionArgs,
    idFromEvent: (raw) => (typeof raw?.session_id === "string" ? raw.session_id : null),
  }),

  run: Object.freeze({
    // Variadic options first, the prompt last, straight after `--model` — so
    // no option can take the prompt as one of its values (the PoC's order).
    // --effort only when the member has a level: none leaves the model's own
    // default, and the flag does not persist past this process.
    argv: ({ model, sessionId = null, newSessionId = null, prompt, surface = "gate", reasoningEffort = null }) => {
      if (surface === "account") return ["auth", "login"];
      const surfaceArgs = SURFACE_ARGS[surface];
      if (!surfaceArgs) throw new Error(`Claude Code has no ${JSON.stringify(surface)} surface`);
      const effort = launchReasoningLevel(claudeDriver, reasoningEffort);
      return [
        "-p", ...surfaceArgs(), "--setting-sources", "user", ...sessionArgs({ sessionId, newSessionId }),
        ...(effort ? ["--effort", effort] : []),
        "--output-format", "stream-json", "--verbose", "--model", model, prompt,
      ];
    },
    // A task's shell is the sandbox shell, with the login covered and the shell
    // snapshots kept (Stage 12 X1); its bridge serves the reports.
    environment: ({ surface = null, toolBridge = [] } = {}) => [
      ...adapter.autoUpdate.environment,
      ...(surface === "task" ? [...sandboxShellEnvironment(adapter, ["CLAUDE_CODE_SHELL", "SHELL"]), "INFRA_BRIDGE_TOOLS=reports"] : []),
      ...toolBridge,
    ],
    readOnlyWritable: Object.freeze([...adapter.writableState, "/tmp", "/dev/null"]),
    // The catalog holds Claude Code's own names for its models.
    qualifyModel: (_provider, model) => model,
  }),

  stream: Object.freeze({
    framing: "jsonl",
    parse,
    answer,
    failure,
    resolvedModel,
  }),

  // How a reasoning level reaches the runtime, and which values it may be. The
  // catalog's list per model comes from the table (by resolved model); a launch
  // is checked against the flag's values.
  reasoning: Object.freeze({
    applied: "`--effort <level>` per process, one process per turn; not persisted",
    levels: EFFORT_LEVELS,
    accepts: (level) => EFFORT_LEVELS.includes(level),
    byModel: EFFORT_BY_MODEL,
    forModel: effortForModel,
    discovery: "none: the documented table by resolved model",
    source: "code.claude.com/docs/en/model-config § Adjust effort level; code.claude.com/docs/en/cli-reference --effort",
    verifiedAgainst: "2.1.270 (docs read 2026-09-29)",
  }),

  input: Object.freeze({
    // A turn takes no stdin; the next input is the next turn, resumed. The
    // sign-in takes one line: the code.
    channelState: (surface) => (surface === "account" ? claudeAccountState() : null),
    validate: (surface, data, state) => {
      if (surface === "account") return validateClaudeAccountInput(data, state);
      throw new Error(`Claude Code has no channel on its ${surface} surface`);
    },
    observes: () => false,
  }),

  interrupt: Object.freeze({
    mechanism: "cgroup",
    // The sign-in channel (rc.123) runs no turn: it ends with its cgroup.
    channel: "cgroup",
  }),

  toolBridge: Object.freeze({
    transport: "mcp_stdio",
    // The executor's terminal reports, served by the bridge on a task (X1).
    tools: WORKER_REPORT_TOOLS,
    platformTools: PLATFORM_COMMAND_TOOL_NAMES,
    environment: ({ socket, capability, runId, sessionId = null }) => [
      `INFRA_WORKER_TOOL_SOCKET=${socket}`, `INFRA_WORKER_CAPABILITY=${capability}`, `INFRA_WORKER_RUN_ID=${runId}`,
      ...(sessionId ? [`INFRA_NATIVE_SESSION_ID=${sessionId}`] : []),
    ],
  }),

  normalizeEvent,
});
