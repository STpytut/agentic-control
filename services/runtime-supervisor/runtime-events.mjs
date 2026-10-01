import { claudeRateLimits, claudeTokens, codexRateLimits, codexTokens, costUsd, openCodeTokens } from "./usage-limits.mjs";

// What a normalised event may carry into runtime_activity_events.details. A
// closed list, because these rows are written from a runtime's own stdout and
// the panel reads them: an open one would carry whatever the runtime decided to
// print, including the contents of a file it had just read.
//
// `error` joined it for WP-8a. `complete_task error` reached the panel as
// `{"tool":"complete_task","status":"error"}` — the runtime had said why, and
// the normaliser dropped it on the way past (defect 105).
//
// Stage 12 (limits and usage): `cost_basis` says what a cost is (OpenCode's and
// Claude Code's are list-price estimates, never a charge), `thread_total` is
// Codex's cumulative count that lets a repeated usage update be recognised,
// and `rate_limits` a subscription's windows. Each is built by usage-limits.mjs
// from named, bounded fields — never passed through.
const allowedDetails = new Set([
  "reason", "status", "tool", "item_type", "tokens", "cost", "characters", "error",
  "cost_basis", "thread_total", "rate_limits",
]);

// What a tool said when it failed. OpenCode puts it in different places
// depending on the failure, so each is named rather than the object being
// passed through.
function toolError(state) {
  const value = state?.error ?? state?.output?.error ?? state?.output?.message ?? state?.message;
  if (typeof value === "string") return value;
  if (value && typeof value.message === "string") return value.message;
  return undefined;
}

function cleanDetails(details = {}) {
  return Object.fromEntries(Object.entries(details)
    .filter(([key, value]) => allowedDetails.has(key) && value !== undefined)
    .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 200) : value]));
}

export function normalizeOpenCodeEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "step_start") return {
    eventType: "runtime.turn.started", phase: "running_turn", summary: "OpenCode started a model step", details: {},
  };
  if (event.type === "tool_use") return {
    eventType: "runtime.tool.updated", phase: "running_turn",
    summary: `${String(event.part?.tool ?? "tool").slice(0, 80)} ${String(event.part?.state?.status ?? "updated").slice(0, 40)}`,
    details: cleanDetails({ tool: event.part?.tool, status: event.part?.state?.status,
      error: event.part?.state?.status === "error" ? toolError(event.part?.state) : undefined }),
  };
  // Tokens by name (they were passed through whole), and the cost as what it
  // is: OpenCode's estimate from its catalog price, not the provider's bill.
  if (event.type === "step_finish") {
    const cost = costUsd(event.part?.cost);
    return {
      eventType: "runtime.turn.usage", phase: "running_turn", summary: "OpenCode completed a model step",
      details: cleanDetails({ reason: event.part?.reason, tokens: openCodeTokens(event.part?.tokens) ?? undefined,
        cost, cost_basis: cost === undefined ? undefined : "list_estimate" }),
    };
  }
  if (event.type === "text") return {
    eventType: "runtime.output.completed", phase: "running_turn", summary: "OpenCode produced an agent response",
    details: cleanDetails({ characters: String(event.part?.text ?? "").length }),
  };
  return null;
}

// Claude Code's `--output-format stream-json` (sprint C K2): one object per
// line, each with a type and the session it belongs to. The shapes are the
// PoC's recorded streams at 2.1.270 (drivers/test fixtures).
//
// The cost is kept since Stage 12, labelled for what it is: on a subscription
// login `total_cost_usd` is the list price of the tokens (`costBasis: "list"`),
// not a charge, and the panel shows it as an estimate. The thinking tokens are
// split out of `output_tokens`, which includes them. A `rate_limit_event`
// carries the subscription's windows, the only reading there is of them.
export function normalizeClaudeEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  if (event.type === "system" && event.subtype === "init") return {
    eventType: "runtime.turn.started", phase: "running_turn", summary: "Claude Code started the turn", details: {},
  };
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  if (event.type === "assistant") {
    const tool = blocks.find((block) => block?.type === "tool_use");
    if (tool) return {
      eventType: "runtime.tool.updated", phase: "running_turn",
      summary: `${String(tool.name ?? "tool").slice(0, 80)} requested`,
      details: cleanDetails({ tool: tool.name, status: "requested" }),
    };
    const text = blocks.filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join("");
    if (text) return {
      eventType: "runtime.output.completed", phase: "running_turn", summary: "Claude Code produced an agent response",
      details: cleanDetails({ characters: text.length, error: typeof event.error === "string" ? event.error : undefined }),
    };
    return null;
  }
  if (event.type === "user") {
    const result = blocks.find((block) => block?.type === "tool_result");
    if (!result) return null;
    return {
      eventType: "runtime.tool.updated", phase: "running_turn", summary: `tool ${result.is_error ? "failed" : "completed"}`,
      details: cleanDetails({ status: result.is_error ? "error" : "completed" }),
    };
  }
  if (event.type === "result") {
    const cost = costUsd(event.total_cost_usd);
    return {
      eventType: "runtime.turn.usage", phase: "finalizing",
      summary: event.is_error ? "Claude Code ended the turn with an error" : "Claude Code finished the turn",
      details: cleanDetails({ reason: event.subtype, status: event.is_error ? "error" : "completed",
        tokens: claudeTokens(event.usage), cost, cost_basis: cost === undefined ? undefined : "list_estimate" }),
    };
  }
  if (event.type === "rate_limit_event") {
    const limits = claudeRateLimits(event);
    return limits ? {
      eventType: "runtime.limits.updated", phase: "running_turn", summary: "Claude Code reported the subscription's usage windows",
      details: cleanDetails({ rate_limits: limits, status: limits.status ?? undefined }),
    } : null;
  }
  return null;
}

export function normalizeCodexEvent(message) {
  const method = String(message?.method ?? "");
  if (method === "turn/started") return {
    eventType: "runtime.turn.started", phase: "running_turn", summary: "Codex started the turn", details: {},
  };
  if (method === "item/started" || method === "item/completed") {
    const itemType = String(message.params?.item?.type ?? "item").slice(0, 80);
    return {
      eventType: method === "item/started" ? "runtime.item.started" : "runtime.item.completed",
      phase: "running_turn", summary: `Codex ${method === "item/started" ? "started" : "completed"} ${itemType}`,
      details: cleanDetails({ item_type: itemType }),
    };
  }
  if (method === "turn/completed") return {
    eventType: "runtime.turn.completed", phase: "finalizing", summary: "Codex finished the turn",
    details: cleanDetails({ status: message.params?.turn?.status }),
  };
  // Stage 12: what a model call used (`last`) with the thread's running total,
  // which recognises the same update sent twice (Codex repeats it when only its
  // windows change); and the ChatGPT subscription's windows. No cost: a ChatGPT
  // login reports none.
  if (method === "thread/tokenUsage/updated") {
    const usage = message.params?.tokenUsage;
    const last = codexTokens(usage?.last);
    if (!last) return null;
    const total = codexTokens(usage?.total);
    return {
      eventType: "runtime.usage.updated", phase: "running_turn", summary: "Codex reported token usage",
      details: cleanDetails({ tokens: last, thread_total: total ? total.total : undefined }),
    };
  }
  if (method === "account/rateLimits/updated") {
    const limits = codexRateLimits(message.params);
    return limits ? {
      eventType: "runtime.limits.updated", phase: "running_turn", summary: "Codex reported the subscription's usage windows",
      details: cleanDetails({ rate_limits: limits }),
    } : null;
  }
  return null;
}

// Codex as an executor (Stage 12 X2) runs `codex exec --json`, whose events
// differ from app-server's: `thread.started` names the session, `item.*`
// carry commands, file changes, MCP calls and messages, `turn.completed`
// the turn's usage (snake_case, 0.158.0 on the host), `turn.failed` and
// `error` the reason a turn stopped.
export function codexExecTokens(usage) {
  const u = usage && typeof usage === "object" && !Array.isArray(usage) ? usage : null;
  if (!u) return null;
  return codexTokens({ inputTokens: u.input_tokens, cachedInputTokens: u.cached_input_tokens,
    cacheWriteInputTokens: u.cache_write_input_tokens, outputTokens: u.output_tokens, reasoningOutputTokens: u.reasoning_output_tokens });
}

export function normalizeCodexExecEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const type = String(event.type ?? "");
  if (type === "turn.started") return {
    eventType: "runtime.turn.started", phase: "running_turn", summary: "Codex started the turn", details: {},
  };
  if (type === "item.started" || type === "item.completed" || type === "item.updated") {
    const item = event.item && typeof event.item === "object" ? event.item : {};
    const itemType = String(item.type ?? "item").slice(0, 80);
    const tool = itemType === "mcp_tool_call" ? item.tool : itemType === "command_execution" ? "shell" : undefined;
    return {
      eventType: type === "item.started" ? "runtime.item.started" : "runtime.item.completed",
      phase: "running_turn", summary: `Codex ${type === "item.started" ? "started" : "completed"} ${itemType}`,
      details: cleanDetails({ item_type: itemType, tool, status: typeof item.status === "string" ? item.status : undefined,
        error: typeof item.error?.message === "string" ? item.error.message : undefined }),
    };
  }
  if (type === "turn.completed") return {
    eventType: "runtime.turn.usage", phase: "finalizing", summary: "Codex finished the turn",
    details: cleanDetails({ status: "completed", tokens: codexExecTokens(event.usage) ?? undefined }),
  };
  if (type === "turn.failed" || type === "error") return {
    eventType: "runtime.turn.completed", phase: "finalizing", summary: "Codex ended the turn with an error",
    details: cleanDetails({ status: "error", error: String(event.error?.message ?? event.message ?? "").slice(0, 200) || undefined }),
  };
  return null;
}
