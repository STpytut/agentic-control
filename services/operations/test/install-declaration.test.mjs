// The install declaration is data from a closed vocabulary (WP-A). These tests
// hold the vocabulary closed: every way a manifest could point the coordinator
// somewhere else is refused by name.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INSTALL_CONTRACT_VERSION,
  MIN_COORDINATOR_VERSION,
  compareVersions,
  declareInstall,
  installDeclarationFor,
  installSectionProblems,
} from "../install-declaration.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");

const unit = (name) => ({ root: "systemd", source: `deploy/systemd/${name}`, name, mode: "0644" });
const section = (files) => ({ contractVersion: 1, minCoordinatorVersion: "0.4.0-rc.25", files });

test("the repository's tree declares every unit, tmpfiles rule, the Caddyfile and the tool definitions", () => {
  const declaration = declareInstall(ROOT);
  assert.equal(declaration.contractVersion, INSTALL_CONTRACT_VERSION);
  assert.equal(declaration.minCoordinatorVersion, MIN_COORDINATOR_VERSION);
  const count = (root) => declaration.files.filter((entry) => entry.root === root).length;
  const units = readdirSync(path.join(ROOT, "deploy/systemd")).filter((name) => /\.(service|timer|target)$/.test(name));
  const tmpfiles = readdirSync(path.join(ROOT, "deploy/tmpfiles.d")).filter((name) => name.endsWith(".conf"));
  const tools = readdirSync(path.join(ROOT, "services/runtime-supervisor/opencode-tools")).filter((name) => name.endsWith(".ts"));
  assert.equal(count("systemd"), units.length, "a shipped unit is not declared, or the vocabulary refuses its name");
  assert.equal(count("tmpfiles"), tmpfiles.length);
  assert.equal(count("caddy"), 1);
  assert.equal(count("runtime-tools"), tools.length);
  assert.ok(tools.length >= 3);
  assert.deepEqual(installSectionProblems(declaration), []);
});

// Sprint C K2: runtime accounts a release adds, made by systemd-sysusers before
// its tmpfiles rules name them. The coordinator knows the root one release
// before any release ships a file under it.
test("a sysusers file is an entry of its own root, and only under its own name", () => {
  const entry = { root: "sysusers", source: "deploy/sysusers.d/infra-cod-runtimes.conf", name: "infra-cod-runtimes.conf", mode: "0644" };
  assert.deepEqual(installSectionProblems(section([entry])), []);
  const foreign = installSectionProblems(section([{ ...entry, source: "deploy/sysusers.d/basic.conf", name: "basic.conf" }]));
  assert.ok(foreign.some((problem) => problem.includes("which the sysusers root does not accept")), foreign.join("; "));
});

// Stage 12 R13: the AppArmor profile that lets bubblewrap, and only it, create
// a user namespace. The coordinator knows the root one release before any
// release ships a file under it.
test("an AppArmor profile is an entry of its own root, and only under this product's names", () => {
  const entry = { root: "apparmor", source: "deploy/apparmor/infra-cod-bwrap", name: "infra-cod-bwrap", mode: "0644" };
  assert.deepEqual(installSectionProblems(section([entry])), []);
  for (const name of ["bwrap", "usr.bin.bwrap", "infra-cod-bwrap/../x"]) {
    const foreign = installSectionProblems(section([{ ...entry, source: `deploy/apparmor/${name}`, name }]));
    assert.ok(foreign.length > 0, `${name} was accepted`);
  }
});

test("an entry outside the vocabulary is refused, naming what is wrong", () => {
  const cases = [
    [{ ...unit("infra-cod-web.service"), root: "etc" }, 'names the root "etc", which is not in the vocabulary'],
    [unit("sshd.service"), 'installs "sshd.service", which the systemd root does not accept'],
    [{ ...unit("infra-cod-web.service"), name: "../../bin/sh" }, "which the systemd root does not accept"],
    [{ ...unit("infra-cod-web.service"), source: "/etc/passwd" }, "a source is a relative path inside the release"],
    [{ ...unit("infra-cod-web.service"), source: "deploy/../../x/infra-cod-web.service" }, "a source is a relative path inside the release"],
    [{ ...unit("infra-cod-web.service"), source: "services/infra-cod-web.service" }, "not from deploy/systemd"],
    [{ ...unit("infra-cod-web.service"), mode: "4755" }, 'has the mode "4755"'],
    [{ ...unit("infra-cod-web.service"), command: "rm -rf /" }, 'has an unknown key "command"'],
    [{ ...unit("infra-cod-web.service"), runtime: "codex" }, "names a runtime for the systemd root"],
    [{ root: "runtime-tools", runtime: "codex", source: "services/runtime-supervisor/opencode-tools/x.ts", name: "x.ts", mode: "0644" },
      'installs tools for "codex", which declares no tool directory'],
    [{ root: "runtime-tools", runtime: "opencode", source: "deploy/x.ts", name: "x.ts", mode: "0644" },
      "not from services/runtime-supervisor/opencode-tools"],
  ];
  for (const [entry, expected] of cases) {
    const problems = installSectionProblems(section([entry]));
    assert.ok(problems.some((problem) => problem.includes(expected)), `${JSON.stringify(entry)}: ${problems.join("; ")}`);
  }
  assert.ok(installSectionProblems(section([unit("infra-cod-web.service"), unit("infra-cod-web.service")]))
    .some((problem) => problem.includes("a second time")));
});

test("a contract or a coordinator this code does not know is refused, not guessed at", () => {
  assert.ok(installSectionProblems({ ...section([unit("infra-cod-web.service")]), contractVersion: 2 })
    .some((problem) => problem.includes("contractVersion 2 is not one this coordinator implements")));
  assert.throws(
    () => installDeclarationFor({ install: { ...section([unit("infra-cod-web.service")]), minCoordinatorVersion: "0.5.0" } }, ROOT,
      { coordinatorVersion: "0.4.0-rc.25" }),
    /needs a coordinator of 0\.5\.0 or later/,
  );
  assert.doesNotThrow(() => installDeclarationFor({ install: section([unit("infra-cod-web.service")]) }, ROOT,
    { coordinatorVersion: "0.4.0-rc.26" }));
});

test("a development build is the code of its own tree, not a coordinator older than every release", () => {
  assert.doesNotThrow(() => installDeclarationFor({ install: { ...section([unit("infra-cod-web.service")]), minCoordinatorVersion: "0.4.0-rc.63" } },
    ROOT, { coordinatorVersion: "0.0.0-dev+1dbba6995317" }));
});

test("a release built before WP-A gets the declaration its tree implies", () => {
  const derived = installDeclarationFor({}, ROOT, { coordinatorVersion: "0.4.0-rc.25" });
  assert.deepEqual(derived, declareInstall(ROOT));
});

test("versions compare by SemVer precedence, release candidates included", () => {
  assert.equal(compareVersions("0.4.0-rc.9", "0.4.0-rc.25"), -1);
  assert.equal(compareVersions("0.4.0-rc.25", "0.4.0"), -1);
  assert.equal(compareVersions("0.4.0", "0.4.0-rc.25"), 1);
  assert.equal(compareVersions("0.4.0-rc.25", "0.4.0-rc.25"), 0);
  assert.equal(compareVersions("0.3.9", "0.4.0-rc.1"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
});
