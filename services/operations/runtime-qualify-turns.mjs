// The qualification checks that run turns (Stage 12 W3b,
// RUNTIMES_AND_MODELS_DESIGN §3.2). Each runs the candidate through the
// supervisor's qualification surface — its own executable, in a scratch home
// and a scratch repository — and records one check.
//
// The prompts are short and the answers are checked for facts the model could
// only know by doing the thing: a line of a file it had to read, a word it had
// to remember across a resume, a commit that exists afterwards. A check whose
// cause is outside the runtime — no model to run, a usage limit — is
// `inconclusive`, which keeps the qualification from passing without blaming
// the version.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import { adapterFor, configOverridesFor } from "./runtime-adapters.mjs";
import { runCandidateProbe } from "./runtime.mjs";
import { driverFor } from "../runtime-supervisor/drivers/index.mjs";
import { PLATFORM_COMMAND_TOOLS } from "../runtime-supervisor/drivers/tool-contracts.mjs";
import { CodexGateSession } from "../control-plane/codex-gate-session.mjs";
import { collectGateAgentText, parseGateThreadResult, parseGateTurnCompleted, parseGateTurnResult } from "../control-plane/codex-gate-transcript.mjs";

const NOTE = "QUALIFICATION_NOTE_OK";
const LIMIT = /usage limit|rate limit|quota|429|too many requests|insufficient credit|out of credits/i;

// The line of a failing run's stderr that names the failure: the last one that
// says error, else the last that says anything. Bun ends a crash with its own
// version banner, and OpenCode's EACCES on the host was a few lines above it.
export const lastLine = (text) => {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines.findLast((line) => /error|denied|EACCES|ENOENT|EPERM/i.test(line)) ?? lines.at(-1) ?? "").slice(0, 300);
};

const nonce = () => `QN${randomBytes(4).toString("hex").toUpperCase()}`;

const READ_ONLY_PROMPT = {
  opencode: [
    "This is a platform check of this environment.",
    "1. Run the shell command `git status` and note the branch name.",
    "2. Read the file NOTE.md and find its second line.",
    "3. Try to create a file named probe.txt containing the word WRITE (it is expected to be refused).",
    "Reply with one line: BRANCH=<branch> NOTE=<second line of NOTE.md> WRITE=<refused or allowed>.",
  ].join("\n"),
  claude: [
    "This is a platform check of this environment.",
    "1. Read the file NOTE.md with your Read tool and find its second line.",
    "2. Try to create a file named probe.txt containing the word WRITE, if any of your tools can (it is expected not to be possible).",
    "Reply with one line: NOTE=<second line of NOTE.md> WRITE=<refused or allowed>.",
  ].join("\n"),
  codex: [
    "This is a platform check of this environment.",
    "1. Run the shell command `cat NOTE.md` and note its second line.",
    "2. Run the shell command `git log -1 --oneline` and note the commit subject.",
    "3. Run the shell command `touch probe.txt` (it is expected to be refused).",
    "Reply with one line: NOTE=<second line> COMMIT=<subject> WRITE=<refused or allowed>.",
  ].join("\n"),
};

// The supervisor, with its memory refusal waited out. A run's memory stays
// reserved for the admission's growth window after it ends, so the second turn
// of a qualification was refused on the host and every check after it stopped.
// The refusal is raised before anything is spawned, so repeating it is safe.
export function admitting(supervisor, { waitMs = 15_000, forMs = 300_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const retried = (method) => async (...args) => {
    for (const until = Date.now() + forMs; ;) {
      try {
        return await supervisor[method](...args);
      } catch (error) {
        if (error?.code !== "runtime_capacity" || Date.now() + waitMs > until) throw error;
        await sleep(waitMs);
      }
    }
  };
  const wrapped = { runQualification: retried("runQualification"), open: retried("open"), account: retried("account") };
  return new Proxy(supervisor, {
    get: (target, key) => wrapped[key] ?? (typeof target[key] === "function" ? target[key].bind(target) : target[key]),
  });
}

// Everything a check needs about the candidate, gathered once.
export async function runTurnChecks({ name, version, activeVersion, qualificationId, supervisor: direct, prepared, models, suite, record, admit = admitting }) {
  const supervisor = admit(direct);
  const driver = driverFor(name);
  const adapter = adapterFor(name);
  const want = new Set(suite.map((check) => check.key));
  const done = new Set();
  const note = async (key, result, options = {}) => {
    if (!want.has(key) || done.has(key)) return;
    done.add(key);
    await record(key, result, options);
  };
  const inconclusiveRest = async (detail) => {
    for (const check of suite) if (!done.has(check.key)) await note(check.key, "inconclusive", { failureClass: "infrastructure", detail });
  };

  // What a probe as the runtime's user says in the scratch home.
  const probe = (args, extra = []) => runCandidateProbe(adapter, prepared.executable, args, { home: prepared.home, extraEnvironment: extra });

  // auth.present: the copied login is usable by the candidate.
  let started = Date.now();
  if (adapter.authEvidence) {
    const evidence = runCandidateProbe(adapter, "/usr/bin/test", ["-s", path.join(prepared.home, adapter.authEvidence.path)], { home: prepared.home });
    await note("auth.present", evidence.ok ? "passed" : "failed", {
      failureClass: "runtime", started,
      detail: evidence.ok ? `${adapter.authEvidence.of} is present in the scratch home` : `${adapter.authEvidence.of} was not copied or is empty`,
    });
  } else {
    const auth = probe(adapter.authProbe);
    await note("auth.present", auth.ok ? "passed" : "failed", { failureClass: "runtime", started, detail: auth.ok ? "the auth probe answers" : (auth.stderr || auth.stdout).split("\n")[0] });
  }

  // config.keys: the switches the adapter relies on are honoured at this version.
  started = Date.now();
  await note(...configKeys(name, adapter, prepared, probe, started, version));

  if (models.length === 0) {
    await inconclusiveRest(`no model is in use on ${name}; nothing to run turns with`);
    return;
  }
  // Codex has no batch run and so no qualifyModel: its app-server takes the
  // model id as the catalog has it (the first host run stopped here).
  const model = driver.run?.qualifyModel ? driver.run.qualifyModel(models[0].provider, models[0].model) : models[0].model;
  const q = { id: qualificationId, version };

  if (name === "codex") {
    await codexTurns({ driver, q, model, models, activeVersion, prepared, supervisor, note, qualificationId });
  } else {
    await batchTurns({ name, driver, q, model, models, activeVersion, prepared, supervisor, note });
  }
  await catalogList({ name, driver, q, activeVersion, supervisor, note });
  await inconclusiveRest("not reached");
}

// What `infra-cod runtime qualify` hands qualifyRuntime: a supervisor
// connection, the scratch repository and home, the checks, and the cleanup —
// which copies back a login the candidate refreshed.
export function supervisorTurns({ connect }) {
  return async (options) => {
    const supervisor = await connect();
    let prepared = null;
    try {
      prepared = await supervisor.prepareQualification({ runtime: options.name, version: options.version, qualificationId: options.qualificationId });
      await runTurnChecks({ ...options, supervisor, prepared });
    } finally {
      if (prepared) await supervisor.cleanupQualification({ runtime: options.name, qualificationId: options.qualificationId }).catch(() => {});
      supervisor.close();
    }
  };
}

function configKeys(name, adapter, prepared, probe, started, version = null) {
  if (name === "codex") {
    let config = "";
    try { config = readFileSync(path.join(prepared.home, ".codex/config.toml"), "utf8"); } catch {}
    const ok = /^\s*check_for_update_on_startup\s*=\s*false\s*$/m.test(config.split(/^\s*\[/m)[0]);
    return ["config.keys", ok ? "passed" : "failed", {
      failureClass: "runtime", started,
      detail: ok ? `check_for_update_on_startup = false in the root table; launched with ${configOverridesFor(adapter, version).map((value) => `-c ${value}`).join(" ") || "no -c overrides"}`
        : "the scratch home's config.toml does not carry check_for_update_on_startup = false",
    }];
  }
  if (name === "claude") {
    const answer = probe(["update"]);
    const text = `${answer.stdout}\n${answer.stderr}`;
    const refused = /disabled/i.test(text);
    return ["config.keys", refused ? "passed" : "failed", {
      failureClass: "runtime", started,
      detail: refused ? "`claude update` refused with the adapter's switches" : `\`claude update\` was not refused: ${text.trim().split("\n")[0].slice(0, 200)}`,
    }];
  }
  // OpenCode: its update runs only from the TUI, which is never launched; the
  // tree is root-owned and its digest recorded, so an update could not replace
  // what runs even if a version started calling it from `run`.
  return ["config.keys", "passed", {
    started,
    detail: `${adapter.autoUpdate.setting} is passed on every launch; the executable tree is root-owned and its digest recorded`,
  }];
}

function answerOf(driver, result) {
  try { return String(driver.stream.answer(result?.stdout ?? "") ?? ""); } catch { return ""; }
}

function limited(result) {
  return LIMIT.test(`${result?.stdout ?? ""}\n${result?.stderr ?? ""}`);
}

function streamFacts(driver, stdout) {
  const lines = String(stdout ?? "").split("\n").filter((line) => line.trim());
  const parsed = lines.map((line) => driver.stream.parse(line));
  return {
    lines: lines.length,
    unparsed: parsed.filter((entry) => !entry).length,
    normalised: parsed.filter((entry) => entry?.event).length,
    usage: parsed.some((entry) => entry && (
      (entry.raw?.type === "step_finish" && entry.raw?.part?.tokens)
      || (entry.raw?.type === "result" && entry.raw?.usage)
    )),
  };
}

// The canary's path in a script in the scratch workspace, owned by the runtime
// user: the model is asked to run the script, and the refusal, if it comes,
// is the sandbox's. Null when the script cannot be placed.
function placeCheckScript(prepared, file, user) {
  const script = path.join(prepared.workspace, "check.sh");
  try {
    writeFileSync(script, `#!/bin/sh\ncat '${file.replaceAll("'", "'\\''")}'\n`, { mode: 0o644 });
    execFileSync("/usr/bin/chown", [user, script]);
    return script;
  } catch {
    rmSync(script, { force: true });
    return null;
  }
}

// What a covered path answers: Codex's profile refuses it, the sandbox shell's
// tmpfs has nothing there.
function coverRefusal(seen, file) {
  return seen.includes(`${file}: Permission denied`) || seen.includes(`${file}: No such file or directory`);
}

// login.isolated (Stage 12 M0): each attempt asks the model to print the
// canary the supervisor put beside the scratch login. The nonce must not come
// back anywhere; an attempt whose tool never ran proves nothing. The nonce is
// never written into the evidence.
async function loginIsolated(prepared, started, attempts) {
  const canary = prepared.canary;
  if (!canary?.path || !canary?.nonce) {
    return ["login.isolated", "inconclusive", { failureClass: "infrastructure", started, detail: "the supervisor placed no canary beside the scratch login" }];
  }
  const results = [];
  for (const attempt of attempts) {
    const result = await attempt(canary.path);
    results.push({ how: result.how, ran: result.ran, read: String(result.seen ?? "").includes(canary.nonce) });
  }
  const read = results.filter((result) => result.read);
  const unproven = results.filter((result) => !result.read && !result.ran);
  return ["login.isolated", read.length ? "failed" : unproven.length ? "inconclusive" : "passed", {
    failureClass: read.length ? "runtime" : unproven.length ? "infrastructure" : undefined, started,
    detail: read.length ? `the model read the canary beside its login: ${read.map((result) => result.how).join(", ")}`
      : unproven.length ? `the tool did not run: ${unproven.map((result) => result.how).join(", ")}`
      : `refused: ${results.map((result) => result.how).join(", ")}`,
    evidence: { attempts: results },
  }];
}

// write.commit and tools.report: a writing run commits a file and reports
// through the platform's complete_task — every executor, whatever its bridge
// (OpenCode's tool files, the MCP bridge of Claude Code and Codex).
async function writeChecks({ run, prepared, note }) {
  const started = Date.now();
  const writing = await run({ surface: "task", prompt: [
    "This is a platform check. Create a file named qualification.txt containing the word COMMITTED,",
    "commit it with the message \"qualification commit\", then call the complete_task tool with a one-line summary.",
  ].join("\n") });
  let log = "";
  try { log = execFileSync("/usr/bin/git", ["-C", prepared.workspace, "-c", "safe.directory=*", "log", "--oneline", "-3"], { encoding: "utf8" }); } catch {}
  const committed = /qualification commit/.test(log) && existsSync(path.join(prepared.workspace, "qualification.txt"));
  await note("write.commit", committed ? "passed" : "failed", { failureClass: "runtime", started, detail: committed ? "the commit exists" : `git log: ${log.trim().split("\n")[0] ?? ""}; exit ${writing.exit_code}` });
  const reported = (writing.tool_calls ?? []).some((call) => call.tool === "complete_task");
  await note("tools.report", reported ? "passed" : "failed", { failureClass: "runtime", started, detail: reported ? "complete_task reached the worker socket" : "no report tool was called" });
}

// The login check through a writing run's shell: a workspace script, whose
// refusal is the sandbox's.
function taskShellAttempt({ run, prepared, user, toolName }) {
  return async (file) => {
    const scripted = placeCheckScript(prepared, file, user);
    const prompt = scripted
      ? "This is a platform check. Run exactly the shell command `sh check.sh` in the current directory and reply with what it printed, or with its error. Do not commit anything."
      : `This is a platform check. Run exactly the shell command \`cat ${file}\` and reply with what it printed, or with its error. Do not commit anything.`;
    try {
      const shell = await run({ surface: "task", prompt });
      const seen = `${shell.stdout ?? ""}\n${shell.stderr ?? ""}`;
      const ran = new RegExp(`"(tool|name|type)"\\s*:\\s*"${toolName}"`, "i").test(String(shell.stdout ?? "")) || (Boolean(scripted) && coverRefusal(seen, file));
      return { how: "a writing run's script", ran, seen };
    } finally {
      if (scripted) rmSync(scripted, { force: true });
    }
  };
}

async function batchTurns({ name, driver, q, model, models, activeVersion, prepared, supervisor, note }) {
  const run = (options) => supervisor.runQualification({ runtime: name, qualification: q, model, ...options });
  const word = nonce();

  // read_only.shell, stream.parse, usage.report — one read-only turn.
  let started = Date.now();
  const readOnly = await run({ surface: "project", prompt: `${READ_ONLY_PROMPT[name]}\nAlso remember this word for later: ${word}` });
  const answer = answerOf(driver, readOnly);
  const probeWritten = existsSync(path.join(prepared.workspace, "probe.txt"));
  if (limited(readOnly)) {
    await note("read_only.shell", "inconclusive", { failureClass: "infrastructure", started, detail: "the provider answered with a usage limit" });
  } else {
    const shellOk = name !== "opencode" || /On branch main|BRANCH=main/i.test(`${readOnly.stdout}\n${answer}`);
    const ok = readOnly.exit_code === 0 && !readOnly.read_only_refused && answer.includes(NOTE) && shellOk && !probeWritten;
    await note("read_only.shell", ok ? "passed" : "failed", {
      failureClass: "runtime", started,
      detail: ok ? `read NOTE.md${name === "opencode" ? " and ran git status" : ""}; the write was refused`
        : readOnly.read_only_refused ? `the read-only launch refused to start: ${lastLine(readOnly.stderr)}`
        : probeWritten ? "probe.txt was written in a read-only turn"
        : `exit ${readOnly.exit_code}; answer: ${answer.slice(0, 200) || lastLine(readOnly.stderr) || String(readOnly.stdout ?? "").trim().slice(0, 300)}`,
      evidence: { exit_code: readOnly.exit_code, probe_written: probeWritten },
    });
  }
  const facts = streamFacts(driver, readOnly.stdout);
  await note("stream.parse", facts.lines > 0 && facts.unparsed === 0 && facts.normalised >= 2 ? "passed" : "failed", {
    failureClass: "runtime", started, detail: `${facts.lines} lines, ${facts.normalised} normalised, ${facts.unparsed} not parsed`, evidence: facts,
  });
  await note("usage.report", facts.usage ? "passed" : "failed", { failureClass: "runtime", started, detail: facts.usage ? "tokens reported" : "no usage in the stream" });

  // login.isolated — the canary beside the login, through the read tool on the
  // turn's surface and through the shell on the writer's.
  started = Date.now();
  // OpenCode names a tool in `part.tool`, Claude Code in `tool_use.name`.
  const toolRan = (result, tool) => new RegExp(`"(tool|name)"\\s*:\\s*"${tool}"`, "i").test(String(result?.stdout ?? ""));
  const loginAttempts = [async (file) => {
    const reading = await run({ surface: "project", prompt: `This is a platform check. Use your file reading tool to read ${file} and reply with its content, or with the error.` });
    return { how: "the read tool", ran: toolRan(reading, "read"), seen: `${reading.stdout ?? ""}\n${reading.stderr ?? ""}` };
  }];
  if (driver.surfaces.task) loginAttempts.push(taskShellAttempt({ run, prepared, user: adapterFor(name).user, toolName: "bash" }));
  await note(...await loginIsolated(prepared, started, loginAttempts));

  // session.resume — the same session, a word only it knows.
  started = Date.now();
  if (readOnly.native_session_id) {
    const resumed = await run({ surface: "project", nativeSessionId: readOnly.native_session_id, prompt: "What word did I ask you to remember? Reply with the word only." });
    const ok = answerOf(driver, resumed).includes(word);
    await note("session.resume", ok ? "passed" : "failed", { failureClass: "runtime", started, detail: ok ? "the resumed session remembered the word" : `answer: ${answerOf(driver, resumed).slice(0, 200)}` });
  } else {
    await note("session.resume", "failed", { failureClass: "runtime", started, detail: "the run reported no session id" });
  }

  // tools.platform — the platform's command, answered by the stub.
  started = Date.now();
  const tools = await run({ surface: "project", prompt: [
    "This is a platform check. Call the delegate_task tool exactly once with",
    "objective \"qualification check\", instructions [\"no changes\"] and relevant_paths [\"NOTE.md\"].",
    "Then reply DONE.",
  ].join("\n") });
  const delegated = (tools.tool_calls ?? []).some((call) => call.tool === "delegate_task");
  await note("tools.platform", delegated ? "passed" : "failed", { failureClass: "runtime", started, detail: delegated ? "delegate_task reached the platform" : `tools called: ${(tools.tool_calls ?? []).map((call) => call.tool).join(", ") || "none"}` });

  // write.commit and tools.report — a writing run.
  if (driver.surfaces.task) await writeChecks({ run, prepared, note });

  // interrupt — a long turn, stopped.
  started = Date.now();
  const stopped = await run({ surface: "project", interruptAfterMs: 4000, prompt: "Write a detailed essay of at least 2000 words about the history of version control." });
  await note("interrupt", stopped.interrupted ? "passed" : "failed", { failureClass: "runtime", started, detail: stopped.interrupted ? `stopped after ${Date.now() - started} ms` : "the run ended on its own before the interrupt" });

  // session.resume_from_active — a session the active version made, resumed by the candidate.
  started = Date.now();
  const remembered = nonce();
  const first = await supervisor.runQualification({ runtime: name, qualification: { ...q, version: activeVersion }, model, surface: "project",
    prompt: `Remember this word for later: ${remembered}. Reply OK.` });
  if (first.native_session_id) {
    const second = await run({ surface: "project", nativeSessionId: first.native_session_id, prompt: "What word did I ask you to remember? Reply with the word only." });
    const ok = answerOf(driver, second).includes(remembered);
    await note("session.resume_from_active", ok ? "passed" : "failed", { failureClass: "runtime", started, detail: ok ? `${q.version} resumed a session ${activeVersion} created` : `answer: ${answerOf(driver, second).slice(0, 200)}` });
  } else {
    await note("session.resume_from_active", "inconclusive", { failureClass: "infrastructure", started, detail: `the active ${activeVersion} reported no session id` });
  }

  // models.in_use — each on the candidate.
  started = Date.now();
  const results = [];
  for (const entry of models) {
    const parity = await supervisor.runQualification({ runtime: name, qualification: q, surface: "project",
      model: driver.run.qualifyModel(entry.provider, entry.model), prompt: "Reply with exactly the word PARITY_OK and nothing else." });
    results.push({ model: entry.model, ok: answerOf(driver, parity).includes("PARITY_OK"), limited: limited(parity) });
  }
  const failedModels = results.filter((result) => !result.ok && !result.limited);
  await note("models.in_use", failedModels.length ? "failed" : results.some((result) => result.limited) ? "inconclusive" : "passed", {
    failureClass: failedModels.length ? "runtime" : "infrastructure", started,
    detail: results.map((result) => `${result.model}: ${result.ok ? "ok" : result.limited ? "limited" : "failed"}`).join(", "),
    evidence: { models: results },
  });
}

async function codexTurns({ driver, q, model, models, activeVersion, prepared, supervisor, note }) {
  // A writing run is a batch (`codex exec`), beside the gate channel's turns.
  const batch = (options) => supervisor.runQualification({ runtime: "codex", qualification: q, model, ...options });
  const open = async (version) => new CodexGateSession(await supervisor.open({ runtime: "codex", surface: "gate", qualification: { ...q, version } }));
  const initialize = (session) => session.request("initialize", {
    clientInfo: { name: "infra_cod", title: "infra_cod qualification", version: "0.1.0" }, capabilities: { experimentalApi: true },
  }, 30_000).then(() => session.send({ method: "initialized", params: {} }));
  const text = (value) => [{ type: "text", text: value, text_elements: [] }];
  // A request to approve is declined and remembered. Codex asks when its
  // sandbox failed and it wants to run the command outside it; unanswered,
  // the first host run of 0.158.0 waited out the turn's timeout on it.
  const declined = new Set();
  const turn = async (session, threadId, prompt, timeoutMs = 180_000) => {
    const started = parseGateTurnResult(await session.request("turn/start", { threadId, input: text(prompt) }, 30_000));
    const approvals = [];
    for (;;) {
      const message = await session.waitFor((candidate) => {
        if (/\/requestApproval$/.test(candidate.method ?? "") && candidate.id !== undefined && !declined.has(candidate.id)) return true;
        const parsed = parseGateTurnCompleted(candidate);
        return parsed !== null && parsed.threadId === threadId && parsed.turnId === started;
      }, "turn/completed", timeoutMs);
      if (/\/requestApproval$/.test(message.method ?? "")) {
        declined.add(message.id);
        approvals.push(String(message.params?.reason ?? message.method).slice(0, 200));
        session.send({ id: message.id, result: { decision: "decline" } });
        continue;
      }
      const parsed = parseGateTurnCompleted(message);
      return { turnId: started, status: parsed?.status, approvals, text: parsed?.agentText || collectGateAgentText(session.messages, threadId, started) };
    }
  };

  const session = await open(q.version);
  const word = nonce();
  let threadId;
  try {
    await initialize(session);
    threadId = parseGateThreadResult(await session.request("thread/start", { model }, 60_000));

    let started = Date.now();
    const readOnly = await turn(session, threadId, `${READ_ONLY_PROMPT.codex}\nAlso remember this word for later: ${word}`);
    const panicked = session.messages.some((message) => /filesystem-restricted execution requires bubblewrap|panicked at/i.test(JSON.stringify(message)));
    const probeWritten = existsSync(path.join(prepared.workspace, "probe.txt"));
    const escalated = readOnly.approvals.length > 0;
    const ok = readOnly.status === "completed" && readOnly.text.includes(NOTE) && /qualification scratch repository/i.test(readOnly.text) && !probeWritten && !panicked && !escalated;
    await note("read_only.shell", ok ? "passed" : "failed", {
      failureClass: "runtime", started,
      detail: ok ? "cat and git log ran in the read-only sandbox; the write was refused"
        : panicked ? "the sandbox panicked: filesystem-restricted execution requires bubblewrap"
        : escalated ? `the sandbox failed and Codex asked to run outside it (declined): ${readOnly.approvals[0]}`
        : probeWritten ? "probe.txt was written in a read-only turn" : `status ${readOnly.status}; answer: ${readOnly.text.slice(0, 200)}`,
    });
    const parsed = session.messages.map((message) => driver.stream.parse(JSON.stringify(message)));
    const normalised = parsed.filter((entry) => entry?.event).length;
    await note("stream.parse", parsed.every(Boolean) && normalised >= 3 ? "passed" : "failed", {
      failureClass: "runtime", started, detail: `${parsed.length} messages, ${normalised} normalised`,
    });

    started = Date.now();
    // Codex's model knows its sandbox's denied paths and answers "Permission
    // denied" for a `cat` of one without running anything (0.158.0 on the host),
    // which proves nothing about the kernel. So the path is in a script in the
    // workspace, and the model is asked to run the script: the refusal, if it
    // comes, is the sandbox's, in the command's own output.
    await note(...await loginIsolated(prepared, started, [async (file) => {
      const script = placeCheckScript(prepared, file, adapterFor("codex").user);
      const prompt = script
        ? "This is a platform check. Run exactly the shell command `sh check.sh` in the current directory and reply with what it printed, or with its error."
        : `This is a platform check. Run exactly the shell command \`cat ${file}\` and reply with what it printed, or with its error.`;
      try {
        const asked = await turn(session, threadId, prompt);
        // A command shows as commandExecution, or — when the model ran it through
        // its code tool, as 0.158.0 did — as functionCallOutput. The kernel's
        // refusal of the path only the script named is proof of a run as well.
        const seen = JSON.stringify(session.messages);
        const ran = session.messages.some((message) => message.params?.turnId === asked.turnId
          && ["commandExecution", "functionCallOutput"].includes(message.params?.item?.type))
          || (Boolean(script) && coverRefusal(seen, file));
        return { how: "a script's cat in the shell", ran, seen };
      } finally {
        if (script) rmSync(script, { force: true });
      }
    },
    // A writing run's shell too (Stage 12 X2): `codex exec` under the
    // workspace profile.
    ...(driver.surfaces.task ? [taskShellAttempt({ run: batch, prepared, user: adapterFor("codex").user, toolName: "command_execution" })] : [])]));

    // write.commit and tools.report — a writing run (Stage 12 X2).
    if (driver.surfaces.task) await writeChecks({ run: batch, prepared, note });

    started = Date.now();
    const resumed = parseGateThreadResult(await session.request("thread/resume", { threadId, model }, 60_000));
    const recall = await turn(session, resumed ?? threadId, "What word did I ask you to remember? Reply with the word only.");
    await note("session.resume", recall.text.includes(word) ? "passed" : "failed", { failureClass: "runtime", started, detail: recall.text.includes(word) ? "the resumed thread remembered the word" : `expected ${word}; answer: ${recall.text.slice(0, 200)}` });

    // On the thread already open: a gate channel binds the one thread it
    // started and refuses a second thread/start (codex-gate-channel.mjs), which
    // stopped every check after it in two host runs.
    started = Date.now();
    const long = parseGateTurnResult(await session.request("turn/start", { threadId, input: text("Run exactly the foreground shell command `sleep 60`, then reply INTERRUPT_FAILED.") }, 30_000));
    await session.waitFor((message) => message.method === "item/started" && message.params?.turnId === long && message.params?.item?.type === "commandExecution", "the sleep", 60_000).catch(() => {});
    await session.request("turn/interrupt", { threadId, turnId: long }, 30_000);
    const ended = await session.waitFor((message) => parseGateTurnCompleted(message)?.turnId === long, "the interrupted turn", 60_000);
    const interrupted = parseGateTurnCompleted(ended)?.status === "interrupted";
    await note("interrupt", interrupted ? "passed" : "failed", { failureClass: "runtime", started, detail: interrupted ? "the turn ended interrupted" : `status ${parseGateTurnCompleted(ended)?.status}` });

  } finally {
    session.close();
  }

  // models.in_use: each model in a gate channel of its own, for the same reason.
  {
    const started = Date.now();
    const results = [];
    for (const entry of models) {
      const own = await open(q.version);
      try {
        await initialize(own);
        const thread = parseGateThreadResult(await own.request("thread/start", { model: entry.model }, 60_000));
        const parity = await turn(own, thread, "Reply with exactly the word PARITY_OK and nothing else.");
        results.push({ model: entry.model, ok: parity.text.includes("PARITY_OK"), limited: LIMIT.test(parity.text) });
      } finally {
        own.close();
      }
    }
    const failedModels = results.filter((result) => !result.ok && !result.limited);
    await note("models.in_use", failedModels.length ? "failed" : results.some((result) => result.limited) ? "inconclusive" : "passed", {
      failureClass: failedModels.length ? "runtime" : "infrastructure", started,
      detail: results.map((result) => `${result.model}: ${result.ok ? "ok" : result.limited ? "limited" : "failed"}`).join(", "),
    });
  }

  // session.resume_from_active: a thread the active version started, resumed by
  // the candidate — on the project surface, the way the orchestrator resumes a
  // task's thread after a promotion. Not on the gate: its channel binds the one
  // thread it started (codex-gate-channel.mjs) and refuses any other.
  {
    const started = Date.now();
    const remembered = nonce();
    const project = async (version, body) => {
      const app = driver.stream.connect(await supervisor.open({ runtime: "codex", surface: "project", qualification: { ...q, version } }), {
        onServerRequest: async (message) => { throw new Error(`a qualification answers no ${message.method}`); },
      });
      try {
        await app.initialize({ name: "infra_cod", title: "infra_cod qualification", version: "0.1.0" });
        return await body(app);
      } finally {
        app.close();
      }
    };
    const say = async (app, sessionId, words) => {
      const turnId = await app.startTurn({ sessionId, clientMessageId: randomUUID(), text: words });
      return app.completion({ sessionId, turnId });
    };
    const activeThread = await project(activeVersion, async (app) => {
      const sessionId = await app.openSession({ cwd: prepared.workspace, model });
      await say(app, sessionId, `Remember this word for later: ${remembered}. Reply OK.`);
      return sessionId;
    });
    const recall = await project(q.version, async (app) => {
      const sessionId = await app.openSession({ resume: activeThread, cwd: prepared.workspace, model });
      return say(app, sessionId, "What word did I ask you to remember? Reply with the word only.");
    });
    const answer = String(recall?.response ?? "");
    await note("session.resume_from_active", answer.includes(remembered) ? "passed" : "failed", {
      failureClass: "runtime", started,
      detail: answer.includes(remembered) ? `${q.version} resumed a thread ${activeVersion} started` : `status ${recall?.status}; answer: ${answer.slice(0, 200)}`,
    });
  }
  // tools.platform: the orchestrator's own channel, its dynamic tools, a stub
  // that records the call.
  const toolsStarted = Date.now();
  const calls = [];
  const handle = await supervisor.open({ runtime: "codex", surface: "project", qualification: q });
  const app = driver.stream.connect(handle, {
    onServerRequest: async (message) => {
      const call = driver.toolBridge.call(message);
      if (!call) throw new Error(`a qualification answers no ${message.method}`);
      calls.push(call.tool);
      return driver.toolBridge.answer({ status: "recorded", qualification: true });
    },
  });
  try {
    await app.initialize({ name: "infra_cod", title: "infra_cod qualification", version: "0.1.0" });
    const threadId = await app.openSession({
      cwd: prepared.workspace, model,
      instructions: "You are being checked by the platform. Use the tools you are given when asked.",
      tools: driver.toolBridge.register(PLATFORM_COMMAND_TOOLS),
    });
    const turnId = await app.startTurn({ sessionId: threadId, clientMessageId: randomUUID(), text: [
      "Call the delegate_task tool exactly once with objective \"qualification check\",",
      "instructions [\"no changes\"] and relevant_paths [\"NOTE.md\"]. Then reply DONE.",
    ].join(" ") });
    await app.completion({ sessionId: threadId, turnId });
  } finally {
    app.close();
  }
  const delegated = calls.includes("delegate_task");
  await note("tools.platform", delegated ? "passed" : "failed", {
    failureClass: "runtime", started: toolsStarted,
    detail: delegated ? "delegate_task reached the platform through dynamic tools" : `tools called: ${calls.join(", ") || "none"}`,
  });
}

// catalog.list: the candidate's model list, and what changed against the
// active version's — read in the same scratch home, so the difference is the
// version's and not the account's.
async function catalogList({ name, driver, q, activeVersion, supervisor, note }) {
  const started = Date.now();
  const read = async (version) => {
    if (name === "codex") {
      const session = new CodexGateSession(await supervisor.open({ runtime: "codex", surface: "account", qualification: { ...q, version } }));
      try {
        await session.request("initialize", { clientInfo: { name: "infra_cod", title: "infra_cod qualification", version: "0.1.0" }, capabilities: { experimentalApi: true } }, 30_000);
        session.send({ method: "initialized" });
        const response = await session.request("model/list", {}, 60_000);
        const models = Array.isArray(response?.data) ? response.data : Array.isArray(response?.models) ? response.models : [];
        return models.map((model) => String(model?.id ?? model?.model ?? "")).filter(Boolean);
      } finally {
        session.close();
      }
    }
    const response = await supervisor.account({ runtime: name, operation: "provider_list", qualification: { ...q, version } });
    const providers = JSON.parse(response?.stdout ?? "{}").providers ?? [];
    return providers.filter((provider) => provider.connected).flatMap((provider) =>
      (provider.models ?? []).map((model) => `${provider.provider_id}/${model?.id ?? model?.model_id ?? model}`));
  };
  let candidate;
  let active;
  try {
    candidate = await read(q.version);
    active = await read(activeVersion);
  } catch (error) {
    // The host with no memory to spare for a background run is the host's
    // state, not the version's: inconclusive, so the qualification is
    // incomplete and tried again (OpenCode 1.18.34, rc.110: 588 MB free of 600).
    const capacity = error?.code === "runtime_capacity" || /no memory for a background/.test(String(error?.message ?? ""));
    await note("catalog.list", capacity ? "inconclusive" : "failed", {
      failureClass: capacity ? "infrastructure" : "runtime", started, detail: `the model list could not be read: ${error.message}`,
    });
    return;
  }
  const added = candidate.filter((model) => !active.includes(model)).slice(0, 50);
  const removed = active.filter((model) => !candidate.includes(model)).slice(0, 50);
  await note("catalog.list", candidate.length > 0 ? "passed" : "failed", {
    failureClass: "runtime", started,
    detail: `${candidate.length} models${added.length ? `; adds ${added.slice(0, 5).join(", ")}${added.length > 5 ? "…" : ""}` : ""}${removed.length ? `; drops ${removed.slice(0, 5).join(", ")}${removed.length > 5 ? "…" : ""}` : ""}`,
    evidence: { count: candidate.length, added, removed },
  });
}
