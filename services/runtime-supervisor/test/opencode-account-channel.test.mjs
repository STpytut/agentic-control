import test from "node:test";
import assert from "node:assert/strict";
import { OPENCODE_ACCOUNT_LABELS, openCodeCatalogSummary, openCodeProviderFor, validateOpenCodeAccountInput } from "../opencode-account-channel.mjs";

test("OpenCode account channel accepts the allowlisted operations", () => {
  const login = validateOpenCodeAccountInput({
    type: "opencode_account",
    request_id: "req-1",
    operation: "login",
    provider: "opencode-go",
    key: "secret-api-key-material",
  });
  assert.equal(login.operation, "login");
  assert.equal(login.key, "secret-api-key-material");
  assert.equal(login.provider, "opencode-go");
  assert.equal(login.transport, "local_server_api");
  assert.equal(validateOpenCodeAccountInput({ operation: "status" }).transport, "local_server_api");
  assert.deepEqual(
    validateOpenCodeAccountInput({ operation: "logout" }).argv,
    ["auth", "logout", "opencode-go"],
  );
  assert.equal(validateOpenCodeAccountInput({ operation: "models_list" }).transport, "local_server_api");
});

test("OpenCode catalog discovery accepts only the fixed Free, Go and OpenRouter providers", () => {
  const both = validateOpenCodeAccountInput({ operation: "provider_list" });
  assert.equal(both.operation, "provider_list");
  assert.equal(both.provider, null);
  assert.equal(both.transport, "local_server_api");
  for (const provider of ["opencode", "opencode-go", "openrouter"]) {
    assert.equal(validateOpenCodeAccountInput({ operation: "provider_list", provider }).provider, provider);
  }
  assert.throws(
    () => validateOpenCodeAccountInput({ operation: "provider_list", provider: "anthropic" }),
    /catalog provider must be one of opencode, opencode-go, openrouter/,
  );
  assert.throws(
    () => validateOpenCodeAccountInput({ operation: "provider_list", key: "sk-not-allowed" }),
    /does not accept secrets/,
  );
});

// An API key signs in to Go or to OpenRouter, and to nothing else; which one
// is the connection's billing boundary, resolved on the VPS.
test("an API key signs in to Go or OpenRouter, chosen by the access gateway", () => {
  assert.equal(openCodeProviderFor("opencode_zen"), "opencode");
  assert.equal(openCodeProviderFor("opencode_go"), "opencode-go");
  assert.equal(openCodeProviderFor("openrouter"), "openrouter");
  // The billing words are not gateways (0083): a boundary never names a provider.
  for (const word of ["free", "go", "external_api", "subscription", "openai_chatgpt"]) {
    assert.throws(() => openCodeProviderFor(word), /no OpenCode provider/);
  }

  const login = validateOpenCodeAccountInput({ operation: "login", provider: "openrouter", key: "sk-or-v1-material" });
  assert.equal(login.provider, "openrouter");
  assert.equal(validateOpenCodeAccountInput({ operation: "status", provider: "openrouter" }).provider, "openrouter");
  assert.deepEqual(validateOpenCodeAccountInput({ operation: "logout", provider: "openrouter" }).argv, ["auth", "logout", "openrouter"]);
  // Omitted, it is Go, as it always was: the isolated enrollment screen and
  // an older caller say nothing.
  assert.equal(validateOpenCodeAccountInput({ operation: "status" }).provider, "opencode-go");
  for (const provider of ["opencode", "anthropic", "openrouter/../x"]) {
    assert.throws(() => validateOpenCodeAccountInput({ operation: "login", provider, key: "sk-material" }),
      /account provider must be opencode-go or openrouter/);
  }
  assert.throws(() => validateOpenCodeAccountInput({ operation: "status", provider: "openrouter", key: "sk" }),
    /do not accept secrets/);
  assert.deepEqual(OPENCODE_ACCOUNT_LABELS, { "opencode-go": "OpenCode Go", openrouter: "OpenRouter" });
});

test("OpenCode account channel rejects unsupported operations and secrets on reads", () => {
  assert.throws(
    () => validateOpenCodeAccountInput({ operation: "shell", command: "rm -rf /" }),
    /unexpected OpenCode account field: command/,
  );
  assert.throws(
    () => validateOpenCodeAccountInput({ operation: "login", provider: "opencode-go" }),
    /invalid OpenCode login key/,
  );
  assert.throws(
    () => validateOpenCodeAccountInput({ operation: "login", provider: "opencode-go", key: "abc" }),
    /invalid OpenCode login key/,
  );
  assert.throws(
    () => validateOpenCodeAccountInput({ operation: "login", provider: "github", key: "some-api-key" }),
    /provider must be opencode-go/,
  );
  assert.throws(
    () => validateOpenCodeAccountInput({ operation: "status", key: "sk-should-not-pass" }),
    /read operations do not accept secrets/,
  );
  assert.throws(
    () => validateOpenCodeAccountInput({ operation: "nope" }),
    /unsupported OpenCode account operation/,
  );
});

// OpenRouter lists hundreds of models, some chat-only. An orchestrator and an
// executor both work through tools, so a model that cannot call them is left
// out of the catalog rather than offered and refused at the gate.
test("a provider's catalog leaves out models that cannot call tools", () => {
  const payload = {
    connected: ["openrouter"],
    all: [{ id: "openrouter", models: {
      "anthropic/claude-sonnet-4.5": { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", tool_call: true },
      "z-ai/glm-4.6": { id: "z-ai/glm-4.6", name: "GLM 4.6", capabilities: { toolcall: true } },
      "some/chat-only": { id: "some/chat-only", tool_call: false },
      "other/chat-only": { id: "other/chat-only", capabilities: { toolcall: false } },
      "unknown/model": { id: "unknown/model" },
    } }],
  };
  const summary = openCodeCatalogSummary(payload, "openrouter");
  assert.equal(summary.connected, true);
  assert.deepEqual(summary.models.map((model) => model.model_id),
    ["anthropic/claude-sonnet-4.5", "z-ai/glm-4.6", "unknown/model"]);
  assert.equal(summary.models[0].display_name, "Claude Sonnet 4.5");
  assert.equal(openCodeCatalogSummary(payload, "opencode-go").connected, false);
});

// Stage 12: a model's reasoning levels are its variants' names, in OpenCode's
// order — `run --variant` takes them — and never the providers' options.
test("a provider's catalog keeps each model's variant names as its reasoning levels", () => {
  const payload = {
    connected: ["opencode-go"],
    all: [{ id: "opencode-go", models: {
      "glm-5": { id: "glm-5", tool_call: true, variants: { high: { reasoningEffort: "high" }, max: { thinking: { budgetTokens: 32000 } } } },
      "kimi-k3": { id: "kimi-k3", tool_call: true, variants: { "bad name": {}, thinking: {} } },
      "plain": { id: "plain", tool_call: true },
    } }],
  };
  const models = openCodeCatalogSummary(payload, "opencode-go").models;
  assert.deepEqual(models.find((model) => model.model_id === "glm-5").reasoning_efforts, ["high", "max"]);
  assert.deepEqual(models.find((model) => model.model_id === "kimi-k3").reasoning_efforts, ["thinking"]);
  assert.equal(models.find((model) => model.model_id === "plain").reasoning_efforts, undefined);
  assert.ok(!JSON.stringify(models).includes("budgetTokens"), "a variant's provider options stay in the runtime");
});
