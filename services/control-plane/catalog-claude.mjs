// Claude's catalog, pure: the aliases Claude Code resolves and the models the
// subscription names (catalog-refresh-worker.mjs reads the list through the
// supervisor). Kept apart so it is tested without starting the worker.

function normalizeString(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : "";
}


// Claude Code has no command that lists models: its `--model` takes an alias
// the CLI resolves to the current model of that family for the signed-in
// subscription. So its catalog is the aliases, written here, and each is
// checked by the model check lane by itself — three aliases are a small
// subscription list (Stage 12 W6) — which runs it and records the exact model
// the alias resolved to (catalog-gate-worker.mjs). A model the subscription
// cannot use is refused by its check and is not offered.
const CLAUDE_ALIASES = Object.freeze([
  Object.freeze({ model_id: "haiku", display_name: "Claude Haiku (latest)" }),
  Object.freeze({ model_id: "sonnet", display_name: "Claude Sonnet (latest)" }),
  Object.freeze({ model_id: "opus", display_name: "Claude Opus (latest)" }),
]);

export function claudeAliasEntries(connection) {
  return CLAUDE_ALIASES.map((alias) => ({
    runtime_type: "claude",
    provider_id: "anthropic",
    model_id: alias.model_id,
    display_name: alias.display_name,
    provider_badge: "Claude",
    plan_badge: normalizeString(connection?.plan_badge, 64),
    billing_boundary: "subscription",
    // Not the worker's to say: the database fills a Claude row's levels from
    // the documented table by the model its check resolved (0110).
    reasoning_efforts: [],
    service_tiers: [],
    adapter_version: normalizeString(connection?.adapter_version, 64),
    runtime_version: normalizeString(connection?.runtime_version, 64),
    discovery_source: "claude_aliases",
  }));
}

// The models the subscription itself names (claude-models.mjs, read as
// claude-worker): Opus 5.5 was out while `opus` still meant Opus 5 in Claude
// Code 2.1.286, and three aliases could not say so. The newest of each family
// is offered beside the aliases — a list that stays small enough to be checked
// automatically — and every one is checked before it is offered, like any
// model. A list that cannot be read leaves the aliases.
// The source of the models the Claude list names, as the catalog records it.
export const CLAUDE_LISTED_SOURCE = "anthropic_models";

export function claudeListedEntries(models, connection) {
  const newest = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const family = /^claude-([a-z]+)-/.exec(String(model?.id ?? ""))?.[1];
    if (!family) continue;
    const current = newest.get(family);
    if (!current || String(model.created_at ?? "") > String(current.created_at ?? "")) newest.set(family, model);
  }
  return [...newest.values()].sort((a, b) => a.id.localeCompare(b.id)).map((model) => ({
    ...claudeAliasEntries(connection)[0],
    model_id: model.id,
    display_name: normalizeString(model.display_name, 200) || model.id,
    discovery_source: CLAUDE_LISTED_SOURCE,
  }));
}


// What one refresh of a Claude connection discovers: the aliases always, and
// the listed models when the list was read. A list that could not be read (an
// expired token answers {"error":"expired"}) names its source as unread, and
// the refresh's end leaves the models it listed before as they were (0137): a
// list not read says nothing about them.
export function claudeDiscovery(answer, connection) {
  const aliases = claudeAliasEntries(connection);
  if (!Array.isArray(answer?.models)) return { entries: aliases, unreadSources: [CLAUDE_LISTED_SOURCE] };
  return { entries: [...aliases, ...claudeListedEntries(answer.models, connection)], unreadSources: [] };
}
