// Reconciliation against a prefixed host (WP-A): what is declared is installed,
// what was installed before and is no longer declared is retired — a unit
// stopped and disabled first — and nothing the product never recorded is
// touched.

import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// The modules read the prefix when they load, so it is set first.
const base = mkdtempSync(path.join(os.tmpdir(), "install-reconcile-"));
const prefix = path.join(base, "root");
const bin = path.join(base, "bin");
mkdirSync(bin, { recursive: true });
// A systemctl that logs every call and fails the actions listed in
// $base/systemctl-fails, one "<action> <unit>" per line.
writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh
echo "systemctl $*" >> "${base}/systemctl.log"
if grep -qx "$1 $2" "${base}/systemctl-fails" 2>/dev/null; then echo "Failed to $1 $2: harness refusal" >&2; exit 1; fi
exit 0
`);
chmodSync(path.join(bin, "systemctl"), 0o755);
process.env.INFRA_COD_INSTALL_PREFIX = prefix;
process.env.PATH = `${bin}:${process.env.PATH}`;

const { declareInstall } = await import("../install-declaration.mjs");
const { INSTALL_LEDGER, installDifferences, readLedger, reconcileInstall } = await import("../install-reconcile.mjs");

test.after(() => rmSync(base, { recursive: true, force: true }));

function release(name, { units = [], tools = [], tmpfiles = ["infra-cod-a.conf"] }) {
  const root = path.join(base, name);
  const write = (relative, text) => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  };
  for (const unit of units) write(`deploy/systemd/${unit}`, `[Unit]\nDescription=${unit} ${name}\n`);
  for (const file of tmpfiles) write(`deploy/tmpfiles.d/${file}`, `d /x 0755 root root -\n`);
  write("deploy/caddy/Caddyfile", `# ${name}\n`);
  for (const tool of tools) write(`services/runtime-supervisor/opencode-tools/${tool}`, `// ${tool} ${name}\n`);
  return root;
}

const log = () => (existsSync(path.join(base, "systemctl.log")) ? readFileSync(path.join(base, "systemctl.log"), "utf8") : "");
const at = (...parts) => path.join(prefix, ...parts);
const tools = at("home/opencode-worker/.config/opencode/tools");

test("a release installs its declaration, and the next one retires what it dropped", () => {
  const first = release("first", {
    units: ["infra-cod-web.service", "infra-cod-retired-worker.service"],
    tools: ["complete_task.ts", "retired_tool.ts"],
  });
  const one = reconcileInstall({ declaration: declareInstall(first), releaseRoot: first, previous: readLedger() });
  assert.equal(one.retired.length, 0);
  assert.ok(existsSync(at("etc/systemd/system/infra-cod-retired-worker.service")));
  assert.ok(existsSync(path.join(tools, "retired_tool.ts")));
  assert.equal((lstatSync(path.join(tools, "complete_task.ts")).mode & 0o777), 0o644);
  assert.deepEqual(installDifferences({ declaration: declareInstall(first), releaseRoot: first }), []);

  // Something the product never installed, with a name it would have used.
  writeFileSync(at("etc/systemd/system/infra-cod-operator-own.service"), "[Unit]\n");
  writeFileSync(path.join(tools, "operator_tool.ts"), "// mine\n");

  const second = release("second", { units: ["infra-cod-web.service"], tools: ["complete_task.ts"] });
  const two = reconcileInstall({
    declaration: declareInstall(second),
    releaseRoot: second,
    previous: [...readLedger(), ...declareInstall(first).files],
  });

  assert.deepEqual(two.retired.sort(), ["runtime-tools:opencode/retired_tool.ts", "systemd/infra-cod-retired-worker.service"]);
  assert.ok(!existsSync(at("etc/systemd/system/infra-cod-retired-worker.service")), "the retired unit is still installed");
  assert.ok(!existsSync(path.join(tools, "retired_tool.ts")), "the withdrawn tool definition is still installed");
  const stop = log().indexOf("systemctl stop infra-cod-retired-worker.service");
  const disable = log().indexOf("systemctl disable infra-cod-retired-worker.service");
  assert.ok(stop >= 0 && disable > stop, `the retired unit was not stopped, then disabled:\n${log()}`);

  // Never recorded, never touched.
  assert.ok(existsSync(at("etc/systemd/system/infra-cod-operator-own.service")));
  assert.ok(existsSync(path.join(tools, "operator_tool.ts")));

  assert.match(readFileSync(at("etc/systemd/system/infra-cod-web.service"), "utf8"), /second/);
  assert.deepEqual(readLedger().map((entry) => entry.name).sort(),
    ["Caddyfile", "complete_task.ts", "infra-cod-a.conf", "infra-cod-web.service"]);
  assert.ok(existsSync(INSTALL_LEDGER));
});

test("a symlink planted at a declared name is replaced, not written through", () => {
  const victim = path.join(base, "victim");
  writeFileSync(victim, "untouched\n");
  const link = path.join(tools, "complete_task.ts");
  rmSync(link, { force: true });
  symlinkSync(victim, link);
  const third = release("third", { units: ["infra-cod-web.service"], tools: ["complete_task.ts"] });
  reconcileInstall({ declaration: declareInstall(third), releaseRoot: third, previous: readLedger() });
  assert.equal(readFileSync(victim, "utf8"), "untouched\n");
  assert.ok(!lstatSync(link).isSymbolicLink());
});

test("an install record naming something outside the vocabulary is ignored, not followed", () => {
  const outside = path.join(prefix, "etc/passwd-like");
  writeFileSync(outside, "keep\n");
  const fourth = release("fourth", { units: ["infra-cod-web.service"], tools: ["complete_task.ts"] });
  const warnings = [];
  reconcileInstall({
    declaration: declareInstall(fourth),
    releaseRoot: fourth,
    previous: [{ root: "systemd", name: "../passwd-like" }, { root: "etc", name: "passwd-like" }],
    reporter: { warn: (line) => warnings.push(line) },
  });
  assert.equal(readFileSync(outside, "utf8"), "keep\n");
  assert.equal(warnings.length, 2, warnings.join("\n"));
});

// Retiring a unit fails closed (review of rc.25). A unit that could not be
// stopped keeps running with no file behind it; one that could not be disabled
// leaves a wants-link; and a ledger that forgets either leaves nothing to retry
// from. So: the file stays, the ledger keeps it, and reconcile fails.
function stageRetirement(name) {
  const withUnit = release(`${name}-with`, { units: ["infra-cod-web.service", "infra-cod-stuck.service"], tools: ["complete_task.ts"] });
  reconcileInstall({ declaration: declareInstall(withUnit), releaseRoot: withUnit, previous: readLedger() });
  const without = release(`${name}-without`, { units: ["infra-cod-web.service"], tools: ["complete_task.ts"] });
  return { withUnit, without };
}

function refuseSystemctl(...lines) {
  writeFileSync(path.join(base, "systemctl-fails"), lines.map((line) => `${line}\n`).join(""));
}

const stuckUnit = () => at("etc/systemd/system/infra-cod-stuck.service");
const ledgerNames = () => readLedger().map((entry) => entry.name);

for (const [label, failing, named] of [
  ["stop", ["stop infra-cod-stuck.service"], [/stop/]],
  ["disable", ["disable infra-cod-stuck.service"], [/disable/]],
  ["stop and disable", ["stop infra-cod-stuck.service", "disable infra-cod-stuck.service"], [/stop/, /disable/]],
]) {
  test(`a unit whose ${label} fails is not retired, stays on disk and stays in the ledger`, () => {
    const { withUnit, without } = stageRetirement(label.replaceAll(" ", "-"));
    refuseSystemctl(...failing);
    try {
      assert.throws(
        () => reconcileInstall({ declaration: declareInstall(without), releaseRoot: without, previous: [...readLedger(), ...declareInstall(withUnit).files] }),
        (error) => /infra-cod-stuck\.service/.test(error.message) && named.every((pattern) => pattern.test(error.message)),
      );
      assert.ok(existsSync(stuckUnit()), "the unit file was removed although retirement failed");
      assert.ok(ledgerNames().includes("infra-cod-stuck.service"), "the ledger forgot a unit it could not retire");
    } finally {
      refuseSystemctl();
    }

    // Nothing was forgotten, so the next reconcile retires it.
    const again = reconcileInstall({ declaration: declareInstall(without), releaseRoot: without, previous: readLedger() });
    assert.deepEqual(again.retired, ["systemd/infra-cod-stuck.service"]);
    assert.ok(!existsSync(stuckUnit()));
    assert.ok(!ledgerNames().includes("infra-cod-stuck.service"));
  });
}

test("a runtime-owned directory swapped for a symlink is refused, and nothing lands where it points", () => {
  const configDir = at("home/opencode-worker/.config/opencode");
  const moved = at("home/opencode-worker/.config/opencode-moved");
  const victim = path.join(base, "victim-etc");
  mkdirSync(path.join(victim, "tools"), { recursive: true });
  renameSync(configDir, moved);
  symlinkSync(victim, configDir);
  try {
    const fifth = release("fifth", { units: ["infra-cod-web.service"], tools: ["complete_task.ts"] });
    assert.throws(
      () => reconcileInstall({ declaration: declareInstall(fifth), releaseRoot: fifth, previous: readLedger() }),
      /\.config\/opencode is not a plain directory/,
    );
    assert.deepEqual(readdirSync(path.join(victim, "tools")), [], "a file was written through the planted symlink");
  } finally {
    rmSync(configDir, { force: true });
    renameSync(moved, configDir);
  }
});

// Stage 12 R13: the release's AppArmor profiles are loaded after they are
// installed; a host without AppArmor has nothing to load, and a profile that
// does not load fails the reconcile.
test("declared AppArmor profiles are loaded, and a failure to load is a failure", async () => {
  const { applyApparmor } = await import("../install-reconcile.mjs");
  const declaration = { files: [
    { root: "apparmor", source: "deploy/apparmor/infra-cod-bwrap", name: "infra-cod-bwrap", mode: "0644" },
    { root: "systemd", source: "deploy/systemd/infra-cod-web.service", name: "infra-cod-web.service", mode: "0644" },
  ] };
  const calls = [];
  const loaded = applyApparmor(declaration, { enabled: () => true, parse: (args) => { calls.push(args); return { ok: true, stderr: "" }; } });
  assert.deepEqual(loaded.loaded, ["infra-cod-bwrap"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "-r");
  assert.match(calls[0][1], /\/etc\/apparmor\.d\/infra-cod-bwrap$/);

  assert.deepEqual(applyApparmor(declaration, { enabled: () => false, parse: () => assert.fail("parsed without AppArmor") }).loaded, []);
  assert.throws(() => applyApparmor(declaration, { enabled: () => true, parse: () => ({ ok: false, stderr: "syntax error" }) }), /apparmor_parser -r failed: syntax error/);
});
