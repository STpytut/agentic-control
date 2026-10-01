// The Models card's and the Team picker's reading of the model checks
// (Stage 12 W7; docs/W6_W7_CONTRACT.md, docs/RUNTIMES_AND_MODELS_DESIGN.md §2.5–2.7).
//
// Pure types and parsing, no database import: the card and the picker are
// client components. Every shape here is the contract's, field for field; a
// value the database did not send is read as absent, never invented. The one
// thing added is the state's words, which §2.7 fixes: ready, checking…,
// not checked, refused (reason), waiting (reason) — `failed` is shown as
// refused, with a note that it points at the runtime rather than the model.

type Json = Record<string, unknown>;

export type ModelState = "ready" | "checking" | "not_checked" | "refused" | "waiting" | "failed";
export type CheckState = "checking" | "ready" | "refused" | "waiting" | "failed";
export type CheckTrigger = "pick" | "pin" | "check_again";

export type ModelUse = { projectId: string; projectName: string; role: string };

export type ModelRow = {
  entryId: string; providerId: string; modelId: string; displayName: string; vendor: string;
  pinned: boolean; inUse: ModelUse[];
  state: ModelState; reason: string | null; checkedAt: string | null; retryAt: string | null;
  resolvedModel: string | null;
  /** A Claude alias a real run saw resolve to another model than its last check recorded (0105). */
  aliasDrift: { model: string; seenAt: string | null } | null;
};

export type ModelRollup = { ready: number; checking: number; notChecked: number; refused: number; waiting: number; total: number };
export type VendorCount = { vendor: string; count: number };
/** What the latest qualification of a newer runtime version read in its model list, for this connection (0105). */
export type NewerRuntime = { version: string; result: string; added: string[]; removed: string[] };

export type ModelConnection = {
  connectionId: string; provider: string; label: string; runtimeType: string; runtimeVersion: string | null;
  billing: string; listReadAt: string | null; totalModels: number; models: ModelRow[]; moreCount: number;
  vendors: VendorCount[]; rollup: ModelRollup | null; newerRuntime: NewerRuntime | null;
};

/** The daily budget is the last 24 hours: one check frees when the oldest counted one ages out. */
export type CheckBudget = { nextSlotAt: string | null; clearAt: string | null; autoNextSlotAt: string | null };

export type OperatorModels = {
  checksToday: number;
  autoChecks: { used: number; limit: number };
  hardLimit: number;
  budget: CheckBudget;
  connections: ModelConnection[];
  /** When the panel read it — the reference for "2 h ago", the same on server and client. */
  readAt: string;
};

export type CatalogSearch = { total: number; results: ModelRow[] };
export type CatalogFilters = { vendor: string | null; checkedOnly: boolean };

export type ModelCheck = {
  checkId: string; entryId: string; state: CheckState;
  result: "passed" | "rejected" | "inconclusive" | "failed" | null;
  failureClass: "model" | "infrastructure" | "runtime" | "harness" | null;
  reason: string | null; queuePosition: number;
  requestedAt: string | null; startedAt: string | null; finishedAt: string | null; retryAt: string | null;
};

export type CheckRequest = { checkId: string; state: CheckState; deduplicated: boolean; reason: string | null; retryAt: string | null };
export type PinResult = { entryId: string; pinned: boolean; checkId: string | null };

const text = (value: unknown) => (typeof value === "string" ? value : "");
const maybe = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
const count = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const list = (value: unknown) => (Array.isArray(value) ? (value as Json[]) : []);

const MODEL_STATES = new Set<ModelState>(["ready", "checking", "not_checked", "refused", "waiting", "failed"]);
const CHECK_STATES = new Set<CheckState>(["checking", "ready", "refused", "waiting", "failed"]);

function modelState(value: unknown): ModelState {
  return MODEL_STATES.has(value as ModelState) ? value as ModelState : "not_checked";
}

export function checkState(value: unknown): CheckState {
  return CHECK_STATES.has(value as CheckState) ? value as CheckState : "checking";
}

export function modelRowFromJson(row: Json): ModelRow {
  return {
    entryId: text(row.entry_id), providerId: text(row.provider_id), modelId: text(row.model_id),
    displayName: text(row.display_name), vendor: text(row.vendor),
    pinned: row.pinned === true,
    inUse: list(row.in_use).map((use) => ({ projectId: text(use.project_id), projectName: text(use.project_name), role: text(use.role) })),
    state: modelState(row.state), reason: maybe(row.reason), checkedAt: maybe(row.checked_at), retryAt: maybe(row.retry_at),
    resolvedModel: maybe(row.resolved_model),
    aliasDrift: row.alias_drift && typeof row.alias_drift === "object" && maybe((row.alias_drift as Json).model)
      ? { model: text((row.alias_drift as Json).model), seenAt: maybe((row.alias_drift as Json).seen_at) } : null,
  };
}

function rollupFromJson(value: unknown): ModelRollup | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Json;
  return { ready: count(row.ready), checking: count(row.checking), notChecked: count(row.not_checked),
    refused: count(row.refused), waiting: count(row.waiting), total: count(row.total) };
}

function newerRuntimeFromJson(value: unknown): NewerRuntime | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Json;
  const names = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  const newer = { version: text(row.version), result: text(row.result), added: names(row.added), removed: names(row.removed) };
  return newer.version && (newer.added.length || newer.removed.length) ? newer : null;
}

export function operatorModelsFromJson(value: Json, readAt: string): OperatorModels {
  const auto = (value.auto_checks && typeof value.auto_checks === "object" ? value.auto_checks : {}) as Json;
  const budget = (value.budget && typeof value.budget === "object" ? value.budget : {}) as Json;
  return {
    checksToday: count(value.checks_today),
    autoChecks: { used: count(auto.used), limit: count(auto.limit) },
    hardLimit: count(value.hard_limit),
    budget: { nextSlotAt: maybe(budget.next_slot_at), clearAt: maybe(budget.clear_at), autoNextSlotAt: maybe(budget.auto_next_slot_at) },
    readAt,
    connections: list(value.connections).map((connection) => {
      const models = list(connection.models).map(modelRowFromJson);
      const total = count(connection.total_models);
      return {
        connectionId: text(connection.connection_id), provider: text(connection.provider), label: text(connection.label),
        runtimeType: text(connection.runtime_type), runtimeVersion: maybe(connection.runtime_version),
        billing: text(connection.billing), listReadAt: maybe(connection.list_read_at),
        totalModels: total, models,
        moreCount: connection.more_count === undefined ? Math.max(0, total - models.length) : count(connection.more_count),
        vendors: list(connection.vendors).map((entry) => ({ vendor: text(entry.vendor), count: count(entry.count) }))
          .filter((entry) => entry.vendor),
        rollup: rollupFromJson(connection.rollup),
        newerRuntime: newerRuntimeFromJson(connection.newer_runtime),
      };
    }),
  };
}

export function catalogSearchFromJson(value: Json | null): CatalogSearch {
  return { total: count(value?.total), results: list(value?.results).map(modelRowFromJson) };
}

export function modelCheckFromJson(value: Json): ModelCheck {
  const oneOf = <T extends string>(candidate: unknown, allowed: readonly T[]) =>
    (allowed as readonly unknown[]).includes(candidate) ? candidate as T : null;
  return {
    checkId: text(value.check_id), entryId: text(value.entry_id), state: checkState(value.state),
    result: oneOf(value.result, ["passed", "rejected", "inconclusive", "failed"] as const),
    failureClass: oneOf(value.failure_class, ["model", "infrastructure", "runtime", "harness"] as const),
    reason: maybe(value.reason), queuePosition: count(value.queue_position),
    requestedAt: maybe(value.requested_at), startedAt: maybe(value.started_at),
    finishedAt: maybe(value.finished_at), retryAt: maybe(value.retry_at),
  };
}

// The answer says why at once when it is a refusal or a wait (0105), so the
// panel shows it without a poll.
export function checkRequestFromJson(value: Json): CheckRequest {
  return { checkId: text(value.check_id), state: checkState(value.state), deduplicated: value.deduplicated === true,
    reason: maybe(value.reason), retryAt: maybe(value.retry_at) };
}

// A model as the operator picks it: a Claude alias with the model it resolves
// to ("opus → claude-opus-5"); the alias is what is stored and sent.
export function modelWithResolved(model: string, resolved: string | null | undefined) {
  return resolved && resolved !== model ? `${model} → ${resolved}` : model;
}

// What a model resolves to, by its catalog entry, from the check list (a
// Claude alias), or null.
export function resolvedModelOf(models: OperatorModels | null, entryId: string) {
  for (const connection of models?.connections ?? []) {
    const row = connection.models.find((candidate) => candidate.entryId === entryId);
    if (row) return row.resolvedModel;
  }
  return null;
}

// "3 ready · 1 checking · 290 not checked", zeros left out.
export function rollupWords(rollup: ModelRollup | null) {
  if (!rollup) return "";
  return ([[rollup.ready, "ready"], [rollup.checking, "checking"], [rollup.waiting, "waiting"],
    [rollup.refused, "refused"], [rollup.notChecked, "not checked"]] as const)
    .filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`).join(" · ");
}

// "gpt-6-sol, gpt-6-luna and 3 more".
export function someNames(names: string[], shown = 4) {
  return names.length <= shown ? names.join(", ") : `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

export function pinResultFromJson(value: Json): PinResult {
  return { entryId: text(value.entry_id), pinned: value.pinned === true, checkId: maybe(value.check_id) };
}

// A check that will not move without something changing: the dialog stops
// polling on these. `waiting` is not one — it retries by itself.
export function checkSettled(state: CheckState) {
  return state === "ready" || state === "refused" || state === "failed";
}

// The one-word state and its tone, as §2.7 writes them. The reason, when there
// is one, is shown beside the word ("refused" + "no endpoint for your key"),
// never folded into it.
export type StateTone = "success" | "info" | "neutral" | "danger" | "warning";
export function stateWords(state: ModelState, retryAt: string | null): { word: string; tone: StateTone; note: string | null } {
  switch (state) {
    case "ready": return { word: "ready", tone: "success", note: null };
    case "checking": return { word: "checking…", tone: "info", note: null };
    case "not_checked": return { word: "not checked", tone: "neutral", note: null };
    case "waiting": return { word: "waiting", tone: "warning", note: retryAt ? `retry at ${clockTime(retryAt)}` : null };
    case "refused": return { word: "refused", tone: "danger", note: null };
    case "failed": return { word: "refused", tone: "danger", note: "this points at the runtime or the host, not the model" };
  }
}

// A row offers "Check again" only when its last check did not pass (§2.7).
export function canCheckAgain(state: ModelState) {
  return state === "refused" || state === "failed";
}

export function clockTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${date.toISOString().slice(11, 16)} UTC`;
}

// "2 h ago", against a reference instant the caller passes in (the moment the
// page read the data, then a clock), so the server and the first client render
// agree.
export function timeAgo(value: string | null, now: number) {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// The contract's billing words, and the catalog's older ones that the team
// read (0089) still carries.
export const BILLING_WORDS: Record<string, string> = {
  subscription: "subscription", free: "free", metered: "metered",
  direct_metered: "metered", third_party_metered: "metered via gateway",
};
export const GATEWAY_WORDS: Record<string, string> = {
  opencode_zen: "OpenCode Zen", opencode_go: "OpenCode Go", openrouter: "OpenRouter", openai_chatgpt: "ChatGPT",
};

// The vendors in the order the redesign groups them: Anthropic, OpenAI, then
// everyone else alphabetically, the unnamed last.
const VENDOR_ORDER = ["anthropic", "openai"];
export function vendorRank(vendor: string) {
  const index = VENDOR_ORDER.indexOf(vendor.toLowerCase());
  return index === -1 ? (vendor ? VENDOR_ORDER.length : VENDOR_ORDER.length + 1) : index;
}
export function compareVendors(a: string, b: string) {
  return vendorRank(a) - vendorRank(b) || a.localeCompare(b);
}
export function vendorLabel(vendor: string) {
  return ({ anthropic: "Anthropic", openai: "OpenAI" } as Record<string, string>)[vendor.toLowerCase()] ?? (vendor || "Other vendors");
}

// A connection's main vendor, for ordering the connections themselves: the
// vendor most of its listed rows share.
export function connectionVendor(connection: ModelConnection) {
  const tally = new Map<string, number>();
  for (const row of connection.models) tally.set(row.vendor, (tally.get(row.vendor) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || compareVendors(a[0], b[0]))[0]?.[0] ?? "";
}

// The refusal the database gives over the day's hard ceiling (SQLSTATE 54000,
// detail reason `model_check_budget`), in the operator's words. The route
// passes the database's message through; this is where the panel recognises it.
export const CHECK_BUDGET_WORDS = "The check limit for the last 24 hours is reached. Checks start again as the oldest ones age out.";
