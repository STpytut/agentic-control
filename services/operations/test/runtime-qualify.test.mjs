// Qualifying a runtime version (Stage 12 W3): a candidate beside the active
// version, checks recorded one by one, the result derived — never asserted.
import test from "node:test";
import assert from "node:assert/strict";

import { QUALIFICATION_CHECKS, memoryRecorder, qualifyRuntime, suiteFor } from "../runtime-qualify.mjs";
import { driverFor } from "../../runtime-supervisor/drivers/index.mjs";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";

const reporter = { steps: [], step(line) { this.steps.push(line); } };
const active = (version) => () => ({ codex: { active: { version } }, opencode: { active: { version } }, claude: { active: { version } } });

test("the suite is one check per capability the driver claims", () => {
  const keys = (name) => suiteFor(driverFor(name)).map((check) => check.key);
  assert.ok(keys("opencode").includes("write.commit"), "OpenCode writes");
  // Every executor writes (Stage 12 X1/X2).
  for (const name of ["codex", "opencode", "claude"]) assert.ok(keys(name).includes("write.commit"), `${name} writes`);
  assert.ok(!keys("claude").includes("catalog.list"), "Claude has no model list");
  for (const name of ["codex", "opencode", "claude"]) {
    assert.ok(keys(name).includes("read_only.shell"), `${name}: the check that would have refused Codex 0.158.0`);
    // Every capability a driver claims is covered by some check, or knowingly left to another.
    const covered = new Set(QUALIFICATION_CHECKS.map((check) => check.capability).filter(Boolean));
    const uncovered = Object.keys(driverFor(name).capabilities).filter((capability) => !covered.has(capability));
    // input.steer (rc.146): its flag is config.keys' — a version without
    // --input-format fails there; the behaviour was shown on the host.
    assert.deepEqual(uncovered.filter((capability) => !/^(sessions\.create|events\.raw|account\.|input\.steer$)/.test(capability)), [], `${name}: ${uncovered}`);
  }
});

test("a version that needs what the host lacks is refused before anything is downloaded", async () => {
  let installed = false;
  const recorder = memoryRecorder();
  const outcome = await qualifyRuntime({
    name: "codex", version: "0.158.0", actor: "root", reporter, recorder, releaseVersion: "test",
    inventory: active("0.154.0"), facts: {},
    hostProbe: (requirement) => (requirement === "bwrap.userns" ? { met: false, detail: "no bubblewrap on the runtime's PATH" } : { met: true, detail: "" }),
    install: async () => { installed = true; },
  });
  assert.equal(outcome.result, "refused");
  assert.equal(installed, false);
  assert.deepEqual(outcome.checks.map((check) => [check.key, check.result, check.failureClass]), [["host.requirements", "failed", "host"]]);
  assert.match(outcome.summary, /needs bwrap\.userns/);
});

test("a candidate that installs is incomplete until the turn checks exist", async () => {
  const recorder = memoryRecorder();
  let options;
  const outcome = await qualifyRuntime({
    name: "opencode", version: "1.18.32", actor: "root", reporter, recorder, releaseVersion: "test",
    inventory: active("1.18.31"), facts: {},
    hostProbe: () => ({ met: true, detail: "landlock" }),
    install: async (given) => { options = given; return { package: "opencode-linux-x64@1.18.32", signedBy: "SHA256:key", executableSha256: "a".repeat(64), smoke: "1.18.32" }; },
  });
  assert.equal(outcome.result, "incomplete", "never passed while checks are skipped");
  assert.equal(options.version, "1.18.32");
  const byKey = Object.fromEntries(outcome.checks.map((check) => [check.key, check.result]));
  assert.deepEqual(
    ["host.requirements", "package.signature", "executable.digest", "version.reports"].map((key) => byKey[key]),
    ["passed", "passed", "passed", "passed"],
  );
  assert.equal(byKey["read_only.shell"], "skipped");
  assert.equal(outcome.checks.length, suiteFor(driverFor("opencode")).length, "every check of the suite is recorded");
});

test("a candidate that cannot be installed fails, with the class of what failed", async () => {
  const outcome = await qualifyRuntime({
    name: "claude", version: "2.1.283", actor: "root", reporter, recorder: memoryRecorder(), releaseVersion: "test",
    inventory: active("2.1.270"), facts: {}, hostProbe: () => ({ met: true, detail: "" }),
    install: async () => { throw new Error("the registry signature for @anthropic-ai/claude-code-linux-x64@2.1.283 does not verify against the pinned key"); },
  });
  assert.equal(outcome.result, "failed");
  assert.deepEqual(outcome.checks.at(-1).key, "package.signature");
  assert.equal(outcome.checks.at(-1).failureClass, "runtime");
});

test("no active version, no qualification: a candidate is judged beside one", async () => {
  await assert.rejects(qualifyRuntime({
    name: "codex", version: "0.157.1", actor: "root", reporter, recorder: memoryRecorder(), releaseVersion: "test",
    inventory: () => ({}), facts: {}, hostProbe: () => ({ met: true }), install: async () => ({}),
  }), /no active version/);
});

// W3b: the turn checks, against a supervisor that answers like OpenCode does.
test("the turn checks read what only doing the thing could produce", async () => {
  const { runTurnChecks } = await import("../runtime-qualify-turns.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const os = await import("node:os");
  const pathModule = await import("node:path");
  const workspace = mkdtempSync(pathModule.join(os.tmpdir(), "qualify-"));
  execFileSync("git", ["-C", workspace, "init", "-q", "-b", "main"]);
  writeFileSync(pathModule.join(workspace, "qualification.txt"), "COMMITTED\n");
  execFileSync("git", ["-C", workspace, "-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
  execFileSync("git", ["-C", workspace, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "qualification commit"]);

  const events = (text, session = "ses_1") => [
    { type: "step_start", sessionID: session, part: {} },
    { type: "text", sessionID: session, part: { text } },
    { type: "step_finish", sessionID: session, part: { reason: "stop", tokens: { input: 5, output: 3 }, cost: 0 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  let remembered = null;
  const calls = [];
  const supervisor = {
    async account(request) {
      const models = request.qualification.version === "1.18.32" ? [{ id: "big-pickle" }, { id: "kimi-k3" }] : [{ id: "big-pickle" }, { id: "old-model" }];
      return { exit_code: 0, stdout: JSON.stringify({ providers: [{ provider_id: "opencode", connected: true, models }] }) };
    },
    async runQualification(request) {
      calls.push(request);
      if (request.interruptAfterMs) return { exit_code: null, interrupted: true, stdout: "", stderr: "" };
      const word = /remember this word for later: (QN[0-9A-F]+)/i.exec(request.prompt)?.[1];
      if (word) remembered = word;
      if (/What word/.test(request.prompt)) return { exit_code: 0, native_session_id: "ses_1", stdout: events(remembered), stderr: "" };
      if (/delegate_task/.test(request.prompt)) return { exit_code: 0, native_session_id: "ses_2", stdout: events("DONE"), tool_calls: [{ tool: "delegate_task" }] };
      // login.isolated: the read tool on the turn, bash on the task; both refused.
      if (/session-note/.test(request.prompt)) {
        const tool = request.surface === "task" ? "bash" : "read";
        const use = JSON.stringify({ type: "tool_use", sessionID: "ses_3", part: { tool, state: { status: "error", error: "No such file or directory" } } });
        return { exit_code: 0, stdout: `${use}\n${events("the file is not there")}`, stderr: "" };
      }
      if (request.surface === "task") return { exit_code: 0, stdout: events("done"), tool_calls: [{ tool: "complete_task" }] };
      if (/PARITY_OK/.test(request.prompt)) return { exit_code: 0, stdout: events("PARITY_OK") };
      return { exit_code: 0, native_session_id: "ses_1", stdout: `${JSON.stringify({ type: "text", sessionID: "ses_1", part: { text: "On branch main" } })}\n${events("BRANCH=main NOTE=QUALIFICATION_NOTE_OK WRITE=refused")}`, stderr: "" };
    },
  };
  const recorded = {};
  const { driverFor } = await import("../../runtime-supervisor/drivers/index.mjs");
  const suite = suiteFor(driverFor("opencode")).filter((check) => !["host.requirements", "package.signature", "executable.digest", "version.reports", "auth.present"].includes(check.key));
  await runTurnChecks({
    name: "opencode", version: "1.18.32", activeVersion: "1.18.31", qualificationId: "00000000-0000-4000-8000-000000000001",
    supervisor, prepared: { workspace, home: workspace, executable: "/bin/true", canary: { path: `${workspace}/.local/share/opencode/session-note.txt`, nonce: "NOTE-00112233aabbccdd" } },
    models: [{ provider: "opencode", model: "big-pickle" }], suite,
    record: async (key, result, options) => { recorded[key] = { result, detail: options.detail }; },
  });
  for (const key of ["read_only.shell", "stream.parse", "usage.report", "session.resume", "tools.platform", "write.commit", "tools.report", "interrupt", "session.resume_from_active", "models.in_use", "config.keys", "login.isolated"]) {
    assert.equal(recorded[key]?.result, "passed", `${key}: ${JSON.stringify(recorded[key])}`);
  }
  // The candidate's list against the active version's, read in the same home.
  assert.equal(recorded["catalog.list"].result, "passed");
  assert.match(recorded["catalog.list"].detail, /2 models; adds opencode\/kimi-k3; drops opencode\/old-model/);
  // login.isolated asked through the read tool on the turn and bash on the task.
  assert.match(recorded["login.isolated"].detail, /refused: the read tool, a writing run's script/);
  // The resume from the active version ran the active version first.
  assert.ok(calls.some((request) => request.qualification.version === "1.18.31"));
  assert.ok(calls.filter((request) => request.qualification.version === "1.18.32").length >= 5);
});

test("a version passed on this host is verified for its driver; only under the same adapter", async () => {
  const { capabilityVerification, activeQualification } = await import("../../runtime-supervisor/drivers/capabilities.mjs");
  const codex = driverFor("codex");
  const passed = { id: "q1", result: "passed", version: "0.157.1", adapterVersion: codex.verified.adapterVersion };
  assert.deepEqual(
    [capabilityVerification(codex, "0.157.1", { qualification: passed }).status, capabilityVerification(codex, "0.157.1", { qualification: passed }).verified_by],
    ["verified", "host qualification q1"],
  );
  assert.equal(capabilityVerification(codex, "0.157.1").status, "unverified", "no qualification, not the baseline");
  assert.equal(capabilityVerification(codex, "0.157.1", { qualification: { ...passed, adapterVersion: "0.9.0" } }).status, "unverified",
    "a qualification made under another adapter does not carry over");
  assert.equal(capabilityVerification(codex, "0.158.0", { qualification: passed }).status, "unverified", "a qualification is for its own version");
  assert.equal(capabilityVerification(codex, codex.verified.runtimeVersion).verified_by, "baseline");
  const entry = { active: { directory: "/opt/b" }, installed: [{ directory: "/opt/a", qualification: { id: "old" } }, { directory: "/opt/b", qualification: passed }] };
  assert.equal(activeQualification(entry).id, "q1", "the qualification of the tree that is active");
});

test("a memory refusal is waited out, and a failing run says why", async () => {
  const { admitting, lastLine } = await import("../runtime-qualify-turns.mjs");
  let calls = 0;
  const supervisor = {
    async runQualification() {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("there is no memory for another opencode run right now"), { code: "runtime_capacity" });
      return { exit_code: 0 };
    },
    other() { return this === supervisor; },
  };
  const slept = [];
  const admitted = admitting(supervisor, { waitMs: 10, forMs: 1000, sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(await admitted.runQualification({}), { exit_code: 0 });
  assert.equal(calls, 3);
  assert.deepEqual(slept, [10, 10]);
  assert.equal(admitted.other(), true);
  // Anything else is not repeated.
  const failing = admitting({ async open() { throw new Error("boom"); } }, { sleep: async () => assert.fail("slept") });
  await assert.rejects(failing.open(), /boom/);

  assert.equal(lastLine("EACCES: permission denied, mkdir '/q/home/.cache'\n    errno: -13\n\nBun v1.3.14 (Linux x64 baseline)\n"),
    "EACCES: permission denied, mkdir '/q/home/.cache'");
  assert.equal(lastLine("only this\n\n"), "only this");
});

// A Codex app-server, faked at its JSON-RPC lines: enough of thread/turn,
// interrupt, dynamic tools and model/list for every Codex turn check to run
// against it. The first host run of Codex's checks stopped on a call the
// OpenCode test could not reach (driver.run.qualifyModel); this one reaches
// every line of codexTurns.
function fakeCodexAppServer({ version, words, calls, escalate = false, surface = "gate", leaksLogin = false, workspace = "" }) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const handle = new EventEmitter();
  let next = 1;
  const pendingTool = new Map();
  // The gate channel's rule (codex-gate-channel.mjs): one thread per channel,
  // and a resume only of that thread. The supervisor refuses the rest, and the
  // client hears nothing back.
  let boundThread = null;
  const emit = (message) => stdout.write(`${JSON.stringify(message)}\n`);
  const finish = (threadId, turnId, text, status = "completed") => {
    emit({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: `i${next++}`, text } } });
    emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, items: text ? [{ type: "agentMessage", text }] : [] } } });
  };
  const answer = (threadId, turnId, prompt) => {
    emit({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
    const word = /remember this word for later: (QN[0-9A-F]+)/i.exec(prompt)?.[1];
    if (word) words.set(threadId, word);
    if (/sleep 60/.test(prompt)) {
      emit({ method: "item/started", params: { threadId, turnId, item: { type: "commandExecution", id: `c${next++}`, command: "sleep 60" } } });
      return;
    }
    if (/delegate_task/.test(prompt)) {
      const id = `srv${next++}`;
      pendingTool.set(id, () => finish(threadId, turnId, "DONE"));
      emit({ method: "item/tool/call", id, params: { threadId, turnId, callId: `call${next++}`, tool: "delegate_task", arguments: { objective: "qualification check" } } });
      return;
    }
    // login.isolated: the command runs; what it prints is the sandbox's answer,
    // or — a Codex that leaks — the file itself.
    // The check runs a script in the workspace that cats the canary (Codex's
    // model will not run a cat of a path it knows is denied).
    const scripted = /`sh check\.sh`/.test(prompt) ? /cat '([^']+)'/.exec(readFileSync(`${workspace}/check.sh`, "utf8"))?.[1] : null;
    const canary = scripted ?? /`cat (\S+session-note\.txt)`/.exec(prompt)?.[1];
    if (canary) {
      const output = leaksLogin ? readFileSync(canary, "utf8") : `cat: ${canary}: Permission denied`;
      const item = { type: "commandExecution", id: `c${next++}`, command: `cat ${canary}` };
      emit({ method: "item/started", params: { threadId, turnId, item } });
      emit({ method: "item/completed", params: { threadId, turnId, item: { ...item, aggregatedOutput: output, exitCode: leaksLogin ? 0 : 1 } } });
      finish(threadId, turnId, output);
      return;
    }
    if (escalate && /cat NOTE.md/.test(prompt)) {
      // The sandbox failed; Codex asks to run the command outside it, and
      // finishes the turn once it is answered.
      const id = next++;
      pendingTool.set(id, () => finish(threadId, turnId, "I could not run the command."));
      emit({ method: "item/commandExecution/requestApproval", id, params: { threadId, turnId, reason: "May I run the requested read-only cat command outside the restricted shell sandbox?" } });
      return;
    }
    const text = /cat NOTE.md/.test(prompt) ? "NOTE=QUALIFICATION_NOTE_OK COMMIT=qualification scratch repository WRITE=refused"
      : /What word/.test(prompt) ? (words.get(threadId) ?? "forgotten")
      : /PARITY_OK/.test(prompt) ? "PARITY_OK" : "OK";
    finish(threadId, turnId, text);
  };
  const handleRequest = (message) => {
    if (message.id !== undefined && !message.method) {
      pendingTool.get(message.id)?.();
      return;
    }
    calls.push({ version, method: message.method });
    if (message.id === undefined) return;
    const params = message.params ?? {};
    const reply = (result) => emit({ id: message.id, result });
    switch (message.method) {
      case "initialize": return reply({ userAgent: `codex/${version}` });
      case "thread/start": {
        // A thread's own sandbox would replace the launch's permission profile.
        if ("sandbox" in params) return emit({ id: message.id, error: { code: -32602, message: "a thread may not name a sandbox" } });
        if (surface === "gate" && boundThread) return undefined;
        const id = `th-${version}-${next++}`;
        boundThread ??= id;
        return reply({ thread: { id } });
      }
      case "thread/resume": {
        if ("sandbox" in params) return emit({ id: message.id, error: { code: -32602, message: "a thread may not name a sandbox" } });
        if (surface === "gate" && boundThread !== params.threadId) return undefined;
        boundThread ??= params.threadId;
        return reply({ thread: { id: params.threadId } });
      }
      case "turn/start": {
        const turnId = `tu${next++}`;
        reply({ turn: { id: turnId, status: "inProgress", items: [] } });
        const prompt = (params.input ?? []).map((item) => item.text).join("\n");
        return setImmediate(() => answer(params.threadId, turnId, prompt));
      }
      case "turn/interrupt": reply({}); return setImmediate(() => finish(params.threadId, params.turnId, "", "interrupted"));
      case "model/list": return reply({ data: (version === "0.158.0" ? ["gpt-5.6-luna", "gpt-6-luna"] : ["gpt-5.6-luna", "gpt-5.5"]).map((id) => ({ id })) });
      default: return emit({ id: message.id, error: { code: -32601, message: `no ${message.method}` } });
    }
  };
  let buffer = "";
  handle.stdin = new Writable({
    write(chunk, _encoding, done) {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        // Answered on a later tick, as a process would: a reply written inside
        // the write arrives before the client has registered what it waits for.
        if (line.trim()) setImmediate(handleRequest, JSON.parse(line));
      }
      done();
    },
    final(done) { stdout.end(); handle.emit("close", 0, null); done(); },
  });
  handle.stdout = stdout;
  handle.stderr = stderr;
  return handle;
}

// A writing run of Codex (Stage 12 X2) in a fake: the commit it would make,
// complete_task reaching the socket, and the sandbox's answer to check.sh.
function fakeCodexBatch(workspace) {
  return async (request) => {
    if (/qualification\.txt/.test(request.prompt)) {
      const { execFileSync } = await import("node:child_process");
      const { writeFileSync } = await import("node:fs");
      const git = (...args) => execFileSync("/usr/bin/git", ["-C", workspace, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
      try { git("init", "-q"); } catch {}
      writeFileSync(`${workspace}/qualification.txt`, "COMMITTED\n");
      git("add", "qualification.txt");
      git("commit", "-q", "-m", "qualification commit");
      return { exit_code: 0, stdout: "", tool_calls: [{ tool: "complete_task" }] };
    }
    const path = /`cat (\S+)`/.exec(request.prompt)?.[1] ?? "check.sh";
    const item = { type: "command_execution", command: "sh check.sh", aggregated_output: `cat: ${path}: Permission denied` };
    return { exit_code: 0, stdout: `${JSON.stringify({ type: "item.completed", item })}\n`, tool_calls: [] };
  };
}

test("Codex's turn checks run end to end against an app-server", async () => {
  const { runTurnChecks } = await import("../runtime-qualify-turns.mjs");
  const os = await import("node:os");
  const pathModule = await import("node:path");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const home = mkdtempSync(pathModule.join(os.tmpdir(), "qualify-codex-"));
  mkdirSync(pathModule.join(home, ".codex"));
  writeFileSync(pathModule.join(home, ".codex/config.toml"), "check_for_update_on_startup = false\n");
  const canary = { path: pathModule.join(home, ".codex/session-note.txt"), nonce: "NOTE-0123456789abcdef" };
  writeFileSync(canary.path, `${canary.nonce}\n`);
  const words = new Map();
  const calls = [];
  const supervisor = {
    runQualification: fakeCodexBatch(home),
    async open(request) { return fakeCodexAppServer({ version: request.qualification.version, words, calls, surface: request.surface, workspace: home }); },
  };
  const recorded = {};
  const suite = suiteFor(driverFor("codex")).filter((check) => !["host.requirements", "package.signature", "executable.digest", "version.reports", "auth.present"].includes(check.key));
  await runTurnChecks({
    name: "codex", version: "0.158.0", activeVersion: "0.154.0", qualificationId: "00000000-0000-4000-8000-000000000002",
    supervisor, prepared: { workspace: home, home, executable: "/bin/true", canary },
    models: [{ provider: "chatgpt", model: "gpt-5.6-luna" }], suite,
    record: async (key, result, options) => { recorded[key] = { result, detail: options.detail }; },
  });
  for (const check of suite) {
    assert.equal(recorded[check.key]?.result, "passed", `${check.key}: ${JSON.stringify(recorded[check.key])}`);
  }
  assert.match(recorded["catalog.list"].detail, /adds gpt-6-luna; drops gpt-5.5/);
  // The thread the active version started was resumed by the candidate.
  assert.ok(calls.some((call) => call.version === "0.154.0" && call.method === "thread/start"));
  assert.ok(calls.some((call) => call.version === "0.158.0" && call.method === "thread/resume"));
});

test("a Codex that asks to leave its sandbox is declined at once, and fails read_only.shell", async () => {
  const { runTurnChecks } = await import("../runtime-qualify-turns.mjs");
  const os = await import("node:os");
  const pathModule = await import("node:path");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const home = mkdtempSync(pathModule.join(os.tmpdir(), "qualify-codex-"));
  mkdirSync(pathModule.join(home, ".codex"));
  writeFileSync(pathModule.join(home, ".codex/config.toml"), "check_for_update_on_startup = false\n");
  const answers = [];
  const supervisor = {
    runQualification: fakeCodexBatch(home),
    async open(request) {
      const handle = fakeCodexAppServer({ version: request.qualification.version, words: new Map(), calls: [], escalate: true, surface: request.surface });
      const write = handle.stdin.write.bind(handle.stdin);
      handle.stdin.write = (chunk, ...rest) => { if (/"decision"/.test(String(chunk))) answers.push(JSON.parse(String(chunk))); return write(chunk, ...rest); };
      return handle;
    },
  };
  const recorded = {};
  const suite = suiteFor(driverFor("codex")).filter((check) => ["read_only.shell", "config.keys"].includes(check.key));
  await runTurnChecks({
    name: "codex", version: "0.158.0", activeVersion: "0.154.0", qualificationId: "00000000-0000-4000-8000-000000000003",
    supervisor, prepared: { workspace: home, home, executable: "/bin/true" },
    models: [{ provider: "chatgpt", model: "gpt-5.6-luna" }], suite,
    record: async (key, result, options) => { recorded[key] = { result, detail: options.detail }; },
  });
  assert.equal(recorded["read_only.shell"].result, "failed");
  assert.match(recorded["read_only.shell"].detail, /asked to run outside it \(declined\): May I run/);
  assert.equal(answers[0]?.result?.decision, "decline");
  // 0.158.0 launches without the legacy sandbox flag, under the platform's
  // permission profile (Stage 12 M0).
  assert.doesNotMatch(recorded["config.keys"].detail, /use_legacy_landlock/);
  assert.match(recorded["config.keys"].detail, /-c default_permissions="infra_cod_read_only"/);
});

test("a Codex whose shell prints the canary beside its login fails login.isolated, without the nonce in the evidence", async () => {
  const { runTurnChecks } = await import("../runtime-qualify-turns.mjs");
  const os = await import("node:os");
  const pathModule = await import("node:path");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const home = mkdtempSync(pathModule.join(os.tmpdir(), "qualify-codex-"));
  mkdirSync(pathModule.join(home, ".codex"));
  writeFileSync(pathModule.join(home, ".codex/config.toml"), "check_for_update_on_startup = false\n");
  const canary = { path: pathModule.join(home, ".codex/session-note.txt"), nonce: "NOTE-fedcba9876543210" };
  writeFileSync(canary.path, `${canary.nonce}\n`);
  const supervisor = {
    runQualification: fakeCodexBatch(home),
    async open(request) { return fakeCodexAppServer({ version: request.qualification.version, words: new Map(), calls: [], surface: request.surface, leaksLogin: true, workspace: home }); },
  };
  const recorded = {};
  const suite = suiteFor(driverFor("codex")).filter((check) => ["login.isolated"].includes(check.key));
  await runTurnChecks({
    name: "codex", version: "0.158.0", activeVersion: "0.154.0", qualificationId: "00000000-0000-4000-8000-000000000004",
    supervisor, prepared: { workspace: home, home, executable: "/bin/true", canary },
    models: [{ provider: "chatgpt", model: "gpt-5.6-luna" }], suite,
    record: async (key, result, options) => { recorded[key] = { result, detail: options.detail, evidence: options.evidence }; },
  });
  assert.equal(recorded["login.isolated"].result, "failed");
  assert.match(recorded["login.isolated"].detail, /read the canary beside its login: a script's cat in the shell/);
  assert.doesNotMatch(JSON.stringify(recorded), new RegExp(canary.nonce));
});

test("login.isolated is inconclusive when the supervisor placed no canary", async () => {
  const { runTurnChecks } = await import("../runtime-qualify-turns.mjs");
  const os = await import("node:os");
  const pathModule = await import("node:path");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const home = mkdtempSync(pathModule.join(os.tmpdir(), "qualify-codex-"));
  mkdirSync(pathModule.join(home, ".codex"));
  writeFileSync(pathModule.join(home, ".codex/config.toml"), "check_for_update_on_startup = false\n");
  const supervisor = {
    runQualification: fakeCodexBatch(home),
    async open(request) { return fakeCodexAppServer({ version: request.qualification.version, words: new Map(), calls: [], surface: request.surface }); },
  };
  const recorded = {};
  await runTurnChecks({
    name: "codex", version: "0.158.0", activeVersion: "0.154.0", qualificationId: "00000000-0000-4000-8000-000000000005",
    supervisor, prepared: { workspace: home, home, executable: "/bin/true", canary: null },
    models: [{ provider: "chatgpt", model: "gpt-5.6-luna" }], suite: suiteFor(driverFor("codex")).filter((check) => check.key === "login.isolated"),
    record: async (key, result, options) => { recorded[key] = { result, detail: options.detail }; },
  });
  assert.equal(recorded["login.isolated"].result, "inconclusive");
});

test("a model list refused for want of memory leaves the qualification incomplete, not the version failed", async () => {
  // rc.110: OpenCode 1.18.34 passed everything but catalog.list, refused with
  // 588 MB free of the 600 a background run needs.
  const { runTurnChecks } = await import("../runtime-qualify-turns.mjs");
  const suite = suiteFor(driverFor("opencode")).filter((check) => check.key === "catalog.list");
  const recorded = {};
  const refuse = async () => {
    const error = new Error("there is no memory for a background opencode run right now (unit headroom 588 MB, a run needs 600 MB); it waits so a task run is never short of it");
    error.code = "runtime_capacity";
    throw error;
  };
  await runTurnChecks({
    name: "opencode", version: "1.18.34", activeVersion: "1.18.32", qualificationId: "00000000-0000-4000-8000-000000000002",
    supervisor: { account: refuse, run: refuse, qualify: refuse }, prepared: { workspace: "/tmp", home: "/tmp", executable: "/bin/true" },
    models: [], suite,
    record: async (key, result, options) => { recorded[key] = { result, failureClass: options.failureClass }; },
  });
  assert.deepEqual(recorded["catalog.list"], { result: "inconclusive", failureClass: "infrastructure" });
});

// rc.142: a candidate must still offer every flag the Claude Code driver passes.
test("a flag a candidate's --help no longer lists fails config.keys", async () => {
  const { missingFlags } = await import("../runtime-qualify-turns.mjs");
  const { driverFor } = await import("../../runtime-supervisor/drivers/index.mjs");
  const flags = driverFor("claude").run.flags;
  for (const flag of ["--json-schema", "--fallback-model", "--no-session-persistence"]) assert.ok(flags.includes(flag), flag);
  const help = { stdout: flags.map((flag) => `  ${flag} <value>  what it does`).join("\n") };
  assert.deepEqual(missingFlags(flags, help), []);
  const without = { stdout: help.stdout.replace("--fallback-model <value>", "--fallback-models <value>") };
  assert.deepEqual(missingFlags(flags, without), ["--fallback-model"], "a renamed flag is not taken for the old one");
});
