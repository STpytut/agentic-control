// The OpenCode runtime driver (WP-5b).
//
// OpenCode is driven as a batch: `opencode run --format json`, one process per
// run, its JSON events on stdout, a session continued by `--session`. Its tools
// are files it loads from its own config directory, and they call back over a
// Unix socket bound to one run by a one-time capability. Its account is managed
// through a short-lived loopback `opencode serve`, because the CLI's login does
// not take a key from stdin.
//
// Pure: both sides import it.

import { adapterFor } from "../../operations/runtime-adapters.mjs";
import {
  OPENCODE_ACCOUNT_LABELS, openCodeFreeProvider, openCodeGoProvider, openRouterProvider, validateOpenCodeAccountInput,
} from "../opencode-account-channel.mjs";
import { normalizeOpenCodeEvent } from "../runtime-events.mjs";
import { sandboxShellEnvironment } from "../sandbox-shell.mjs";
import { REASONING_LEVEL, launchReasoningLevel } from "./reasoning.mjs";
import { PLATFORM_COMMAND_TOOL_NAMES, WORKER_REPORT_TOOLS } from "./tool-contracts.mjs";

const adapter = adapterFor("opencode");

// The native event type, kept with the normalised event.
function normalizeEvent(raw) {
  const event = normalizeOpenCodeEvent(raw);
  return event ? { ...event, details: { ...event.details, native_type: String(raw.type).slice(0, 80) } } : null;
}

// Each run's configuration, by surface (11.2 N4). OpenCode loads every tool
// file in its config directory, so a run is told which of them are not its
// own: an orchestrator's turn cannot report an implementation, an executor
// cannot delegate. An orchestrator's turn also denies itself edits, shell and
// fetches — the second layer of D5; the first is the kernel's
// (read-only-launch.mjs). A workspace's own opencode.json cannot widen this:
// project configuration is switched off for the turn.
//
// The shell is denied command by command, not as a tool. `"bash": "deny"`
// takes the tool out of the request, and OpenCode's free tier refuses a
// request without it — 403, "OpenCode's free tier can only be used from within
// OpenCode" (rc.44 on the host). With one read-only command allowed the tool
// stays, and every other command is refused before it runs.
const TURN_SHELL_ALLOWED = "git status";

// The login and the state beside it, refused to OpenCode's own file tools on
// every surface (Stage 12 M0): `read` for the read tool, `external_directory`
// for read, grep, glob and list outside the workspace and for the paths it
// finds in a shell command. Its patterns match whole paths, `*` across `/`;
// the rules are appended to the agent's defaults, and the last match wins.
// The shell's real boundary is the sandbox shell below: a path OpenCode does
// not parse out of a command is not asked about.
const LOGIN_DENIED = Object.fromEntries(
  adapter.loginState.flatMap((entry) => [`*/${entry}`, `*/${entry}/*`]).map((pattern) => [pattern, "deny"]),
);
const LOGIN_PERMISSION = Object.freeze({ read: LOGIN_DENIED, external_directory: LOGIN_DENIED });

const RUN_CONFIG = Object.freeze({
  project: {
    permission: { ...LOGIN_PERMISSION, edit: "deny", bash: { "*": "deny", [TURN_SHELL_ALLOWED]: "allow" }, webfetch: "deny" },
    tools: Object.fromEntries(WORKER_REPORT_TOOLS.map((name) => [name, false])),
  },
  task: {
    permission: LOGIN_PERMISSION,
    tools: Object.fromEntries(PLATFORM_COMMAND_TOOL_NAMES.map((name) => [name, false])),
  },
  // An analyst's run (0147): reads the snapshot; no shell, no edit, no tool of
  // the platform's.
  consult: {
    permission: { ...LOGIN_PERMISSION, edit: "deny", bash: "deny", webfetch: "deny" },
    tools: Object.fromEntries([...PLATFORM_COMMAND_TOOL_NAMES, ...WORKER_REPORT_TOOLS].map((name) => [name, false])),
  },
  // A model check (no surface): OpenCode's defaults, less the login.
  gate: {
    permission: LOGIN_PERMISSION,
  },
});

// The self-update switch comes from the registry, where its source is recorded
// (runtime-adapters.mjs), so a run and a probe cannot disagree about it.
//
// Every run whose shell is open — a task, a model check (no surface) — runs its
// commands in the sandbox shell, with the login covered (Stage 12 M0: the
// executor's `cat ~/.local/share/opencode/auth.json` worked). A turn's shell
// runs `git status` and nothing else, under a Landlock ruleset that would not
// let bubblewrap mount anyway.
// OpenCode's own subagents (M7): its `task` tool, on by default, is off for a
// writer or an analyst the operator did not allow them.
const SUBAGENT_SURFACES = new Set(["task", "consult"]);

function runEnvironment({ surface = null, toolBridge = [], subagents = false } = {}) {
  const base = RUN_CONFIG[surface ?? "gate"];
  const config = base && SUBAGENT_SURFACES.has(surface)
    ? { ...base, tools: { ...(base.tools ?? {}), task: Boolean(subagents) } }
    : base;
  return [
    ...adapter.autoUpdate.environment, "OPENCODE_AUTO_SHARE=false",
    // A turn and an analyst's run (0147) read a repository nobody vetted: its
    // own OpenCode config, plugins and tools are never loaded.
    ...(surface === "project" || surface === "consult" ? ["OPENCODE_DISABLE_PROJECT_CONFIG=true"] : sandboxShellEnvironment(adapter)),
    ...(config ? [`OPENCODE_CONFIG_CONTENT=${JSON.stringify(config)}`] : []),
    ...toolBridge,
  ];
}

// The turn's answer: the text of the last message the runtime wrote. A batch
// run has no completion event carrying it; each text part arrives as its own
// JSON line, with the message it belongs to.
function answer(stdout) {
  const parts = String(stdout ?? "").split("\n").map(parse).filter((parsed) => parsed?.raw?.type === "text");
  if (!parts.length) return "";
  const last = parts.at(-1).raw.part?.messageID ?? null;
  return parts.filter((parsed) => (parsed.raw.part?.messageID ?? null) === last)
    .map((parsed) => String(parsed.raw.part?.text ?? "")).join("").trim();
}

// Why the run failed, when it said so: OpenCode reports a provider's refusal as
// an `error` event on stdout and exits 1 with nothing on stderr. Without this
// the operator read "OpenCode exited with code 1" and nothing else.
function failure(stdout) {
  const errors = String(stdout ?? "").split("\n").map(parse).filter((parsed) => parsed?.raw?.type === "error");
  const error = errors.at(-1)?.raw?.error;
  if (!error) return "";
  return String(error.data?.message ?? error.message ?? error.name ?? "").trim().slice(0, 500);
}

function parse(line) {
  if (!line.trim()) return null;
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  return { raw, event: normalizeEvent(raw) };
}

export const opencodeDriver = Object.freeze({
  name: "opencode",
  executable: adapter.executable,

  verified: Object.freeze({
    adapterVersion: "1.0.0",
    runtimeVersion: "1.18.31",
    evidence: Object.freeze({
      "sessions.create": "STAGE_11_1B_ACCEPTANCE.md, rc.36 live run: job 56's sessionID bound to its terminal report",
      "sessions.resume": "STAGE_11_1B_ACCEPTANCE.md, rc.29: the resumed revision continued the session that asked",
      "run.workspace_write": "STAGE_11_1B_ACCEPTANCE.md, rc.36 live run: job 56 implemented and committed 0f6bd78",
      "stream.structured": "STAGE_11_1B_ACCEPTANCE.md, rc.36 live run: `run --format json` events in the activity feed",
      "interrupt": "catalog-gate-worker.mjs: the OpenCode gate's interrupt check signals the run's cgroup",
      "tools.worker_report": "STAGE_11_1B_ACCEPTANCE.md, rc.36/rc.37: complete_task through the worker tool socket",
      "events.raw": "drivers.test.mjs: every stdout line is parsed as { raw, event }, and the bounded stdout is returned whole",
      "usage.report": "product-data.ts: step_finish tokens and cost summed from the activity feed",
      "run.read_only": "read-only-launch.test.mjs: a Landlock ruleset refuses edit, create, remove and mkdir in the workspace, against the kernel; the host as opencode-worker on a file it owns (STAGE_11_2_ACCEPTANCE.md)",
      "tools.platform": "drivers.test.mjs and worker-tool-socket.test.mjs: delegate_task and request_revision tool files calling the run's socket, which accepts them for an orchestrator's run only",
      "account.api_key": "STAGE_11_1_ACCEPTANCE.md: the OpenCode Go key enrolled through the loopback server",
      "catalog.models": "catalog-refresh-worker.mjs: provider_list over the loopback server",
      "gate.smoke": "catalog-gate-worker.mjs: the OpenCode capability gate",
    }),
  }),

  capabilities: Object.freeze({
    "sessions.create": { by: "sessions", native: "`run` without --session; sessionID on every event" },
    "sessions.resume": { by: "sessions", native: "`run --session <id>`" },
    "run.workspace_write": { by: "run", native: "`run --auto` in the granted workspace, as the runtime's user" },
    "stream.structured": { by: "stream", native: "`run --format json`, one event per line" },
    "interrupt": { by: "interrupt", native: "the run's cgroup: SIGTERM, then cgroup.kill" },
    "tools.worker_report": { by: "toolBridge", native: "tool files in .config/opencode/tools, calling the worker tool socket" },
    "run.read_only": { by: "run", native: "`run` under a Landlock ruleset: the workspace readable, only the runtime's own state writable" },
    "tools.platform": { by: "toolBridge", native: "delegate_task and request_revision tool files, calling the run's socket" },
    "events.raw": { by: "normalizeEvent", native: "each JSON line kept with its type as native_type" },
    "usage.report": { by: "normalizeEvent", native: "step_finish tokens and cost" },
    "account.api_key": { by: "input", native: "PUT /auth/{opencode-go,openrouter} on a loopback `opencode serve`" },
    "catalog.models": { by: "input", native: "GET /provider on a loopback `opencode serve`" },
    "gate.smoke": { by: "run", native: "the gate surface: a batch run in a scratch workspace" },
  }),

  surfaces: Object.freeze({
    task: Object.freeze({ transport: "batch", workspace: "grant", grantMode: "read_write", capability: "run.workspace_write" }),
    // An orchestrator's turn: one batch run in the conversation's session, the
    // workspace granted read-only and held read-only by the kernel.
    project: Object.freeze({ transport: "batch", workspace: "grant", grantMode: "read_only", capability: "run.read_only" }),
    consult: Object.freeze({ transport: "batch", workspace: "snapshot", capability: "run.read_only" }),
    gate: Object.freeze({ transport: "batch", workspace: "gate", capability: "gate.smoke" }),
    account: Object.freeze({ transport: "local_server", capability: "account.api_key" }),
  }),

  sessions: Object.freeze({
    // Resumed by the id the runtime gave; created by not naming one.
    args: (sessionId) => (sessionId ? ["--session", sessionId] : []),
    idFromEvent: (raw) => (typeof raw?.sessionID === "string" ? raw.sessionID : null),
  }),

  run: Object.freeze({
    // --variant only when the member has a level. OpenCode ignores a variant
    // the model does not have, silently (session/llm/request.ts:80-91 at
    // v1.18.32), so the database accepts only one the model's catalog entry
    // lists; here the value is held to a token.
    // A role's instructions (rc.143) head the prompt: an OpenCode agent's
    // `prompt` replaces OpenCode's own system prompt for the provider rather
    // than adding to it (session/llm/request.ts at v1.18.35), and that prompt
    // is how its tools are explained to the model.
    argv: ({ model, sessionId = null, prompt, reasoningEffort = null, systemPrompt = null }) => {
      const variant = launchReasoningLevel(opencodeDriver, reasoningEffort);
      return [
        "run", "--pure", "--auto", "--format", "json", "--model", model,
        ...(variant ? ["--variant", variant] : []),
        ...opencodeDriver.sessions.args(sessionId), systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
      ];
    },
    environment: runEnvironment,
    // What a read-only run may still write: its own state, the scratch
    // directory and the null device. Everything else — the workspace first —
    // is refused by the kernel.
    readOnlyWritable: Object.freeze([...adapter.writableState, "/tmp", "/dev/null"]),
    // OpenCode's --model is provider/model. Qualified where the catalog knows
    // the provider, bare where it does not — which is the older behaviour kept
    // as the fallback rather than a new guess.
    qualifyModel: (provider, model) => (provider ? `${provider}/${model}` : model),
  }),

  stream: Object.freeze({
    framing: "jsonl",
    parse,
    answer,
    failure,
  }),

  // How a reasoning level reaches the runtime, and which values it may be. A
  // model's levels are its variants — their names are whatever the models feed
  // and the user's config make them — so the set is open and each is held to
  // a token; which ones a model has is the catalog's, from GET /provider.
  reasoning: Object.freeze({
    applied: "`run --variant <name>` per run; stored on the session's message, not in config",
    levels: null,
    accepts: (level) => REASONING_LEVEL.test(level),
    discovery: "GET /provider: Object.keys(model.variants)",
    verifiedAgainst: "v1.18.32: opencode/src/cli/cmd/run.ts:212-215, provider/provider.ts:1091-1112",
  }),

  input: Object.freeze({
    // A run takes no stdin; further input is a new run in the same session.
    channelState: () => null,
    validate: (surface) => { throw new Error(`OpenCode has no channel on its ${surface} surface`); },
    observes: () => false,
    account: validateOpenCodeAccountInput,
    // The loopback server the account surface runs: `opencode serve`, bound to
    // 127.0.0.1 on a port the supervisor reserves, behind Basic Auth with a
    // password generated per start. OpenCode uses the fixed username `opencode`.
    localServer: Object.freeze({
      username: "opencode",
      argv: (port) => ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)],
      // `serve` never calls upgrade() at 1.18.31; the switch travels anyway, so
      // the day a version starts to, this launch is already covered.
      environment: ({ username, password }) => [
        ...adapter.autoUpdate.environment,
        `OPENCODE_SERVER_USERNAME=${username}`, `OPENCODE_SERVER_PASSWORD=${password}`,
      ],
      catalogProviders: Object.freeze([openCodeFreeProvider, openCodeGoProvider, openRouterProvider]),
      accountLabels: OPENCODE_ACCOUNT_LABELS,
    }),
  }),

  // The run's cgroup, since sprint C (K1): SIGTERM to every member, SIGKILL
  // through `cgroup.kill` after the grace. It was the process group, which a
  // tool leaves by calling setsid; a cgroup it cannot leave.
  interrupt: Object.freeze({
    mechanism: "cgroup",
  }),

  toolBridge: Object.freeze({
    transport: "unix_socket",
    tools: WORKER_REPORT_TOOLS,
    platformTools: PLATFORM_COMMAND_TOOL_NAMES,
    definitions: adapter.toolDefinitions,
    environment: ({ socket, capability, runId }) => [
      `INFRA_WORKER_TOOL_SOCKET=${socket}`, `INFRA_WORKER_CAPABILITY=${capability}`, `INFRA_WORKER_RUN_ID=${runId}`,
    ],
  }),

  normalizeEvent,
});
