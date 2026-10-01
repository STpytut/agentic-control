// Limits and consumption, as the panel reads them (Stage 12; migrations 0113,
// 0114). Pure: the parsing of get_operator_usage_limits and get_task_usage, the
// words and numbers the cards show, and the OpenCode Go estimates. It imports
// only types, so the client cards and the tests load it as it is.
//
// What the numbers are, said where they are shown:
//   * a window's percentage is the provider's, as last read — with when, and
//     from where (a run's own stream, a read without a model call);
//   * a cost is an estimate at list price unless the database says a provider
//     billed it (none does today): OpenCode prices its own tokens, Claude Code
//     reports the list price of a subscription's tokens, Codex reports none;
//   * "today" is the UTC day; model checks are counted apart.

type Json = Record<string, unknown>;

export type LimitsMode = "read" | "stream" | "probe" | "free" | "none";
export type CostBasis = "provider" | "list_estimate" | "none";

export type UsageWindow = {
  key: string;
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
  resetPassed: boolean;
};

export type UsageReading = {
  source: "runtime_stream" | "runtime_read" | "probe";
  readAt: string;
  windows: UsageWindow[];
  plan: string | null;
  credits: { hasCredits: boolean | null; unlimited: boolean | null; balance: string | null } | null;
  status: "allowed" | "allowed_warning" | "rejected" | null;
  errorClass: string | null;
};

export type UsageTotals = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costBasis: CostBasis;
  runs: number;
  modelSteps: number;
  checks: { count: number; totalTokens: number; costUsd: number | null };
  updatedAt: string | null;
};

export type GoEstimate = { name: string; min: number | null; max: number | null; unlimited: boolean };

export type ModelRequests = { model: string; requests: number; totalTokens: number; estimate: GoEstimate | null };

export type ConnectionUsage = {
  connectionId: string;
  provider: string;
  label: string;
  gateway: string;
  runtimeType: string;
  status: string;
  billing: string;
  limitsMode: LimitsMode;
  limits: UsageReading | null;
  today: UsageTotals;
  window: { key: string; since: string; until: string; usage: UsageTotals } | null;
  requests5h: { since: string; models: ModelRequests[] } | null;
};

export type OperatorUsage = { generatedAt: string; dayStart: string; connections: ConnectionUsage[] };

export type MemberUsage = {
  assignmentId: string;
  agentName: string;
  runtimeType: string;
  roleKey: string;
  model: string | null;
  reasoningEffort: string | null;
  connectionId: string | null;
  running: boolean;
  usage: UsageTotals;
};

export type TaskConnectionLimits = {
  connectionId: string;
  label: string;
  gateway: string;
  runtimeType: string;
  limitsMode: LimitsMode;
  limits: UsageReading | null;
};

export type TaskUsage = {
  taskId: string;
  generatedAt: string;
  active: boolean;
  totals: UsageTotals;
  members: MemberUsage[];
  connections: TaskConnectionLimits[];
};

// ------------------------------------------------------------------ parsing

const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown) => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown) => (typeof value === "string" && value ? value : null);
const num = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (value: unknown) => (value === null || value === undefined || value === "" ? null
  : Number.isFinite(Number(value)) ? Number(value) : null);
const boolOrNull = (value: unknown) => (typeof value === "boolean" ? value : null);

const MODES = new Set<LimitsMode>(["read", "stream", "probe", "free", "none"]);
const SOURCES = new Set(["runtime_stream", "runtime_read", "probe"]);
const STATUSES = new Set(["allowed", "allowed_warning", "rejected"]);

export function usageTotalsFromJson(value: unknown): UsageTotals {
  const v = obj(value) ?? {};
  const checks = obj(v.checks) ?? {};
  const basis = str(v.cost_basis);
  return {
    inputTokens: num(v.input_tokens), cacheReadTokens: num(v.cache_read_tokens), cacheWriteTokens: num(v.cache_write_tokens),
    outputTokens: num(v.output_tokens), reasoningTokens: num(v.reasoning_tokens), totalTokens: num(v.total_tokens),
    costUsd: numOrNull(v.cost_usd),
    costBasis: basis === "provider" || basis === "list_estimate" ? basis : "none",
    runs: num(v.runs), modelSteps: num(v.model_steps),
    checks: { count: num(checks.count), totalTokens: num(checks.total_tokens), costUsd: numOrNull(checks.cost_usd) },
    updatedAt: strOrNull(v.updated_at),
  };
}

export function usageReadingFromJson(value: unknown): UsageReading | null {
  const v = obj(value);
  if (!v || !SOURCES.has(str(v.source))) return null;
  const credits = obj(v.credits);
  return {
    source: str(v.source) as UsageReading["source"],
    readAt: str(v.read_at),
    windows: list(v.windows).map(obj).filter((w): w is Json => Boolean(w) && typeof w?.key === "string").map((w) => ({
      key: str(w.key), usedPercent: Math.max(0, Math.min(100, num(w.used_percent))),
      resetsAt: strOrNull(w.resets_at), windowMinutes: numOrNull(w.window_minutes), resetPassed: w.reset_passed === true,
    })),
    plan: strOrNull(v.plan),
    credits: credits ? { hasCredits: boolOrNull(credits.has_credits), unlimited: boolOrNull(credits.unlimited), balance: strOrNull(credits.balance) } : null,
    status: STATUSES.has(str(v.status)) ? str(v.status) as UsageReading["status"] : null,
    errorClass: strOrNull(v.error_class),
  };
}

const mode = (value: unknown): LimitsMode => (MODES.has(str(value) as LimitsMode) ? str(value) as LimitsMode : "none");

export function operatorUsageFromJson(value: unknown): OperatorUsage {
  const v = obj(value) ?? {};
  return {
    generatedAt: str(v.generated_at), dayStart: str(v.day_start),
    connections: list(v.connections).map(obj).filter((c): c is Json => Boolean(c)).map((c) => {
      const window = obj(c.window);
      const requests = obj(c.requests_5h);
      return {
        connectionId: str(c.connection_id), provider: str(c.provider), label: str(c.label) || str(c.provider),
        gateway: str(c.gateway), runtimeType: str(c.runtime_type), status: str(c.status), billing: str(c.billing),
        limitsMode: mode(c.limits_mode), limits: usageReadingFromJson(c.limits), today: usageTotalsFromJson(c.today),
        window: window ? { key: str(window.key), since: str(window.since), until: str(window.until), usage: usageTotalsFromJson(window.usage) } : null,
        requests5h: requests ? {
          since: str(requests.since),
          models: list(requests.models).map(obj).filter((m): m is Json => Boolean(m)).map((m) => ({
            model: str(m.model), requests: num(m.requests), totalTokens: num(m.total_tokens), estimate: goEstimateFor(str(m.model)),
          })),
        } : null,
      };
    }),
  };
}

export function taskUsageFromJson(value: unknown): TaskUsage | null {
  const v = obj(value);
  if (!v) return null;
  return {
    taskId: str(v.task_id), generatedAt: str(v.generated_at), active: v.active === true,
    totals: usageTotalsFromJson(v.totals),
    members: list(v.members).map(obj).filter((m): m is Json => Boolean(m)).map((m) => ({
      assignmentId: str(m.assignment_id), agentName: str(m.agent_name), runtimeType: str(m.runtime_type),
      roleKey: str(m.role_key) || "executor", model: strOrNull(m.model), reasoningEffort: strOrNull(m.reasoning_effort),
      connectionId: strOrNull(m.connection_id), running: m.running === true, usage: usageTotalsFromJson(m.usage),
    })),
    connections: list(v.connections).map(obj).filter((c): c is Json => Boolean(c)).map((c) => ({
      connectionId: str(c.connection_id), label: str(c.label), gateway: str(c.gateway), runtimeType: str(c.runtime_type),
      limitsMode: mode(c.limits_mode), limits: usageReadingFromJson(c.limits),
    })),
  };
}

// ------------------------------------------------------------------ OpenCode Go

// What opencode.ai/go publishes: estimated requests per 5 hours per model, as
// fetched on the date below. They are OpenCode's estimates, not a limit the
// subscription reports, and the panel says so. Kept with the release, like the
// runtimes' verified facts; a model is matched to a catalog id by its name
// without spaces, dots and dashes ("GLM-5.3-Flash" is glm-5.3-flash), and a
// model that matches none is shown without an estimate.
export const OPENCODE_GO_ESTIMATES = Object.freeze({
  source: "https://opencode.ai/go",
  fetchedAt: "2026-09-29",
  models: Object.freeze<GoEstimate[]>([
    { name: "Kimi K3", min: 110_440, max: 110_440, unlimited: false },
    { name: "Kimi K2.7 Code", min: 1_350, max: 4_050, unlimited: false },
    { name: "MiniMax M3", min: 3_200, max: 9_600, unlimited: false },
    { name: "GPT 6 Luna", min: 4_230, max: 16_920, unlimited: false },
    { name: "Qwen 3.7 Plus", min: 4_300, max: 12_900, unlimited: false },
    { name: "GLM-5.3-Flash", min: 6_320, max: 18_960, unlimited: false },
    { name: "DeepSeek V4.1 Flash", min: 26_000, max: 52_000, unlimited: false },
    { name: "MiMo-V2.6-Flash", min: 30_100, max: 60_200, unlimited: false },
    { name: "Muse Spark 1.3 Contributor", min: 45_300, max: 90_600, unlimited: false },
    { name: "Space Bunny Free", min: null, max: null, unlimited: true },
    { name: "LongCat 2.5 Preview Free", min: null, max: null, unlimited: true },
  ]),
});

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

export function goEstimateFor(modelId: string): GoEstimate | null {
  // A qualified id ("opencode-go/kimi-k3") is matched by its last part.
  const key = squash(modelId.split("/").at(-1) ?? "");
  if (!key) return null;
  return OPENCODE_GO_ESTIMATES.models.find((entry) => squash(entry.name) === key) ?? null;
}

export function goEstimateText(estimate: GoEstimate | null) {
  if (!estimate) return "";
  if (estimate.unlimited) return "unlimited for a limited time (opencode.ai/go)";
  const range = estimate.min === estimate.max ? whole(estimate.min ?? 0) : `${whole(estimate.min ?? 0)}–${whole(estimate.max ?? 0)}`;
  return `≈ ${range} per 5 h (estimate, opencode.ai/go)`;
}

// ------------------------------------------------------------------ words

const WINDOW_NAMES: Record<string, string> = {
  primary: "5-hour window", secondary: "Weekly window", five_hour: "5-hour window", seven_day: "7-day window",
  seven_day_opus: "7-day window (Opus)", seven_day_sonnet: "7-day window (Sonnet)",
  rolling: "5-hour window", weekly: "Weekly window", monthly: "Monthly window",
};

export function windowLabel(window: Pick<UsageWindow, "key" | "windowMinutes">) {
  if (WINDOW_NAMES[window.key]) return WINDOW_NAMES[window.key];
  if (window.windowMinutes && window.windowMinutes % 1_440 === 0) return `${window.windowMinutes / 1_440}-day window`;
  if (window.windowMinutes && window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60}-hour window`;
  return window.key.replace(/_/g, " ");
}

export function sourceLabel(source: UsageReading["source"]) {
  return source === "runtime_read" ? "read from the runtime" : source === "probe" ? "read by the usage probe" : "reported during a run";
}

// What the card says about a connection's limits when it has no windows to show.
const PROBE_ERRORS: Record<string, string> = {
  unauthorized: "The usage probe could not sign in with this connection's key; reconnect OpenCode Go.",
  not_subscribed: "This key has no OpenCode Go subscription.",
  unavailable: "opencode.ai did not answer the usage probe; it tries again in a few minutes.",
  timeout: "opencode.ai did not answer the usage probe in time; it tries again in a few minutes.",
  malformed: "opencode.ai answered the usage probe in a shape it does not read; limits are unknown.",
};

export function limitsNote(connection: Pick<ConnectionUsage, "limitsMode" | "limits"> & { status?: string }) {
  switch (connection.limitsMode) {
    case "free": return "Free — no limits.";
    case "none": return "No limits. The account's balance is not read.";
    case "probe":
      if (connection.limits?.errorClass) return PROBE_ERRORS[connection.limits.errorClass] ?? "Limits are unknown.";
      if (connection.limits) return "";
      return connection.status === "connected"
        ? "Not read yet; the usage probe reads the windows every five minutes."
        : "Connect OpenCode Go to see its limits; the usage probe reads them every five minutes.";
    case "stream": return connection.limits ? "" : "Limits are reported only during a run; none seen yet.";
    case "read": return connection.limits ? "" : "Not read yet; the windows are read every few minutes while the runtime is idle.";
  }
}

export function planLabel(plan: string | null) {
  return plan ? plan.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "";
}

// ------------------------------------------------------------------ numbers

function whole(value: number) {
  return new Intl.NumberFormat("en").format(Math.round(value));
}

export function compactTokens(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

// A cost with what it is. Nothing reported is "" — not "$0".
export function costText(usd: number | null, basis: CostBasis) {
  if (usd === null || basis === "none") return "";
  const amount = usd >= 1 ? usd.toFixed(2) : usd >= 0.01 ? usd.toFixed(3) : usd > 0 ? "<0.01" : "0";
  return basis === "provider" ? `$${amount}` : `≈ $${amount} est.`;
}

export function costTitle(basis: CostBasis) {
  return basis === "list_estimate"
    ? "An estimate at the model's list price, not a charge: a subscription is not billed per token, and OpenCode prices its own tokens."
    : basis === "provider" ? "What the provider billed." : "";
}

function span(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

export function readAge(readAt: string, now: number) {
  const at = Date.parse(readAt);
  if (!Number.isFinite(at)) return "";
  const ms = now - at;
  return ms < 60_000 ? "read just now" : `read ${span(ms)} ago`;
}

export function resetText(window: Pick<UsageWindow, "resetsAt" | "resetPassed">, now: number) {
  const at = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  if (!Number.isFinite(at)) return "reset time not reported";
  if (window.resetPassed || at <= now) return "has reset since this reading";
  return `resets in ${span(at - now)}`;
}

// The bar's tone: the status palette's words.
export function windowTone(window: Pick<UsageWindow, "usedPercent" | "resetPassed">): "success" | "warning" | "danger" | "neutral" {
  if (window.resetPassed) return "neutral";
  if (window.usedPercent >= 90) return "danger";
  if (window.usedPercent >= 70) return "warning";
  return "success";
}
