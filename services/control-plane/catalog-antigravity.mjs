// Antigravity's catalog, pure (rc.150): the models `agy models` lists, as the
// refresh worker reads them through the supervisor. Kept apart so it is
// tested without starting the worker.
//
// Each listed model is offered as it is named — agy's own id, which its
// `--model` takes — and every one is checked by the model check lane before
// it is offered, like any model. No reasoning levels yet: which models take
// `--effort` is not known per model (drivers/antigravity.mjs). The vendor of
// a model is read from its id by the database (catalog_model_vendor): Gemini
// is Google's, and agy also lists Claude and GPT models.

export const ANTIGRAVITY_LISTED_SOURCE = "antigravity_models";

function normalizeString(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : "";
}

export function antigravityListedEntries(models, connection) {
  const seen = new Set();
  const entries = [];
  for (const model of Array.isArray(models) ? models : []) {
    const id = String(model?.id ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    entries.push({
      runtime_type: "antigravity",
      provider_id: "google",
      model_id: id,
      display_name: normalizeString(model?.display_name, 200) || id,
      provider_badge: "Antigravity",
      plan_badge: normalizeString(connection?.plan_badge, 64),
      billing_boundary: "subscription",
      reasoning_efforts: [],
      service_tiers: [],
      adapter_version: normalizeString(connection?.adapter_version, 64),
      runtime_version: normalizeString(connection?.runtime_version, 64),
      discovery_source: ANTIGRAVITY_LISTED_SOURCE,
    });
    if (entries.length >= 100) break;
  }
  return entries.sort((a, b) => a.model_id.localeCompare(b.model_id));
}

// What one refresh of an Antigravity connection discovers: the listed models
// when the list was read; nothing, with the source named as unread, when it
// was not — a list not read says nothing about the models listed before.
export function antigravityDiscovery(answer, connection) {
  if (!Array.isArray(answer?.models)) return { entries: [], unreadSources: [ANTIGRAVITY_LISTED_SOURCE] };
  return { entries: antigravityListedEntries(answer.models, connection), unreadSources: [] };
}
