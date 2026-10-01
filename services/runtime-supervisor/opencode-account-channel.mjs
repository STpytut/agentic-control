// Protocol allowlist for OpenCode account and catalog operations.
//
// The Runtime Supervisor runs OpenCode under the isolated `opencode-worker`
// OS user. The installed CLI's interactive `auth login` does not consume a key
// from stdin, so login is performed through a short-lived localhost-only
// OpenCode server. Login, status and logout name one of the providers an API
// key signs in to — Go (`opencode-go`) or OpenRouter (`openrouter`) — chosen
// by the connection's access gateway, never by the caller's spelling; catalog
// discovery (provider_list) may read those or the Free (`opencode`) provider
// state but never accepts secrets. No operation may accept arbitrary provider
// names, CLI arguments or secrets other than the login key.

const allowedOperations = new Set([
  "login",
  "status",
  "logout",
  "models_list",
  "provider_list",
]);
const allowedRequestFields = new Set(["type", "request_id", "operation", "provider", "key"]);
export const openCodeGoProvider = "opencode-go";
export const openCodeFreeProvider = "opencode";
export const openRouterProvider = "openrouter";

// The provider each OpenCode access gateway is (provider_connections.access_gateway,
// 0083): Zen (Free) needs no key; Go and OpenRouter are signed in to with one.
// A gateway is a closed word of the schema, never a free-form provider name.
const PROVIDER_BY_GATEWAY = Object.freeze({
  opencode_zen: openCodeFreeProvider, opencode_go: openCodeGoProvider, openrouter: openRouterProvider,
});
const keyProviders = new Set([openCodeGoProvider, openRouterProvider]);
const catalogProviders = new Set(Object.values(PROVIDER_BY_GATEWAY));

export function openCodeProviderFor(accessGateway) {
  const provider = PROVIDER_BY_GATEWAY[accessGateway];
  if (!provider) throw new Error(`no OpenCode provider for the access gateway ${JSON.stringify(accessGateway)}`);
  return provider;
}

// What the panel calls a connected account of that provider.
export const OPENCODE_ACCOUNT_LABELS = Object.freeze({
  [openCodeGoProvider]: "OpenCode Go", [openRouterProvider]: "OpenRouter",
});

function keyProvider(request) {
  if (request.provider === undefined) return openCodeGoProvider;
  if (!keyProviders.has(request.provider)) {
    throw new Error(`OpenCode account provider must be ${[...keyProviders].join(" or ")}`);
  }
  return request.provider;
}

export function validateOpenCodeAccountInput(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("OpenCode account request must be an object");
  }
  for (const field of Object.keys(request)) {
    if (!allowedRequestFields.has(field)) {
      throw new Error(`unexpected OpenCode account field: ${field}`);
    }
  }
  const operation = request.operation;
  if (typeof operation !== "string" || !allowedOperations.has(operation)) {
    throw new Error(`unsupported OpenCode account operation: ${String(operation ?? "unknown")}`);
  }
  if (operation === "login") {
    const provider = keyProvider(request);
    if (typeof request.key !== "string" || request.key.length < 4 || request.key.length > 1024) {
      throw new Error("invalid OpenCode login key");
    }
    return {
      operation,
      provider,
      key: request.key,
      transport: "local_server_api",
    };
  }
  if (operation === "provider_list") {
    if (request.provider !== undefined && !catalogProviders.has(request.provider)) {
      throw new Error(`OpenCode catalog provider must be one of ${[...catalogProviders].join(", ")}`);
    }
    if (request.key !== undefined) {
      throw new Error("OpenCode catalog discovery does not accept secrets");
    }
    return {
      operation,
      provider: request.provider ?? null,
      transport: "local_server_api",
    };
  }
  if (request.key !== undefined) {
    throw new Error("OpenCode read operations do not accept secrets");
  }
  const provider = keyProvider(request);
  if (operation === "status") return { operation, provider, transport: "local_server_api" };
  if (operation === "logout") {
    return { operation, provider, transport: "cli", argv: ["auth", "logout", provider] };
  }
  if (operation === "models_list") return { operation, provider, transport: "local_server_api" };
  throw new Error(`unsupported OpenCode account operation: ${operation}`);
}

function normalizeCatalogModel(item) {
  if (typeof item === "string") {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/: -]{0,199}$/.test(item)) return null;
    return { model_id: item };
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const modelId = item.id ?? item.model_id;
  if (typeof modelId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/: -]{0,199}$/.test(modelId)) return null;
  const entry = { model_id: modelId };
  const displayName = item.display_name ?? item.displayName ?? item.name;
  if (typeof displayName === "string" && displayName.length > 0 && displayName.length <= 200) {
    entry.display_name = displayName;
  }
  // A model's reasoning levels are its variants (`Provider.Model.variants`, a
  // record keyed by the variant's name, which `run --variant` takes): only the
  // names are kept, in OpenCode's order — the values are provider options.
  const variants = item.variants && typeof item.variants === "object" && !Array.isArray(item.variants)
    ? Object.keys(item.variants) : null;
  const efforts = variants
    ?? (Array.isArray(item.reasoning_efforts)
      ? item.reasoning_efforts
      : typeof item.reasoning_effort === "string"
        ? [item.reasoning_effort]
        : []);
  const boundedEfforts = efforts
    .map((value) => typeof value === "string" ? value : value?.id ?? null)
    .filter((value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))
    .slice(0, 16);
  if (boundedEfforts.length) entry.reasoning_efforts = boundedEfforts;
  const tiers = Array.isArray(item.service_tiers)
    ? item.service_tiers
    : typeof item.service_tier === "string"
      ? [item.service_tier]
      : [];
  const boundedTiers = tiers
    .map((value) => typeof value === "string" ? value : value?.id ?? null)
    .filter((value) => typeof value === "string" && value.length > 0 && value.length <= 64)
    .slice(0, 16);
  if (boundedTiers.length) entry.service_tiers = boundedTiers;
  const capabilities = {};
  if (typeof item.streaming === "boolean") capabilities.streaming = item.streaming;
  if (typeof item.interrupt === "boolean") capabilities.interrupt = item.interrupt;
  if (typeof item.context_window === "number") capabilities.context_window = item.context_window;
  if (Object.keys(capabilities).length) entry.capabilities = capabilities;
  return entry;
}

// A provider's catalog, from the loopback server's GET /provider: whether this
// account is signed in to it, and its models, bounded and normalised.
export function openCodeCatalogSummary(payload, providerId) {
  const connected = Array.isArray(payload?.connected) && payload.connected.includes(providerId);
  const providers = payload?.all;
  const provider = Array.isArray(providers)
    ? providers.find((item) => item?.id === providerId)
    : providers?.[providerId];
  const modelsValue = provider?.models;
  const rawModels = Array.isArray(modelsValue)
    ? modelsValue
    // Keyed by id, the way OpenCode's server returns them: the value carries
    // the name and what the model can do, and used to be dropped for the key.
    : Object.entries(modelsValue ?? {}).map(([id, value]) => (value && typeof value === "object" ? { ...value, id } : { id }));
  // A model that cannot call tools can be neither orchestrator nor executor:
  // both work through tools. OpenRouter lists hundreds, some of them chat-only;
  // they are left out here rather than offered and refused at the gate.
  const models = rawModels.filter((item) => item?.tool_call !== false && item?.capabilities?.toolcall !== false)
    .map(normalizeCatalogModel).filter(Boolean).slice(0, 500);
  return { connected, provider_id: providerId, models };
}
