// Provider model catalog refresh worker (7.1D.1).
//
// Discovers models only through live, authenticated provider responses and
// persists only normalized bounded metadata:
//   - Codex: the app-server `model/list` method over the account-only Runtime
//     Supervisor channel (the models are those actually visible to the current
//     native credential store, not public documentation);
//   - OpenCode: the authenticated localhost `opencode serve --pure` provider
//     read for the provider of the connection's access gateway: Zen
//     (`opencode`), Go (`opencode-go`) or OpenRouter (`openrouter`).
//
// The worker never receives or stores raw provider responses, API keys,
// tokens or account credentials. Raw native output is normalized in this
// process, bounded, and the normalized entries are persisted through
// control-plane SQL functions that enforce a strict key allowlist and size
// bounds. If a Go connection is disconnected or revoked, its refresh fails
// closed with `not_authenticated`.
//
// A model is one catalog row per connection, whatever runtime version listed it
// (0098, Stage 12 W5-a): each entry carries the version it was read at — OpenCode's
// server reports it; for Codex and Claude the database takes the version the host
// reports running — and the upsert records that version as a listing of the row.
// A new runtime version adds listings, never rows, and marks nothing stale; a
// model the list no longer names is still marked unavailable by the completion.

import readline from "node:readline";
import { queryJson, closePool } from "./db.mjs";
import { claudeAliasEntries, claudeListedEntries } from "./catalog-claude.mjs";
import { RuntimeSupervisorClient, cancelThrough, retryWhileRuntimeBusy } from "../runtime-supervisor/client.mjs";
import { OPENCODE_ACCOUNT_LABELS, openCodeProviderFor } from "../runtime-supervisor/opencode-account-channel.mjs";
import { catalogReasoningLevels } from "../runtime-supervisor/drivers/reasoning.mjs";
import { redactError, runPollLoop, shutdownSignal } from "./worker-loop.mjs";
const workerId = process.env.CATALOG_WORKER_ID ?? `catalog-refresh-worker-${process.pid}`;
const pollMs = Number(process.env.CATALOG_POLL_MS ?? 60_000);
// The claim's lease, as an absolute moment. Parsed from the same string the
// claim was made with, so the two cannot drift apart — and shared by every item
// in the batch, because the batch is worked through one after another and the
// last item does not get a fresh lease.
function leaseDeadline(interval) {
  const match = /^\s*(\d+)\s*(second|minute|hour)s?\s*$/.exec(interval);
  // An interval this cannot read is not a reason to wait longer than the shortest
  // lease any caller holds; the helper's own ceiling still applies.
  if (!match) return null;
  const unit = { second: 1_000, minute: 60_000, hour: 3_600_000 }[match[2]];
  return new Date(Date.now() + Number(match[1]) * unit).toISOString();
}

const refreshLease = process.env.CATALOG_REFRESH_LEASE ?? "5 minutes";
const maxEntriesPerRefresh = 500;

// The redaction and the bounds live in worker-loop.mjs; this names the
// fallback sentence for this service.
const safeError = (error, fallback = "Catalog refresh failed.", transientValues = []) =>
  redactError(error, fallback, transientValues);

// --- Codex app-server session (model/list only) ----------------------------

class CodexModelListSession {
  constructor(processHandle) {
    this.processHandle = processHandle;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.lines = readline.createInterface({ input: processHandle.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    processHandle.stderr.setEncoding("utf8");
    processHandle.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-2000);
    });
    processHandle.once("close", (code, signal) => {
      this.failAll(new Error(`Codex app-server closed (code=${code}, signal=${signal})`));
    });
  }

  send(message) {
    this.processHandle.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    this.send(params === undefined ? { method, id } : { method, id, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
    });
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(String(message.id));
        if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.lines.close();
    this.processHandle.stdin.end();
  }
}

// --- Normalization (bounded, allowlisted) ----------------------------------

function normalizeString(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : "";
}

function normalizeStringList(value, maxItems, maxItemLength) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "string" ? item : item?.id ?? null)
    .filter((item) => typeof item === "string" && item.length > 0 && item.length <= maxItemLength)
    .slice(0, maxItems);
}

function normalizeCodexModel(model, connection) {
  if (!model || typeof model !== "object" || Array.isArray(model)) return null;
  if (model.hidden === true) return null;
  const modelId = normalizeString(model.id ?? model.model ?? model.model_id, 200);
  if (!modelId) return null;
  const entry = {
    runtime_type: "codex",
    provider_id: "chatgpt",
    model_id: modelId,
    display_name: normalizeString(model.display_name ?? model.displayName, 200),
    provider_badge: "ChatGPT",
    plan_badge: normalizeString(connection?.plan_badge, 64),
    billing_boundary: "subscription",
    // `supportedReasoningEfforts: [{reasoningEffort, description}]` and
    // `defaultReasoningEffort` (app-server v2/model.rs at rust-v0.158.0). Read
    // as `item.id` until Stage 12, which is why every Codex row had none.
    reasoning_efforts: catalogReasoningLevels(
      model.supportedReasoningEfforts ?? model.reasoningEfforts ?? model.reasoning_efforts,
      { levelKeys: ["reasoningEffort", "level", "id"], defaultLevel: model.defaultReasoningEffort ?? model.default_reasoning_effort ?? null },
    ),
    service_tiers: normalizeStringList(model.serviceTiers ?? model.service_tiers, 16, 64),
    capabilities: {},
    adapter_version: normalizeString(connection?.adapter_version, 64),
    runtime_version: normalizeString(connection?.runtime_version, 64),
    discovery_source: "codex_model_list",
  };
  const capabilities = model.capabilities;
  if (capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)) {
    if (typeof capabilities.streaming === "boolean") entry.capabilities.streaming = capabilities.streaming;
    if (typeof capabilities.interrupt === "boolean") entry.capabilities.interrupt = capabilities.interrupt;
    if (typeof capabilities.functions === "boolean") entry.capabilities.functions = capabilities.functions;
    if (Number.isInteger(capabilities.max_input_tokens)) {
      entry.capabilities.max_input_tokens = capabilities.max_input_tokens;
    }
    if (Number.isInteger(capabilities.max_output_tokens)) {
      entry.capabilities.max_output_tokens = capabilities.max_output_tokens;
    }
  }
  if (Object.keys(entry.capabilities).length === 0) delete entry.capabilities;
  return entry;
}

function normalizeOpenCodeProviderModels(providerState, connection) {
  const models = Array.isArray(providerState?.models) ? providerState.models : [];
  return models.map((model) => {
    if (typeof model === "string") {
      return {
        runtime_type: "opencode",
        provider_id: providerState.provider_id,
        model_id: model.slice(0, 200),
        display_name: "",
        provider_badge: OPENCODE_ACCOUNT_LABELS[providerState.provider_id] ?? "OpenCode",
        plan_badge: normalizeString(connection?.plan_badge, 64),
        billing_boundary: connection?.billing_boundary ?? "",
        reasoning_efforts: [],
        service_tiers: [],
        capabilities: {},
        adapter_version: normalizeString(providerState?.runtime_version, 64),
        runtime_version: normalizeString(providerState?.runtime_version, 64),
        discovery_source: "opencode_provider_api",
      };
    }
    if (!model || typeof model !== "object" || Array.isArray(model)) return null;
    const modelId = normalizeString(model.model_id ?? model.id, 200);
    if (!modelId) return null;
    const entry = {
      runtime_type: "opencode",
      provider_id: providerState.provider_id,
      model_id: modelId,
      display_name: normalizeString(model.display_name ?? model.displayName, 200),
      provider_badge: OPENCODE_ACCOUNT_LABELS[providerState.provider_id] ?? "OpenCode",
      plan_badge: normalizeString(connection?.plan_badge, 64),
      billing_boundary: connection?.billing_boundary ?? "",
      // The model's variant names, as the account channel reads them from
      // GET /provider. OpenCode names no default: without --variant a run uses
      // none of them.
      reasoning_efforts: catalogReasoningLevels(model.reasoning_efforts),
      service_tiers: normalizeStringList(model.service_tiers ?? model.service_tier, 16, 64),
      capabilities: {},
      adapter_version: normalizeString(providerState?.runtime_version, 64),
      runtime_version: normalizeString(providerState?.runtime_version, 64),
      discovery_source: "opencode_provider_api",
    };
    const capabilities = model.capabilities;
    if (capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)) {
      if (typeof capabilities.streaming === "boolean") entry.capabilities.streaming = capabilities.streaming;
      if (typeof capabilities.interrupt === "boolean") entry.capabilities.interrupt = capabilities.interrupt;
      if (Number.isInteger(capabilities.context_window)) entry.capabilities.context_window = capabilities.context_window;
    }
    if (Object.keys(entry.capabilities).length === 0) delete entry.capabilities;
    return entry;
  }).filter(Boolean).slice(0, maxEntriesPerRefresh);
}

// --- Discovery per provider -------------------------------------------------

async function discoverCodexModels({ supervisor, connection, leaseExpiresAt = null }) {
  // This one's connection belongs to the caller, which closes it in a `finally`
  // — so a failure here is already covered. Noted rather than guarded, because
  // an extra close on a socket somebody else owns is its own bug.
  const processHandle = await retryWhileRuntimeBusy(
    () => supervisor.open({ runtime: "codex", surface: "account" }),
    { leaseExpiresAt,
      onExpiry: () => cancelThrough(supervisor),
      onWait: ({ attempt, remainingMs }) => process.stderr.write(`${JSON.stringify({
        type: "catalog-refresh.waiting-for-runtime", attempt, remaining_ms: remainingMs,
      })}\n`) },
  );
  const session = new CodexModelListSession(processHandle);
  try {
    await session.request("initialize", {
      clientInfo: { name: "infra_cod", title: "infra_cod catalog broker", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, 30_000);
    session.send({ method: "initialized" });
    // The pinned production app-server schema requires the params field even
    // though model/list has no configurable parameters. The account channel
    // permits only this empty object and rejects every non-empty shape.
    const response = await session.request("model/list", {}, 60_000);
    const rawModels = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response?.models)
        ? response.models
        : Array.isArray(response)
          ? response
          : [];
    return rawModels.map((model) => normalizeCodexModel(model, connection))
      .filter(Boolean)
      .slice(0, maxEntriesPerRefresh);
  } finally {
    session.close();
  }
}

async function discoverOpenCodeModels({ supervisor, connection, providerId, leaseExpiresAt = null }) {
  const response = await retryWhileRuntimeBusy(() => supervisor.account({ runtime: "opencode", operation: "provider_list", provider: providerId }), { leaseExpiresAt, onExpiry: () => cancelThrough(supervisor) });
  if (response?.exit_code !== 0) {
    throw new Error("not_authenticated");
  }
  let providers;
  try {
    providers = JSON.parse(response.stdout ?? "{}").providers;
  } catch {
    throw new Error("OpenCode provider response is not JSON");
  }
  const providerState = (providers ?? []).find((item) => item?.provider_id === providerId);
  if (!providerState) throw new Error("OpenCode provider state is missing");
  if (!providerState.connected) throw new Error("not_authenticated");
  return normalizeOpenCodeProviderModels(providerState, connection);
}

// --- Claude Code (sprint C K2) ------------------------------------------------

async function discoverClaudeModels({ supervisor, connection }) {
  const aliases = claudeAliasEntries(connection);
  let listed = [];
  try {
    const answer = await supervisor.listClaudeModels();
    if (Array.isArray(answer?.models)) listed = claudeListedEntries(answer.models, connection);
    else process.stderr.write(`${JSON.stringify({ type: "catalog-refresh.claude-models", error: String(answer?.error ?? "no answer") })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ type: "catalog-refresh.claude-models", error: safeError(error) })}\n`);
  }
  return [...aliases, ...listed];
}

// --- Refresh processing -----------------------------------------------------

function connectionMetadata(connection) {
  const permissions = typeof connection?.permissions === "string"
    ? (() => { try { return JSON.parse(connection.permissions); } catch { return {}; } })()
    : (connection?.permissions ?? {});
  return {
    billing_boundary: connection?.billing_boundary ?? "",
    plan_badge: permissions?.plan ?? "",
    adapter_version: permissions?.adapter_version ?? "",
    runtime_version: permissions?.runtime_version ?? "",
  };
}

async function discoverModels(item, leaseExpiresAt = null) {
  const supervisor = new RuntimeSupervisorClient();
  await supervisor.connect();
  try {
    const connection = { ...item, ...connectionMetadata(item) };
    if (item.provider === "codex") {
      return await discoverCodexModels({ supervisor, connection, leaseExpiresAt });
    }
    if (item.provider === "opencode") {
      const providerId = openCodeProviderFor(item.access_gateway);
      return await discoverOpenCodeModels({ supervisor, connection, providerId, leaseExpiresAt });
    }
    if (item.provider === "claude") return await discoverClaudeModels({ supervisor, connection });
    throw new Error(`catalog discovery is unsupported for provider ${item.provider}`);
  } finally {
    supervisor.close();
  }
}

async function processRefresh(item, leaseExpiresAt = null) {
  let entries;
  try {
    entries = await discoverModels(item, leaseExpiresAt);
    if (entries.length === 0) {
      throw new Error("provider response contained no models");
    }
  } catch (error) {
    const message = safeError(error);

    // An outcome nobody knows is not a failure.
    //
    // The lease ran out mid-call and the work could not be confirmed stopped, so
    // it may have succeeded a moment before the connection went. Writing a
    // terminal failure for that records a lie about the operator's account —
    // and the reviewer's reproduction showed exactly this: the connection
    // closed, the effect completed, and the worker still called `fail_*`.
    //
    // The claim is left to lapse instead. Nothing is recorded, and the next
    // reader sees the state the runtime is actually in.
    if (error.outcomeUnknown === true || error.cancelled === true) {
      await queryJson(`SELECT defer_catalog_refresh(:'refresh_id'::uuid,:'worker_id')::text;`,
        { refresh_id: item.refresh_id, worker_id: workerId }).catch(() => undefined);
      process.stderr.write(`${JSON.stringify({
        type: "catalog-refresh.deferred", refresh_id: item.refresh_id,
        outcome: error.cancelled ? "cancelled" : "unknown", reason: message,
      })}\n`);
      return { status: "deferred", failure_code: null };
    }

    const failureCode = message.includes("not_authenticated") ? "not_authenticated" : "discovery_failed";
    try {
      return await queryJson(
        `SELECT fail_catalog_refresh(:'refresh_id'::uuid,:'worker_id',:'failure_code',:'failure_message')::text;`,
        {
          refresh_id: item.refresh_id,
          worker_id: workerId,
          failure_code: failureCode,
          failure_message: failureCode === "not_authenticated"
            ? "The provider connection is disconnected or revoked. Reconnect it in Settings before retrying."
            : message,
        },
      );
    } catch {
      return { status: "lease_lost", failure_code: failureCode };
    }
  }
  try {
    const upsert = await queryJson(
      `SELECT upsert_catalog_entries(:'refresh_id'::uuid,:'worker_id',:'entries'::jsonb)::text;`,
      {
        refresh_id: item.refresh_id,
        worker_id: workerId,
        entries: JSON.stringify(entries),
      },
    );
    const seenIds = Array.isArray(upsert?.seen_entry_ids) ? upsert.seen_entry_ids : [];
    const completed = await queryJson(
      `SELECT complete_catalog_refresh(:'refresh_id'::uuid,:'worker_id',:'seen_ids'::uuid[],:'missing_status')::text;`,
      {
        refresh_id: item.refresh_id,
        worker_id: workerId,
        seen_ids: seenIds.length ? `{${seenIds.join(",")}}` : "{}",
        missing_status: "unavailable",
      },
    );
    // The journal line says what the list changed: new models, and versions
    // newly seen listing a model already known.
    return { ...completed, created: upsert?.created ?? 0, listings_added: upsert?.listings_added ?? 0 };
  } catch (error) {
    const message = safeError(error);
    try {
      return await queryJson(
        `SELECT fail_catalog_refresh(:'refresh_id'::uuid,:'worker_id','upsert_failed',:'failure_message')::text;`,
        { refresh_id: item.refresh_id, worker_id: workerId, failure_message: message },
      );
    } catch {
      return { status: "lease_lost", failure_code: "upsert_failed" };
    }
  }
}

// --- Worker loop ------------------------------------------------------------

async function refreshOnce() {
  const results = [];
  try {
    await queryJson(`SELECT request_catalog_refreshes_due(:'max_age'::interval)::text;`,
      { max_age: process.env.CATALOG_PERIOD ?? "24 hours" });
  } catch (error) {
    results.push({ kind: "scheduler_failed", error: safeError(error) });
  }
  const claims = await queryJson(
    `SELECT claim_catalog_refresh_work(:'worker_id',:'limit'::integer,:'lease'::interval)::text;`,
    { worker_id: workerId, limit: process.env.CATALOG_BATCH_SIZE ?? "2", lease: refreshLease },
  );
  for (const item of Array.isArray(claims) ? claims : []) {
    const result = await processRefresh(item, item.lease_expires_at);
    results.push({ kind: "catalog_refresh", refresh_id: item.refresh_id, result });
  }
  return results;
}

async function main() {
  if (process.argv.includes("once")) {
    const results = await refreshOnce();
    process.stdout.write(`${JSON.stringify({ type: "catalog-refresh.once", results })}\n`);
    return;
  }
  await runPollLoop({
    name: "catalog-refresh", pollMs, signal: shutdownSignal(),
    fallbackMessage: "Catalog refresh failed.",
    tick: async () => {
      const results = await refreshOnce();
      return results.length ? results : undefined;
    },
  });
}

main()
  .catch((error) => {
    process.stderr.write(`${JSON.stringify({ type: "catalog-refresh.fatal", error: safeError(error) })}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
