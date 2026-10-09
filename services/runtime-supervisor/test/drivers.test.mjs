// The runtime drivers (WP-5b, prework A5).
//
// The risk this package carries in the plan's register is that the shared
// interface trims a runtime's real abilities. The tests below are what stand
// against it: the core each role must keep, refused by name when a driver loses
// any part of it; optional capabilities declared and queryable; native events
// kept beside the normalised ones; and every driver bound to the exact
// adapter/runtime version pair it was shown to work at.

import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import { allAdapters, adapterFor } from "../../operations/runtime-adapters.mjs";
import {
  CAPABILITIES, DRIVER_MEMBERS, ROLE_CORE, assertCapability, capabilityVerification, driverProblems,
  hasCapability, optionalCapabilities, pairOf,
} from "../drivers/capabilities.mjs";
import { allDrivers, driverFor, driverForJobType, driverForRole, driverGaps, surfaceOf } from "../drivers/index.mjs";
import { PLATFORM_COMMAND_TOOLS } from "../drivers/tool-contracts.mjs";
import { SANDBOX_SHELL } from "../sandbox-shell.mjs";

// A driver with one capability taken away, or one member, without touching the
// real one.
function without(driver, { capability, member } = {}) {
  const copy = { ...driver, capabilities: { ...driver.capabilities } };
  if (capability) delete copy.capabilities[capability];
  if (member) delete copy[member];
  return copy;
}


// Stage 12 M0: OpenCode's file tools are refused the login directory.
const LOGIN_DENIED = {
  "*/.local/share/opencode": "deny", "*/.local/share/opencode/*": "deny",
};
const LOGIN_PERMISSION = { read: LOGIN_DENIED, external_directory: LOGIN_DENIED };

test("the drivers match the registry, one to one, and each keeps its role's core", () => {
  const gaps = driverGaps({ adapters: allAdapters(), drivers: allDrivers() });
  assert.deepEqual(gaps, [], gaps.join("\n"));
  for (const adapter of allAdapters()) assert.equal(driverFor(adapter.name).name, adapter.name);
});

test("a role deprived of any capability in its core is refused, by name", () => {
  // The test the package's risk calls for: take away each mandatory capability
  // from each runtime that plays a role, and the registry refuses the driver
  // naming exactly what is missing. A core that could lose a member silently
  // would be the lowest common denominator arriving one capability at a time.
  let checked = 0;
  for (const adapter of allAdapters()) {
    const driver = driverFor(adapter.name);
    for (const role of adapter.roles) {
      assert.ok(ROLE_CORE[role], `${adapter.name} plays ${role}, which has no core`);
      for (const capability of ROLE_CORE[role]) {
        const drivers = allDrivers().map((candidate) => (candidate === driver ? without(driver, { capability }) : candidate));
        const gaps = driverGaps({ adapters: allAdapters(), drivers });
        assert.ok(
          gaps.includes(`${adapter.name} plays ${role} and does not declare ${capability}, which every ${role} must`),
          `${adapter.name} without ${capability} was not refused:\n${gaps.join("\n")}`,
        );
        checked += 1;
      }
    }
  }
  assert.equal(checked, allAdapters().reduce((sum, adapter) => sum + adapter.roles.reduce((n, role) => n + ROLE_CORE[role].length, 0), 0),
    "every capability of every role's core was taken away once, for every runtime that plays it");
});

test("the core cannot be satisfied by a declaration nothing implements", () => {
  const codex = driverFor("codex");
  // Declared, and the member that is said to provide it is gone.
  assert.ok(driverProblems(without(codex, { member: "interrupt" }), { roles: ["orchestrator"] })
    .includes("codex declares interrupt by interrupt, and has no interrupt"));
  // Declared by something that is not a member at all.
  const invented = { ...codex, capabilities: { ...codex.capabilities, interrupt: { by: "hope", native: "x" } } };
  assert.ok(driverProblems(invented).some((problem) => problem.includes('by "hope", which is not a driver member')));
  // A capability outside the vocabulary.
  const unknown = { ...codex, capabilities: { ...codex.capabilities, "teleport": { by: "run", native: "x" } } };
  assert.ok(driverProblems(unknown).includes("codex declares teleport, which is not a capability this product knows"));
  // Every member is required, whatever the role.
  for (const member of DRIVER_MEMBERS) {
    assert.ok(driverProblems(without(codex, { member })).includes(`codex has no ${member}`), member);
  }
});

test("a fictional runtime with a descriptor and no driver is named", () => {
  const fictional = { name: "fictional", executable: "fictional", roles: ["executor"] };
  assert.deepEqual(driverGaps({ adapters: [...allAdapters(), fictional], drivers: allDrivers() }),
    ["fictional is provisioned and has no runtime driver"]);
  const orphan = { ...driverFor("opencode"), name: "orphan" };
  assert.deepEqual(driverGaps({ adapters: allAdapters(), drivers: [...allDrivers(), orphan] }),
    ["orphan has a runtime driver and is not provisioned"]);
});

test("optional capabilities are declared, and can be asked about by name", () => {
  const codex = driverFor("codex");
  const opencode = driverFor("opencode");
  assert.deepEqual(optionalCapabilities(codex, adapterFor("codex").roles),
    ["account.device_login", "catalog.models", "gate.smoke"]);
  assert.deepEqual(optionalCapabilities(opencode, adapterFor("opencode").roles),
    ["account.api_key", "catalog.models", "gate.smoke", "usage.report"]);
  assert.equal(hasCapability(opencode, "usage.report"), true);
  assert.equal(hasCapability(codex, "usage.report"), false);
  assert.throws(() => hasCapability(codex, "usage"), /unknown capability/);
  // Every executor writes since Stage 12 X2; one that does not is refused by name.
  assertCapability(codex, "run.workspace_write");
  assert.throws(() => assertCapability(driverFor("claude"), "account.device_login"),
    (error) => error.code === "capability_not_declared");
  for (const driver of allDrivers()) {
    for (const capability of Object.keys(driver.capabilities)) assert.ok(CAPABILITIES[capability], capability);
  }
});

// ------------------------------------------------------ the version pair
//
// Native samples in the shapes each driver reads, filed under the exact pair.
// Moving a driver's `verified.runtimeVersion` without filing samples — and
// evidence — for the new version fails here and in driverProblems: a capability
// shown at one version is not a capability shown at the next.
const NATIVE_SAMPLES = {
  "codex adapter 1.0.0 / runtime 0.154.0": [
    { method: "turn/started", params: { threadId: "t", turn: { id: "u" } } },
    { method: "item/started", params: { threadId: "t", turnId: "u", item: { type: "commandExecution" } } },
    { method: "item/completed", params: { threadId: "t", turnId: "u", item: { type: "agentMessage", text: "ok" } } },
    { method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "completed", items: [] } } },
    { method: "thread/tokenUsage/updated", params: { threadId: "t" } },
  ],
  "opencode adapter 1.0.0 / runtime 1.18.31": [
    { type: "step_start", sessionID: "ses_1", part: {} },
    { type: "tool_use", sessionID: "ses_1", part: { tool: "complete_task", state: { status: "completed" } } },
    { type: "text", sessionID: "ses_1", part: { text: "done" } },
    { type: "step_finish", sessionID: "ses_1", part: { reason: "stop", tokens: { input: 1, output: 2 }, cost: 0 } },
    { type: "reasoning", sessionID: "ses_1", part: { text: "…" } },
  ],
  // Claude Code's shapes, as the PoC recorded them on the host at 2.1.270
  // (claude-streams/). Since Stage 12 rate_limit_event is normalised (the
  // subscription's windows); a system event other than init is still kept raw.
  "claude adapter 1.1.0 / runtime 2.1.270": [
    { type: "system", subtype: "init", session_id: "s-1", model: "claude-haiku-4-5-20251001", tools: ["Read", "Glob", "Grep"] },
    { type: "assistant", session_id: "s-1", message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__platform__delegate_task", input: {} }] } },
    { type: "user", session_id: "s-1", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }] } },
    { type: "assistant", session_id: "s-1", message: { content: [{ type: "text", text: "DONE" }] } },
    { type: "rate_limit_event", session_id: "s-1", rate_limit_info: { status: "allowed" } },
    { type: "result", subtype: "success", is_error: false, session_id: "s-1", result: "DONE",
      usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }, total_cost_usd: 0.01 },
    { type: "system", subtype: "status", session_id: "s-1" },
  ],
};

test("each driver is bound to the exact adapter/runtime pair it was shown at", () => {
  for (const driver of allDrivers()) {
    const pair = pairOf(driver);
    assert.ok(NATIVE_SAMPLES[pair], `no native samples are filed for ${pair}; a new runtime version is unverified until they are`);
    assert.deepEqual(driverProblems(driver).filter((problem) => problem.includes("evidence")), [], pair);
    // Exact, in both directions: a patch release is not the version shown.
    assert.equal(capabilityVerification(driver, driver.verified.runtimeVersion).status, "verified");
    const [major, minor, patch] = driver.verified.runtimeVersion.split(".").map(Number);
    assert.equal(capabilityVerification(driver, `${major}.${minor}.${patch + 1}`).status, "unverified");
    assert.equal(capabilityVerification(driver, null).status, "unverified");
  }
  const moved = { ...driverFor("codex"), verified: { ...driverFor("codex").verified, runtimeVersion: "0.155" } };
  assert.ok(driverProblems(moved).includes("codex's verified runtimeVersion is not exact"));
});

test("every native event is kept beside its normalised form, including the ones not normalised", () => {
  for (const driver of allDrivers()) {
    const samples = NATIVE_SAMPLES[pairOf(driver)];
    const parsed = samples.map((sample) => driver.stream.parse(JSON.stringify(sample)));
    // Nothing dropped: an event the product does not normalise is a native
    // extension the panel may skip, not an event that never happened.
    assert.equal(parsed.filter(Boolean).length, samples.length, driver.name);
    parsed.forEach((entry, index) => assert.deepEqual(entry.raw, samples[index]));
    const normalised = parsed.filter((entry) => entry.event);
    assert.ok(normalised.length >= 3, `${driver.name} normalised ${normalised.length}`);
    for (const { raw, event } of normalised) {
      assert.match(event.eventType, /^runtime\.[a-z0-9_.-]+$/);
      assert.equal(event.details.native_type, raw.method ?? raw.type, "the native type travels with the event");
    }
    assert.ok(parsed.some((entry) => entry.event === null), `${driver.name}: an unnormalised sample is kept raw`);
    assert.equal(driver.stream.parse("not json"), null);
    assert.equal(driver.stream.parse("   "), null);
  }
});

// ------------------------------------------------------ what each driver does

test("the Codex driver launches one app-server, with the registry's configuration, on every surface", () => {
  const codex = driverFor("codex");
  // A version nobody knows launches as the newest: under the permission
  // profile that hides the login (Stage 12 M0).
  assert.deepEqual(codex.run.argv(), ["-c", 'default_permissions="infra_cod_read_only"',
    "-c", 'permissions.infra_cod_read_only={extends=":read-only",filesystem={"~/.codex"="deny","/home/codex-worker/.codex"="deny"}}',
    "app-server", "--listen", "stdio://"]);
  assert.deepEqual(Object.keys(codex.surfaces).sort(), ["account", "gate", "project", "review", "task"]);
  assert.equal(surfaceOf(codex, "project").grantMode, "read_only");
  // Two runtimes play the orchestrator since 11.2 N4: its job types and its
  // role no longer name one, and asking is refused, not answered with the
  // first. The vendor's job names are gone since 11.2 N6 (migration 0077).
  assert.throws(() => driverForJobType("codex_chat_turn"), /no runtime serves the job type "codex_chat_turn"/);
  assert.throws(() => driverForJobType("orchestrator_turn"), /3 runtimes serve the job type "orchestrator_turn"/);
  assert.throws(() => driverForJobType("resume_orchestrator"), /the job's assignment says which/);
  assert.throws(() => driverForRole("orchestrator"), /3 runtimes play orchestrator/);
});

test("the Codex driver lets through a channel's stdin what that surface allows, and nothing else", () => {
  const { input } = driverFor("codex");
  const line = (message) => `${JSON.stringify(message)}\n`;
  const readOnly = line({ id: 1, method: "thread/start", params: { cwd: "/w", model: "m", approvalPolicy: "never" } });
  input.validate("project", readOnly, null);
  // Stage 12 M0: the launch's permission profile is the sandbox. A message that
  // names one — even read-only — would replace the profile that hides the login.
  for (const params of [{ sandbox: "read-only" }, { sandbox: "workspace-write" }, { config: { default_permissions: ":workspace" } }, { approvalPolicy: "on-request" }]) {
    assert.throws(() => input.validate("project", line({ id: 1, method: "thread/start", params }), null), /may not set one/, JSON.stringify(params));
    assert.throws(() => input.validate("project", line({ id: 1, method: "thread/resume", params: { threadId: "t", ...params } }), null), /may not set one/);
  }
  assert.throws(() => input.validate("project", line({ id: 1, method: "turn/start", params: { threadId: "t", sandboxPolicy: { type: "dangerFullAccess" } } }), null), /may not set one/);
  // What app-server serves beside turns, and a turn never needs.
  for (const method of ["fs/readFile", "command/exec", "config/value/write", "thread/shellCommand"]) {
    assert.throws(() => input.validate("project", line({ id: 1, method, params: {} }), null), /does not permit/, method);
  }
  input.validate("project", line({ id: "srv1", result: { contentItems: [] } }), null);
  assert.throws(() => input.validate("account", readOnly, null), /does not permit thread\/start/);
  input.validate("account", line({ id: 1, method: "model/list", params: {} }), null);
  const state = input.channelState("gate", { workspace: "/srv/infra-cod/gate-smoke/x" });
  assert.equal(input.observes("gate"), true);
  assert.equal(input.observes("project"), false);
  assert.throws(() => input.validate("gate", line({ id: 1, method: "turn/interrupt", params: { threadId: "t", turnId: "u" } }), state));
  assert.throws(() => input.validate("task", readOnly, null), /no task surface/);
});

test("the Codex driver's sessions, turns, interrupts and tools speak app-server", () => {
  const codex = driverFor("codex");
  const params = { cwd: "/w", model: "m", instructions: "i", tools: codex.toolBridge.register(PLATFORM_COMMAND_TOOLS) };
  const [start, startParams] = codex.sessions.start(params);
  assert.equal(start, "thread/start");
  assert.equal("sandbox" in startParams, false, "the launch's permission profile is the sandbox");
  assert.equal(startParams.approvalPolicy, "never");
  assert.deepEqual(startParams.dynamicTools[0].tools.map((tool) => tool.name), ["delegate_task", "request_revision", "consult"]);
  const [resume, resumeParams] = codex.sessions.resume("thr_1", params);
  assert.equal(resume, "thread/resume");
  assert.equal(resumeParams.threadId, "thr_1");
  assert.equal(codex.sessions.idFrom({ thread: { id: "thr_1" } }), "thr_1");
  assert.deepEqual(codex.run.turn({ sessionId: "thr_1", text: "hi", clientMessageId: "e1" }), ["turn/start", {
    threadId: "thr_1", input: [{ type: "text", text: "hi", text_elements: [] }], clientUserMessageId: "e1",
  }]);
  assert.deepEqual(codex.interrupt.request({ sessionId: "thr_1", turnId: "u" }),
    ["turn/interrupt", { threadId: "thr_1", turnId: "u" }]);
  assert.deepEqual(codex.toolBridge.call({ method: "item/tool/call", params: {
    threadId: "t", turnId: "u", callId: "c", namespace: "platform", tool: "delegate_task", arguments: { a: 1 },
  } }), { sessionId: "t", turnId: "u", callId: "c", namespace: "platform", tool: "delegate_task", arguments: { a: 1 } });
  assert.equal(codex.toolBridge.call({ method: "turn/started" }), null);
});

// A channel the way the supervisor client hands one over: stdout, stderr, stdin.
function fakeChannel(answer) {
  const handle = new EventEmitter();
  handle.stdout = new PassThrough();
  handle.stderr = new PassThrough();
  handle.stdin = new PassThrough();
  handle.stdin.setEncoding("utf8");
  handle.sent = [];
  handle.stdin.on("data", (chunk) => {
    for (const line of chunk.split("\n").filter(Boolean)) {
      const message = JSON.parse(line);
      handle.sent.push(message);
      // Answered on a later turn of the loop, as a process would: a PassThrough
      // in flowing mode delivers synchronously, before the request is pending.
      setImmediate(() => {
        for (const reply of answer(message) ?? []) handle.stdout.write(`${JSON.stringify(reply)}\n`);
      });
    }
  });
  return handle;
}

test("a Codex turn runs through the driver's session: open, turn, a tool call, completion", async () => {
  const codex = driverFor("codex");
  const events = [];
  const calls = [];
  const handle = fakeChannel((message) => {
    if (message.method === "initialize") return [{ id: message.id, result: {} }];
    if (message.method === "thread/resume") return [{ id: message.id, result: { thread: { id: message.params.threadId } } }];
    if (message.method === "turn/start") {
      return [
        { id: message.id, result: { turn: { id: "turn_1" } } },
        { method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_1" } } },
        { id: 99, method: "item/tool/call", params: { threadId: "thr_1", turnId: "turn_1", callId: "c1",
          namespace: "platform", tool: "delegate_task", arguments: { objective: "do it" } } },
      ];
    }
    if (message.id === 99) {
      return [{ method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed",
        items: [{ type: "agentMessage", text: "delegated" }] } } }];
    }
    return [];
  });
  const session = codex.stream.connect(handle, {
    onServerRequest: async (message) => {
      const call = codex.toolBridge.call(message);
      calls.push(call);
      return codex.toolBridge.answer({ status: "delegated" });
    },
    onRuntimeEvent: (entry) => events.push(entry),
  });
  await session.initialize({ name: "test" });
  const sessionId = await session.openSession({ resume: "thr_1", cwd: "/w", model: "m", instructions: "i", tools: [] });
  assert.equal(sessionId, "thr_1");
  assert.equal("sandbox" in handle.sent.find((message) => message.method === "thread/resume").params, false);
  const turnId = await session.startTurn({ sessionId, text: "go", clientMessageId: "evt_1" });
  const outcome = await session.completion({ sessionId, turnId });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.response, "delegated");
  assert.equal(calls[0].tool, "delegate_task");
  assert.deepEqual(handle.sent.find((message) => message.id === 99).result,
    { success: true, contentItems: [{ type: "inputText", text: "{\"status\":\"delegated\"}" }] });
  // Raw and normalised, both kept: the server request has no normalised form
  // and still reached the session.
  assert.ok(events.some((entry) => entry.raw.method === "item/tool/call" && entry.event === null));
  assert.ok(events.some((entry) => entry.event?.eventType === "runtime.turn.completed"));
  session.close();
});

test("the OpenCode driver builds the run it always ran, and says how it is interrupted", () => {
  const opencode = driverFor("opencode");
  assert.deepEqual(opencode.run.argv({ model: "opencode-go/m", prompt: "p" }),
    ["run", "--pure", "--auto", "--format", "json", "--model", "opencode-go/m", "p"]);
  assert.deepEqual(opencode.run.argv({ model: "m", sessionId: "ses_1", prompt: "p" }),
    ["run", "--pure", "--auto", "--format", "json", "--model", "m", "--session", "ses_1", "p"]);
  assert.equal(opencode.run.qualifyModel("opencode-go", "m"), "opencode-go/m");
  assert.equal(opencode.run.qualifyModel(null, "m"), "m");
  assert.deepEqual(opencode.run.environment({
    toolBridge: opencode.toolBridge.environment({ socket: "/run/s.sock", capability: "cap", runId: "run" }),
  }), ["OPENCODE_DISABLE_AUTOUPDATE=true", "OPENCODE_AUTO_SHARE=false",
    `SHELL=${SANDBOX_SHELL}`, "INFRA_COD_HIDDEN_STATE=.local/share/opencode:/home/opencode-worker/.local/share/opencode",
    `OPENCODE_CONFIG_CONTENT=${JSON.stringify({ permission: LOGIN_PERMISSION })}`,
    "INFRA_WORKER_TOOL_SOCKET=/run/s.sock", "INFRA_WORKER_CAPABILITY=cap", "INFRA_WORKER_RUN_ID=run"]);
  assert.equal(opencode.interrupt.mechanism, "cgroup");
  assert.equal(opencode.sessions.idFromEvent({ sessionID: "ses_1" }), "ses_1");
  assert.equal(opencode.sessions.idFromEvent({}), null);
  assert.equal(surfaceOf(opencode, "task").grantMode, "read_write");
  // Two runtimes execute since Stage 12 X1: the job's assignment chooses, and
  // asking by job type or role is refused rather than answered with the first.
  assert.throws(() => driverForJobType("implementation_run"), /3 runtimes serve the job type "implementation_run"/);
  assert.throws(() => driverForRole("executor"), /3 runtimes play executor/);
  assert.deepEqual(opencode.toolBridge.definitions, adapterFor("opencode").toolDefinitions);
  assert.throws(() => opencode.input.validate("task", "x"), /no channel/);
  assert.equal(opencode.input.account({ operation: "status" }).operation, "status");
});

// OpenCode as an orchestrator (11.2 N4). Its project surface is a read-only
// batch; the driver declares the orchestrator's whole core, so the registry
// admits it for both roles; and each run is told which tools are its own and,
// for a turn, that it may not edit, run a shell or fetch — the second layer of
// D5 under the kernel's.
test("OpenCode's project surface is a read-only batch whose run config denies what a turn may not do", () => {
  const opencode = driverFor("opencode");
  assert.deepEqual(surfaceOf(opencode, "project"),
    { transport: "batch", workspace: "grant", grantMode: "read_only", capability: "run.read_only" });
  assert.deepEqual(driverProblems(opencode, { roles: ["orchestrator", "executor", "analyst"] }), []);
  const configOf = (environment) => JSON.parse(environment.find((entry) => entry.startsWith("OPENCODE_CONFIG_CONTENT="))
    ?.slice("OPENCODE_CONFIG_CONTENT=".length) ?? "null");

  const turn = opencode.run.environment({ surface: "project", toolBridge: ["INFRA_WORKER_TOOL_SOCKET=/s"] });
  assert.ok(turn.includes("OPENCODE_DISABLE_PROJECT_CONFIG=true"), "a workspace's opencode.json could widen the turn");
  assert.ok(turn.includes("INFRA_WORKER_TOOL_SOCKET=/s"));
  assert.deepEqual(configOf(turn), {
    permission: { ...LOGIN_PERMISSION, edit: "deny", bash: { "*": "deny", "git status": "allow" }, webfetch: "deny" },
    tools: { complete_task: false, report_blocker: false, request_user_input: false },
  });
  // A turn's shell runs `git status` under Landlock, which would not let
  // bubblewrap mount: no sandbox shell there.
  assert.ok(!turn.some((entry) => entry.startsWith("SHELL=")));
  const implementation = opencode.run.environment({ surface: "task" });
  assert.deepEqual(configOf(implementation), { permission: LOGIN_PERMISSION, tools: { delegate_task: false, request_revision: false, consult: false, task: false } });
  assert.ok(!implementation.includes("OPENCODE_DISABLE_PROJECT_CONFIG=true"), "the executor's behaviour changed");
  // Stage 12 M0: every open shell runs in the sandbox shell, the login covered.
  for (const environment of [implementation, opencode.run.environment({ surface: "gate" }), opencode.run.environment()]) {
    assert.ok(environment.includes(`SHELL=${SANDBOX_SHELL}`));
    assert.ok(environment.includes("INFRA_COD_HIDDEN_STATE=.local/share/opencode:/home/opencode-worker/.local/share/opencode"));
  }
  assert.deepEqual(configOf(opencode.run.environment({ surface: "gate" })), { permission: LOGIN_PERMISSION });
  assert.deepEqual(opencode.toolBridge.platformTools, ["delegate_task", "request_revision", "consult"]);
  for (const path of ["/tmp", "/dev/null", ...adapterFor("opencode").writableState]) {
    assert.ok(opencode.run.readOnlyWritable.includes(path), `${path} is not writable in a turn`);
  }
  assert.ok(!opencode.run.readOnlyWritable.some((path) => path.startsWith("/srv")), "a workspace is writable in a turn");
});

test("a turn's answer is the text of the last message the run wrote", () => {
  const { answer } = driverFor("opencode").stream;
  const line = (value) => JSON.stringify(value);
  const stdout = [
    line({ type: "step_start", sessionID: "ses_1" }),
    line({ type: "text", sessionID: "ses_1", part: { messageID: "m1", text: "Let me look." } }),
    line({ type: "tool_use", sessionID: "ses_1", part: { tool: "delegate_task", state: { status: "completed" } } }),
    line({ type: "text", sessionID: "ses_1", part: { messageID: "m2", text: "Delegated " } }),
    line({ type: "text", sessionID: "ses_1", part: { messageID: "m2", text: "to the executor." } }),
    "not json",
  ].join("\n");
  assert.equal(answer(stdout), "Delegated to the executor.");
  assert.equal(answer(line({ type: "step_finish" })), "");
});

test("a run that failed says why: the provider's refusal on stdout", () => {
  const { failure } = driverFor("opencode").stream;
  // rc.44 on the host: exit 1, stderr empty, this on stdout.
  const refused = JSON.stringify({ type: "error", sessionID: "ses_1", error: { name: "APIError",
    data: { message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode", statusCode: 403 } } });
  assert.equal(failure(`${JSON.stringify({ type: "step_start" })}\n${refused}\n`),
    "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode");
  assert.equal(failure(JSON.stringify({ type: "text", part: { text: "fine" } })), "");
});

// OpenRouter's model ids carry a slash of their own. The gate once took a slash
// to mean the provider was already there and ran `openai/gpt-6-luna` against a
// provider nobody had signed in to (rc.46); every launch now asks the driver.
test("a model is qualified by its provider, whatever slashes its own id has", () => {
  const opencode = driverFor("opencode");
  assert.equal(opencode.run.qualifyModel("openrouter", "openai/gpt-6-luna"), "openrouter/openai/gpt-6-luna");
  assert.equal(opencode.run.qualifyModel("opencode", "big-pickle"), "opencode/big-pickle");
  const gate = readFileSync(new URL("../../control-plane/catalog-gate-worker.mjs", import.meta.url), "utf8");
  // The model check lane (Stage 12 W6) names its claim a check.
  assert.match(gate, /driver\.run\.qualifyModel\(check\.provider_id, check\.model_id\)/);
  assert.doesNotMatch(gate, /model_id\.includes\("\/"\)/);
});

// ------------------------------------------------------ Claude Code (sprint C K2)

const claudeStream = (name) => readFileSync(new URL(`./claude-streams/${name}`, import.meta.url), "utf8");

test("the Claude Code driver runs a turn read-only, with the platform's tools and nothing of the workspace's", () => {
  const claude = driverFor("claude");
  assert.deepEqual(Object.keys(claude.surfaces).sort(), ["account", "consult", "gate", "project", "task"]);
  assert.equal(surfaceOf(claude, "project").grantMode, "read_only");
  // Stage 12 X1: an executor too, decision C2's reason closed by M0.
  assert.deepEqual(adapterFor("claude").roles, ["orchestrator", "executor", "analyst"]);

  const argv = claude.run.argv({ model: "haiku", newSessionId: "11111111-1111-4111-8111-111111111111", prompt: "Plan it", surface: "project" });
  const after = (flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(argv[0], "-p");
  assert.equal(after("--tools"), "Read,Glob,Grep", "Write, Edit and Bash are not offered at all");
  assert.equal(after("--allowedTools"), "Read,Glob,Grep,mcp__platform__delegate_task,mcp__platform__request_revision,mcp__platform__consult");
  assert.equal(after("--permission-mode"), "dontAsk");
  assert.equal(after("--setting-sources"), "user", "the workspace's .claude settings and hooks do not apply");
  // rc.67 on the host: Read returned a canary beside the subscription's
  // credential. The runtime's own state is denied to every read tool.
  assert.equal(after("--disallowedTools"), "Read(~/.claude/**),Read(~/.claude.json)");
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.equal(after("--session-id"), "11111111-1111-4111-8111-111111111111");
  assert.equal(after("--output-format"), "stream-json");
  // The prompt last, straight after the model: no variadic option can take it.
  assert.deepEqual(argv.slice(-3), ["--model", "haiku", "Plan it"]);
  const mcp = JSON.parse(after("--mcp-config"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["platform"]);
  assert.match(mcp.mcpServers.platform.args[0], /claude-mcp\/platform-bridge\.mjs$/);
  assert.ok(!after("--mcp-config").includes("CAPABILITY"), "the capability travels in the environment only");

  // A resumed turn names the session it continues, and never chooses a new one.
  const resumed = claude.run.argv({ model: "haiku", sessionId: "s-1", prompt: "Next", surface: "project" });
  assert.equal(resumed[resumed.indexOf("--resume") + 1], "s-1");
  assert.ok(!resumed.includes("--session-id"));
  // The gate offers no tool.
  const gate = claude.run.argv({ model: "haiku", prompt: "PARITY_OK" });
  assert.equal(gate[gate.indexOf("--tools") + 1], "");
  assert.equal(gate[gate.indexOf("--disallowedTools") + 1], "Read(~/.claude/**),Read(~/.claude.json)");
  assert.ok(!gate.includes("--mcp-config"));
  // The sign-in (rc.123) runs `claude auth login`, never a prompt; an unknown surface is refused.
  assert.deepEqual(claude.run.argv({ model: "haiku", prompt: "x", surface: "account" }), ["auth", "login"]);
  assert.throws(() => claude.run.argv({ model: "haiku", prompt: "x", surface: "chat" }), /no "chat" surface/);
  // Stage 12 X1: an executor's run writes the workspace; its Bash runs in the
  // sandbox shell with the login covered and the shell snapshots kept, and its
  // bridge serves the terminal reports — never the orchestrator's commands.
  const task = claude.run.argv({ model: "sonnet", prompt: "go", surface: "task", newSessionId: "00000000-0000-4000-8000-000000000009" });
  assert.equal(task[task.indexOf("--tools") + 1], "Read,Glob,Grep,Edit,Write,Bash");
  assert.deepEqual(task[task.indexOf("--allowedTools") + 1].split(","), ["Read", "Glob", "Grep", "Edit", "Write", "Bash",
    "mcp__platform__complete_task", "mcp__platform__report_blocker", "mcp__platform__request_user_input"]);
  assert.equal(task[task.indexOf("--disallowedTools") + 1], "Read(~/.claude/**),Read(~/.claude.json)");
  assert.equal(task[task.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(task.at(-1), "go");
  const taskEnvironment = claude.run.environment({ surface: "task" });
  for (const entry of [`CLAUDE_CODE_SHELL=${SANDBOX_SHELL}`, `SHELL=${SANDBOX_SHELL}`, "INFRA_BRIDGE_TOOLS=reports",
    "INFRA_COD_KEPT_STATE=.claude/shell-snapshots",
    "INFRA_COD_HIDDEN_STATE=.claude:.claude.json:/home/claude-worker/.claude:/home/claude-worker/.claude.json"]) {
    assert.ok(taskEnvironment.includes(entry), entry);
  }
  assert.ok(!claude.run.environment({ surface: "project" }).some((entry) => /SHELL|INFRA_BRIDGE_TOOLS/.test(entry)),
    "an orchestrator's turn has no shell and serves the commands");

  // Every launch carries the self-update switches, and the bridge its run.
  const environment = claude.run.environment({ toolBridge: claude.toolBridge.environment({
    socket: "/run/s.sock", capability: "c".repeat(32), runId: "r-1", sessionId: "s-1" }) });
  assert.ok(environment.includes("DISABLE_AUTOUPDATER=1") && environment.includes("DISABLE_UPDATES=1"));
  assert.ok(environment.includes("INFRA_NATIVE_SESSION_ID=s-1"));
  assert.equal(claude.run.qualifyModel("anthropic", "haiku"), "haiku");
  assert.ok(claude.run.readOnlyWritable.includes("/home/claude-worker/.claude.json"));
  assert.match(claude.sessions.newId(), /^[0-9a-f-]{36}$/);
});

test("the Claude Code driver reads the recorded streams: the answer, the session and why a turn failed", () => {
  const claude = driverFor("claude");
  const turn = claudeStream("stream-orchestrator-mcp.jsonl");
  assert.equal(claude.stream.answer(turn), "DONE");
  assert.equal(claude.stream.failure(turn), "");
  const parsed = turn.split("\n").map((line) => claude.stream.parse(line)).filter(Boolean);
  const sessions = new Set(parsed.map(({ raw }) => claude.sessions.idFromEvent(raw)).filter(Boolean));
  assert.equal(sessions.size, 1, "one session through the turn");
  assert.ok(parsed.some(({ event }) => event?.eventType === "runtime.tool.updated" && event.details.tool === "mcp__platform__delegate_task"));
  const usage = parsed.find(({ event }) => event?.eventType === "runtime.turn.usage").event;
  assert.ok(usage.details.tokens.output > 0 && usage.details.tokens.total >= usage.details.tokens.output);
  // A subscription's list price is kept since Stage 12, and says it is one: the
  // panel shows it as an estimate, never as money spent.
  assert.equal(usage.details.cost, 0.027229);
  assert.equal(usage.details.cost_basis, "list_estimate");
  assert.equal(usage.details.tokens.reasoning, 423, "the thinking tokens are split out of output_tokens");
  assert.equal(usage.details.tokens.output, 701 - 423);
  const limits = parsed.find(({ event }) => event?.eventType === "runtime.limits.updated").event;
  assert.deepEqual(limits.details.rate_limits.windows.map((w) => [w.key, w.used_percent, w.window_minutes]),
    [["five_hour", 78, 300], ["seven_day", 10, 10_080]]);

  // A failed turn says `subtype: "success"`; is_error and the error decide.
  assert.match(claude.stream.failure(claudeStream("stream-exit-auth.jsonl")), /^Claude Code not signed in/);
  assert.match(claude.stream.failure(claudeStream("stream-exit-model.jsonl")), /^Claude Code model not available/);
  assert.equal(claude.stream.answer(claudeStream("stream-exit-auth.jsonl")).includes("Please run /login"), true);
  assert.ok(claude.stream.answer(claudeStream("stream-resume.jsonl")).length > 0);

  // The init event names the model the alias resolved to (alias drift, §2.4);
  // no other event does, and the other drivers read none.
  const resolved = parsed.map(({ raw }) => claude.stream.resolvedModel(raw)).filter(Boolean);
  assert.deepEqual(resolved, ["claude-haiku-4-5-20251001"]);
  assert.equal(claude.stream.resolvedModel({ type: "system", subtype: "init" }), null);
  for (const other of ["codex", "opencode"]) assert.equal(driverFor(other).stream.resolvedModel, undefined);
});

// ------------------------------------------------ reasoning levels (Stage 12)

test("a reasoning level reaches each runtime only when the member has one, and only as a value its driver allows", () => {
  const codex = driverFor("codex");
  const claude = driverFor("claude");
  const opencode = driverFor("opencode");

  // Codex: turn/start's `effort`, absent when there is none.
  for (const none of [undefined, null, ""]) {
    assert.ok(!("effort" in codex.run.turn({ sessionId: "t", text: "x", clientMessageId: "c", effort: none })[1]));
  }
  assert.equal(codex.run.turn({ sessionId: "t", text: "x", clientMessageId: "c", effort: "xhigh" })[1].effort, "xhigh");
  for (const bad of ["banana", "--effort", "high; rm", "HIGH"]) {
    assert.throws(() => codex.run.turn({ sessionId: "t", text: "x", clientMessageId: "c", effort: bad }),
      (error) => error.code === "reasoning_effort_unsupported", `Codex sent ${bad}`);
  }

  // Claude Code: --effort, before the fixed tail, the prompt still last.
  const plain = claude.run.argv({ model: "opus", sessionId: "s-1", prompt: "Plan it", surface: "project" });
  assert.ok(!plain.includes("--effort"), "a member at the default sends no --effort");
  const argv = claude.run.argv({ model: "opus", sessionId: "s-1", prompt: "Plan it", surface: "project", reasoningEffort: "max" });
  assert.equal(argv[argv.indexOf("--effort") + 1], "max");
  assert.deepEqual(argv.slice(-3), ["--model", "opus", "Plan it"]);
  assert.deepEqual(argv.filter((item) => item !== "--effort" && item !== "max"), plain);
  for (const bad of ["ultracode", "minimal", "-x", "high max"]) {
    assert.throws(() => claude.run.argv({ model: "opus", prompt: "p", surface: "project", reasoningEffort: bad }),
      (error) => error.code === "reasoning_effort_unsupported", `Claude Code took ${bad}`);
  }

  // OpenCode: --variant after the model, before the session and the prompt.
  assert.deepEqual(opencode.run.argv({ model: "m", sessionId: "ses_1", prompt: "p", reasoningEffort: "thinking" }),
    ["run", "--pure", "--auto", "--format", "json", "--model", "m", "--variant", "thinking", "--session", "ses_1", "p"]);
  assert.deepEqual(opencode.run.argv({ model: "m", prompt: "p", reasoningEffort: null }),
    ["run", "--pure", "--auto", "--format", "json", "--model", "m", "p"]);
  for (const bad of ["-x", "--session", "a b", "x".repeat(65)]) {
    assert.throws(() => opencode.run.argv({ model: "m", prompt: "p", reasoningEffort: bad }),
      (error) => error.code === "reasoning_effort_unsupported", `OpenCode took ${bad}`);
  }
});

test("Claude Code's effort table is the driver's, and the database's copy of it is the same table", () => {
  const claude = driverFor("claude");
  assert.match(claude.reasoning.source, /model-config/);
  assert.equal(claude.reasoning.forModel("claude-opus-5-5").default, "medium");
  assert.deepEqual(claude.reasoning.forModel("claude-sonnet-4-6[1m]").levels, ["low", "medium", "high", "max"]);
  assert.deepEqual(claude.reasoning.forModel("claude-haiku-4-5-20251001"), { levels: [], default: "" });
  assert.deepEqual(claude.reasoning.forModel("claude-opus-4-20250514"), { levels: [], default: "" }, "a date is not a minor version");
  assert.equal(claude.reasoning.forModel("claude-opus-4-7-20260101").default, "xhigh");
  assert.deepEqual(claude.reasoning.forModel(""), { levels: [], default: "" });

  const sql = readFileSync(new URL("../../../db/migrations/0110_catalog_reasoning_levels.sql", import.meta.url), "utf8");
  const rows = [...sql.matchAll(/\('(\w+)',\s*'([\d.]+)',\s*'(\[[^\]]*\])'::jsonb,\s*'(\w+)'\)/g)]
    .map(([, family, version, levels, fallback]) => ({ family, version, levels: JSON.parse(levels), default: fallback }));
  assert.ok(rows.length >= 10, `found ${rows.length} rows in claude_reasoning_levels`);
  assert.deepEqual(rows, claude.reasoning.byModel.map((row) => ({ ...row, levels: [...row.levels] })),
    "claude_reasoning_levels (0110) and the Claude driver's table differ");
});

test("the catalog keeps a model's levels as bounded tokens, with descriptions and the default", async () => {
  const { catalogReasoningLevels } = await import("../drivers/reasoning.mjs");
  // Codex's model/list shape.
  assert.deepEqual(catalogReasoningLevels([
    { reasoningEffort: "low", description: "  Fast  " }, { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "low" }, { reasoningEffort: "--flag" }, { reasoningEffort: 3 }, { reasoningEffort: "high" },
  ], { levelKeys: ["reasoningEffort"], defaultLevel: "medium" }), [
    { level: "low", description: "Fast" }, { level: "medium", description: "Balanced", default: true }, { level: "high" },
  ]);
  // OpenCode's variant names.
  assert.deepEqual(catalogReasoningLevels(["high", "max", "bad name"]), [{ level: "high" }, { level: "max" }]);
  assert.deepEqual(catalogReasoningLevels(undefined), []);
  assert.equal(catalogReasoningLevels(Array.from({ length: 40 }, (_, index) => `l${index}`)).length, 16);
});

test("a launch's provenance carries the level it sent, and nothing when it sent none", async () => {
  const { launchProvenance } = await import("../provenance.mjs");
  const codex = driverFor("codex");
  assert.ok(!("reasoning_effort" in launchProvenance(codex, null, { surface: "project", model: "m" })));
  assert.equal(launchProvenance(codex, null, { surface: "project", model: "m", reasoningEffort: "high" }).reasoning_effort, "high");
});

// Stage 12 X2: a writing run of Codex is `codex exec --json`, whose events are
// typed, not JSON-RPC (recorded at 0.158.0 on the host).
test("Codex's writing run reads its exec events: the session, the answer, the failure and the usage", () => {
  const codex = driverFor("codex");
  const lines = [
    { type: "thread.started", thread_id: "01a0ecb6-97fa-7d50-9a90-34e9e583c410" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "item_0", type: "mcp_tool_call", server: "platform", tool: "complete_task", status: "in_progress" } },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Done: added the parser." } },
    { type: "turn.completed", usage: { input_tokens: 24034, cached_input_tokens: 20992, output_tokens: 152, reasoning_output_tokens: 58 } },
  ];
  const parsed = lines.map((line) => codex.stream.parse(JSON.stringify(line)));
  assert.equal(codex.sessions.idFromEvent(parsed[0].raw), "01a0ecb6-97fa-7d50-9a90-34e9e583c410");
  assert.equal(parsed[2].event.details.tool, "complete_task");
  assert.equal(parsed[2].event.details.native_type, "item.started");
  assert.equal(parsed[4].event.eventType, "runtime.turn.usage");
  assert.ok(parsed[4].event.details.tokens, "the turn's tokens are kept");
  const stdout = lines.map((line) => JSON.stringify(line)).join("\n");
  assert.equal(codex.stream.answer(stdout), "Done: added the parser.");
  assert.equal(codex.stream.failure(stdout), "");
  assert.match(codex.stream.failure(`${stdout}\n${JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit." } })}`), /^Codex rate limited/);
  // The app-server's JSON-RPC still parses as it did.
  assert.equal(codex.stream.parse(JSON.stringify({ method: "turn/started", params: {} })).event.eventType, "runtime.turn.started");
  assert.deepEqual(codex.run.environment({ surface: "task" }), ["INFRA_BRIDGE_TOOLS=reports"]);
  assert.deepEqual(codex.run.environment({ surface: "project" }), []);
});

// Stage 12 (0147): an analyst's run reads a snapshot and calls nothing.
test("an analyst's consult surface is a read-only snapshot run with no tool of the platform's", () => {
  for (const name of ["claude", "opencode"]) {
    assert.deepEqual(surfaceOf(driverFor(name), "consult"), { transport: "batch", workspace: "snapshot", capability: "run.read_only" });
    assert.ok(adapterFor(name).roles.includes("analyst"));
    assert.ok(adapterFor(name).dispatch.jobTypes.includes("consultation_run"));
  }
  assert.ok(!adapterFor("codex").roles.includes("analyst"), "Codex is not an analyst until its read-only exec is qualified");

  const claude = driverFor("claude");
  const argv = claude.run.argv({ model: "haiku", prompt: "Read it", surface: "consult" });
  const after = (flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(after("--tools"), "Read,Glob,Grep");
  assert.equal(after("--allowedTools"), "Read,Glob,Grep", "no platform tool is allowed");
  assert.equal(after("--disallowedTools"), "Read(~/.claude/**),Read(~/.claude.json)");
  assert.ok(!argv.includes("--mcp-config"), "no bridge is started");
  assert.deepEqual(claude.run.environment({ surface: "consult" }).filter((entry) => /SHELL|BRIDGE/.test(entry)), []);

  const opencode = driverFor("opencode");
  const environment = opencode.run.environment({ surface: "consult" });
  const config = JSON.parse(environment.find((entry) => entry.startsWith("OPENCODE_CONFIG_CONTENT=")).slice("OPENCODE_CONFIG_CONTENT=".length));
  assert.ok(environment.includes("OPENCODE_DISABLE_PROJECT_CONFIG=true"), "the repository's own OpenCode config is not loaded");
  assert.equal(config.permission.bash, "deny");
  assert.equal(config.permission.edit, "deny");
  assert.ok(Object.entries(config.tools).every(([, enabled]) => enabled === false));
  assert.deepEqual(Object.keys(config.tools).sort(), ["complete_task", "consult", "delegate_task", "report_blocker", "request_revision", "request_user_input", "task"]);
});

// M7: a runtime's own subagents, only for a member the operator allowed them.
test("subagents are offered to a writer or an analyst only when the member allows them", () => {
  const claude = driverFor("claude");
  const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
  for (const surface of ["task", "consult"]) {
    assert.doesNotMatch(after(claude.run.argv({ model: "haiku", prompt: "x", surface }), "--tools"), /Task/);
    const on = claude.run.argv({ model: "haiku", prompt: "x", surface, subagents: true });
    assert.match(after(on, "--tools"), /,Task$/);
    assert.match(after(on, "--allowedTools"), /\bTask\b/);
  }
  assert.doesNotMatch(claude.run.argv({ model: "haiku", prompt: "x", surface: "project", subagents: true }).join(" "), /\bTask\b/,
    "the orchestrator's turn is not changed");

  const opencode = driverFor("opencode");
  const toolsOf = (environment) => JSON.parse(environment.find((entry) => entry.startsWith("OPENCODE_CONFIG_CONTENT="))
    .slice("OPENCODE_CONFIG_CONTENT=".length)).tools;
  for (const surface of ["task", "consult"]) {
    assert.equal(toolsOf(opencode.run.environment({ surface })).task, false);
    assert.equal(toolsOf(opencode.run.environment({ surface, subagents: true })).task, true);
  }

  const codex = driverFor("codex");
  const version = adapterFor("codex").baselineVersion ?? "0.160.0";
  const off = codex.run.argv({ surface: "task", model: "gpt", prompt: "x", version });
  const on = codex.run.argv({ surface: "task", model: "gpt", prompt: "x", version, subagents: true });
  assert.ok(off.includes("features.multi_agent=false"));
  assert.ok(!on.includes("features.multi_agent=false"));
});

// rc.142: an analyst's answer in the report's shape, and a member's fallback.
test("Claude Code holds an analyst to the report's schema, keeps no session, and falls back only where a member set it", () => {
  const claude = driverFor("claude");
  const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
  const consult = claude.run.argv({ model: "opus", prompt: "Read it", surface: "consult" });
  assert.deepEqual(JSON.parse(after(consult, "--json-schema")).required, ["summary", "findings", "open_questions"]);
  assert.ok(consult.includes("--no-session-persistence"));
  assert.equal(consult.at(-1), "Read it", "the prompt stays last");
  for (const surface of ["task", "project", "gate"]) {
    assert.ok(!claude.run.argv({ model: "opus", prompt: "x", surface }).includes("--json-schema"), surface);
  }

  for (const surface of ["task", "consult"]) {
    assert.equal(after(claude.run.argv({ model: "opus", prompt: "x", surface, fallbackModel: "claude-sonnet-5-5" }), "--fallback-model"),
      "claude-sonnet-5-5", surface);
    assert.ok(!claude.run.argv({ model: "opus", prompt: "x", surface }).includes("--fallback-model"));
  }
  assert.ok(!claude.run.argv({ model: "opus", prompt: "x", surface: "project", fallbackModel: "sonnet" }).includes("--fallback-model"),
    "the orchestrator's turn is not changed");
  assert.ok(!claude.run.argv({ model: "opus", prompt: "x", surface: "task", fallbackModel: "opus" }).includes("--fallback-model"),
    "a fallback that is the model itself is not passed");
  assert.ok(!claude.run.argv({ model: "opus", prompt: "x", surface: "task", fallbackModel: "--tools=Bash" }).includes("--fallback-model"),
    "a fallback is a model name, never a flag");
});

test("an analyst's structured output is its answer, rendered as the report", () => {
  const claude = driverFor("claude");
  const stdout = [
    { type: "system", subtype: "init", model: "claude-haiku-5-5", session_id: "s" },
    { type: "result", subtype: "success", is_error: false, result: "{\"summary\":\"raw\"}", session_id: "s",
      structured_output: { summary: "The timer resets in one place.", open_questions: ["Is reset also on load?"],
        findings: [{ file: "src/timer.js", line: 42, claim: "reset() clears the interval" }, { claim: "no tests cover it" }] } },
  ].map((line) => JSON.stringify(line)).join("\n");
  assert.equal(claude.stream.answer(stdout), [
    "The timer resets in one place.",
    "**Findings**\n- `src/timer.js:42` — reset() clears the interval\n- no tests cover it",
    "**Open questions**\n- Is reset also on load?",
  ].join("\n\n"));
});

// rc.143: a role's instructions apart from the message, where each runtime takes them.
test("each runtime takes a role's instructions where it keeps a system prompt, and OpenCode at the head of the prompt", () => {
  const role = "You are the implementation worker.\nCommit your \"work\".";
  const claude = driverFor("claude");
  const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
  for (const surface of ["project", "task", "consult"]) {
    const argv = claude.run.argv({ model: "opus", prompt: "Do it", surface, systemPrompt: role });
    assert.equal(after(argv, "--append-system-prompt"), role, surface);
    assert.equal(argv.at(-1), "Do it", "the message stays the prompt, last");
    assert.ok(!argv.includes("--system-prompt"), "Claude Code's own system prompt is kept, never replaced");
  }
  assert.ok(!claude.run.argv({ model: "opus", prompt: "x", surface: "gate", systemPrompt: role }).includes("--append-system-prompt"));
  assert.ok(!claude.run.argv({ model: "opus", prompt: "x", surface: "task" }).includes("--append-system-prompt"));

  const opencode = driverFor("opencode");
  assert.equal(opencode.run.argv({ model: "m", prompt: "Do it", systemPrompt: role }).at(-1), `${role}\n\nDo it`);
  assert.equal(opencode.run.argv({ model: "m", prompt: "Do it" }).at(-1), "Do it");

  const codex = driverFor("codex");
  const version = adapterFor("codex").baselineVersion ?? "0.160.0";
  const argv = codex.run.argv({ surface: "task", model: "gpt", prompt: "Do it", version, systemPrompt: role });
  assert.ok(argv.includes(`developer_instructions=${JSON.stringify(role)}`));
  assert.ok(argv.indexOf(`developer_instructions=${JSON.stringify(role)}`) < argv.indexOf("exec"), "a config override precedes the subcommand");
  assert.equal(argv.at(-1), "Do it");
});

test("the platform's subagents are offered to a Claude Code writer or analyst only with subagents allowed", () => {
  const claude = driverFor("claude");
  const agentsOf = (argv) => (argv.includes("--agents") ? JSON.parse(argv[argv.indexOf("--agents") + 1]) : null);
  assert.equal(agentsOf(claude.run.argv({ model: "opus", prompt: "x", surface: "task" })), null);
  const task = agentsOf(claude.run.argv({ model: "opus", prompt: "x", surface: "task", subagents: true }));
  assert.deepEqual(Object.keys(task).sort(), ["explorer", "test-runner"]);
  assert.deepEqual(task.explorer.tools, ["Read", "Glob", "Grep"], "the explorer cannot write");
  assert.ok(task["test-runner"].tools.every((tool) => ["Read", "Glob", "Grep", "Bash"].includes(tool)), "no tool the run lacks");
  const consult = agentsOf(claude.run.argv({ model: "opus", prompt: "x", surface: "consult", subagents: true }));
  assert.deepEqual(Object.keys(consult), ["explorer"], "an analyst runs nothing");
  assert.equal(agentsOf(claude.run.argv({ model: "opus", prompt: "x", surface: "project", subagents: true })), null);
  assert.equal(agentsOf(claude.run.argv({ model: "opus", prompt: "x", surface: "gate", subagents: true })), null);
  // Agents are of no use without the tool that starts them.
  for (const surface of ["task", "consult"]) {
    const argv = claude.run.argv({ model: "opus", prompt: "x", surface, subagents: true });
    for (const flag of ["--tools", "--allowedTools"]) assert.match(argv[argv.indexOf(flag) + 1], /\bTask\b/, `${surface} ${flag}`);
  }
});
