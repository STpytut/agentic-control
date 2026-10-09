// rc.146: the owner's message into a running executor's turn (Claude Code's
// stream-json input), and a Codex review's tokens from its session files.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { driverFor } from "../drivers/index.mjs";
import { hasCapability } from "../drivers/capabilities.mjs";
import { COMMAND_CAPABILITY } from "../run-mailbox.mjs";
import { reviewSessionUsage, rolloutUsage } from "../codex-session-usage.mjs";

test("a Claude Code executor streams its input only when asked; everything else keeps the prompt as the last argument", () => {
  const claude = driverFor("claude");
  assert.ok(hasCapability(claude, COMMAND_CAPABILITY.steer), "Claude Code takes a steer");
  for (const name of ["codex", "opencode"]) assert.ok(!hasCapability(driverFor(name), "input.steer"), name);
  const streamed = claude.run.argv({ model: "opus", prompt: "Do it", surface: "task", streamInput: true });
  assert.equal(streamed[streamed.indexOf("--input-format") + 1], "stream-json");
  assert.ok(!streamed.includes("Do it"), "the prompt goes on stdin");
  assert.equal(streamed.at(-1), "opus");
  for (const surface of ["task", "project", "consult", "gate"]) {
    const argv = claude.run.argv({ model: "opus", prompt: "Do it", surface });
    assert.equal(argv.at(-1), "Do it", surface);
    assert.ok(!argv.includes("--input-format"), surface);
  }
  assert.ok(!claude.run.argv({ model: "opus", prompt: "Do it", surface: "project", streamInput: true }).includes("--input-format"),
    "only a writing run streams");
  const stream = claude.input.stream;
  assert.deepEqual(stream.surfaces, ["task"]);
  assert.deepEqual(JSON.parse(stream.message("Use \"the\" helper\nplease")), { type: "user", message: { role: "user", content: "Use \"the\" helper\nplease" } });
  assert.ok(stream.message("x").endsWith("\n"), "one line per message");
  assert.equal(stream.turnEnded({ type: "result", subtype: "success" }), true);
  assert.equal(stream.turnEnded({ type: "assistant" }), false);
});

// As Codex 0.160 wrote the review of focus-timer #13 on the host.
const CWD = "/srv/infra-cod/gate-smoke/review-1/repo";
const rollout = (cwd, totals) => [
  JSON.stringify({ type: "session_meta", payload: { id: "s", cwd, source: { subagent: "review" } } }),
  JSON.stringify({ type: "response_item", payload: {} }),
  ...totals.map((total) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total } } })),
].join("\n");

test("a review's tokens are its own sessions' last totals, split as the panel counts them", () => {
  const last = { input_tokens: 27569, cached_input_tokens: 12800, output_tokens: 237, reasoning_output_tokens: 0 };
  assert.deepEqual(rolloutUsage(rollout(CWD, [{ input_tokens: 100, cached_input_tokens: 0, output_tokens: 1 }, last]), CWD),
    { input: 14769, cache_read: 12800, output: 237, reasoning: 0 });
  assert.equal(rolloutUsage(rollout("/other/repo", [last]), CWD), null, "another run's session is not counted");
  assert.deepEqual(rolloutUsage(rollout(CWD, []), CWD), { input: 0, cache_read: 0, output: 0, reasoning: 0 });
  assert.equal(rolloutUsage("not json", CWD), null);
});

test("the sessions of the review's repository are found and summed; none is null", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-sessions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = new Date();
  const day = path.join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  mkdirSync(day, { recursive: true });
  const usage = { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 10 };
  writeFileSync(path.join(day, "rollout-a.jsonl"), rollout(CWD, [usage]));
  writeFileSync(path.join(day, "rollout-b.jsonl"), rollout(CWD, [usage]));
  writeFileSync(path.join(day, "rollout-other.jsonl"), rollout("/elsewhere", [usage]));
  const old = path.join(day, "rollout-old.jsonl");
  writeFileSync(old, rollout(CWD, [usage]));
  utimesSync(old, new Date(now.getTime() - 3_600_000), new Date(now.getTime() - 3_600_000));
  assert.deepEqual(await reviewSessionUsage({ sessionsRoot: root, cwd: CWD, since: new Date(now.getTime() - 10_000) }),
    { input: 1200, cache_read: 800, output: 80, reasoning: 20 });
  assert.equal(await reviewSessionUsage({ sessionsRoot: root, cwd: "/nowhere", since: now }), null);
});
