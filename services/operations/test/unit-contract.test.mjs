// The unit contract against the units that are actually shipped.
//
// Five hand-kept lists drifted apart, and the drift was invisible until a real
// Ubuntu run: the health snapshot watched a PostgreSQL meta-unit that is always
// inactive and did not watch caddy or the project provisioner at all. This suite
// is what makes the next added worker fail a test instead of going unwatched.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adapterFor, runtimeNames } from "../runtime-adapters.mjs";
import {
  LONG_RUNNING_SERVICES,
  ONESHOT_SERVICES,
  POSTGRESQL_UNIT,
  RUNTIME_SANDBOX_PATHS,
  TIMERS,
  unitFileNames,
} from "../unit-contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "../../../");
const SYSTEMD_DIR = path.join(REPOSITORY_ROOT, "deploy/systemd");

function targetWants() {
  const target = readFileSync(path.join(SYSTEMD_DIR, "infra-cod.target"), "utf8");
  return target
    .split("\n")
    .filter((line) => line.startsWith("Wants="))
    .map((line) => line.slice("Wants=".length).trim())
    // The target also wants things that are not part of this installation's own
    // unit set, such as network-online.target.
    .filter((unit) => unit.startsWith("infra-cod-"));
}

test("every unit the target wants is in the contract", () => {
  const wanted = targetWants().sort();
  const declared = unitFileNames().filter((name) => name !== "infra-cod.target").sort();
  assert.deepEqual(wanted, declared.filter((name) => wanted.includes(name)).sort(),
    "the target wants a unit the contract does not name");
  const missing = wanted.filter((unit) => !declared.includes(unit));
  assert.deepEqual(missing, [], `not in the contract: ${missing.join(", ")}`);
});

test("every unit in the contract is wanted by the target", () => {
  const wanted = targetWants();
  // Oneshot services are pulled in by their timers, not by the target.
  const expected = [
    ...LONG_RUNNING_SERVICES.map((name) => `${name}.service`),
    ...TIMERS.map((name) => `${name}.timer`),
  ];
  const orphans = expected.filter((unit) => !wanted.includes(unit));
  assert.deepEqual(orphans, [], `in the contract but not started by the target: ${orphans.join(", ")}`);
});

test("every unit in the contract ships as a file", () => {
  const shipped = new Set(readdirSync(SYSTEMD_DIR).filter((name) => /\.(service|timer|target)$/.test(name)));
  const missing = unitFileNames().filter((name) => !shipped.has(name));
  assert.deepEqual(missing, [], `named by the contract but not shipped: ${missing.join(", ")}`);
});

test("every shipped unit file is named by the contract", () => {
  const declared = new Set(unitFileNames());
  const shipped = readdirSync(SYSTEMD_DIR).filter((name) => /\.(service|timer|target)$/.test(name));
  const unwatched = shipped.filter((name) => !declared.has(name));
  // A unit that is installed and started but that nothing checks is exactly how
  // caddy and the provisioner went unwatched by the health snapshot.
  assert.deepEqual(unwatched, [], `shipped but unwatched: ${unwatched.join(", ")}`);
});

test("the long-running services are Type=simple and the oneshots are Type=oneshot", () => {
  for (const unit of LONG_RUNNING_SERVICES) {
    const source = readFileSync(path.join(SYSTEMD_DIR, `${unit}.service`), "utf8");
    assert.match(source, /^Type=simple$/m, `${unit} is not Type=simple but is checked with is-active`);
  }
  for (const unit of ONESHOT_SERVICES) {
    const source = readFileSync(path.join(SYSTEMD_DIR, `${unit}.service`), "utf8");
    assert.match(source, /^Type=oneshot$/m, `${unit} is not Type=oneshot but is checked with Result=success`);
  }
});

test("every long-running service declares how long it may take to stop", () => {
  // A unit that does not stop on SIGTERM is SIGKILLed after TimeoutStopSec, and
  // a worker killed mid-tick never releases the lease it holds or writes the
  // terminal status it owes (defect 106). The bound is declared per unit rather
  // than left to systemd's 90-second default, so the number is visible next to
  // the service it governs.
  for (const unit of LONG_RUNNING_SERVICES) {
    const source = readFileSync(path.join(SYSTEMD_DIR, `${unit}.service`), "utf8");
    const declared = /^TimeoutStopSec=(\d+)$/m.exec(source);
    assert.ok(declared, `${unit} declares no TimeoutStopSec, so a slow stop is SIGKILLed after systemd's default`);
    assert.ok(Number(declared[1]) <= 30, `${unit} allows ${declared[1]}s to stop; an update restarts every service in turn`);
  }
});

test("the PostgreSQL unit named is the one that runs the cluster", () => {
  // `postgresql.service` is a Debian meta-unit that stays inactive while
  // postgresql@17-main.service runs the cluster. Health asked the meta-unit and
  // therefore failed the install on a host whose database was fine.
  assert.equal(POSTGRESQL_UNIT, "postgresql@17-main.service");

  // And it is what the units themselves order against.
  const web = readFileSync(path.join(SYSTEMD_DIR, "infra-cod-web.service"), "utf8");
  assert.match(web, /postgresql@17-main\.service/);
});

test("nothing outside the contract hard-codes a unit list", () => {
  // The health snapshot and doctor must read the contract rather than repeat it.
  for (const relative of ["services/operations/health-snapshot.mjs", "services/operations/doctor.mjs"]) {
    const source = readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8");
    assert.match(source, /unit-contract\.mjs/, `${relative} does not use the shared unit contract`);
    assert.doesNotMatch(source, /"postgresql\.service"/, `${relative} still asks the PostgreSQL meta-unit`);
  }
});

test("every sandbox path a unit names is created by tmpfiles", () => {
  // systemd resolves ReadWritePaths and ReadOnlyPaths while building the unit's
  // mount namespace, before ExecStart, so a path nothing creates is a unit that
  // cannot start — which is exactly how the runtime supervisor failed on a clean
  // installation with status=226/NAMESPACE.
  const tmpfilesDir = path.join(REPOSITORY_ROOT, "deploy/tmpfiles.d");
  const created = new Set();
  for (const file of readdirSync(tmpfilesDir)) {
    for (const line of readFileSync(path.join(tmpfilesDir, file), "utf8").split("\n")) {
      if (!/^[dDf]\s/.test(line)) continue;
      created.add(line.split(/\s+/)[1]);
    }
  }

  // Paths systemd itself provides, and paths the installer owns.
  const provided = [/^\/opt\/infra-cod\//, /^\/var\/lib\/infra-cod-backups/, /^\/var\/lib\/infra-control/, /^\/var\/log\//];

  const missing = [];
  for (const name of readdirSync(SYSTEMD_DIR).filter((f) => f.endsWith(".service"))) {
    const source = readFileSync(path.join(SYSTEMD_DIR, name), "utf8");
    for (const line of source.split("\n")) {
      const match = /^(?:ReadWritePaths|ReadOnlyPaths)=(.+)$/.exec(line);
      if (!match) continue;
      for (const raw of match[1].trim().split(/\s+/)) {
        const target = raw.startsWith("-") ? raw.slice(1) : raw;
        if (raw.startsWith("-")) continue;               // optional by declaration
        if (provided.some((pattern) => pattern.test(target))) continue;
        if (!created.has(target)) missing.push(`${name}: ${target}`);
      }
    }
  }
  assert.deepEqual(missing, [], `no tmpfiles entry creates these: ${missing.join(", ")}`);
});

// ---------------------------------------------------------------------------
// The runtime directories: owner, group and mode, in one place and three users.
// ---------------------------------------------------------------------------

function tmpfilesEntries() {
  const directory = path.join(REPOSITORY_ROOT, "deploy/tmpfiles.d");
  const entries = new Map();
  for (const file of readdirSync(directory)) {
    for (const line of readFileSync(path.join(directory, file), "utf8").split("\n")) {
      if (!/^[dDf]\s/.test(line)) continue;
      const [, target, mode, owner, group] = line.split(/\s+/);
      entries.set(target, { mode: parseInt(mode, 8), owner, group });
    }
  }
  return entries;
}

test("tmpfiles declares every runtime path with the contract's owner, group and mode", () => {
  // Existence alone is not the property that matters: `.codex` and `.local` hold
  // the agents' credentials, so a directory that is there with the wrong mode is
  // a finding. Three places have to agree, and this is where they are compared.
  const declared = tmpfilesEntries();
  const mismatches = [];
  for (const entry of RUNTIME_SANDBOX_PATHS) {
    const actual = declared.get(entry.path);
    if (!actual) { mismatches.push(`${entry.path}: no tmpfiles entry`); continue; }
    if (actual.mode !== entry.mode) {
      mismatches.push(`${entry.path}: tmpfiles mode 0${actual.mode.toString(8)}, contract 0${entry.mode.toString(8)}`);
    }
    if (actual.owner !== entry.owner) mismatches.push(`${entry.path}: tmpfiles owner ${actual.owner}, contract ${entry.owner}`);
    if (actual.group !== entry.group) mismatches.push(`${entry.path}: tmpfiles group ${actual.group}, contract ${entry.group}`);
  }
  assert.deepEqual(mismatches, [], mismatches.join("; "));
});

test("the installer guards every runtime home path, and creates none of them", () => {
  // Root must not create or chmod anything inside a directory a runtime user can
  // write: `mkdir -p` accepts a symlink that is already there and a following
  // chmod acts on its target. systemd-tmpfiles is the only creator, because it
  // walks the path with symlink protections a shell cannot express. The
  // installer's part is to refuse.
  const installer = readFileSync(path.join(REPOSITORY_ROOT, "deploy/install.sh"), "utf8");
  const list = installer.slice(installer.indexOf("readonly RUNTIME_HOME_PATHS=("));
  const guarded = list.slice(0, list.indexOf(")"));

  const missing = RUNTIME_SANDBOX_PATHS
    .filter((entry) => entry.path.startsWith("/home/"))
    .map((entry) => entry.path)
    .filter((target) => !new RegExp(`^\\s*${target}\\s*$`, "m").test(guarded));
  assert.deepEqual(missing, [], `not guarded by the installer: ${missing.join(", ")}`);

  // And nothing chmods or chowns its way into a home.
  const body = installer.replace(/^\s*#.*$/gm, "");
  for (const pattern of [/chmod[^\n]*\/home\//, /chown[^\n]*\/home\//, /set_owner[^\n]*\/home\//]) {
    assert.doesNotMatch(body, pattern, `the installer still mutates a runtime home: ${pattern}`);
  }
});

test("doctor checks the runtime paths against the contract, not just their existence", () => {
  const source = readFileSync(path.join(REPOSITORY_ROOT, "services/operations/doctor.mjs"), "utf8");
  assert.match(source, /RUNTIME_SANDBOX_PATHS/, "doctor keeps its own copy of the path list");
  const check = source.slice(source.indexOf("async function checkRuntimeSandboxPaths"));
  const body = check.slice(0, check.indexOf("\n}"));
  assert.match(body, /entry\.owner/, "doctor does not check the owner");
  assert.match(body, /entry\.group/, "doctor does not check the group");
  assert.match(body, /entry\.mode/, "doctor does not check the mode");
});

test("a unit that sets a setgid mode holds CAP_FSETID", () => {
  // Linux clears S_ISGID on chmod when the caller lacks CAP_FSETID and the
  // file's group is not one of its own — root included, once a unit runs with a
  // bounding set. The supervisor's `chmod(gateRoot, 0o2771)` therefore landed as
  // 0771 and every scratch directory it created inherited the wrong group, which
  // nothing noticed until doctor started comparing all four mode digits.
  const setgidPaths = RUNTIME_SANDBOX_PATHS.filter((entry) => (entry.mode & 0o2000) !== 0);
  assert.ok(setgidPaths.length > 0, "no setgid path in the contract; this test has nothing to protect");

  const source = readFileSync(path.join(REPOSITORY_ROOT, "services/runtime-supervisor/server.mjs"), "utf8");
  const setsSetgid = /chmod\([^)]*0o2\d{3}\)/.test(source);
  if (!setsSetgid) return;

  const unit = readFileSync(path.join(SYSTEMD_DIR, "infra-cod-runtime-supervisor.service"), "utf8");
  for (const directive of ["CapabilityBoundingSet", "AmbientCapabilities"]) {
    const line = unit.split("\n").find((candidate) => candidate.startsWith(`${directive}=`));
    assert.ok(line, `${directive} is not set`);
    assert.match(line, /CAP_FSETID/,
      `${directive} lacks CAP_FSETID, so the supervisor's setgid chmod is silently dropped`);
  }
});

test("the supervisor's unit delegates its cgroup subtree, because the supervisor makes a cgroup per run", () => {
  // K1 (sprint C): every run is started in a cgroup of its own beneath the
  // unit's, and stopped by killing it — the process group let a tool that
  // called setsid outlive a stop. A cgroup can be made there only if systemd
  // has handed the subtree over, and the supervisor refuses to start otherwise
  // rather than launch a run it could not kill. So the unit that runs the code
  // that creates the leaves has to say `Delegate=yes`, and this is where the
  // two are compared.
  const source = readFileSync(path.join(REPOSITORY_ROOT, "services/runtime-supervisor/server.mjs"), "utf8");
  assert.match(source, /run-cgroup\.mjs/, "the supervisor no longer isolates runs by cgroup; this test has nothing to protect");

  const unit = readFileSync(path.join(SYSTEMD_DIR, "infra-cod-runtime-supervisor.service"), "utf8");
  assert.match(unit, /^Delegate=yes$/m,
    "the supervisor makes run cgroups under its own, and the unit does not delegate the subtree to it");
  // The runs stay inside the unit's cgroup on purpose: a stop of the unit ends
  // them, which the acceptance of every update relies on. `KillMode=process`
  // would leave them, and `ProtectControlGroups` would make the subtree
  // read-only under the sandbox.
  assert.doesNotMatch(unit, /^KillMode=(process|none)$/m, "a stop of the unit would no longer end the runs");
  assert.doesNotMatch(unit, /^ProtectControlGroups=(yes|true|private|strict)$/m,
    "ProtectControlGroups makes the cgroup filesystem read-only, and no leaf can be made");
  assert.doesNotMatch(unit, /^Environment=RUNTIME_RUN_ISOLATION=/m,
    "the process-group fallback is for the gate's container, never for the host");
});

test("every runtime's own state directory is writable under the supervisor's sandbox", () => {
  // `ProtectHome=read-only` plus `ProtectSystem=strict` means a directory the
  // runtime must write is unwritable unless the unit says otherwise, and nothing
  // said so for OpenCode's config directory. The server writes a `.gitignore`
  // there while booting, so it died before it listened, the supervisor waited out
  // its 30-second deadline, and the panel reported "OpenCode account server
  // startup timed out:" with nothing after the colon — the process never wrote to
  // stderr, and the reason lived only in OpenCode's own log.
  //
  // Read from the adapters rather than from a list kept here: a runtime added
  // tomorrow brings its own state directory, and a list would not.
  const unit = readFileSync(
    path.join(SYSTEMD_DIR, "infra-cod-runtime-supervisor.service"),
    "utf8",
  );
  const directives = (name) => unit
    .split("\n")
    .filter((line) => line.startsWith(`${name}=`))
    .map((line) => line.slice(name.length + 1).trim());

  const writable = directives("ReadWritePaths");
  const readOnly = directives("ReadOnlyPaths");
  const covers = (list, target) => list.some((entry) => target === entry || target.startsWith(`${entry}/`));

  for (const name of runtimeNames()) {
    const adapter = adapterFor(name);
    // Every directory the adapter declares, not only the credential store. The
    // first version of this test checked `credentialState` alone and passed
    // while `~/.cache` was still read-only — so the executor exited 1 with
    // "Failed to fetch models.dev ... EROFS", and the supervisor, which discards
    // the runtime's stdout, reported "exited with code 1: " and nothing else.
    for (const directory of adapter.writableState) {
      assert.ok(
        covers(writable, directory),
        `${name} must be able to write ${directory}, which no ReadWritePaths covers: `
        + "the runtime will fail somewhere that does not name this unit",
      );
    }
    assert.ok(
      adapter.writableState.some((directory) => covers([directory], adapter.credentialState))
      || covers(adapter.writableState, adapter.credentialState),
      `${name} declares a credential store ${adapter.credentialState} that its own writableState does not cover`,
    );
    assert.ok(
      covers(writable, adapter.credentialState),
      `${name} keeps its state in ${adapter.credentialState}, which no ReadWritePaths covers: `
      + "the runtime cannot write its own home and will fail somewhere that does not name this unit",
    );
    // A narrower ReadOnlyPaths *inside* that tree is deliberate — OpenCode's
    // `tools` directory holds definitions this product installs and the runtime
    // must not rewrite — but shadowing the whole state directory is the bug
    // above wearing a different directive.
    assert.ok(
      !covers(readOnly, adapter.credentialState),
      `${name}'s state directory ${adapter.credentialState} is itself listed read-only`,
    );
  }
});

test("the run timeout is set the same in both units that read it", () => {
  // The supervisor enforces the cap and the executor worker waits it out. While
  // one was five minutes and the other ten, the mismatch was harmless. Raising
  // the supervisor to an hour made the worker the binding limit, and its failure
  // is the one the whole design exists to prevent: it gave up, retried, and the
  // run it abandoned kept writing — two OpenCode processes in one workspace.
  const read = (unit) => {
    const text = readFileSync(path.join(SYSTEMD_DIR, unit), "utf8");
    const line = text.split("\n").find((entry) => entry.startsWith("Environment=RUNTIME_RUN_TIMEOUT_MS="));
    return line ? line.split("=").at(-1).trim() : null;
  };
  const supervisor = read("infra-cod-runtime-supervisor.service");
  const executor = read("infra-cod-implementation-worker.service");
  assert.ok(supervisor, "the supervisor unit must set RUNTIME_RUN_TIMEOUT_MS");
  assert.ok(executor, "the executor worker unit must set RUNTIME_RUN_TIMEOUT_MS");
  assert.equal(
    supervisor, executor,
    "both units read this variable; different values mean the worker and the supervisor disagree about when a run is over",
  );
});
