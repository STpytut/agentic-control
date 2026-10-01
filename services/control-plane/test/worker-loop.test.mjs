// The loop primitives (WP-6): the wait a SIGTERM interrupts, a tick whose error
// ends the cycle and not the loop, the quiet cycle that writes nothing, and the
// outcome vocabulary a leased job must answer in.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { JOB_OUTCOMES, runLeasedJob, redactError, runPollLoop } from "../worker-loop.mjs";

function recorder() {
  const lines = [];
  return { lines, write: (text) => lines.push(JSON.parse(text)), types: () => lines.map((line) => line.type) };
}

test("a quiet cycle writes nothing, and a cycle that did something writes one line", async () => {
  const out = recorder();
  const err = recorder();
  const results = [undefined, [], {}, false, { claimed: 1 }, [{ id: 7 }]];
  await runPollLoop({ name: "test-loop", pollMs: 0, once: false, out, err, tick: () => results.shift(),
    signal: { get aborted() { return results.length === 0; } } });
  assert.deepEqual(out.types(), ["test-loop.ready", "test-loop", "test-loop"]);
  assert.deepEqual(out.lines[1], { type: "test-loop", claimed: 1 });
  assert.deepEqual(out.lines[2], { type: "test-loop", results: [{ id: 7 }] });
  assert.equal(err.lines.length, 0);
});

test("an error from a tick ends the cycle, not the loop", async () => {
  const out = recorder();
  const err = recorder();
  let cycle = 0;
  const controller = new AbortController();
  const summary = await runPollLoop({ name: "test-loop", pollMs: 0, signal: controller.signal, out, err,
    tick: () => {
      cycle += 1;
      if (cycle === 1) throw new Error("the database went away");
      if (cycle === 3) controller.abort();
      return { cycle };
    } });
  assert.equal(summary.cycles, 3);
  assert.equal(summary.failures, 1);
  // The line is the envelope now (WP-8a): the sentence, the family it was
  // classified into, and whether waiting would help.
  assert.equal(err.lines.length, 1);
  assert.equal(err.lines[0].type, "test-loop.failed");
  assert.equal(err.lines[0].error, "the database went away");
  assert.equal(err.lines[0].code, "unknown");
  assert.equal(err.lines[0].retryable, false);
  assert.deepEqual(out.types(), ["test-loop.ready", "test-loop", "test-loop"]);
});

test("the wait is interrupted by the signal rather than slept through", async () => {
  const out = recorder();
  const controller = new AbortController();
  const started = Date.now();
  const loop = runPollLoop({ name: "test-loop", pollMs: 60_000, signal: controller.signal, out, err: recorder(),
    tick: () => undefined });
  setTimeout(() => controller.abort(), 20);
  await loop;
  assert.ok(Date.now() - started < 5_000, "the loop slept through its shutdown");
});

test("`once` runs a single cycle, announces nothing, and ignores the poll interval", async () => {
  const out = recorder();
  let cycles = 0;
  const summary = await runPollLoop({ name: "test-loop", pollMs: 60_000, once: true, out, err: recorder(),
    tick: () => { cycles += 1; return { cycles }; } });
  assert.equal(cycles, 1);
  assert.equal(summary.cycles, 1);
  assert.deepEqual(out.types(), ["test-loop"]);
});

test("a leased job answers in the vocabulary, and anything else is refused by name", async () => {
  const out = recorder();
  const err = recorder();
  const reported = [];
  const report = (result, job) => { reported.push([job.id, result.outcome]); return "recorded"; };

  const done = await runLeasedJob({ name: "test-job", job: { id: 1 }, report, out, err,
    handle: () => "completed" });
  assert.equal(done.outcome, "completed");
  assert.deepEqual(out.lines.at(-1), { type: "test-job.completed", jobId: 1, reported: "recorded" });

  // A failure that a later attempt could still win is retryable by default, and
  // the error reaches the line redacted.
  const failed = await runLeasedJob({ name: "test-job", job: { id: 2 }, report, out, err,
    handle: () => { throw new Error("upstream said sk-0123456789abcdef0123"); } });
  assert.equal(failed.outcome, "retryable");
  assert.equal(err.lines.at(-1).type, "test-job.retryable");
  assert.equal(err.lines.at(-1).error, "upstream said [REDACTED]");

  // The worker's own classification decides between the words.
  const deferred = await runLeasedJob({ name: "test-job", job: { id: 3 }, report, out, err,
    classify: () => ({ outcome: "deferred", reason: "workspace_busy" }),
    handle: () => { throw new Error("a writer holds the workspace"); } });
  assert.equal(deferred.outcome, "deferred");
  assert.equal(err.lines.at(-1).reason, "workspace_busy");

  assert.deepEqual(reported, [[1, "completed"], [2, "retryable"], [3, "deferred"]]);

  await assert.rejects(() => runLeasedJob({ name: "test-job", job: { id: 4 }, out, err, handle: () => "done" }),
    /answered "done", which is not one of/);
  assert.deepEqual(JOB_OUTCOMES,
    ["completed", "retryable", "deferred", "cancelled", "outcome_unknown", "needs_attention"]);
});

test("a report that fails is its own line, and does not change the job's outcome", async () => {
  const out = recorder();
  const err = recorder();
  const result = await runLeasedJob({ name: "test-job", job: { id: 9 }, out, err,
    handle: () => ({ outcome: "outcome_unknown", reason: "the account server never answered" }),
    report: () => { throw new Error("lease lost"); } });
  assert.equal(result.outcome, "outcome_unknown");
  assert.deepEqual(err.types(), ["test-job.outcome_unknown", "test-job.unreported"]);
});

test("redactError redacts tokens, strips control characters and bounds the length", () => {
  assert.equal(redactError(new Error("token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghij.klmnopqrst")), "token [REDACTED]");
  assert.equal(redactError(new Error("nothing\u0007here")), "nothing here");
  assert.equal(redactError(new Error("x".repeat(900))).length, 500);
  assert.equal(redactError(new Error("secret is hunter2"), "fallback", ["hunter2"]), "secret is [REDACTED]");
  // A message is bounded from the front — what it was, first. Evidence a caller
  // attaches to a failure asks for the end instead, where the thing that went
  // wrong is (WP-8b).
  assert.equal(redactError(`${"a".repeat(600)}EROFS`, "", [], { maxLength: 20, keep: "tail" }), "aaaaaaaaaaaaaaaEROFS");
  assert.match(redactError(`${"a".repeat(600)}EROFS`, ""), /^a+$/);
  assert.equal(redactError(undefined, "fallback"), "fallback");
  // The widest of the five copies, not their common part: the OpenCode broker
  // redacted these two and the other four did not, and the shared one keeps
  // them so no operator's address is written into the journal.
  assert.equal(redactError(new Error("rk-abcdefghijklmnop0123 rejected")), "[REDACTED] rejected");
  assert.equal(redactError(new Error("account owner@example.com is locked")), "account [REDACTED_EMAIL] is locked");
});

// The point of the primitives is that there is one copy. A service that grows
// its own loop again is how defect 106 happened — the fix reached eleven of
// twelve copies — so the twelfth copy is refused here rather than in review.
test("no control-plane service runs a loop of its own", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const own = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".mjs") || name === "worker-loop.mjs" || name === "poll-wait.mjs") continue;
    const source = readFileSync(path.join(root, name), "utf8");
    if (!source.includes("waitForPoll")) continue;
    // `project-provisioner.mjs` waits for one workspace operation to finish
    // inside a single tick, which is not a poll loop; it is named rather than
    // matched loosely, so a new exception has to be argued for here.
    if (name === "project-provisioner.mjs" && !/while \(!signal\?\.aborted\)|while \(!controller/.test(source)) continue;
    // `implementation-worker.mjs` waits inside one job for memory to free
    // (sprint C K3: it holds its workspace, so it is not handed back to the
    // queue), bounded by EXECUTOR_CAPACITY_WAIT_MS — also not a poll loop.
    if (name === "implementation-worker.mjs" && !/while \(!signal\?\.aborted\)|while \(!controller/.test(source)) continue;
    own.push(name);
  }
  assert.deepEqual(own, [], `these services still wait between polls themselves: ${own.join(", ")}`);
});
