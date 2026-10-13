// The Antigravity driver (rc.150): the launches it builds, the stream it
// reads — the shapes the spike recorded on the host at agy 1.3.4 — and what it
// says when a run fails.

import test from "node:test";
import assert from "node:assert/strict";

import { adapterFor } from "../../operations/runtime-adapters.mjs";
import { driverFor, surfaceOf } from "../drivers/index.mjs";
import { optionalCapabilities } from "../drivers/capabilities.mjs";
import { parseAntigravityModels } from "../drivers/antigravity.mjs";
import { ANALYST_REPORT_SCHEMA } from "../analyst-report.mjs";
import { antigravityAccountState, validateAntigravityAccountInput } from "../antigravity-account-channel.mjs";
import { createTokenMeter } from "../run-token-meter.mjs";
import { antigravityTokens } from "../usage-limits.mjs";

const agy = driverFor("antigravity");
const lines = (events) => events.map((event) => JSON.stringify(event)).join("\n");

const INIT = { event: "init", conversation_id: "c-9", init: { cwd: "/snap", tools: ["read_file", "list_dir"], permission_mode: "default", model: "claude-sonnet-4-6" } };
const RESULT = (extra = {}) => ({ event: "result", result: { conversation_id: "c-9", status: "SUCCESS", response: "The answer.", duration_seconds: 3.2, num_turns: 1,
  usage: { input_tokens: 120, output_tokens: 40, thinking_tokens: 15, cache_read_tokens: 20, total_tokens: 195 }, ...extra } });

test("Antigravity is an analyst only, read-only by the kernel, and nothing of the platform's reaches it", () => {
  const adapter = adapterFor("antigravity");
  assert.deepEqual(adapter.roles, ["analyst"]);
  assert.deepEqual(adapter.dispatch.jobTypes, ["consultation_run"]);
  assert.deepEqual(Object.keys(agy.surfaces).sort(), ["account", "consult", "gate"]);
  assert.deepEqual(surfaceOf(agy, "consult"), { transport: "batch", workspace: "snapshot", capability: "run.read_only" });
  assert.equal(agy.toolBridge.transport, "none");
  assert.deepEqual(agy.toolBridge.platformTools, []);
  assert.ok(!("input.steer" in agy.capabilities), "live input is not a surface this runtime has");
  assert.deepEqual(optionalCapabilities(agy, adapter.roles).sort(),
    ["account.login", "catalog.models", "events.raw", "gate.smoke", "sessions.create", "sessions.resume", "usage.report"]);
  assert.deepEqual(agy.run.readOnlyWritable, [
    "/home/antigravity-worker/.gemini", "/home/antigravity-worker/.config/antigravity", "/home/antigravity-worker/.cache", "/tmp", "/dev/null",
  ]);
  assert.equal(adapter.autoUpdate.mechanism, "directory");
  assert.equal(adapter.authEvidence.path, ".gemini/antigravity-cli/antigravity-oauth-token");
  assert.equal(agy.executable, "agy");
});

test("an analyst's run heads the prompt with the role's instructions, holds the answer to the report's shape, and resumes by conversation", () => {
  const argv = agy.run.argv({ model: "gemini-3.8-flash-high", prompt: "Read it", surface: "consult", systemPrompt: "You are the reviewer." });
  assert.deepEqual(argv.slice(0, 2), ["-p", "You are the reviewer.\n\nRead it"], "no system-prompt flag exists; the instructions head the prompt");
  const after = (flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(after("--output-format"), "stream-json");
  assert.equal(after("--model"), "gemini-3.8-flash-high");
  assert.deepEqual(JSON.parse(after("--json-schema")), ANALYST_REPORT_SCHEMA);
  assert.ok(argv.includes("--disable-slash-commands"));
  assert.ok(!argv.includes("--conversation") && !argv.includes("--effort"));
  assert.ok(!argv.includes("--system-prompt") && !argv.includes("--append-system-prompt"), "nothing is invented");

  const resumed = agy.run.argv({ model: "m", prompt: "Next", surface: "consult", sessionId: "c-9", reasoningEffort: "high" });
  assert.equal(resumed[resumed.indexOf("--conversation") + 1], "c-9");
  assert.equal(resumed[resumed.indexOf("--effort") + 1], "high");
  assert.throws(() => agy.run.argv({ model: "m", prompt: "x", surface: "consult", reasoningEffort: "ultra" }), (error) => error.code === "reasoning_effort_unsupported");

  const gate = agy.run.argv({ model: "m", prompt: "PARITY_OK", surface: "gate", systemPrompt: "role" });
  assert.deepEqual(gate, ["-p", "PARITY_OK", "--output-format", "stream-json", "--model", "m"], "a gate run takes no instructions and no schema");
  assert.throws(() => agy.run.argv({ model: "m", prompt: "x", surface: "task" }), /no "task" surface/);
  // Every flag a launch passes is one qualification checks against --help.
  for (const flag of ["--output-format", "--model", "--conversation", "--effort", "--json-schema", "--disable-slash-commands"]) {
    assert.ok(agy.run.flags.includes(flag), flag);
  }
  assert.deepEqual(agy.run.environment({ toolBridge: ["X=1"] }), ["X=1"]);
  assert.equal(agy.run.qualifyModel("google", "gemini-3.8-flash-high"), "gemini-3.8-flash-high");
});

test("the sign-in runs one headless prompt in the home and takes one code, with Google's slashes, on one line", () => {
  assert.deepEqual(agy.run.argv({ model: "m", prompt: "x", surface: "account" }),
    ["-p", "Reply with the single word OK and nothing else.", "--output-format", "stream-json", "--disable-slash-commands"]);
  assert.equal(surfaceOf(agy, "account").transport, "channel");
  const state = agy.input.channelState("account");
  assert.deepEqual(state, antigravityAccountState());
  assert.throws(() => validateAntigravityAccountInput("/logout\n", antigravityAccountState()), /only the code/);
  assert.throws(() => validateAntigravityAccountInput("4/0AX4XfWh-abc", antigravityAccountState()), /only the code/);
  agy.input.validate("account", "4/0AX4XfWh-abc_def\n", state);
  assert.throws(() => agy.input.validate("account", "4/0AX4XfWh-abc_def\n", state), /one code/);
  assert.throws(() => agy.input.validate("consult", "x\n", null), /no channel/);
  assert.match(agy.input.login.urlPattern.source, /accounts\\\.google\\\.com/);
  assert.equal(agy.input.login.signedInWithoutLink, true);
  assert.equal(agy.input.login.succeeded('{"event":"result","result":{"status":"SUCCESS"}}', null), true);
  assert.equal(agy.input.login.succeeded("", 0), true);
  assert.equal(agy.input.login.succeeded("", 1), false);
});

test("the stream is read: the session, the answer, the model, the tools and the usage", () => {
  const stdout = lines([
    INIT,
    { event: "step_update", step_update: { conversation_id: "c-9", step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "read_file" } },
    { event: "step_update", step_update: { conversation_id: "c-9", step_index: 1, state: "DONE", step_type: "tool", tool_name: "read_file",
      tool_info: { name: "read_file", parameters: { path: "x" }, output: "", error: "ENOENT" } } },
    { event: "step_update", step_update: { conversation_id: "c-9", step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "The " } },
    { event: "step_update", step_update: { conversation_id: "c-9", step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "answer." } },
    RESULT(),
  ]);
  const parsed = stdout.split("\n").map((line) => agy.stream.parse(line));
  assert.ok(parsed.every(Boolean));
  assert.deepEqual(parsed.map((entry) => entry.event?.eventType ?? null), [
    "runtime.turn.started", "runtime.tool.updated", "runtime.tool.updated", null, "runtime.output.completed", "runtime.turn.usage",
  ]);
  assert.deepEqual(parsed[1].event.details, { tool: "read_file", status: "requested", native_type: "step_update" });
  assert.deepEqual(parsed[2].event.details, { tool: "read_file", status: "error", error: "ENOENT", native_type: "step_update" });
  assert.equal(parsed[0].event.details.model, "claude-sonnet-4-6");
  assert.equal(parsed[5].event.phase, "finalizing");
  assert.deepEqual(parsed[5].event.details.tokens, { input: 120, output: 40, reasoning: 15, cache: { read: 20, write: 0 }, total: 195 });
  assert.deepEqual([...new Set(parsed.map(({ raw }) => agy.sessions.idFromEvent(raw)))], ["c-9"]);
  assert.deepEqual(agy.sessions.args("c-9"), ["--conversation", "c-9"]);
  assert.deepEqual(agy.sessions.args(null), []);
  assert.equal(agy.stream.resolvedModel(INIT), "claude-sonnet-4-6");
  assert.equal(agy.stream.resolvedModel(RESULT()), null);
  assert.equal(agy.stream.answer(stdout), "The answer.");
  assert.equal(agy.stream.failure(stdout), "");
  assert.equal(agy.stream.parse("not json"), null);
  assert.equal(agy.stream.parse('{"type":"assistant"}'), null, "a line without an event is not this runtime's");
});

test("an analyst's structured output is its answer, rendered as the report; the deltas are the answer when there is no result", () => {
  const structured = lines([INIT, RESULT({ response: "", structured_output: {
    summary: "Two findings.", findings: [{ file: "src/a.ts", line: 12, claim: "Unchecked input: the query is trusted." }], open_questions: ["Is it reachable?"],
  } })]);
  const report = agy.stream.answer(structured);
  assert.equal(report, "Two findings.\n\n**Findings**\n- `src/a.ts:12` — Unchecked input: the query is trusted.\n\n**Open questions**\n- Is it reachable?");
  const partial = lines([INIT,
    { event: "step_update", step_update: { conversation_id: "c-9", step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "Half an " } },
    { event: "step_update", step_update: { conversation_id: "c-9", step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "answer" } },
  ]);
  assert.equal(agy.stream.answer(partial), "Half an answer");
});

test("a failed run says why: the result's error, the sign-in's, or the AGY_ERROR line on stderr", () => {
  const auth = lines([{ event: "result", result: { conversation_id: "c-1", status: "ERROR", error: "authentication failed or timed out", duration_seconds: 60 } }]);
  assert.match(agy.stream.failure(auth), /^Antigravity not signed in: authentication failed or timed out$/);
  assert.equal(agy.stream.answer(auth), "", "a failed result has no answer");
  const limited = lines([INIT, { event: "result", result: { status: "ERROR", error: "429 Too Many Requests: quota exceeded" } }]);
  assert.match(agy.stream.failure(limited), /^Antigravity rate limited: 429/);
  const stderr = 'something\nAGY_ERROR: {"code":"MODEL_NOT_FOUND","message":"model gemini-9 is not available"}\n';
  assert.match(agy.stream.failure(lines([INIT]), stderr), /^Antigravity failed: model gemini-9 is not available$/);
  assert.match(agy.stream.failure("", 'AGY_ERROR: {"message":"auth token expired"}'), /^Antigravity not signed in: auth token expired$/);
  assert.match(agy.stream.failure("", "AGY_ERROR: not json"), /^Antigravity failed: not json$/);
  assert.equal(agy.stream.failure(lines([INIT]), "plain noise"), "", "no result and no AGY_ERROR is not a failure the stream knows");
  assert.match(agy.stream.failure(lines([{ event: "result", result: { status: "CANCELLED" } }])), /^Antigravity failed \(CANCELLED\)$/);
});

test("the usage is read from the result once, by the meter too, whichever way agy nests its parts", () => {
  // Disjoint parts: the total is their sum.
  assert.deepEqual(antigravityTokens({ input_tokens: 10, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 2, total_tokens: 16 }),
    { input: 10, output: 3, reasoning: 1, cache: { read: 2, write: 0 }, total: 16 });
  // Nested parts: the total is input + output, so the cache is inside the
  // input and the thinking inside the output.
  assert.deepEqual(antigravityTokens({ input_tokens: 100, output_tokens: 50, thinking_tokens: 20, cache_read_tokens: 30, total_tokens: 150 }),
    { input: 70, output: 30, reasoning: 20, cache: { read: 30, write: 0 }, total: 150 });
  assert.equal(antigravityTokens(null), null);
  const meter = createTokenMeter("antigravity", 10_000);
  assert.equal(meter.add(INIT), false);
  assert.equal(meter.add(RESULT()), false);
  assert.equal(meter.total, 195);
  const over = createTokenMeter("antigravity", 10_000);
  assert.equal(over.add(RESULT({ usage: { input_tokens: 20_000, output_tokens: 1, total_tokens: 20_001 } })), true);
});

test("`agy models` lines become ids and names, bounded and once each", () => {
  const listed = parseAntigravityModels([
    "gemini-3.8-flash-high\tGemini 3.8 Flash (high)",
    "claude-sonnet-4-6\tClaude Sonnet 4.6",
    "claude-opus-4-6-thinking\tClaude Opus 4.6 (thinking)",
    "gpt-oss-120b-medium\tGPT-OSS 120B medium",
    "gemini-3.8-flash-high\tagain",
    "bad id with spaces\tno",
    "",
  ].join("\n"));
  assert.deepEqual(listed, [
    { id: "gemini-3.8-flash-high", display_name: "Gemini 3.8 Flash (high)" },
    { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6-thinking", display_name: "Claude Opus 4.6 (thinking)" },
    { id: "gpt-oss-120b-medium", display_name: "GPT-OSS 120B medium" },
  ]);
  assert.deepEqual(parseAntigravityModels("only-an-id"), [{ id: "only-an-id", display_name: "only-an-id" }]);
  assert.deepEqual(agy.catalog.argv, ["models"]);
});
