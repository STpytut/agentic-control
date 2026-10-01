// The panel's reading of the model checks (Stage 12 W7, docs/W6_W7_CONTRACT.md).
//
// W6 writes the database functions and W7 the panel, on separate branches, and
// neither can run the other's half until they meet. What can be pinned here is
// the panel's side of the contract: that the JSON shapes the contract names are
// read field for field (and nothing the database did not send is invented),
// that the state words are §2.7's, and that the Team picker puts each model in
// the group the design says — ready, not checked, not available for this role.
// The modules are pure and import only types, so they load as they are.
import test from "node:test";
import assert from "node:assert/strict";

const models = await import("../../../apps/web/src/lib/models.ts");
const { candidatesFor } = await import("../../../apps/web/src/lib/team-candidates.ts");

const entry = (id) => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;

const contractModels = {
  checks_today: 12,
  auto_checks: { used: 9, limit: 30 },
  hard_limit: 60,
  connections: [
    {
      connection_id: entry(100), provider: "openrouter", label: "OpenRouter", runtime_type: "opencode", runtime_version: "1.18.31",
      billing: "metered", list_read_at: "2026-09-28T10:00:00Z", total_models: 299,
      models: [
        { entry_id: entry(1), provider_id: "openrouter", model_id: "deepseek/deepseek-v4", display_name: "DeepSeek V4", vendor: "deepseek",
          pinned: true, in_use: [{ project_id: entry(900), project_name: "infra", role: "coder" }], state: "ready",
          reason: null, checked_at: "2026-09-28T09:00:00Z", retry_at: null, resolved_model: null },
        { entry_id: entry(2), provider_id: "openrouter", model_id: "openai/gpt-6-luna", display_name: "GPT-6 Luna", vendor: "openai",
          pinned: true, in_use: [], state: "refused", reason: "provider refused: no endpoint for your key",
          checked_at: "2026-09-28T09:00:00Z", retry_at: null, resolved_model: null },
        { entry_id: entry(3), provider_id: "openrouter", model_id: "mistral/devstral-3", display_name: "Devstral 3", vendor: "mistral",
          pinned: true, in_use: [], state: "not_checked", reason: null, checked_at: null, retry_at: null, resolved_model: null },
      ],
      more_count: 296,
    },
    {
      connection_id: entry(101), provider: "claude", label: "Claude", runtime_type: "claude", runtime_version: "2.1.270",
      billing: "subscription", list_read_at: null, total_models: 1,
      models: [{ entry_id: entry(4), provider_id: "claude", model_id: "haiku", display_name: "", vendor: "anthropic", pinned: false,
        in_use: [], state: "ready", reason: null, checked_at: null, retry_at: null, resolved_model: "claude-haiku-4-5" }],
      more_count: 0,
    },
  ],
};

test("get_operator_models is read field for field", () => {
  const read = models.operatorModelsFromJson(contractModels, "2026-09-28T12:00:00Z");
  assert.equal(read.checksToday, 12);
  assert.deepEqual(read.autoChecks, { used: 9, limit: 30 });
  assert.equal(read.hardLimit, 60);
  assert.equal(read.connections.length, 2);
  const [openrouter, claude] = read.connections;
  assert.equal(openrouter.runtimeType, "opencode");
  assert.equal(openrouter.totalModels, 299);
  assert.equal(openrouter.moreCount, 296);
  assert.deepEqual(openrouter.models[0].inUse, [{ projectId: entry(900), projectName: "infra", role: "coder" }]);
  assert.equal(openrouter.models[1].reason, "provider refused: no endpoint for your key");
  assert.equal(claude.listReadAt, null);
  assert.equal(claude.models[0].resolvedModel, "claude-haiku-4-5");
});

test("a state the contract does not name is not read as ready", () => {
  const row = models.modelRowFromJson({ entry_id: entry(9), state: "verified" });
  assert.equal(row.state, "not_checked");
  assert.equal(models.checkState("done"), "checking");
});

test("more_count missing is total minus what is listed", () => {
  const value = structuredClone(contractModels);
  delete value.connections[0].more_count;
  assert.equal(models.operatorModelsFromJson(value, "2026-09-28T12:00:00Z").connections[0].moreCount, 296);
});

test("get_model_check, the search and the writes are read as the contract writes them", () => {
  const check = models.modelCheckFromJson({ check_id: entry(50), entry_id: entry(3), state: "waiting", result: null,
    failure_class: "infrastructure", reason: "usage limit", queue_position: 2, requested_at: "2026-09-28T12:00:00Z",
    started_at: null, finished_at: null, retry_at: "2026-09-28T14:20:00Z" });
  assert.equal(check.state, "waiting");
  assert.equal(check.failureClass, "infrastructure");
  assert.equal(check.queuePosition, 2);
  assert.equal(models.checkSettled(check.state), false, "a waiting check retries by itself; the dialog keeps asking");
  assert.equal(models.checkSettled("refused"), true);
  assert.equal(models.checkSettled("ready"), true);

  const search = models.catalogSearchFromJson({ total: 37, results: [contractModels.connections[0].models[2]] });
  assert.equal(search.total, 37);
  assert.equal(search.results[0].modelId, "mistral/devstral-3");
  assert.deepEqual(models.catalogSearchFromJson(null), { total: 0, results: [] });

  assert.deepEqual(models.pinResultFromJson({ entry_id: entry(3), pinned: true, check_id: entry(51) }),
    { entryId: entry(3), pinned: true, checkId: entry(51) });
  assert.deepEqual(models.checkRequestFromJson({ check_id: entry(51), state: "checking", deduplicated: true }),
    { checkId: entry(51), state: "checking", deduplicated: true, reason: null, retryAt: null });
  // An immediate refusal says why (0105): the dialog needs no poll to show it.
  assert.deepEqual(models.checkRequestFromJson({ check_id: entry(52), state: "refused", deduplicated: true,
    result: "rejected", failure_class: "model", reason: "not in your plan", retry_at: null }),
  { checkId: entry(52), state: "refused", deduplicated: true, reason: "not in your plan", retryAt: null });
});

test("the state words are §2.7's, and failed reads as refused pointing at the runtime", () => {
  assert.equal(models.stateWords("ready", null).word, "ready");
  assert.equal(models.stateWords("checking", null).word, "checking…");
  assert.equal(models.stateWords("not_checked", null).word, "not checked");
  assert.equal(models.stateWords("refused", null).word, "refused");
  const waiting = models.stateWords("waiting", "2026-09-28T14:20:00Z");
  assert.equal(waiting.word, "waiting");
  assert.equal(waiting.note, "retry at 14:20 UTC");
  const failed = models.stateWords("failed", null);
  assert.equal(failed.word, "refused");
  assert.match(failed.note, /runtime/);
  assert.equal(models.canCheckAgain("refused"), true);
  assert.equal(models.canCheckAgain("failed"), true);
  assert.equal(models.canCheckAgain("ready"), false);
  assert.equal(models.canCheckAgain("not_checked"), false, "no Verify button: a model not checked is pinned or picked");
});

test("time words and vendor order", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  assert.equal(models.timeAgo("2026-09-28T10:00:00Z", now), "2 h ago");
  assert.equal(models.timeAgo("2026-09-28T11:59:30Z", now), "just now");
  assert.equal(models.timeAgo("2026-09-27T12:00:00Z", now), "yesterday");
  assert.equal(models.timeAgo(null, now), null);
  assert.deepEqual(["mistral", "", "openai", "anthropic", "deepseek"].sort(models.compareVendors),
    ["anthropic", "openai", "deepseek", "mistral", ""]);
});

const words = { runtime: (runtime) => ({ opencode: "OpenCode", claude: "Claude Code", codex: "Codex" })[runtime] ?? runtime, heldBack: {
  runtime_cannot_play_role: "their runtime cannot play this role",
} };

const team = {
  projectId: entry(900), managed: true, version: 3,
  roles: [],
  runtimes: [
    { runtime: "opencode", capabilities: [], plays: ["orchestrator", "executor"] },
    { runtime: "claude", capabilities: [], plays: ["orchestrator"] },
  ],
  assignments: [
    { assignmentId: entry(700), agentName: "o", runtime: "claude", roleKey: "orchestrator", roleName: "Orchestrator", isDefault: true,
      entryId: entry(4), modelId: "haiku", displayName: "", openTasks: 0 },
    { assignmentId: entry(701), agentName: "e", runtime: "opencode", roleKey: "executor", roleName: "Executor", isDefault: false,
      entryId: entry(5), modelId: "qwen/qwen3.5-coder", displayName: "", openTasks: 0 },
  ],
  models: [
    { entryId: entry(1), runtime: "opencode", modelId: "deepseek/deepseek-v4", displayName: "DeepSeek V4", gateway: "openrouter", vendor: "deepseek",
      billing: "third_party_metered", orchestratorUnavailable: null, executorUnavailable: null },
    { entryId: entry(5), runtime: "opencode", modelId: "qwen/qwen3.5-coder", displayName: "", gateway: "openrouter", vendor: "qwen",
      billing: "third_party_metered", orchestratorUnavailable: null, executorUnavailable: null },
    { entryId: entry(4), runtime: "claude", modelId: "haiku", displayName: "", gateway: "", vendor: "anthropic",
      billing: "subscription", orchestratorUnavailable: null, executorUnavailable: "runtime_cannot_play_role" },
  ],
  heldBack: [],
};

test("Add executor: ready first, then not checked, then the models this role cannot use", () => {
  const read = models.operatorModelsFromJson(contractModels, "2026-09-28T12:00:00Z");
  const found = candidatesFor(team, read, { kind: "add" }, words);
  const group = (id) => found.find((candidate) => candidate.entryId === entry(id))?.group;
  assert.equal(group(1), "ready");
  assert.equal(group(5), undefined, "an executor already on the team is not offered twice");
  assert.equal(group(2), "unchecked", "a refused pin is listed with its reason, to be checked again on pick");
  assert.equal(group(3), "unchecked");
  assert.equal(group(4), "unavailable");
  assert.match(found.find((candidate) => candidate.entryId === entry(4)).why, /cannot hold this role/);
});

test("Change model keeps to the member's runtime and marks the current model", () => {
  const read = models.operatorModelsFromJson(contractModels, "2026-09-28T12:00:00Z");
  const executor = team.assignments[1];
  const found = candidatesFor(team, read, { kind: "change", assignment: executor }, words);
  const current = found.find((candidate) => candidate.entryId === entry(5));
  assert.equal(current.group, "ready");
  assert.equal(current.current, true);
  assert.equal(found.find((candidate) => candidate.entryId === entry(4)).group, "unavailable");

  const orchestrator = team.assignments[0];
  const forOrchestrator = candidatesFor(team, read, { kind: "change", assignment: orchestrator }, words);
  assert.equal(forOrchestrator.find((candidate) => candidate.entryId === entry(4)).group, "ready");
  const other = forOrchestrator.find((candidate) => candidate.entryId === entry(1));
  assert.equal(other.group, "unavailable", "another runtime is another member, as the database says");
  assert.match(other.why, /another runtime/);
});

test("a searched model joins the group of its connection's runtime; without the checks, only the team's read counts", () => {
  const read = models.operatorModelsFromJson(contractModels, "2026-09-28T12:00:00Z");
  const searched = [models.modelRowFromJson({ entry_id: entry(20), model_id: "z-ai/glm-5", state: "not_checked", vendor: "z-ai" })];
  const found = candidatesFor(team, read, { kind: "add" }, words, searched, { [entry(20)]: entry(100) });
  assert.equal(found.find((candidate) => candidate.entryId === entry(20))?.group, "unchecked");

  const before = candidatesFor(team, null, { kind: "add" }, words);
  assert.deepEqual(before.map((candidate) => candidate.group).sort(), ["ready", "unavailable"]);
});

// 0105: what the card reads beside the models.
test("the card's additions: vendors, rollup, newer runtime, budget and alias drift", () => {
  const withAdditions = structuredClone(contractModels);
  withAdditions.budget = { window_hours: 24, next_slot_at: "2026-09-29T08:00:00Z", clear_at: "2026-09-29T11:00:00Z",
    auto_next_slot_at: null };
  Object.assign(withAdditions.connections[0], {
    vendors: [{ vendor: "deepseek", count: 40 }, { vendor: "openai", count: 60 }, { vendor: "", count: 3 }],
    rollup: { ready: 2, checking: 1, not_checked: 290, refused: 5, waiting: 1, total: 299 },
    newer_runtime: { version: "1.18.33", qualification_id: entry(60), result: "passed", added: ["openai/gpt-7"], removed: [] },
  });
  Object.assign(withAdditions.connections[1].models[0], { alias_drift: { model: "claude-haiku-5", seen_at: "2026-09-28T11:00:00Z" } });
  const read = models.operatorModelsFromJson(withAdditions, "2026-09-28T12:00:00Z");
  const [openrouter, claude] = read.connections;
  assert.deepEqual(openrouter.vendors, [{ vendor: "deepseek", count: 40 }, { vendor: "openai", count: 60 }], "an unnamed vendor is no filter");
  assert.deepEqual(openrouter.rollup, { ready: 2, checking: 1, notChecked: 290, refused: 5, waiting: 1, total: 299 });
  assert.equal(models.rollupWords(openrouter.rollup), "2 ready · 1 checking · 1 waiting · 5 refused · 290 not checked");
  assert.deepEqual(openrouter.newerRuntime, { version: "1.18.33", result: "passed", added: ["openai/gpt-7"], removed: [] });
  assert.deepEqual(read.budget, { nextSlotAt: "2026-09-29T08:00:00Z", clearAt: "2026-09-29T11:00:00Z", autoNextSlotAt: null });
  assert.deepEqual(claude.models[0].aliasDrift, { model: "claude-haiku-5", seenAt: "2026-09-28T11:00:00Z" });
  assert.equal(claude.newerRuntime, null);
  assert.deepEqual(claude.vendors, []);

  // The contract's shape before these keys reads as absent, never invented.
  const bare = models.operatorModelsFromJson(contractModels, "2026-09-28T12:00:00Z");
  assert.equal(bare.connections[0].rollup, null);
  assert.equal(bare.connections[0].models[0].aliasDrift, null);
  assert.deepEqual(bare.budget, { nextSlotAt: null, clearAt: null, autoNextSlotAt: null });
  // A newer version that changes nothing for the connection is not a line.
  assert.equal(models.operatorModelsFromJson({ connections: [{ newer_runtime: { version: "2.0.0", added: [], removed: [] } }] }, "")
    .connections[0].newerRuntime, null);
});

test("an alias is shown with what it resolves to, everywhere a model is picked", () => {
  assert.equal(models.modelWithResolved("opus", "claude-opus-5"), "opus → claude-opus-5");
  assert.equal(models.modelWithResolved("gpt-5.6-luna", null), "gpt-5.6-luna");
  assert.equal(models.modelWithResolved("gpt-5.6-luna", "gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(models.someNames(["a", "b", "c", "d", "e", "f"]), "a, b, c, d and 2 more");

  const read = models.operatorModelsFromJson(contractModels, "2026-09-28T12:00:00Z");
  assert.equal(models.resolvedModelOf(read, entry(4)), "claude-haiku-4-5");
  assert.equal(models.resolvedModelOf(read, entry(1)), null);
  // The Team picker: the team's read names the alias; the check list says what it is.
  const orchestrator = team.assignments[0];
  const found = candidatesFor(team, read, { kind: "change", assignment: orchestrator }, words);
  assert.equal(found.find((candidate) => candidate.entryId === entry(4)).resolved, "claude-haiku-4-5");
  assert.equal(found.find((candidate) => candidate.entryId === entry(1)).resolved, null);
});
