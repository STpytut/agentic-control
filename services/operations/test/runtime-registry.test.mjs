// The adapter registry and the installation layout are the source; everything
// that repeats them is compared with them (WP-5a).
//
// The tests that matter most here hand the comparison a registry that is not the
// real one: a fictional third runtime, and a layout moved the way WP-5c will move
// it. Each must fail by naming every place still to change — that list is the
// checklist, and it is the tests that write it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RESERVED_RUNTIME_NAMES,
  adapterFor,
  allAdapters,
  credentialReferenceFor,
  runtimeNames,
  configOverridesFor,
} from "../runtime-adapters.mjs";
import { INSTALLATION_LAYOUT } from "../installation-layout.mjs";
import { assumedStructuralRuntimes, registryGaps } from "../runtime-registry-check.mjs";
import { driverFor } from "../../runtime-supervisor/drivers/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../");

const FICTIONAL = Object.freeze({
  name: "fictional",
  user: "fictional-worker",
  home: "/home/fictional-worker",
  credentialState: "/home/fictional-worker/.state",
  writableState: ["/home/fictional-worker/.state"],
  display: { label: "Fictional" },
  roles: ["executor"],
  dispatch: { jobTypes: ["fictional_turn"], connectionProvider: "fictional" },
  units: ["infra-cod-fictional-worker"],
  sandboxPaths: [{ path: "/home/fictional-worker", mode: 0o750 }, { path: "/home/fictional-worker/.state", mode: 0o700 }],
  backup: ["/home/fictional-worker/.state"],
});

test("every copy of the registry and the layout agrees with them", () => {
  const gaps = registryGaps({ adapters: allAdapters(), layout: INSTALLATION_LAYOUT, root: ROOT });
  assert.deepEqual(gaps, [], gaps.join("\n"));
});

test("a fictional third runtime is refused by name in every place that does not know it", () => {
  const gaps = registryGaps({ adapters: [...allAdapters(), FICTIONAL], layout: INSTALLATION_LAYOUT, root: ROOT });
  assert.deepEqual(gaps.sort(), [
    "apps/web/src/lib/runtime-labels.ts has no label for fictional",
    "apps/web/src/lib/runtime-labels.ts gives no roles for fictional",
    "deploy/install.sh does not create the account fictional-worker for fictional",
    "deploy/install.sh does not guard /home/fictional-worker in RUNTIME_HOME_PATHS",
    "deploy/install.sh does not guard /home/fictional-worker/.state in RUNTIME_HOME_PATHS",
    "deploy/systemd/infra-cod-fictional-worker.service does not exist, and fictional names it",
    "deploy/tmpfiles.d creates no /home/fictional-worker",
    "deploy/tmpfiles.d creates no /home/fictional-worker/.state",
    "infra-cod-runtime-supervisor.service does not let fictional write /home/fictional-worker/.state",
    "services/operations/unit-contract.mjs does not list infra-cod-fictional-worker, which fictional names",
  ].sort());
});

test("a moved layout is refused by name in every place that still has the old one", () => {
  // The roots moving somewhere else — as WP-5c moved them. Every copy that has
  // not moved with them is named: the list such a move works through.
  const moved = {
    ...INSTALLATION_LAYOUT,
    workspaceRoot: { ...INSTALLATION_LAYOUT.workspaceRoot, path: "/srv/infra-cod-next/workspaces" },
    gateSmokeRoot: { ...INSTALLATION_LAYOUT.gateSmokeRoot, path: "/srv/infra-cod-next/gate-smoke" },
  };
  const gaps = registryGaps({ adapters: allAdapters(), layout: moved, root: ROOT });
  const named = (fragment) => gaps.some((gap) => gap.includes(fragment));
  for (const place of [
    "deploy/tmpfiles.d creates no /srv/infra-cod-next/workspaces",
    "deploy/tmpfiles.d creates no /srv/infra-cod-next/gate-smoke",
    "deploy/install.sh sets WORKSPACE_ROOT",
    "deploy/install.sh sets GATE_SMOKE_ROOT",
    "infra-cod-runtime-supervisor.service sets PROJECT_WORKSPACE_ROOT",
    "infra-cod-runtime-supervisor.service sets RUNTIME_GATE_WORKSPACE_ROOT",
    "infra-cod-project-provisioner.service sets PROJECT_WORKSPACE_ROOT",
    "infra-cod-github-app-worker.service sets PROJECT_WORKSPACE_ROOT",
    "infra-cod-catalog-gate-worker.service sets RUNTIME_GATE_WORKSPACE_ROOT",
    "apps/web/src/lib/control-plane-actions.ts falls back to",
  ]) {
    assert.ok(named(place), `a moved layout does not name "${place}":\n${gaps.join("\n")}`);
  }
});

test("a relabelled runtime is named where the panel still shows the old name", () => {
  const relabelled = allAdapters().map((adapter) => adapter.name === "opencode"
    ? { ...adapter, display: { label: "Open Code" } } : adapter);
  const gaps = registryGaps({ adapters: relabelled, layout: INSTALLATION_LAYOUT, root: ROOT });
  assert.deepEqual(gaps, ['apps/web/src/lib/runtime-labels.ts labels opencode "OpenCode", the registry "Open Code"']);
});

test("the panel takes a project's runtime from the model picked, not from a literal", () => {
  const source = readFileSync(path.join(ROOT, "apps/web/src/lib/control-plane-actions.ts"), "utf8");
  assert.deepEqual(assumedStructuralRuntimes(source), []);
  // rc.44's line, which gave an OpenCode orchestrator a Codex profile.
  assert.deepEqual(assumedStructuralRuntimes('? await structuralProfile(operator.userId, "codex")'), ["codex"]);
});

test("each descriptor answers what the registry now promises", () => {
  const roles = new Map();
  const jobs = new Map();
  for (const adapter of allAdapters()) {
    assert.equal(adapterFor(adapter.name), adapter);
    assert.ok(adapter.display?.label, `${adapter.name} has no display label`);
    assert.ok(adapter.roles.length > 0, `${adapter.name} plays no role`);
    for (const role of adapter.roles) {
      assert.ok(["orchestrator", "executor", "analyst"].includes(role), `${adapter.name} declares an unknown role ${role}`);
      roles.set(role, [...(roles.get(role) ?? []), adapter.name]);
    }
    for (const type of adapter.dispatch.jobTypes) jobs.set(type, [...(jobs.get(type) ?? []), adapter.name]);
    assert.equal(credentialReferenceFor(adapter), `${adapter.name}-home:${adapter.user}`);
    // Every directory it mounts is inside its home, and its home is the first.
    assert.equal(adapter.sandboxPaths[0].path, adapter.home, `${adapter.name}'s first sandbox path is not its home`);
    for (const { path: directory } of adapter.sandboxPaths) {
      assert.ok(directory === adapter.home || directory.startsWith(`${adapter.home}/`), `${directory} is outside ${adapter.name}'s home`);
    }
    // What a backup carries is its own, and includes its credentials.
    for (const directory of adapter.backup) {
      assert.ok(directory.startsWith(`${adapter.home}/`), `${adapter.name} backs up ${directory}, outside its home`);
    }
  }
  assert.deepEqual([...roles.keys()].sort(), ["analyst", "executor", "orchestrator"], "a role has no runtime");
  // A type served by more than one runtime is chosen among by the task's
  // assignment (11.2 N4 for the orchestrator; Stage 12 X1 for the executor):
  // every runtime serving a type plays the role that type is for.
  for (const [type, owners] of jobs) {
    const role = type === "implementation_run" ? "executor" : "orchestrator";
    for (const owner of owners) assert.ok(adapterFor(owner).roles.includes(role), `${type} is served by ${owner}, which does not play ${role}`);
  }
  assert.deepEqual([...jobs.get("implementation_run")].sort(), ["claude", "codex", "opencode"]);
});

// 11.2 N6, exit criterion 1: no job type names a vendor. The registry's types
// are neutral, and the vendor's names are gone from the product — the code the
// release ships and its tests. Migrations keep them as history, and one test
// writes them on purpose, to show 0077 renaming what an older host left.
test("no job type names a vendor, and the retired names are gone from the product", () => {
  const vendors = [...allAdapters().map((adapter) => adapter.name), ...Object.keys(RESERVED_RUNTIME_NAMES)];
  for (const adapter of allAdapters()) {
    for (const type of adapter.dispatch.jobTypes) {
      assert.ok(!vendors.some((name) => type.includes(name)), `${adapter.name} serves ${type}, which names a runtime`);
    }
  }
  const retired = /\b(codex_chat_turn|resume_codex)\b|['"`]start_implementation['"`]/;
  const exempt = new Set(["services/control-plane/test/job-vocabulary-contract.test.mjs",
    "services/operations/test/runtime-registry.test.mjs", "services/runtime-supervisor/test/drivers.test.mjs"]);
  const found = [];
  const walk = (directory) => {
    for (const name of readdirSync(path.join(ROOT, directory))) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const relative = path.posix.join(directory, name);
      if (statSync(path.join(ROOT, relative)).isDirectory()) { walk(relative); continue; }
      if (!/\.(mjs|js|ts|tsx|sh|service|json)$/.test(name) || exempt.has(relative)) continue;
      const lines = readFileSync(path.join(ROOT, relative), "utf8").split("\n");
      lines.forEach((line, index) => { if (retired.test(line)) found.push(`${relative}:${index + 1}`); });
    }
  };
  for (const directory of ["services", "apps/web/src", "deploy", "scripts"]) walk(directory);
  assert.deepEqual(found, [], `a retired job name is still used: ${found.join(", ")}`);
});

test("a reserved runtime name is not also an adapter", () => {
  for (const name of Object.keys(RESERVED_RUNTIME_NAMES)) {
    assert.ok(!runtimeNames().includes(name), `${name} is both reserved and provisioned`);
  }
});

test("no service repeats a path the registry or the layout owns", () => {
  // The literal belongs in the two declarations and nowhere else in running
  // code. A comment may mention it; tests may construct it.
  const owned = [
    ...Object.values(INSTALLATION_LAYOUT).map((entry) => entry.path),
    ...allAdapters().map((adapter) => adapter.home),
  ];
  const sources = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const full = path.join(directory, name);
      if (name === "test" || name === "node_modules") continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".mjs")) sources.push(full);
    }
  };
  walk(path.join(ROOT, "services"));
  const declarations = ["services/operations/runtime-adapters.mjs", "services/operations/installation-layout.mjs"];
  const offenders = [];
  for (const file of sources) {
    const relative = path.relative(ROOT, file);
    if (declarations.includes(relative)) continue;
    const code = readFileSync(file, "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*)/.test(line)).join("\n");
    for (const literal of owned) {
      // The path itself or something under it — not a sibling file that happens
      // to share its prefix, such as /etc/infra-cod/github-app.env.
      const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`["'\`]${escaped}(?=["'\`/])`).test(code)) offenders.push(`${relative}: ${literal}`);
    }
  }
  assert.deepEqual(offenders, [], `hard-coded outside the registry and the layout:\n${offenders.join("\n")}`);
});

test("every Codex the supervisor starts carries the registry's launch configuration", () => {
  // P-2: without features.use_legacy_landlock every sandboxed command a Codex
  // turn ran failed with RTM_NEWADDR under Ubuntu 24.04's userns restriction.
  // A launch added later without the overrides would bring that back.
  // Since Stage 12 W8 it is bound to the versions that need it: Codex after
  // 0.154.0 refuses the legacy path and panics with the flag set.
  const codex = adapterFor("codex");
  assert.deepEqual(configOverridesFor(codex, "0.154.0"), ["features.use_legacy_landlock=true", 'sandbox_mode="read-only"']);
  // Stage 12 M0: from 0.155.0 a permission profile that denies the login, under
  // `~` (a qualification's scratch home) and the real home both.
  const profile = [
    'default_permissions="infra_cod_read_only"',
    'permissions.infra_cod_read_only={extends=":read-only",filesystem={"~/.codex"="deny","/home/codex-worker/.codex"="deny"}}',
  ];
  assert.deepEqual(configOverridesFor(codex, "0.158.0"), profile);
  assert.deepEqual(configOverridesFor(codex, null), profile, "an unknown version launches as the newest, and an older binary refuses it");
  assert.match(codex.configOverridesVerifiedAgainst, /rust-v0\.154\.0/);
  for (const adapter of allAdapters()) {
    for (const override of configOverridesFor(adapter)) {
      assert.match(override, /^[a-z_][a-z0-9_.]*=[^\s]+$/, `${adapter.name}: ${override} is not key=value`);
    }
  }
  // Since WP-5b the supervisor starts every runtime from its driver: the
  // command is the driver's executable and the arguments its argv. So the
  // launch configuration is asserted on the driver, for every surface Codex
  // is opened on, and the supervisor is asserted to launch nothing by name.
  const codexDriver = driverFor("codex");
  // Its channels; a writing run (Stage 12 X2) is `codex exec`, asserted below.
  const surfaces = Object.keys(codexDriver.surfaces).filter((surface) => codexDriver.surfaces[surface].transport === "channel");
  assert.ok(surfaces.length >= 3, `found ${surfaces.length} Codex surfaces`);
  assert.throws(() => codexDriver.run.argv({ surface: "task", version: "0.154.0", model: "m", prompt: "p" }), /cannot hide its login from a writing run/);
  const task = codexDriver.run.argv({ surface: "task", version: "0.158.0", model: "m", prompt: "p" });
  assert.deepEqual(task.slice(0, 4), ["-c", 'default_permissions="infra_cod_workspace"', "-c",
    'permissions.infra_cod_workspace={extends=":workspace",filesystem={":workspace_roots"={".git"="write"},"~/.codex"="deny","/home/codex-worker/.codex"="deny"},network={enabled=true}}']);
  assert.ok(task.includes('approval_policy="never"') && task.includes('mcp_servers.platform.default_tools_approval_mode="approve"'));
  assert.deepEqual(task.slice(task.indexOf("exec")), ["exec", "--json", "--skip-git-repo-check", "-m", "m", "p"]);
  const resumed = codexDriver.run.argv({ surface: "task", version: "0.158.0", model: "m", prompt: "p", sessionId: "thr-1" });
  assert.deepEqual(resumed.slice(resumed.indexOf("exec")), ["exec", "resume", "--json", "--skip-git-repo-check", "-m", "m", "thr-1", "p"]);
  for (const surface of surfaces) {
    assert.deepEqual(codexDriver.run.argv({ surface, version: "0.154.0" }).slice(0, 4), ["-c", "features.use_legacy_landlock=true", "-c", 'sandbox_mode="read-only"'],
      `a Codex ${surface} launch without the registry's configuration`);
    assert.deepEqual(codexDriver.run.argv({ surface, version: "0.158.0" }).slice(0, 4), ["-c", profile[0], "-c", profile[1]],
      `a Codex 0.158.0 ${surface} launch without the permission profile`);
    assert.ok(!codexDriver.run.argv({ surface, version: "0.158.0" }).includes("features.use_legacy_landlock=true"),
      `a Codex 0.158.0 ${surface} launch carries the legacy sandbox flag`);
  }
  const server = readFileSync(path.join(ROOT, "services/runtime-supervisor/server.mjs"), "utf8");
  const launches = [...server.matchAll(/cleanRuntimeArgs\(\s*[^,]+,\s*[^,]+,\s*([^,]+),\s*([^,(]+)/g)]
    .map((match) => [match[1].trim(), match[2].trim()])
    .filter(([command]) => command !== "command");
  assert.ok(launches.length >= 3, `found ${launches.length} runtime launches`);
  // Since Stage 12 W3 a qualification launches a candidate's executable: an
  // exact recorded version whose digest still matches (qualification-surface.mjs),
  // never a name and never a path a request supplies. The argv stays the driver's.
  const allowed = new Set(["driver.executable", "candidate?.executable ?? driver.executable", "executable"]);
  for (const [command, args] of launches) {
    assert.ok(allowed.has(command), `a runtime launched by name: ${command}`);
    assert.equal(args, "driver.run.argv", `a runtime launched with arguments that are not its driver's: ${args}`);
  }
});

// Stage 12: a member's reasoning level reaches a runtime's argv or its
// turn/start, so it comes from where the model does — the task's snapshot, read
// by the database for the job the launcher leases — and never from what a
// request to the supervisor says. The driver checks the value again (drivers.test.mjs).
test("a launch's reasoning level is read from the job's context, never taken from a request", () => {
  for (const file of ["services/runtime-supervisor/server.mjs", "services/control-plane/orchestrator-worker.mjs"]) {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    const sources = [...source.matchAll(/\b(?:reasoningEffort|effort):\s*([^\n]+)/g)].map((match) => match[1].trim());
    assert.ok(sources.length >= 1, `${file} passes no reasoning level`);
    for (const value of sources) {
      assert.ok(/^(context\.reasoning_effort\b|launchReasoningLevel\(driver, context\.reasoning_effort\)|reasoningEffort\b)/.test(value),
        `${file} takes a reasoning level from ${value}`);
    }
    assert.ok(!/request\.reasoning/.test(source), `${file} reads a reasoning level from a request`);
  }
});

// WP-9c: the panel's data layer names no runtime. It used to decide identity,
// capability and usage by name — `runtimeType === "codex"`, a CASE on job type
// that said "opencode", "Codex delegated implementation to OpenCode." — and after
// neutral jobs each of those is silently wrong. What a job ran is read from its
// recorded provenance; what a runtime can be offered for, from the roles in
// runtime-labels.ts, which the test above holds to the registry.
//
// Comments are left out: they may say what happened on the host.
test("apps/web/src/lib/product-data.ts names no runtime", () => {
  const source = readFileSync(path.join(ROOT, "apps/web/src/lib/product-data.ts"), "utf8");
  const code = source.split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").replace(/--.*$/, ""))
    .join("\n");
  const names = [...allAdapters().map((adapter) => adapter.name), ...Object.keys(RESERVED_RUNTIME_NAMES)];
  const found = names.flatMap((name) => [...code.matchAll(new RegExp(`\\b${name}\\b`, "gi"))].map((match) => {
    const line = code.slice(0, match.index).split("\n").length;
    return `${name} on line ${line}`;
  }));
  assert.deepEqual(found, [], `runtime names in product-data.ts: ${found.join(", ")}`);
});
