// The panel's reading of limits and consumption (Stage 12; migrations 0113,
// 0114): the JSON the two functions return is read field for field and
// nothing is invented; a cost says whether it is an estimate; a window says
// when it resets and when it was read; a connection whose limits cannot be
// read says why; an OpenCode Go model is set beside its published estimate
// only when its id matches one. lib/usage.ts imports only types, so it loads
// as it is.
import test from "node:test";
import assert from "node:assert/strict";

const usage = await import("../../../apps/web/src/lib/usage.ts");

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const totals = (over = {}) => ({ input_tokens: 900, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 80,
  reasoning_tokens: 20, total_tokens: 1000, cost_usd: null, cost_basis: "none", runs: 1, model_steps: 2,
  checks: { count: 1, total_tokens: 40, cost_usd: null }, updated_at: "2026-09-29T10:00:00Z", ...over });

// As get_operator_usage_limits returns it (0073's fixture, shortened).
const operatorJson = {
  generated_at: "2026-09-29T10:00:00Z", day_start: "2026-09-29T00:00:00Z",
  connections: [
    { connection_id: id(1), provider: "codex", label: "ChatGPT", gateway: "openai_chatgpt", runtime_type: "codex",
      status: "connected", billing: "subscription", limits_mode: "read",
      limits: { source: "runtime_stream", read_at: "2026-09-29T09:58:00Z", first_read_at: "2026-09-29T09:50:00Z", plan: "pro",
        credits: { has_credits: false, unlimited: false, balance: "0" }, status: null, error_class: null,
        windows: [
          { key: "primary", used_percent: 61, resets_at: "2026-09-29T11:00:00Z", window_minutes: 300, reset_passed: false },
          { key: "secondary", used_percent: 120, resets_at: null, window_minutes: 10080, reset_passed: false },
          { key: "stale", used_percent: 99, resets_at: "2026-09-29T09:59:00Z", window_minutes: 60, reset_passed: true },
          { used_percent: 5 },
        ] },
      today: totals(), window: { key: "primary", since: "2026-09-29T06:00:00Z", until: "2026-09-29T11:00:00Z", usage: totals() },
      requests_5h: null },
    { connection_id: id(2), provider: "openrouter", label: "OpenRouter", gateway: "openrouter", runtime_type: "opencode",
      status: "connected", billing: "metered", limits_mode: "none", limits: null,
      today: totals({ cost_usd: 0.02, cost_basis: "list_estimate", total_tokens: 500 }), window: null, requests_5h: null },
    { connection_id: id(3), provider: "opencode-go", label: "OpenCode Go", gateway: "opencode_go", runtime_type: "opencode",
      status: "connected", billing: "subscription", limits_mode: "probe", limits: null, today: totals(), window: null,
      requests_5h: { since: "2026-09-29T05:00:00Z", models: [
        { model: "kimi-k3", requests: 7, total_tokens: 900 },
        { model: "opencode-go/glm-5.3-flash", requests: 1, total_tokens: 30 },
        { model: "an-unknown-model", requests: 2, total_tokens: 10 },
      ] } },
    { connection_id: id(4), provider: "opencode", label: "OpenCode Zen", gateway: "opencode_zen", runtime_type: "opencode",
      status: "connected", billing: "free", limits_mode: "free", limits: null, today: totals(), window: null, requests_5h: null },
  ],
};

test("Settings: each connection, field for field, and nothing the database did not send", () => {
  const parsed = usage.operatorUsageFromJson(operatorJson);
  assert.equal(parsed.connections.length, 4);
  const [chatgpt, router, go, zen] = parsed.connections;
  assert.equal(chatgpt.label, "ChatGPT");
  assert.equal(chatgpt.limitsMode, "read");
  assert.equal(chatgpt.limits.plan, "pro");
  assert.deepEqual(chatgpt.limits.credits, { hasCredits: false, unlimited: false, balance: "0" });
  // A window without a key is not a window; a percentage past 100 is 100.
  assert.deepEqual(chatgpt.limits.windows.map((w) => [w.key, w.usedPercent, w.resetPassed]),
    [["primary", 61, false], ["secondary", 100, false], ["stale", 99, true]]);
  assert.equal(chatgpt.today.totalTokens, 1000);
  assert.equal(chatgpt.today.checks.count, 1);
  assert.equal(chatgpt.today.costUsd, null, "no cost reported is not $0");
  assert.equal(chatgpt.window.key, "primary");
  assert.equal(router.today.costBasis, "list_estimate");
  assert.equal(router.limits, null);
  assert.equal(go.limitsMode, "probe");
  assert.equal(zen.limitsMode, "free");
  // An unknown mode, source or status is not trusted.
  const odd = usage.operatorUsageFromJson({ connections: [{ connection_id: id(9), limits_mode: "guess",
    limits: { source: "somewhere", windows: [] }, today: {} }] });
  assert.equal(odd.connections[0].limitsMode, "none");
  assert.equal(odd.connections[0].limits, null);
  assert.deepEqual(usage.operatorUsageFromJson(null).connections, []);
});

test("a cost says what it is, and nothing reported is not shown as zero", () => {
  assert.equal(usage.costText(0.0125, "list_estimate"), "≈ $0.013 est.");
  assert.equal(usage.costText(2.5, "provider"), "$2.50");
  assert.equal(usage.costText(0.001, "list_estimate"), "≈ $<0.01 est.");
  assert.equal(usage.costText(null, "none"), "");
  assert.equal(usage.costText(0.5, "none"), "");
  assert.match(usage.costTitle("list_estimate"), /list price, not a charge/);
});

test("a window says its name, when it resets and when it was read", () => {
  const now = Date.parse("2026-09-29T10:00:00Z");
  assert.equal(usage.windowLabel({ key: "primary", windowMinutes: 300 }), "5-hour window");
  assert.equal(usage.windowLabel({ key: "seven_day", windowMinutes: 10080 }), "7-day window");
  assert.equal(usage.windowLabel({ key: "rolling", windowMinutes: null }), "5-hour window");
  assert.equal(usage.windowLabel({ key: "custom_one", windowMinutes: 2880 }), "2-day window");
  assert.equal(usage.resetText({ resetsAt: "2026-09-29T11:20:00Z", resetPassed: false }, now), "resets in 1 h 20 min");
  assert.equal(usage.resetText({ resetsAt: "2026-09-29T09:59:00Z", resetPassed: false }, now), "has reset since this reading");
  assert.equal(usage.resetText({ resetsAt: null, resetPassed: false }, now), "reset time not reported");
  assert.equal(usage.readAge("2026-09-29T09:58:00Z", now), "read 2 min ago");
  assert.equal(usage.readAge("2026-09-29T09:59:40Z", now), "read just now");
  assert.equal(usage.windowTone({ usedPercent: 95, resetPassed: false }), "danger");
  assert.equal(usage.windowTone({ usedPercent: 95, resetPassed: true }), "neutral");
  assert.equal(usage.sourceLabel("runtime_read"), "read from the runtime");
});

test("a connection whose limits cannot be read says why", () => {
  // OpenCode Go (ADR-0019): what the probe found, or why it has not read.
  assert.match(usage.limitsNote({ limitsMode: "probe", limits: null, status: "action_required" }), /Connect OpenCode Go/);
  assert.match(usage.limitsNote({ limitsMode: "probe", limits: null, status: "connected" }), /every five minutes/);
  assert.match(usage.limitsNote({ limitsMode: "probe", limits: { windows: [], errorClass: "not_subscribed" } }), /no OpenCode Go subscription/);
  assert.equal(usage.limitsNote({ limitsMode: "probe", limits: { windows: [{ key: "rolling" }], errorClass: null } }), "");
  assert.equal(usage.limitsNote({ limitsMode: "free", limits: null }), "Free — no limits.");
  assert.match(usage.limitsNote({ limitsMode: "none", limits: null }), /balance is not read/);
  assert.match(usage.limitsNote({ limitsMode: "stream", limits: null }), /only during a run/);
  assert.equal(usage.limitsNote({ limitsMode: "read", limits: { windows: [] } }), "");
});

test("OpenCode Go: a model is set beside its published estimate only when its id matches one", () => {
  const go = usage.operatorUsageFromJson(operatorJson).connections[2];
  const [kimi, glm, unknown] = go.requests5h.models;
  assert.equal(kimi.requests, 7);
  assert.equal(kimi.estimate.name, "Kimi K3");
  assert.equal(usage.goEstimateText(kimi.estimate), "≈ 110,440 per 5 h (estimate, opencode.ai/go)");
  assert.equal(glm.estimate.name, "GLM-5.3-Flash");
  assert.equal(usage.goEstimateText(glm.estimate), "≈ 6,320–18,960 per 5 h (estimate, opencode.ai/go)");
  assert.equal(unknown.estimate, null);
  assert.equal(usage.goEstimateFor("gpt-6-luna").name, "GPT 6 Luna");
  assert.equal(usage.goEstimateFor("qwen3.7-plus").name, "Qwen 3.7 Plus");
  assert.equal(usage.goEstimateText(usage.goEstimateFor("space-bunny-free")), "unlimited for a limited time (opencode.ai/go)");
  assert.equal(usage.OPENCODE_GO_ESTIMATES.source, "https://opencode.ai/go");
  assert.equal(usage.OPENCODE_GO_ESTIMATES.fetchedAt, "2026-09-29");
});

test("the task view: members with their usage, running while their attempt is open", () => {
  const parsed = usage.taskUsageFromJson({
    task_id: id(10), generated_at: "2026-09-29T10:00:00Z", active: true, totals: totals({ total_tokens: 8500 }),
    members: [
      { assignment_id: id(11), agent_name: "reads-codex", runtime_type: "codex", role_key: "orchestrator", model: "gpt-reads",
        reasoning_effort: "medium", connection_id: id(1), running: true, usage: totals({ total_tokens: 8000, runs: 2 }) },
      { assignment_id: id(12), agent_name: "reads-worker", runtime_type: "opencode", role_key: null, model: null,
        reasoning_effort: null, connection_id: null, running: false, usage: totals({ total_tokens: 0, runs: 0 }) },
    ],
    connections: [{ connection_id: id(1), label: "ChatGPT", gateway: "openai_chatgpt", runtime_type: "codex",
      limits_mode: "read", limits: operatorJson.connections[0].limits }],
  });
  assert.equal(parsed.active, true);
  assert.equal(parsed.totals.totalTokens, 8500);
  assert.deepEqual(parsed.members.map((m) => [m.roleKey, m.running, m.usage.totalTokens, m.reasoningEffort]),
    [["orchestrator", true, 8000, "medium"], ["executor", false, 0, null]]);
  assert.equal(parsed.connections[0].limits.windows.length, 3);
  assert.equal(usage.taskUsageFromJson(null), null, "a task that is not the operator's reads as nothing");
});
