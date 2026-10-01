// Tokens, cost and subscription windows, as each runtime reports them (Stage 12;
// docs/REASONING_AND_LIMITS_RESEARCH.md §1 B, §2 B, §3 B2).
//
// Everything here reads a runtime's own output, which the product does not
// control, so each value is picked by name, checked for its type and range, and
// bounded; anything else is dropped. Unknown is null, never a guess: a window
// whose percentage cannot be read is left out rather than shown as 0 %.
//
// One shape for tokens, whichever runtime: `input` excludes cached input,
// `output` excludes reasoning, and `total` is the sum of the five parts.
//
// | Runtime  | tokens from                                            | cost                         |
// | Codex    | thread/tokenUsage/updated `last` (input includes cache, | none on a ChatGPT login      |
// |          | output includes reasoning — both split here)            |                              |
// | Claude   | result.usage + output_tokens_details.thinking_tokens    | total_cost_usd, list price   |
// | OpenCode | step_finish part.tokens                                 | part.cost, OpenCode's        |
// |          |                                                         | estimate at list price       |

const MAX_TOKENS = 50_000_000; // per event: far above any one model call
const MAX_COST_USD = 1_000; // per event

function count(value) {
  const number = typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) : value;
  return Number.isInteger(number) && number >= 0 && number <= MAX_TOKENS ? number : 0;
}

function tokens({ input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0 }) {
  const parts = { input: count(input), output: count(output), reasoning: count(reasoning),
    cache: { read: count(cacheRead), write: count(cacheWrite) } };
  parts.total = parts.input + parts.output + parts.reasoning + parts.cache.read + parts.cache.write;
  return parts;
}

export function costUsd(value) {
  const number = typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > MAX_COST_USD) return undefined;
  return Math.round(number * 1e6) / 1e6;
}

const obj = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

// Codex app-server `TokenUsageBreakdown` (v2/thread.rs:1855-1935).
export function codexTokens(breakdown) {
  const b = obj(breakdown);
  if (!b) return null;
  const input = count(b.inputTokens);
  const cached = Math.min(count(b.cachedInputTokens), input);
  const output = count(b.outputTokens);
  const reasoning = Math.min(count(b.reasoningOutputTokens), output);
  return tokens({ input: input - cached, cacheRead: cached, cacheWrite: b.cacheWriteInputTokens,
    output: output - reasoning, reasoning });
}

// Claude Code's `result.usage`. output_tokens includes the thinking tokens
// (recorded at 2.1.270: 701 output, 423 thinking, costed as 701).
export function claudeTokens(usage) {
  const u = obj(usage) ?? {};
  const output = count(u.output_tokens);
  const thinking = Math.min(count(u.output_tokens_details?.thinking_tokens), output);
  return tokens({ input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens,
    output: output - thinking, reasoning: thinking });
}

// OpenCode's `step_finish` part.tokens: already input without cache and output
// without reasoning (opencode:session.ts:338-402).
export function openCodeTokens(value) {
  const t = obj(value);
  if (!t) return null;
  return tokens({ input: t.input, output: t.output, reasoning: t.reasoning,
    cacheRead: obj(t.cache)?.read, cacheWrite: obj(t.cache)?.write });
}

// ------------------------------------------------------------------ windows

function percent(value, { fraction = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const p = fraction ? value * 100 : value;
  if (p < 0 || p > 1000) return null;
  return Math.round(Math.min(p, 100) * 10) / 10;
}

// Unix seconds, as both runtimes send them; milliseconds and ISO strings are
// accepted defensively. Out of any plausible range is null.
function epochSeconds(value) {
  let seconds = null;
  if (typeof value === "number" && Number.isFinite(value)) seconds = value > 1e12 ? value / 1000 : value;
  else if (typeof value === "string" && !Number.isNaN(Date.parse(value))) seconds = Date.parse(value) / 1000;
  if (seconds === null || seconds < 1_600_000_000 || seconds > 4_100_000_000) return null;
  return Math.floor(seconds);
}

function minutes(value) {
  return Number.isInteger(value) && value > 0 && value <= 527_040 ? value : null;
}

const WORD = /^[a-z0-9_]{1,40}$/;
const word = (value) => {
  const text = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return WORD.test(text) ? text : null;
};

function window(key, { used, resetsAt, windowMinutes }) {
  if (used === null) return null;
  return { key, used_percent: used, resets_at: epochSeconds(resetsAt), window_minutes: minutes(windowMinutes) };
}

// Codex `RateLimitSnapshot` (v2/account.rs:664-676, 752-778), from
// `account/rateLimits/read` (its `rateLimits`) or `account/rateLimits/updated`.
// `primary` is the 5 h window, `secondary` the weekly one; the key says which
// by its length when the snapshot says it.
export function codexRateLimits(result) {
  const snapshot = obj(result?.rateLimits) ?? obj(result);
  if (!snapshot) return null;
  const windows = [];
  for (const slot of ["primary", "secondary"]) {
    const w = obj(snapshot[slot]);
    if (!w) continue;
    const entry = window(slot, { used: percent(w.usedPercent), resetsAt: w.resetsAt, windowMinutes: w.windowDurationMins });
    if (entry) windows.push(entry);
  }
  const credits = obj(snapshot.credits);
  const balance = typeof credits?.balance === "string" && /^-?\d{1,12}(\.\d{1,6})?$/.test(credits.balance.trim())
    ? credits.balance.trim() : typeof credits?.balance === "number" && Number.isFinite(credits.balance) ? String(credits.balance) : null;
  const reading = {
    windows,
    plan: word(snapshot.planType),
    credits: credits ? {
      has_credits: typeof credits.hasCredits === "boolean" ? credits.hasCredits : null,
      unlimited: typeof credits.unlimited === "boolean" ? credits.unlimited : null,
      balance,
    } : null,
    status: snapshot.rateLimitReachedType ? "rejected" : null,
    limit_id: word(snapshot.limitId),
  };
  return reading.windows.length || reading.plan || reading.credits ? reading : null;
}

const CLAUDE_WINDOWS = Object.freeze({ five_hour: 300, seven_day: 10_080, seven_day_opus: 10_080, seven_day_sonnet: 10_080 });

// Claude Code's stream-json `rate_limit_event` (agent-sdk SDKRateLimitEvent,
// plus the undocumented `unifiedWindows` recorded on the host at 2.1.270:
// utilization is a 0–1 fraction, resetsAt unix seconds). Pinned to what was
// recorded; a field that moves between releases becomes null, not wrong.
export function claudeRateLimits(event) {
  const info = obj(event?.rate_limit_info);
  if (!info) return null;
  const windows = [];
  const unified = obj(info.unifiedWindows);
  if (unified) {
    for (const [name, value] of Object.entries(unified).slice(0, 6)) {
      const key = word(name);
      const w = obj(value);
      if (!key || !w) continue;
      const entry = window(key, { used: percent(w.utilization, { fraction: true }), resetsAt: w.resetsAt,
        windowMinutes: CLAUDE_WINDOWS[key] ?? null });
      if (entry) windows.push(entry);
    }
  } else {
    // The documented fields alone: one window, the one the event is about.
    const key = word(info.rateLimitType) ?? "current";
    const entry = window(key, { used: percent(info.utilization, { fraction: true }), resetsAt: info.resetsAt,
      windowMinutes: CLAUDE_WINDOWS[key] ?? null });
    if (entry) windows.push(entry);
  }
  const status = ["allowed", "allowed_warning", "rejected"].includes(info.status) ? info.status : null;
  if (!windows.length && !status) return null;
  return { windows, plan: null, credits: null, status, limit_id: null };
}

// ------------------------------------------------------------------ totals

// What a run's normalised events add up to — the model check lane's own
// accounting, since a check has no job and writes no activity events. Codex
// repeats a usage notification when only its windows change, so a Codex
// update whose thread total did not move is not counted twice.
export function summarizeUsage(events) {
  const sum = tokens({});
  let cost = null;
  let costBasis = "none";
  let steps = 0;
  let threadTotal = null;
  let rateLimits = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event?.details) continue;
    if (event.eventType === "runtime.limits.updated" && event.details.rate_limits) rateLimits = event.details.rate_limits;
    if (event.eventType !== "runtime.turn.usage" && event.eventType !== "runtime.usage.updated") continue;
    const t = event.details.tokens;
    if (!t) continue;
    const total = Number.isInteger(event.details.thread_total) ? event.details.thread_total : null;
    if (total !== null) {
      if (threadTotal !== null && total <= threadTotal) continue;
      threadTotal = total;
    }
    sum.input += count(t.input);
    sum.output += count(t.output);
    sum.reasoning += count(t.reasoning);
    sum.cache.read += count(t.cache?.read);
    sum.cache.write += count(t.cache?.write);
    steps += 1;
    const c = costUsd(event.details.cost);
    if (c !== undefined) {
      cost = Math.round(((cost ?? 0) + c) * 1e6) / 1e6;
      costBasis = event.details.cost_basis === "provider" ? "provider" : "list_estimate";
    }
  }
  sum.total = sum.input + sum.output + sum.reasoning + sum.cache.read + sum.cache.write;
  return { tokens: sum, cost, cost_basis: cost === null ? "none" : costBasis, steps, rate_limits: rateLimits };
}
