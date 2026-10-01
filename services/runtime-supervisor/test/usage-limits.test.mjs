// Tokens, cost and windows as the three runtimes report them (Stage 12;
// docs/REASONING_AND_LIMITS_RESEARCH.md §1 B, §2 B, §3 B2). The fixtures are
// shaped like the research doc's sources: Codex 0.158.0's app-server
// notifications, Claude Code 2.1.270's recorded stream, OpenCode 1.18.32's
// step_finish.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizeClaudeEvent, normalizeCodexEvent, normalizeOpenCodeEvent } from "../runtime-events.mjs";
import { claudeRateLimits, codexRateLimits, summarizeUsage } from "../usage-limits.mjs";
import { driverFor } from "../drivers/index.mjs";
import { usageOf } from "../../control-plane/catalog-gate-worker.mjs";

const RESET = 1_790_443_800;

const codexSnapshot = {
  limitId: "codex", limitName: null,
  primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: RESET },
  secondary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: RESET + 86_400 },
  credits: { hasCredits: true, unlimited: false, balance: "12.5" },
  individualLimit: null, spendControlReached: false, planType: "plus", rateLimitReachedType: null,
};

test("Codex: a model call's usage is split into the one shape, with the thread's running total", () => {
  const event = normalizeCodexEvent({ method: "thread/tokenUsage/updated", params: { threadId: "t", turnId: "u", tokenUsage: {
    total: { totalTokens: 1_300, inputTokens: 1_000, cachedInputTokens: 600, cacheWriteInputTokens: 0, outputTokens: 300, reasoningOutputTokens: 120 },
    last: { totalTokens: 650, inputTokens: 500, cachedInputTokens: 300, cacheWriteInputTokens: 10, outputTokens: 150, reasoningOutputTokens: 60 },
    modelContextWindow: 272_000,
  } } });
  assert.equal(event.eventType, "runtime.usage.updated");
  // input without the cached part; output without the reasoning part.
  assert.deepEqual(event.details.tokens, { input: 200, output: 90, reasoning: 60, cache: { read: 300, write: 10 }, total: 660 });
  assert.equal(event.details.thread_total, 1_300);
  assert.equal(event.details.cost, undefined, "a ChatGPT login reports no cost");
  assert.equal(normalizeCodexEvent({ method: "thread/tokenUsage/updated", params: { threadId: "t" } }), null,
    "an update without usage is not an event");
});

test("Codex: the windows, the plan and the credits, from the notification and from the read alike", () => {
  const pushed = normalizeCodexEvent({ method: "account/rateLimits/updated", params: { rateLimits: codexSnapshot } });
  assert.equal(pushed.eventType, "runtime.limits.updated");
  assert.deepEqual(pushed.details.rate_limits, {
    windows: [
      { key: "primary", used_percent: 42, resets_at: RESET, window_minutes: 300 },
      { key: "secondary", used_percent: 7, resets_at: RESET + 86_400, window_minutes: 10_080 },
    ],
    plan: "plus", credits: { has_credits: true, unlimited: false, balance: "12.5" }, status: null, limit_id: "codex",
  });
  // account/rateLimits/read answers { rateLimits, rateLimitsByLimitId, … }.
  assert.deepEqual(codexRateLimits({ rateLimits: codexSnapshot, rateLimitsByLimitId: {}, accountId: "acct" }),
    pushed.details.rate_limits);
  // Defensive: nothing usable is null, a percentage that is not one is dropped.
  assert.equal(codexRateLimits({ rateLimits: {} }), null);
  assert.equal(codexRateLimits(null), null);
  const odd = codexRateLimits({ rateLimits: { primary: { usedPercent: "42" }, secondary: { usedPercent: 3, resetsAt: "soon" },
    planType: "Team Plan", credits: { balance: "$5", hasCredits: "yes" }, rateLimitReachedType: "primary" } });
  assert.deepEqual(odd, { windows: [{ key: "secondary", used_percent: 3, resets_at: null, window_minutes: null }],
    plan: "team_plan", credits: { has_credits: null, unlimited: null, balance: null }, status: "rejected", limit_id: null });
});

test("Claude Code: the recorded result keeps thinking apart and its cost as a list-price estimate", () => {
  const stream = readFileSync(new URL("./claude-streams/stream-orchestrator-mcp.jsonl", import.meta.url), "utf8");
  const events = stream.split("\n").filter(Boolean).map((line) => normalizeClaudeEvent(JSON.parse(line))).filter(Boolean);
  const usage = events.find((event) => event.eventType === "runtime.turn.usage");
  assert.deepEqual(usage.details.tokens, { input: 26, output: 278, reasoning: 423, cache: { read: 20_602, write: 10_819 }, total: 32_148 });
  assert.equal(usage.details.cost, 0.027229);
  assert.equal(usage.details.cost_basis, "list_estimate");
  const limits = events.filter((event) => event.eventType === "runtime.limits.updated");
  assert.ok(limits.length >= 1);
  assert.deepEqual(limits[0].details.rate_limits.windows, [
    { key: "five_hour", used_percent: 78, resets_at: 1_790_443_800, window_minutes: 300 },
    { key: "seven_day", used_percent: 10, resets_at: 1_791_028_800, window_minutes: 10_080 },
  ]);
  assert.equal(limits[0].details.status, "allowed");
});

test("Claude Code: the undocumented windows are read defensively, and the documented fields suffice", () => {
  // Only the documented fields: one window, the one the event names.
  assert.deepEqual(claudeRateLimits({ rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.912, resetsAt: RESET } }),
    { windows: [{ key: "seven_day", used_percent: 91.2, resets_at: RESET, window_minutes: 10_080 }],
      plan: null, credits: null, status: "allowed_warning", limit_id: null });
  // A moved field is left out, not guessed; an unknown status is null.
  assert.deepEqual(claudeRateLimits({ rate_limit_info: { status: "maybe", unifiedWindows: {
    five_hour: { utilization: "78%" }, "Opus Week": { utilization: 0.5, resetsAt: "not a time" } } } }),
    { windows: [{ key: "opus_week", used_percent: 50, resets_at: null, window_minutes: null }],
      plan: null, credits: null, status: null, limit_id: null });
  assert.equal(claudeRateLimits({ rate_limit_info: {} }), null);
  assert.equal(normalizeClaudeEvent({ type: "rate_limit_event", rate_limit_info: { status: "sure" } }), null);
  // A rejected window still says so, with or without a percentage.
  assert.equal(normalizeClaudeEvent({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }).details.status, "rejected");
});

test("OpenCode: step_finish tokens by name and its cost as OpenCode's estimate", () => {
  const event = normalizeOpenCodeEvent({ type: "step_finish", part: { reason: "stop", cost: 0.0042,
    tokens: { total: 1_830, input: 1_200, output: 300, reasoning: 30, cache: { read: 300, write: 0 }, secret: "x" } } });
  assert.deepEqual(event.details, { reason: "stop", tokens: { input: 1_200, output: 300, reasoning: 30, cache: { read: 300, write: 0 }, total: 1_830 },
    cost: 0.0042, cost_basis: "list_estimate" });
  const junk = normalizeOpenCodeEvent({ type: "step_finish", part: { cost: "a lot", tokens: { input: -1, output: "2" } } });
  assert.deepEqual(junk.details.tokens, { input: 0, output: 2, reasoning: 0, cache: { read: 0, write: 0 }, total: 2 });
  assert.equal(junk.details.cost, undefined);
  assert.equal(junk.details.cost_basis, undefined);
});

test("a check's usage adds up once: a Codex update repeated with the same thread total is not counted twice", () => {
  const update = (last, total) => ({ method: "thread/tokenUsage/updated", params: { tokenUsage: {
    last: { inputTokens: last, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: last },
    total: { inputTokens: total, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: total } } } });
  const summary = usageOf(driverFor("codex"), [
    update(100, 100), update(100, 100), { method: "account/rateLimits/updated", params: { rateLimits: codexSnapshot } },
    update(50, 150), { method: "turn/completed", params: { turn: { status: "completed" } } },
  ]);
  assert.equal(summary.tokens.total, 150);
  assert.equal(summary.steps, 2);
  assert.equal(summary.cost, null);
  assert.equal(summary.cost_basis, "none");
  assert.equal(summary.rate_limits.plan, "plus");

  const opencode = summarizeUsage([
    normalizeOpenCodeEvent({ type: "step_finish", part: { cost: 0.001, tokens: { input: 10, output: 5 } } }),
    normalizeOpenCodeEvent({ type: "step_finish", part: { cost: 0.002, tokens: { input: 20, output: 5 } } }),
  ]);
  assert.equal(opencode.tokens.total, 40);
  assert.equal(opencode.cost, 0.003);
  assert.equal(opencode.cost_basis, "list_estimate");
  assert.equal(opencode.steps, 2);
});
