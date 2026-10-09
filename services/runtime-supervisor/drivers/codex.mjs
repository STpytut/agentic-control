// The Codex runtime driver (WP-5b): how Codex is driven, as opposed to how it
// is provisioned — which is its descriptor in runtime-adapters.mjs.
//
// Codex is driven through `codex app-server --listen stdio://`: JSON-RPC over
// the process's stdin and stdout, carried by the supervisor as a channel. Every
// surface — a project's read-only turn, the account, the capability gate — is
// the same app-server; what differs is the workspace it is opened in and what
// the supervisor lets through on its stdin.
//
// Pure, apart from `connect`, which wraps a channel the caller already holds:
// both the supervisor and the control plane import this, and neither may get a
// side effect from doing so.

import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { adapterFor, codexTaskConfigOverrides, configOverridesFor } from "../../operations/runtime-adapters.mjs";
import { validateCodexAccountInput } from "../codex-account-channel.mjs";
import {
  bindCodexGateResponse, createCodexGateChannelStateValidator, validateCodexGateInput,
} from "../codex-gate-channel.mjs";
import { codexExecTokens, normalizeCodexEvent, normalizeCodexExecEvent } from "../runtime-events.mjs";
import { launchReasoningLevel } from "./reasoning.mjs";
import { PLATFORM_COMMAND_NAMESPACE, WORKER_REPORT_TOOLS } from "./tool-contracts.mjs";

const adapter = adapterFor("codex");

// The effort values Codex's protocol knows (ReasoningEffort's wire names at
// rust-v0.158.0, codex-rs/protocol/src/openai_models.rs:56-88). Which of them a
// model takes is the model's (`model/list` supportedReasoningEfforts, kept in
// the catalog); a value outside this set — the enum's Custom(String) — is not
// sent, whatever the catalog says.
const CODEX_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"]);

// A read-only project turn. How its commands are sandboxed is set at launch,
// by version (runtime-adapters.mjs, Stage 12 M0): from 0.155.0 a permission
// profile that also denies the login, which a thread's own `sandbox` would
// replace (0.158.0 on the host: the profile gone, `cat ~/.codex/auth.json`
// readable again). So a message may carry nothing that sets a sandbox, a
// permission profile, config or approvals, and only the methods the platform
// sends get through: app-server also serves `fs/readFile`, `command/exec` and
// `config/value/write`, none of which a turn needs. Replies to the server's
// own requests (no method) pass. Moved here from the supervisor, which used to
// know it by `channel.mode`.
const PROJECT_METHODS = new Set([
  "initialize", "initialized", "thread/start", "thread/resume", "turn/start", "turn/interrupt", "item/list",
  "model/list", "account/read", "account/rateLimits/read",
]);
const PERMISSION_KEYS = ["sandbox", "sandboxPolicy", "config", "approvalsReviewer"];

function validateReadOnlyInput(data) {
  for (const line of String(data).split("\n").filter((item) => item.trim())) {
    const message = JSON.parse(line);
    if (message.method === undefined) continue;
    if (!PROJECT_METHODS.has(message.method)) {
      throw new Error(`Codex channel does not permit ${String(message.method)}`);
    }
    const params = message.params ?? {};
    if (PERMISSION_KEYS.some((key) => key in params)
        || ("approvalPolicy" in params && params.approvalPolicy !== "never")) {
      throw new Error("Codex channel threads take the launch's sandbox; a message may not set one");
    }
  }
}

// The thread every product turn opens, never asking for approval (RUNTIME_CONTRACT
// §7.1). No `sandbox`: the launch's permission profile is the sandbox.
function threadParams({ cwd, model, instructions, tools }) {
  return {
    cwd,
    model,
    approvalPolicy: "never",
    developerInstructions: instructions,
    dynamicTools: tools,
  };
}

// The platform's tools in app-server's dynamic-tool shape: one namespace, each
// tool a function with its schema.
function registerTools(tools) {
  return [{
    type: "namespace",
    name: PLATFORM_COMMAND_NAMESPACE.name,
    description: PLATFORM_COMMAND_NAMESPACE.description,
    tools: tools.map((tool) => ({
      type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    })),
  }];
}

// An app-server `item/tool/call`, as the platform reads a tool call. Anything
// that is not one is null, and the session answers it as unsupported.
function toolCall(message) {
  if (message?.method !== "item/tool/call") return null;
  const params = message.params ?? {};
  return {
    sessionId: params.threadId, turnId: params.turnId, callId: params.callId,
    namespace: params.namespace, tool: params.tool, arguments: params.arguments,
  };
}

// The native method, kept with the normalised event: what `events.raw` means
// for a runtime whose events are JSON-RPC notifications. A writing run's
// `codex exec --json` events have a type instead of a method (Stage 12 X2).
function normalizeEvent(raw) {
  if (raw && typeof raw === "object" && raw.method === undefined && typeof raw.type === "string") {
    const event = normalizeCodexExecEvent(raw);
    return event ? { ...event, details: { ...event.details, native_type: String(raw.type).slice(0, 80) } } : null;
  }
  const event = normalizeCodexEvent(raw);
  return event ? { ...event, details: { ...event.details, native_type: String(raw.method).slice(0, 80) } } : null;
}

// A writing run (Stage 12 X2): `codex exec --json`, one process per turn like
// Claude Code and OpenCode, under the workspace profile that denies the login
// (runtime-adapters.mjs codexTaskConfigOverrides), with the executor's reports
// as MCP tools of the platform bridge.
const BRIDGE = fileURLToPath(new URL("../claude-mcp/platform-bridge.mjs", import.meta.url));

function execObjects(stdout) {
  return String(stdout ?? "").split("\n").map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter((raw) => raw && typeof raw === "object" && typeof raw.type === "string");
}

function execAnswer(stdout) {
  const message = execObjects(stdout).findLast((raw) => raw.type === "item.completed" && raw.item?.type === "agent_message");
  return String(message?.item?.text ?? "").trim();
}

function execFailure(stdout) {
  const raws = execObjects(stdout);
  const failed = raws.findLast((raw) => raw.type === "turn.failed" || raw.type === "error");
  if (!failed) return "";
  const text = String(failed.error?.message ?? failed.message ?? "").trim();
  const cls = /usage limit|rate limit|429/i.test(text) ? "rate limited" : /401|403|auth|sign in|log in/i.test(text) ? "not signed in" : "failed";
  return `Codex ${cls}${text ? `: ${text.slice(0, 300)}` : ""}`.slice(0, 500);
}

// A role's instructions (rc.143) as `developer_instructions`, the key the
// app-server's threads take them by: a TOML basic string, which JSON's
// escapes are (shown on the host at 0.160).
function execArgv({ model, sessionId = null, prompt, reasoningEffort = null, version = null, subagents = false, systemPrompt = null }) {
  const overrides = codexTaskConfigOverrides(version, { node: process.execPath, bridge: BRIDGE });
  if (!overrides) throw new Error(`Codex ${version} cannot hide its login from a writing run; a task needs 0.155.0 or later`);
  const effort = launchReasoningLevel(codexDriver, reasoningEffort);
  // Codex's own subagents (M7): `multi_agent` is on by default since 0.160;
  // a member the operator did not allow them runs with it off.
  const config = [...overrides, ...(effort ? [`model_reasoning_effort="${effort}"`] : []),
    ...(subagents ? [] : ["features.multi_agent=false"]),
    ...(systemPrompt ? [`developer_instructions=${JSON.stringify(systemPrompt)}`] : [])].flatMap((value) => ["-c", value]);
  return [...config, "exec", ...(sessionId ? ["resume"] : []), "--json", "--skip-git-repo-check", "-m", model,
    ...(sessionId ? [sessionId] : []), prompt];
}

// A pull request's review (rc.145): Codex's own review mode, `exec review`,
// against the base branch, in a scratch repository built from the pull
// request — under the read-only profile every orchestrator turn has, its own
// subagents off. The prompt, when there is one, is the platform's review
// instructions.
const REVIEW_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
function reviewArgv({ model, version = null, baseBranch, prompt = null }) {
  if (!REVIEW_BRANCH.test(String(baseBranch ?? "")) || String(baseBranch).includes("..")) {
    throw new Error("a review names the branch it compares against");
  }
  // The pull request's own AGENTS.md is not read: its author would be telling
  // the reviewer what to say (0.160 on the host: an AGENTS.md instruction was
  // followed, and not with `project_doc_max_bytes=0`).
  return [...configOverridesFor(adapter, version), "features.multi_agent=false", "project_doc_max_bytes=0"].flatMap((value) => ["-c", value])
    .concat(["exec", "review", "--json", "-m", model, "--base", baseBranch, ...(prompt ? [prompt] : [])]);
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

// The app-server conversation over a supervisor channel: requests with ids,
// server requests answered, notifications waited for. Moved from
// codex-chat-worker.mjs (now orchestrator-worker.mjs), where it was the worker's own class, unchanged in what
// it does; what is new is that each line arrives as `{ raw, event }` and both
// halves are kept.
export class CodexAppServerSession {
  constructor(processHandle, { onServerRequest, onRuntimeEvent } = {}) {
    this.processHandle = processHandle;
    this.pending = new Map();
    this.waiters = new Set();
    this.messages = [];
    this.nextId = 1;
    this.onServerRequest = onServerRequest;
    this.onRuntimeEvent = onRuntimeEvent;
    this.stderr = "";
    this.lines = readline.createInterface({ input: processHandle.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    processHandle.stderr.setEncoding("utf8");
    processHandle.stderr.on("data", (chunk) => { this.stderr += chunk; });
    processHandle.once("close", (code, signal) => {
      this.failAll(new Error(`Codex app-server closed (code=${code}, signal=${signal})`));
    });
  }

  send(message) {
    this.processHandle.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    this.send({ method, id, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
    });
  }

  waitFor(predicate, description, timeoutMs = 5 * 60_000) {
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
    const parsed = parse(line);
    if (!parsed) return;
    const message = parsed.raw;
    this.messages.push(message);
    // Both halves: the normalised event for the activity feed, the native
    // message for whoever needs what the normaliser does not carry.
    this.onRuntimeEvent?.(parsed);
    if (message.method && message.id !== undefined) {
      void this.handleServerRequest(message);
    } else if (message.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(String(message.id));
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
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

  async handleServerRequest(message) {
    try {
      if (!this.onServerRequest) throw new Error(`Unsupported server request: ${message.method}`);
      const result = await this.onServerRequest(message);
      this.send({ id: message.id, result });
    } catch (error) {
      if (message.method === "item/tool/call") {
        this.send({ id: message.id, result: {
          success: false,
          contentItems: [{ type: "inputText", text: `Rejected: ${error.message}` }],
        } });
      } else {
        this.send({ id: message.id, error: { code: -32000, message: error.message } });
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

  // ------------------------------------------------ the driver's verbs

  async initialize(clientInfo) {
    await this.request("initialize", { clientInfo, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized", params: {} });
  }

  // A new thread, or the stored one resumed — never a new one called a resume
  // (RUNTIME_CONTRACT §7). Returns the native session id, which the caller
  // records before the first turn so a retry continues this thread.
  async openSession({ resume = null, ...params }) {
    const [method, request] = resume
      ? codexDriver.sessions.resume(resume, params)
      : codexDriver.sessions.start(params);
    const result = await this.request(method, request);
    const sessionId = codexDriver.sessions.idFrom(result);
    if (!sessionId) throw new Error("Codex app-server did not return a thread id");
    return sessionId;
  }

  async startTurn({ sessionId, text, clientMessageId, effort = null }) {
    const [method, request] = codexDriver.run.turn({ sessionId, text, clientMessageId, effort });
    const result = await this.request(method, request);
    const turnId = result?.turn?.id;
    if (!turnId) throw new Error("Codex app-server did not return a turn id");
    return turnId;
  }

  interrupt({ sessionId, turnId }, timeoutMs = 15_000) {
    const [method, request] = codexDriver.interrupt.request({ sessionId, turnId });
    return this.request(method, request, timeoutMs);
  }

  // The turn's end, and the answer it gave: from the structured `agentMessage`,
  // never from free stdout (RUNTIME_CONTRACT §7.1).
  async completion({ sessionId, turnId }) {
    const completed = await this.waitFor(
      (message) => message.method === "turn/completed"
        && message.params?.threadId === sessionId
        && message.params?.turn?.id === turnId,
      `turn/completed for ${turnId}`,
    );
    const status = completed.params?.turn?.status ?? "unknown";
    const items = completed.params?.turn?.items ?? [];
    const response = [...items].reverse().find((item) => item.type === "agentMessage" && item.text?.trim())?.text
      ?? [...this.messages].reverse().find((message) => message.method === "item/completed"
        && message.params?.threadId === sessionId
        && message.params?.turnId === turnId
        && message.params?.item?.type === "agentMessage")?.params?.item?.text;
    return { status, response: response ?? null, raw: completed };
  }
}

export const codexDriver = Object.freeze({
  name: "codex",
  executable: adapter.executable,

  // Shown at this pair and at no other. A Codex other than 0.154.0 is
  // `unverified` until the evidence below is produced again for it.
  verified: Object.freeze({
    adapterVersion: "1.0.0",
    runtimeVersion: "0.154.0",
    evidence: Object.freeze({
      "sessions.create": "STAGE_11_1B_ACCEPTANCE.md, rc.36 live run: job 55 started a thread and bound it before turn/start",
      "sessions.resume": "STAGE_11_1B_ACCEPTANCE.md, rc.31: an existing thread resumed across the layout move",
      "run.read_only": "STAGE_11_1B_ACCEPTANCE.md, rc.30 (P-2): read-only turns sandboxed by Landlock on the host",
      "stream.structured": "STAGE_11_1B_ACCEPTANCE.md, rc.36 live run: turn/item notifications in the activity feed",
      "interrupt": "CAPABILITY_MATRIX.md §2: turn/interrupt wired to the product's interrupt action; the catalog gate's interrupt check",
      "tools.platform": "STAGE_11_1B_ACCEPTANCE.md, rc.36 live run: job 55 delegated through platform.delegate_task",
      "events.raw": "drivers.test.mjs: every app-server line reaches the session as { raw, event }",
      "account.device_login": "STAGE_11_1_ACCEPTANCE.md: ChatGPT device authorization on the host",
      "catalog.models": "catalog-refresh-worker.mjs: model/list over the account channel",
      "gate.smoke": "catalog-gate-worker.mjs: the Codex capability gate",
      "run.workspace_write": "Stage 12 X2 on the host (0.158.0): the workspace profile writes, reaches the network, and is denied ~/.codex",
      "tools.worker_report": "Stage 12 X2 on the host: codex exec called the platform bridge's MCP tool with the run's socket variables",
    }),
  }),

  // Each capability, the member that provides it, and the native mechanism.
  capabilities: Object.freeze({
    "sessions.create": { by: "sessions", native: "thread/start" },
    "sessions.resume": { by: "sessions", native: "thread/resume" },
    "run.read_only": { by: "run", native: "turn/start in a read-only sandbox, approval policy never" },
    "stream.structured": { by: "stream", native: "app-server turn/* and item/* notifications" },
    "interrupt": { by: "interrupt", native: "turn/interrupt" },
    "tools.platform": { by: "toolBridge", native: "app-server dynamicTools and item/tool/call" },
    "events.raw": { by: "normalizeEvent", native: "each JSON-RPC message kept with its method as native_type" },
    "account.device_login": { by: "input", native: "account/login/start chatgptDeviceCode" },
    "catalog.models": { by: "input", native: "model/list" },
    "gate.smoke": { by: "run", native: "the gate surface: an app-server in a scratch workspace" },
    "run.workspace_write": { by: "run", native: "`codex exec --json` under a :workspace permission profile that denies ~/.codex" },
    "tools.worker_report": { by: "toolBridge", native: "the platform bridge as an MCP server, its tools approved in advance" },
  }),

  // Where the supervisor opens it, per surface, how the workspace is found, and
  // the capability the surface exercises — refused if the driver does not
  // declare it. `grant` is resolved from the opaque grant token; `home` is the
  // runtime's own home; `gate` is a scratch directory under the gate root.
  surfaces: Object.freeze({
    project: Object.freeze({ transport: "channel", workspace: "grant", grantMode: "read_only", capability: "run.read_only" }),
    account: Object.freeze({ transport: "channel", workspace: "home", capability: "account.device_login" }),
    gate: Object.freeze({ transport: "channel", workspace: "gate", capability: "gate.smoke" }),
    // A writing run (Stage 12 X2): a batch, like the other executors.
    task: Object.freeze({ transport: "batch", workspace: "grant", grantMode: "read_write", capability: "run.workspace_write" }),
    // A pull request's review (rc.145): a batch in a scratch repository built
    // from the pull request, never the project's workspace.
    review: Object.freeze({ transport: "batch", workspace: "review", capability: "run.read_only" }),
  }),

  sessions: Object.freeze({
    start: (params) => ["thread/start", threadParams(params)],
    resume: (sessionId, params) => ["thread/resume", { threadId: sessionId, ...threadParams(params) }],
    idFrom: (result) => result?.thread?.id ?? null,
    // A writing run's session: Codex names it in its first event.
    idFromEvent: (raw) => (raw?.type === "thread.started" && typeof raw.thread_id === "string" ? raw.thread_id : null),
  }),

  run: Object.freeze({
    // The same app-server for every surface, with the registry's launch
    // configuration before the subcommand (P-2).
    // A task is `codex exec` (Stage 12 X2); every other surface the app-server.
    argv: ({ version = null, surface = null, model, sessionId = null, prompt, reasoningEffort = null, subagents = false,
      systemPrompt = null, baseBranch = null } = {}) => (surface === "task"
      ? execArgv({ model, sessionId, prompt, reasoningEffort, version, subagents, systemPrompt })
      : surface === "review" ? reviewArgv({ model, version, baseBranch, prompt })
      : [...configOverridesFor(adapter, version).flatMap((override) => ["-c", override]), "app-server", "--listen", "stdio://"]),
    // No read-only launch (`readOnlyWritable`) for a review: under a Landlock
    // ruleset Codex's own sandbox cannot start — "bwrap: setting up uid map:
    // Permission denied" (0.160 on the host, rc.145) — so a review is held
    // read-only by Codex's read-only profile, as an orchestrator's turn is,
    // and runs in a throwaway copy of the pull request, not the workspace.
    // A task's bridge serves the executor's reports.
    environment: ({ surface = null, toolBridge = [] } = {}) => [...(surface === "task" ? ["INFRA_BRIDGE_TOOLS=reports"] : []), ...toolBridge],
    // The catalog holds Codex's own names for its models.
    qualifyModel: (_provider, model) => model,
    // The effort is sent on every turn that has one: Codex keeps a turn's
    // effort for the turns after it, so a turn that sent none would inherit
    // the last one rather than get the default. None is sent when there is
    // none — the thread then runs at the model's default, unless an earlier
    // turn of it set one.
    turn: ({ sessionId, text, clientMessageId, effort = null }) => {
      const level = launchReasoningLevel(codexDriver, effort);
      return ["turn/start", {
        threadId: sessionId,
        input: [{ type: "text", text, text_elements: [] }],
        clientUserMessageId: clientMessageId,
        ...(level ? { effort: level } : {}),
      }];
    },
  }),

  // How a reasoning level reaches the runtime, and which values it may be.
  reasoning: Object.freeze({
    applied: "turn/start `effort`, on every turn that has one (sticky for later turns)",
    // A turn's effort stays with the thread, so "Default" sends the model's
    // default level rather than nothing (0116).
    sticky: true,
    levels: CODEX_EFFORTS,
    accepts: (level) => CODEX_EFFORTS.includes(level),
    discovery: "model/list supportedReasoningEfforts [{reasoningEffort, description}] and defaultReasoningEffort",
    verifiedAgainst: "rust-v0.158.0: app-server-protocol/src/protocol/v2/turn.rs:245-247, v2/model.rs:55-65",
  }),

  stream: Object.freeze({
    framing: "jsonl",
    parse,
    connect: (processHandle, handlers) => new CodexAppServerSession(processHandle, handlers),
    // A writing run's answer and failure, from its exec events.
    answer: execAnswer,
    failure: execFailure,
    usage: (stdout) => codexExecTokens(execObjects(stdout).findLast((raw) => raw.type === "turn.completed")?.usage),
  }),

  // What the supervisor lets through a channel's stdin, per surface — the
  // `channel.mode` branches the supervisor used to hold.
  input: Object.freeze({
    channelState(surface, { workspace } = {}) {
      if (surface !== "gate") return null;
      const gate = { workspace, threadId: null, turnId: null, pending: new Map() };
      return { gate, validate: createCodexGateChannelStateValidator(gate) };
    },
    validate(surface, data, state) {
      if (surface === "project") return validateReadOnlyInput(data);
      if (surface === "account") return validateCodexAccountInput(data);
      if (surface === "gate") {
        validateCodexGateInput(data);
        return state.validate(data);
      }
      throw new Error(`Codex has no ${surface} surface`);
    },
    // What the runtime answered, where the surface needs to remember it: the
    // gate binds thread and turn ids so its stdin can only name its own.
    observe(surface, state, raw) {
      if (surface === "gate") bindCodexGateResponse(state.gate, raw);
    },
    observes: (surface) => surface === "gate",
  }),

  interrupt: Object.freeze({
    mechanism: "protocol",
    // A writing run is a batch: stopped by its cgroup (Stage 12 X2).
    batch: "cgroup",
    request: ({ sessionId, turnId }) => ["turn/interrupt", { threadId: sessionId, turnId }],
  }),

  toolBridge: Object.freeze({
    transport: "dynamic_tools",
    // A writing run's terminal reports, over the MCP bridge (X2).
    tools: WORKER_REPORT_TOOLS,
    register: registerTools,
    call: toolCall,
    answer: (receipt) => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify(receipt) }] }),
    // A writing run reaches its reports through the MCP bridge, which Codex
    // hands these variables and no others (env_vars in its launch config).
    environment: ({ socket, capability, runId, sessionId = null }) => [
      `INFRA_WORKER_TOOL_SOCKET=${socket}`, `INFRA_WORKER_CAPABILITY=${capability}`, `INFRA_WORKER_RUN_ID=${runId}`,
      ...(sessionId ? [`INFRA_NATIVE_SESSION_ID=${sessionId}`] : []),
    ],
  }),

  normalizeEvent,
});
