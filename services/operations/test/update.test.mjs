// The update state machine, run end to end against a sandboxed host.
//
// Every test here asks the question the plan's gate asks: did the *running code*
// change, and if something failed, is what is running now a release that can
// read the schema that is there now. A status code is never accepted as the
// answer — the assertions read each service's own working directory, the
// migration ledger, the symlink and the receipt.

import test from "node:test";
import assert from "node:assert/strict";
import { createHost, defaultMigrations, harnessPrerequisites } from "./update-harness.mjs";
import { decideCompatibility, longRunningServicesOf } from "../update.mjs";
import { readFileSync } from "node:fs";
import { LONG_RUNNING_SERVICES } from "../unit-contract.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const missing = harnessPrerequisites();
const options = missing.length > 0 ? { skip: `missing: ${missing.join(", ")}` } : {};

const BASE = defaultMigrations(50);
const additive = [...BASE, { name: "0051_additive.sql" }];
const compatible = {
  contract: "infra-cod/schema-compatibility/1",
  unverifiedThrough: "0050",
  unverified: BASE.map((entry) => entry.name.slice(0, 4)),
  backwardIncompatible: [],
};
const incompatible = {
  ...compatible,
  backwardIncompatible: ["0051"],
};


// Which releases the running processes are executing, as a stable, readable set.
// `outside-the-release-tree` is the dispatcher and the reconciler, whose working
// directory is /var/lib/infra-control and therefore names no release.
function releasesRunning(host) {
  return [...new Set(Object.values(host.runningReleases()).map((release) => release ?? "outside-the-release-tree"))].sort();
}

function withHost(body, setup = {}) {
  return async () => {
    const host = createHost(setup).boot();
    try {
      await body(host);
    } finally {
      host.destroy();
    }
  };
}

test("A -> B with no migration replaces the running processes, not just the symlink", options, withHost(async (host) => {
  const before = host.runningReleases();
  // Twelve of the fourteen run from the release tree. The dispatcher and the
  // reconciler run from /var/lib/infra-control, so their cwd is `null` here and
  // the coordinator has to prove them another way.
  assert.deepEqual(releasesRunning(host), ["0.1.0", "outside-the-release-tree"]);
  assert.deepEqual(
    Object.entries(before).filter(([, release]) => release === null).map(([unit]) => unit).sort(),
    ["infra-cod-dispatcher", "infra-cod-reconciler"],
  );
  const beforePids = host.units();

  const artifact = host.artifact({ version: "0.2.0" });
  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 0, result.stderr);

  assert.equal(host.currentTarget(), "0.2.0");
  assert.deepEqual(
    releasesRunning(host),
    ["0.2.0", "outside-the-release-tree"],
    "every service that runs from the release tree must execute the new release",
  );
  for (const [unit, info] of Object.entries(host.units())) {
    assert.notEqual(info.pid, beforePids[unit].pid, `${unit} kept its process across the update`);
  }

  // The previous release is still on disk: a rollback target that was deleted
  // to save disk is not a rollback target.
  assert.deepEqual(host.releaseNames(), ["0.1.0", "0.2.0"]);

  const [receipt] = host.receipts();
  assert.equal(receipt.outcome, "updated");
  assert.equal(receipt.from.version, "0.1.0");
  assert.equal(receipt.to.version, "0.2.0");
  assert.equal(receipt.actor, "harness");
  assert.deepEqual(receipt.schemaBoundary.applied, []);
  assert.equal(host.updateState(), null, "a completed update leaves no interrupted-run record");
}));

test("an update removes releases past the limit, never the live one or its rollback target", options, withHost(async (host) => {
  // rc.121: nothing removed an installed release before, and with the backups
  // they had filled the host's disk.
  const extraEnv = { INFRA_RELEASES_KEEP: "2" };
  for (const version of ["0.2.0", "0.3.0"]) {
    const result = host.cli(host.updateArgs(host.artifact({ version })), { extraEnv });
    assert.equal(result.code, 0, result.stderr);
  }
  assert.equal(host.currentTarget(), "0.3.0");
  assert.deepEqual(host.releaseNames(), ["0.2.0", "0.3.0"]);
}));

// WP-A. The host is reconciled to the staged release's install declaration:
// what the leaving release installed and the new one no longer ships is
// retired — the unit stopped and disabled before its file goes.
const retiredUnit = "etc/systemd/system/infra-cod-retired-worker.service";
const retiredTool = "home/opencode-worker/.config/opencode/tools/retired_tool.ts";

test("an update retires a unit and a tool definition the new release no longer ships", options, withHost(async (host) => {
  host.installCurrent();
  assert.ok(host.installed(retiredUnit) && host.installed(retiredTool), "the first release did not install its extras");

  const result = host.cli(host.updateArgs(host.artifact({ version: "0.2.0" })));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(host.currentTarget(), "0.2.0");

  assert.ok(!host.installed(retiredUnit), "the retired unit is still installed");
  assert.ok(!host.installed(retiredTool), "the withdrawn tool definition is still installed");
  assert.ok(host.installed("home/opencode-worker/.config/opencode/tools/complete_task.ts"), "a declared tool was removed");
  const log = host.state("systemctl.log");
  const stop = log.indexOf("systemctl stop infra-cod-retired-worker.service");
  assert.ok(stop >= 0 && log.indexOf("systemctl disable infra-cod-retired-worker.service") > stop,
    "the retired unit was not stopped and then disabled");
  assert.match(result.stdout + result.stderr, /retired .*infra-cod-retired-worker\.service/);
}, { extra: { units: ["infra-cod-retired-worker.service"], tools: ["retired_tool.ts"] } }));

// rc.43 renamed the orchestrator and implementation workers. The rc.42
// coordinator installed and started the new units, retired the old ones, and
// then waited 120 s for the old ones — its own LONG_RUNNING_SERVICES — to come
// back, and failed an update that had worked. Which services must be up after
// the switch is the target release's to say.
test("an update that renames a long-running unit waits for the new name, not the old", options, withHost(async (host) => {
  host.installCurrent();
  // The new release's target wants the renamed unit in place of the old one.
  host.setState("target-units", `${LONG_RUNNING_SERVICES
    .map((unit) => unit === "infra-cod-orchestrator-worker" ? "infra-cod-renamed-worker" : unit).join("\n")}\n`);

  const result = host.cli(host.updateArgs(host.artifact({
    version: "0.2.0",
    extra: { renameUnits: { "infra-cod-orchestrator-worker.service": "infra-cod-renamed-worker.service" } },
  })));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(host.currentTarget(), "0.2.0");
  assert.ok(!host.installed("etc/systemd/system/infra-cod-orchestrator-worker.service"), "the old unit was not retired");
  assert.equal(host.units()["infra-cod-renamed-worker"]?.status, "active");
  assert.equal(host.runningReleases()["infra-cod-renamed-worker"], "0.2.0");
}));

test("the long-running services a release declares are the unit contract's", () => {
  const target = readFileSync(path.join(REPOSITORY_ROOT, "deploy/systemd/infra-cod.target"), "utf8");
  assert.deepEqual(longRunningServicesOf(target), [...LONG_RUNNING_SERVICES].sort());
});

test("a unit that cannot be stopped fails the update, which rolls back and keeps the unit and its record", options, withHost(async (host) => {
  host.installCurrent();
  host.setState("systemctl-fails", "stop infra-cod-retired-worker.service\n");

  const result = host.cli(host.updateArgs(host.artifact({ version: "0.2.0" })));
  assert.notEqual(result.code, 0, "an update that could not retire a unit reported success");
  assert.match(result.stderr, /could not retire infra-cod-retired-worker\.service \(stop failed/);
  assert.equal(host.currentTarget(), "0.1.0", "the failed update did not roll back");

  // Asserted on the host, not on the output: the file and the record survive.
  assert.ok(host.installed(retiredUnit), "the unit file was removed although it could not be stopped");
  const ledger = JSON.parse(host.readPrefixed("etc/infra-cod/install-ledger.json"));
  assert.ok(ledger.files.some((entry) => entry.name === "infra-cod-retired-worker.service"), "the ledger forgot the unit");

  // Once it can be stopped, the next update retires it.
  host.setState("systemctl-fails", "");
  const again = host.cli(host.updateArgs(host.artifact({ version: "0.3.0" })));
  assert.equal(again.code, 0, again.stderr);
  assert.ok(!host.installed(retiredUnit));
}, { extra: { units: ["infra-cod-retired-worker.service"], tools: ["retired_tool.ts"] } }));

test("a rollback retires what the failed release added", options, withHost(async (host) => {
  host.installCurrent();
  const artifact = host.artifact({ version: "0.2.0", extra: { units: ["infra-cod-retired-worker.service"], tools: ["retired_tool.ts"] } });
  assert.equal(host.cli(host.updateArgs(artifact)).code, 0);
  assert.ok(host.installed(retiredUnit), "the new release did not install its unit");

  const result = host.cli(["rollback", "--to", "0.1.0", "--yes"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(host.currentTarget(), "0.1.0");
  assert.ok(!host.installed(retiredUnit), "the rolled-back release's unit survived the rollback");
  assert.ok(!host.installed(retiredTool), "the rolled-back release's tool survived the rollback");
}));

test("a release that needs a newer coordinator is refused before anything is staged", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0", install: { contractVersion: 1, minCoordinatorVersion: "9.0.0", files: [
    { root: "caddy", source: "deploy/caddy/Caddyfile", name: "Caddyfile", mode: "0644" },
  ] } });
  const result = host.cli(host.updateArgs(artifact));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /needs a coordinator of 9\.0\.0 or later/);
  assert.equal(host.currentTarget(), "0.1.0");
  assert.deepEqual(host.releaseNames(), ["0.1.0"], "a refused release was staged");
}));

test("an additive migration is applied and leaves the previous release able to read the schema", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0", migrations: additive, compatibility: compatible });
  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 0, result.stderr);

  assert.match(host.state("ledger"), /0051/);
  const [receipt] = host.receipts();
  assert.deepEqual(receipt.schemaBoundary.applied, ["0051_additive.sql"]);
  assert.equal(receipt.schemaBoundary.applicationRollbackSafe, true);

  // And the rollback it advertises actually works.
  const rollback = host.cli(["rollback", "--to", "0.1.0", "--yes"]);
  assert.equal(rollback.code, 0, rollback.stderr);
  assert.equal(host.currentTarget(), "0.1.0");
  assert.deepEqual(releasesRunning(host), ["0.1.0", "outside-the-release-tree"]);
}));

test("an incompatible migration stops the target first and disables application-only rollback", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0", migrations: additive, compatibility: incompatible });
  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 0, result.stderr);

  const systemctlLog = host.state("systemctl.log");
  const stopIndex = systemctlLog.indexOf("systemctl stop infra-cod.target");
  const restartIndex = systemctlLog.indexOf("systemctl restart infra-cod.target");
  assert.ok(stopIndex >= 0, "the target must be stopped before a migration the running release cannot read");
  assert.ok(stopIndex < restartIndex, "the stop must come before the restart");

  const [receipt] = host.receipts();
  assert.equal(receipt.schemaBoundary.applicationRollbackSafe, false);

  // And the rollback refuses rather than pointing old code at the new schema.
  const rollback = host.cli(["rollback", "--to", "0.1.0", "--yes"]);
  assert.equal(rollback.code, 1);
  assert.match(rollback.stderr, /Restore the pre-update backup/);
  assert.equal(host.currentTarget(), "0.2.0", "a refused rollback must change nothing");
}));

test("a health failure after the switch restarts the previous release, and says so", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  // The new release's panel is the one that does not answer. The old one is
  // fine, which is what makes this a rollback rather than an outage.
  host.setState("web-down", "0.2.0");

  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 1);

  assert.equal(host.currentTarget(), "0.1.0", "current must be back on the release that works");
  assert.deepEqual(
    releasesRunning(host),
    ["0.1.0", "outside-the-release-tree"],
    "the previous release must be running again, not merely pointed at",
  );
  const [receipt] = host.receipts();
  assert.equal(receipt.outcome, "rolled_back");
  assert.match(receipt.error, /did not verify/);
}));

// rc.127: the processes and /login were healthy while every chat with a review
// failed on "permission denied". The panel's self-test fails the update.
test("a panel whose pages fail their self-test is rolled back", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  host.setState("selftest-fails", "0.2.0");

  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 1);
  assert.equal(host.currentTarget(), "0.1.0", "current must be back on the release whose pages load");
  const [receipt] = host.receipts();
  assert.equal(receipt.outcome, "rolled_back");
  assert.match(receipt.error, /self-test failed/);
}));

test("a failed update with an incompatible schema refuses to call a symlink move a rollback", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0", migrations: additive, compatibility: incompatible });
  host.setState("web-down", "0.2.0");

  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 1);

  const [receipt] = host.receipts();
  assert.equal(receipt.outcome, "database_restore_required");
  assert.equal(receipt.rollback.performed, false);
  assert.match(host.state("ledger"), /0051/, "the migration that was applied is still applied");
}));

test("a failing migration leaves the live release serving", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0", migrations: additive, compatibility: compatible });
  host.setState("migrations-fail", "");

  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 1);
  assert.equal(host.currentTarget(), "0.1.0");
  assert.deepEqual(releasesRunning(host), ["0.1.0", "outside-the-release-tree"]);
  const [receipt] = host.receipts();
  assert.match(receipt.error, /migrations failed/);
}));

test("an artifact that fails verification changes nothing at all", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  host.setState("units-before", JSON.stringify(host.units()));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${artifact.artifact}.rejected`, "");

  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /failed verification/);
  assert.deepEqual(host.releaseNames(), ["0.1.0"], "nothing may be staged from an unverified artifact");
  assert.equal(host.receipts().length, 0);
}));

test("in-flight work blocks the update until the operator says to interrupt it", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  host.setState("in-flight", "3\n");

  const blocked = host.cli(host.updateArgs(artifact, ["--drain-timeout", "1"]));
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /--interrupt-active/);
  assert.equal(host.currentTarget(), "0.1.0");
  // An aborted drain must leave the dispatcher handing out work again.
  const log = host.state("systemctl.log");
  assert.ok(log.includes("systemctl start infra-cod-dispatcher.service"), "the dispatcher must be restarted after an aborted drain");

  const forced = host.cli(host.updateArgs(artifact, ["--drain-timeout", "1", "--interrupt-active"]));
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(host.currentTarget(), "0.2.0");
}));

test("a second update refuses while one holds the host lock", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  const { spawnSync } = await import("node:child_process");
  // Take the lock the way the installer does, from outside this process.
  const holder = spawnSync("sh", ["-c",
    `${host.binDir}/flock ${host.prefix}/run/lock/infra-cod-install.lock sh -c '${process.execPath} ${host.currentRelease()}/services/cli/infra-cod.mjs releases list >/dev/null'`,
  ], { env: host.env, encoding: "utf8" });
  assert.equal(holder.status, 0);

  // While held, an update must refuse rather than proceed alongside it.
  const lockDirectory = `${host.prefix}/run/lock/infra-cod-install.lock.d`;
  const { mkdirSync, rmSync } = await import("node:fs");
  mkdirSync(lockDirectory, { recursive: true });
  try {
    const result = host.cli(host.updateArgs(artifact));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /holds .*infra-cod-install\.lock/);
  } finally {
    rmSync(lockDirectory, { recursive: true, force: true });
  }
}));

test("the compatibility decision fails closed on silence", () => {
  const pending = [{ name: "0051_x.sql", version: "0051" }];
  const contract = {
    known: true,
    unverifiedThrough: "0050",
    unverified: new Set(["0050"]),
    backwardIncompatible: new Set(),
  };

  assert.equal(decideCompatibility({ contract, pending }).applicationRollbackSafe, true);
  assert.equal(
    decideCompatibility({ contract, pending: [{ name: "0050_old.sql", version: "0050" }] }).applicationRollbackSafe,
    false,
    "a migration that predates the contract is unknown, and unknown is not compatible",
  );
  assert.equal(
    decideCompatibility({ contract: { known: false, reason: "no contract" }, pending }).applicationRollbackSafe,
    false,
    "a release that carries no contract cannot authorise an application-only rollback",
  );
  assert.equal(decideCompatibility({ contract, pending: [] }).applicationRollbackSafe, true);
});

// ---------------------------------------------------------------------------
// Fault injection and power loss
//
// Every durable phase is killed at, and the same two questions are asked each
// time: is the host still serving a release that can read the schema that is
// there, and can the run be finished afterwards. `--resume` reuses the staged
// tree; a plain re-run must refuse rather than start a second update over an
// interrupted one.
// ---------------------------------------------------------------------------

const DURABLE_PHASES = [
  "staged", "decided", "stopped", "migrated",
  // The three mutations inside the switch, separately: units installed, symlink
  // moved, target restarted.
  "units_installed", "symlink_switched", "switched",
  "verified_live",
];

for (const phase of DURABLE_PHASES) {
  test(`a power loss after ${phase} leaves a host that can say where it stopped, and can be resumed`, options, withHost(async (host) => {
    const artifact = host.artifact({ version: "0.2.0", migrations: additive, compatibility: incompatible });

    const killed = host.cli(host.updateArgs(artifact), { extraEnv: { INFRA_COD_UPDATE_FAULT_KILL: phase } });
    assert.notEqual(killed.code, 0, "a killed update must not report success");

    const state = host.updateState();
    assert.ok(state, `a crash after ${phase} must leave a record of where it stopped`);
    assert.equal(state.phase, phase);
    assert.equal(state.to.version, "0.2.0");

    // A plain re-run refuses: finishing an interrupted update is a decision, not
    // something a second run should make on its own.
    const refused = host.cli(host.updateArgs(artifact));
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /--resume/);

    const resumed = host.cli(host.updateArgs(artifact, ["--resume"]));
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(host.currentTarget(), "0.2.0");
    assert.deepEqual(releasesRunning(host), ["0.2.0", "outside-the-release-tree"]);
    assert.equal(host.updateState(), null);

    // The staged tree was reused rather than staged again: a resume that
    // re-extracted would leave 0.2.0 and 0.2.0.r2 behind.
    assert.deepEqual(host.releaseNames(), ["0.1.0", "0.2.0"]);

    const receipt = host.receipts().at(-1);
    assert.equal(receipt.outcome, "updated");
    assert.equal(receipt.resumedFrom, phase);

    // The receipt has to describe the update that happened, not the state of the
    // host when the resume ran. A resumed run re-reads the ledger after its
    // migration has landed, so every one of these fields was wrong: it claimed
    // 0051 -> 0051, applied nothing, and that a rollback to 0.1.0 was safe — for
    // an update that applied an incompatible 0051 over 0050.
    assert.equal(receipt.schemaBoundary.from, "0050", "the receipt must name the boundary the update started from");
    assert.equal(receipt.schemaBoundary.to, "0051");
    assert.deepEqual(receipt.schemaBoundary.applied, ["0051_additive.sql"]);
    assert.equal(
      receipt.schemaBoundary.applicationRollbackSafe,
      false,
      "an incompatible migration must not leave a receipt that authorises an application-only rollback",
    );
    assert.deepEqual(receipt.schemaBoundary.beyondRollbackTarget, ["0051_additive.sql"]);
  }));
}

test("a resume whose staged tree was damaged starts over from the artifact instead of trusting it", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  const killed = host.cli(host.updateArgs(artifact), { extraEnv: { INFRA_COD_UPDATE_FAULT_KILL: "staged" } });
  assert.notEqual(killed.code, 0);

  const { writeFileSync } = await import("node:fs");
  const staged = host.updateState().stagedDirectory;
  writeFileSync(`${staged}/manifest.json`, JSON.stringify({ schema: "infra-cod/release-manifest/1", version: "0.2.0", tampered: true }));

  const resumed = host.cli(host.updateArgs(artifact, ["--resume"]));
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.match(resumed.stdout + resumed.stderr, /does not match its own checksums/);
  // Started over, so the damaged tree was left where it was and the verified one
  // went beside it.
  assert.deepEqual(host.releaseNames(), ["0.1.0", "0.2.0", "0.2.0.r2"]);
  assert.equal(host.currentTarget(), "0.2.0.r2");
}));

test("--abandon discards the record without touching the host", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  host.cli(host.updateArgs(artifact), { extraEnv: { INFRA_COD_UPDATE_FAULT_KILL: "staged" } });
  assert.ok(host.updateState());

  const abandoned = host.cli(["update", "--abandon"]);
  assert.equal(abandoned.code, 0);
  assert.equal(host.updateState(), null);
  assert.equal(host.currentTarget(), "0.1.0");
}));

// ---------------------------------------------------------------------------
// Review findings
//
// One test per finding from the review of this branch, each failing against the
// code as it was written.
// ---------------------------------------------------------------------------

test("the services that do not run from the release tree are proven by re-exec, not called unknown", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  const before = host.units();

  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 0, result.stderr);

  // The dispatcher and the reconciler run from /var/lib/infra-control, so their
  // cwd can never name a release. The update must still pass, and it must pass
  // for the right reason: they re-exec'd after the switch.
  const receipt = host.receipts().at(-1);
  const byUnit = Object.fromEntries(receipt.processes.map((entry) => [entry.unit, entry]));
  for (const unit of ["infra-cod-dispatcher", "infra-cod-reconciler"]) {
    assert.equal(byUnit[unit].evidence, "re-exec after the switch", `${unit} must be proven by its restart`);
    assert.ok(host.units()[unit].startedMonotonic > before[unit].startedMonotonic);
  }
  assert.equal(byUnit["infra-cod-web"].evidence, "cwd");
  assert.equal(byUnit["infra-cod-web"].release, "0.2.0");
}));

test("a service that never re-execs fails the update even though the symlink moved", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  // A reconciler that survives the restart is exactly the failure `restart`
  // exists to prevent, and its cwd cannot reveal it.
  host.setState("restart-immune", "infra-cod-reconciler\n");

  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 1);
  assert.match(result.stderr + result.stdout, /did not re-exec after the switch: infra-cod-reconciler/);
  assert.equal(host.currentTarget(), "0.1.0", "the previous release must be restored");
}));

test("a resume after the migration landed still refuses to start the old release on the new schema", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0", migrations: additive, compatibility: incompatible });

  // Killed after the incompatible migration was applied.
  const killed = host.cli(host.updateArgs(artifact), { extraEnv: { INFRA_COD_UPDATE_FAULT_KILL: "migrated" } });
  assert.notEqual(killed.code, 0);
  assert.match(host.state("ledger"), /0051/, "the incompatible migration is applied");

  // The resumed run fails its health gate. Nothing pending now means nothing to
  // migrate — it must not mean the old release can read the schema.
  host.setState("web-down", "0.2.0");
  const resumed = host.cli(host.updateArgs(artifact, ["--resume"]));
  assert.equal(resumed.code, 1);

  const receipt = host.receipts().at(-1);
  assert.equal(receipt.outcome, "database_restore_required");
  assert.equal(receipt.rollback.performed, false);
  assert.equal(host.currentTarget(), "0.2.0", "0.1.0 must not be started against a schema it cannot read");
  assert.deepEqual(receipt.schemaBoundary.beyondRollbackTarget, ["0051_additive.sql"]);
}));

test("a migration that failed before applying anything rolls back instead of demanding a restore", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0", migrations: additive, compatibility: incompatible });
  host.setState("migrations-fail", "");

  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 1);

  // The ledger never moved, so the previous release can read the schema and the
  // rollback is a rollback — not a database restore.
  assert.doesNotMatch(host.state("ledger"), /0051/);
  const receipt = host.receipts().at(-1);
  assert.equal(receipt.outcome, "rolled_back");
  assert.deepEqual(receipt.schemaBoundary.beyondRollbackTarget, []);
  assert.equal(host.currentTarget(), "0.1.0");
  assert.deepEqual(releasesRunning(host), ["0.1.0", "outside-the-release-tree"]);
}));

test("a database that cannot be read fails closed rather than authorising a rollback", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0", migrations: additive, compatibility: compatible });
  host.setState("web-down", "0.2.0");

  const result = host.cli(host.updateArgs(artifact), { extraEnv: { INFRA_COD_HARNESS_PSQL_FAILS_AFTER: "switched" } });
  assert.equal(result.code, 1);
  const receipt = host.receipts().at(-1);
  assert.equal(receipt.outcome, "database_restore_required");
  assert.match(receipt.rollback.detail, /schema/);
}));

test("the health snapshot is run after the switch, not remembered from before it", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  host.setState("failing-units", "infra-cod-health\n");

  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 1);
  assert.match(result.stderr + result.stdout, /health snapshot failed after the switch/);
  assert.equal(host.currentTarget(), "0.1.0");

  // And when it passes, the update passes — the point being that the verdict
  // comes from a run this update triggered. A stale failure from the outage a
  // rollback just repaired called a healthy host unhealthy on the first real
  // host.
  host.setState("failing-units", "");
  const recovered = host.cli(host.updateArgs(artifact));
  assert.equal(recovered.code, 0, recovered.stderr);
  const log = host.state("systemctl.log");
  assert.ok(log.includes("systemctl start infra-cod-health.service"), "the health snapshot must be started, not inspected");
}));

test("an authenticated surface that stops refusing anonymous callers fails the update", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  // The panel answers /login and serves /projects to anybody: an authorization
  // regression that /login alone cannot see.
  host.setState("auth-open", "");

  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 1);
  assert.match(result.stderr + result.stdout, /authenticated surface no longer/);
  assert.equal(host.currentTarget(), "0.1.0");
}));

test("an interrupted rollback is finished by rolling back again, not by resuming an update", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  assert.equal(host.cli(host.updateArgs(artifact)).code, 0);

  const killed = host.cli(["rollback", "--to", "0.1.0", "--yes"], { extraEnv: { INFRA_COD_UPDATE_FAULT_KILL: "rollback_switched" } });
  assert.notEqual(killed.code, 0);
  assert.equal(host.updateState().action, "rollback");

  const refused = host.cli(host.updateArgs(artifact, ["--resume"]));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /was a rollback/);

  // The symlink already points at 0.1.0, but nothing is running it. Re-running
  // the rollback finishes the job rather than refusing because `current` looks
  // right.
  const again = host.cli(["rollback", "--to", "0.1.0", "--yes"]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(host.currentTarget(), "0.1.0");
  assert.deepEqual(releasesRunning(host), ["0.1.0", "outside-the-release-tree"]);
  assert.equal(host.updateState(), null);

  // And a third run, with nothing left to do, changes nothing.
  const settled = host.cli(["rollback", "--to", "0.1.0", "--yes"]);
  assert.equal(settled.code, 0, settled.stderr);
  assert.match(settled.stdout, /already current and running/);
}));

test("the pre-update snapshot records the unit contract and the process identities it verified against", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  assert.equal(host.cli(host.updateArgs(artifact)).code, 0);

  const receipt = host.receipts().at(-1);
  assert.ok(receipt.unitContract.longRunning.includes("infra-cod-dispatcher"));
  assert.ok(receipt.unitContract.oneshots.includes("infra-cod-backup"));
  assert.ok(receipt.unitContract.timers.includes("infra-cod-health"));
  assert.equal(receipt.processes.length, receipt.unitContract.longRunning.length);
}));

test("a successful update's receipt agrees with what rollback will actually allow", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0", migrations: additive, compatibility: incompatible });

  // Interrupted after the migration, then resumed to success: the path where the
  // receipt and the command used to disagree.
  host.cli(host.updateArgs(artifact), { extraEnv: { INFRA_COD_UPDATE_FAULT_KILL: "migrated" } });
  const resumed = host.cli(host.updateArgs(artifact, ["--resume"]));
  assert.equal(resumed.code, 0, resumed.stderr);

  const receipt = host.receipts().at(-1);
  assert.equal(receipt.schemaBoundary.applicationRollbackSafe, false);

  // The command's answer and the receipt's claim are the same answer.
  const rollback = host.cli(["rollback", "--to", "0.1.0", "--yes"]);
  assert.equal(rollback.code, 1);
  assert.match(rollback.stderr, /Restore the pre-update backup/);
  assert.equal(host.currentTarget(), "0.2.0");
}));

test("an additive update's receipt records the boundary it crossed and permits the rollback", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0", migrations: additive, compatibility: compatible });
  assert.equal(host.cli(host.updateArgs(artifact)).code, 0);

  const receipt = host.receipts().at(-1);
  assert.equal(receipt.schemaBoundary.from, "0050");
  assert.equal(receipt.schemaBoundary.to, "0051");
  assert.deepEqual(receipt.schemaBoundary.applied, ["0051_additive.sql"]);
  assert.equal(receipt.schemaBoundary.applicationRollbackSafe, true);
  assert.equal(host.cli(["rollback", "--to", "0.1.0", "--yes"]).code, 0);
}));

test("a service that is still mid-restart is waited for, not called a failure", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  // What the first real host did: `systemctl restart` on the target returned
  // while two workers were still restarting, systemd still named their previous
  // MainPID, and reading /proc for a process that no longer existed produced
  // "could not be shown to run this release" — for services that were running
  // the new release a second later. A correct update reported itself as failed
  // and rolled back.
  host.setState("restart-slow", "infra-cod-github-app-worker\ninfra-cod-project-deprovision-worker\n");

  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(host.currentTarget(), "0.2.0");
  assert.deepEqual(releasesRunning(host), ["0.2.0", "outside-the-release-tree"]);

  const receipt = host.receipts().at(-1);
  assert.equal(receipt.outcome, "updated");
  const byUnit = Object.fromEntries(receipt.processes.map((entry) => [entry.unit, entry]));
  assert.equal(byUnit["infra-cod-github-app-worker"].release, "0.2.0");
}));

test("an update refuses to start while a package operation holds dpkg's lock", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });

  // What happened on the first real host: unattended-upgrades woke up mid-update,
  // upgraded packages, restarted PostgreSQL and restarted sshd — killing the
  // session the update was running in.
  //
  // The lock is taken here the way apt takes it, with fcntl. The first version of
  // this guard asked `flock(1)`, which takes a BSD lock that does not exclude
  // apt's at all, so it would have reported this host as quiet.
  const release = host.holdPackageLock();
  try {
    const blocked = host.cli(host.updateArgs(artifact));
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /package operation holds/);
    assert.match(blocked.stderr, /unattended-upgr/, "the message must name who is holding it");
    assert.deepEqual(host.releaseNames(), ["0.1.0"], "nothing may be staged while apt works");
  } finally {
    release();
  }

  const quiet = host.cli(host.updateArgs(artifact));
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(host.currentTarget(), "0.2.0");
}));

test("an update refuses while a periodic apt job is running — and not merely because Ubuntu is Ubuntu", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  host.setState("apt-running", "");

  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /apt-daily-upgrade\.service is active/);

  // `unattended-upgrades.service` is "Unattended Upgrades Shutdown": it waits for
  // a shutdown signal and is `active (running)` for the life of the machine. It
  // was on the refusal list, and it refused an update on the first stock Ubuntu
  // host it met — a check that is always closed is an outage, not a safeguard.
  host.setState("apt-running", "");
  host.setState("apt-shutdown-helper-running", "");
  const { rmSync } = await import("node:fs");
  rmSync(`${host.stateDir}/apt-running`);
  const quiet = host.cli(host.updateArgs(artifact));
  assert.equal(quiet.code, 0, quiet.stderr);
}));

test("the package lock is held for the whole run, including a resumed one", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });

  // A guard that checks once and lets go says nothing about the minutes that
  // follow, and those minutes are what unattended-upgrades started in. While the
  // update runs, apt must not be able to take the lock.
  const killed = host.cli(host.updateArgs(artifact), { extraEnv: { INFRA_COD_UPDATE_FAULT_KILL: "staged" } });
  assert.notEqual(killed.code, 0);

  // A resumed run takes it too: the resume path used to skip the guard entirely.
  const release = host.holdPackageLock();
  try {
    const blocked = host.cli(host.updateArgs(artifact, ["--resume"]));
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /package operation holds/);
  } finally {
    release();
  }

  const resumed = host.cli(host.updateArgs(artifact, ["--resume"]));
  assert.equal(resumed.code, 0, resumed.stderr);
}));

test("a rollback refuses while a package operation is running, too", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  assert.equal(host.cli(host.updateArgs(artifact)).code, 0);

  const release = host.holdPackageLock();
  try {
    const blocked = host.cli(["rollback", "--to", "0.1.0", "--yes"]);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /package operation holds/);
    assert.equal(host.currentTarget(), "0.2.0", "a refused rollback changes nothing");
  } finally {
    release();
  }
}));

test("a service that is still mid-restart is waited for, not called a failure", options, withHost(async (host) => {
  const artifact = host.artifact({ version: "0.2.0" });
  // What the first real host did: `systemctl restart` on the target returned
  // while two workers were still restarting, systemd still named their previous
  // MainPID, and reading /proc for a process that no longer existed produced
  // "could not be shown to run this release" — for services that were running
  // the new release a second later. A correct update reported itself as failed
  // and rolled back.
  host.setState("restart-slow", "infra-cod-github-app-worker\ninfra-cod-project-deprovision-worker\n");

  const result = host.cli(host.updateArgs(artifact));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(host.currentTarget(), "0.2.0");
  assert.deepEqual(releasesRunning(host), ["0.2.0", "outside-the-release-tree"]);

  const receipt = host.receipts().at(-1);
  assert.equal(receipt.outcome, "updated");
  const byUnit = Object.fromEntries(receipt.processes.map((entry) => [entry.unit, entry]));
  assert.equal(byUnit["infra-cod-github-app-worker"].release, "0.2.0");
}));

