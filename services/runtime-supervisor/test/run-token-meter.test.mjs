// A member's token limit per run (rc.142): the meter reads each runtime's
// stream as the host showed it (Claude Code 2.1.294, OpenCode 1.18.35, Codex
// 0.160 exec) and says once when the run goes past its limit.
import test from "node:test";
import assert from "node:assert/strict";

import { createTokenMeter, runTokenLimit } from "../run-token-meter.mjs";
import { renderAnalystReport } from "../analyst-report.mjs";
import { normalizeClaudeEvent } from "../runtime-events.mjs";

const claudeMessage = (id, usage, type = "text") => ({ type: "assistant", message: { id, usage, content: [{ type }] } });

test("Claude Code's tokens are counted once per model call, from each message's usage", () => {
  const meter = createTokenMeter("claude", 10_000);
  const usage = { input_tokens: 2, cache_creation_input_tokens: 3066, cache_read_input_tokens: 1729, output_tokens: 16 };
  assert.equal(meter.add(claudeMessage("m1", usage, "thinking")), false);
  assert.equal(meter.add(claudeMessage("m1", usage, "tool_use")), false, "a message's second block repeats its usage");
  assert.equal(meter.total, 4813);
  assert.equal(meter.add(claudeMessage("m2", { ...usage, cache_read_input_tokens: 6000 })), true, "past the limit, said once");
  assert.equal(meter.add(claudeMessage("m3", usage)), false);
  assert.ok(meter.exceeded);
  assert.match(meter.describe(), /used 18,710 tokens, past this member's limit of 10,000 per run/);
  assert.equal(meter.add({ type: "result", usage: { input_tokens: 99999 } }), false, "the result repeats what was counted");
});

test("OpenCode is counted per step, Codex at the end of its turn", () => {
  const opencode = createTokenMeter("opencode", 10_000);
  const step = { type: "step_finish", part: { tokens: { input: 3000, output: 500, reasoning: 0, cache: { read: 4000, write: 0 } } } };
  assert.equal(opencode.add(step), false);
  assert.equal(opencode.add(step), true);
  assert.equal(opencode.total, 15_000);

  const codex = createTokenMeter("codex", 40_000);
  assert.equal(codex.add({ type: "item.completed", item: { type: "agent_message" } }), false);
  assert.equal(codex.add({ type: "turn.completed", usage: { input_tokens: 42744, cached_input_tokens: 38656, output_tokens: 89 } }), true);
  assert.equal(codex.total, 42_833);
});

test("no limit, or one out of range, never stops a run", () => {
  for (const limit of [null, undefined, 0, 9_999, 1_000_000_001, "abc", 12.5]) {
    const meter = createTokenMeter("opencode", limit);
    assert.equal(meter.limit, null, String(limit));
    assert.equal(meter.add({ type: "step_finish", part: { tokens: { input: 50_000_000 } } }), false);
  }
  assert.equal(runTokenLimit("250000"), 250_000);
  assert.equal(createTokenMeter("antigravity", 10_000).add({ type: "assistant" }), false, "a runtime the meter cannot read adds nothing");
});

test("an analyst's report renders bounded, and nothing for anything else", () => {
  assert.equal(renderAnalystReport(null), "");
  assert.equal(renderAnalystReport("text"), "");
  assert.equal(renderAnalystReport({ summary: "Only this." }), "Only this.");
  const report = renderAnalystReport({ summary: "s", findings: [{ file: "a`b\n.js", line: -3, claim: "  two\nlines  " }, { claim: "" }, "x"] });
  assert.equal(report, "s\n\n**Findings**\n- `ab .js` — two lines");
  const many = renderAnalystReport({ summary: "s", findings: Array.from({ length: 100 }, (_, index) => ({ claim: `c${index}` })) });
  assert.equal(many.split("\n").filter((line) => line.startsWith("- ")).length, 60);
});

test("a switch to the fallback model is an activity event naming both models", () => {
  const event = normalizeClaudeEvent({ type: "system", subtype: "model_fallback", trigger: "model_not_found",
    original_model: "claude-opus-9-9", fallback_model: "claude-haiku-5-5", content: "Switched to Haiku 5.5" });
  assert.equal(event.eventType, "runtime.model.fallback");
  assert.deepEqual(event.details, { model: "claude-haiku-5-5", from: "claude-opus-9-9", reason: "model_not_found" });
  assert.match(event.summary, /switched to claude-haiku-5-5: claude-opus-9-9 was not available/);
  assert.equal(normalizeClaudeEvent({ type: "system", subtype: "model_fallback" }), null);
});

// rc.147: a run stopped at its limit never reaches the event its usage is
// recorded from, so the meter's own count is recorded instead, by part.
test("the meter keeps what it counted by part, in the usage events' shape", () => {
  const meter = createTokenMeter("claude", 20_000);
  meter.add(claudeMessage("m1", { input_tokens: 2, cache_creation_input_tokens: 3066, cache_read_input_tokens: 1729, output_tokens: 16 }));
  meter.add(claudeMessage("m2", { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 20000, output_tokens: 40 }));
  assert.equal(meter.exceeded, true);
  assert.deepEqual(meter.tokens, { input: 7, output: 56, reasoning: 0, cache: { read: 21729, write: 3166 }, total: 24958 });
  assert.equal(meter.tokens.total, meter.total);
  const copy = meter.tokens;
  copy.cache.read = 0;
  assert.equal(meter.tokens.cache.read, 21729, "a copy, not the meter's own");
});
