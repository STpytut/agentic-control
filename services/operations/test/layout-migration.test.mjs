// The layout move (WP-5c) against a prefixed host: the account renamed with its
// home, the compatibility link, the roots moved, the runtimes record updated —
// and every way it can fail leaving the host on the layout it started on.

import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const base = mkdtempSync(path.join(os.tmpdir(), "layout-migration-"));
const prefix = path.join(base, "root");
const bin = path.join(base, "bin");
const state = path.join(base, "state");
for (const directory of [prefix, bin, state]) mkdirSync(directory, { recursive: true });

function stub(name, body) {
  writeFileSync(path.join(bin, name), `#!/bin/sh\nSTATE="${state}"\nPREFIX="${prefix}"\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
}
// getent passwd|group NAME, from two plain files.
stub("getent", `grep -q "^$2:" "$STATE/$1"`);
// usermod -l NEW -d HOME -m OLD: renames the entry and moves the home.
stub("usermod", `[ -f "$STATE/fail-usermod" ] && { echo "usermod: refused (harness)" >&2; exit 1; }
new=$2; home=$4; old=$6
oldhome=$(grep "^$old:" "$STATE/passwd" | cut -d: -f6)
sed -i.bak "s#^$old:\\(.*\\):$oldhome:#$new:\\1:$home:#" "$STATE/passwd"
mv "$PREFIX$oldhome" "$PREFIX$home"`);
stub("groupmod", `[ -f "$STATE/fail-groupmod" ] && { echo "groupmod: refused (harness)" >&2; exit 1; }
sed -i.bak "s#^$3:#$2:#" "$STATE/group"`);
stub("pgrep", `grep -qx "$2" "$STATE/running" 2>/dev/null && { echo 4242; exit 0; }; exit 1`);
stub("systemctl", `cat "$STATE/supervisor" 2>/dev/null || echo inactive`);

process.env.INFRA_COD_INSTALL_PREFIX = prefix;
process.env.PATH = `${bin}:${process.env.PATH}`;

const {
  LAYOUT_JOURNAL, LEGACY_LAYOUT, applyLayout, detectLayout, planLayout, revertLayout,
} = await import("../layout-migration.mjs");
const { adapterFor } = await import("../runtime-adapters.mjs");
const { INSTALLATION_LAYOUT } = await import("../installation-layout.mjs");

test.after(() => rmSync(base, { recursive: true, force: true }));

const at = (absolute) => path.join(prefix, absolute);
const next = { user: adapterFor("codex").user, home: adapterFor("codex").home,
  workspaceRoot: INSTALLATION_LAYOUT.workspaceRoot.path, gateSmokeRoot: INSTALLATION_LAYOUT.gateSmokeRoot.path };

function legacyHost() {
  rmSync(prefix, { recursive: true, force: true });
  for (const file of ["running", "supervisor", "fail-usermod", "fail-groupmod"]) rmSync(path.join(state, file), { force: true });
  mkdirSync(at("/etc/infra-cod"), { recursive: true });
  writeFileSync(path.join(state, "passwd"), `root:x:0:0::/root:/bin/sh\n${LEGACY_LAYOUT.user}:x:993:982::${LEGACY_LAYOUT.home}:/usr/sbin/nologin\n`);
  writeFileSync(path.join(state, "group"), `root:x:0:\n${LEGACY_LAYOUT.user}:x:982:\n`);
  mkdirSync(at(`${LEGACY_LAYOUT.home}/.codex/sessions`), { recursive: true });
  writeFileSync(at(`${LEGACY_LAYOUT.home}/.codex/auth.json`), "{}\n");
  mkdirSync(at(`${LEGACY_LAYOUT.workspaceRoot}/project-1`), { recursive: true });
  writeFileSync(at(`${LEGACY_LAYOUT.workspaceRoot}/project-1/README.md`), "hello\n");
  mkdirSync(at(LEGACY_LAYOUT.gateSmokeRoot), { recursive: true });
  writeFileSync(at("/etc/infra-cod/runtimes.json"), `${JSON.stringify({ schema: "infra-cod/runtimes/1",
    runtimes: { codex: { runtime: "codex", user: LEGACY_LAYOUT.user } } }, null, 2)}\n`);
}

test("a legacy host is recognised, and plan describes the move without making it", () => {
  legacyHost();
  const plan = planLayout();
  assert.equal(plan.layout, "legacy");
  assert.equal(plan.actions.length, 4);
  assert.match(plan.actions[0], /rename the account and group codex-poc to codex-worker/);
  assert.equal(detectLayout().layout, "legacy", "plan changed the host");
  assert.ok(!existsSync(LAYOUT_JOURNAL));
});

test("apply moves the account, its home, the roots and the record, and links the old home", () => {
  legacyHost();
  const result = applyLayout();
  assert.deepEqual(result, { moved: true, layout: "current" });
  assert.match(readFileSync(path.join(state, "passwd"), "utf8"), new RegExp(`^${next.user}:x:993:982::${next.home}:`, "m"));
  assert.match(readFileSync(path.join(state, "group"), "utf8"), new RegExp(`^${next.user}:x:982:`, "m"));
  assert.equal(readFileSync(at(`${next.home}/.codex/auth.json`), "utf8"), "{}\n");
  assert.ok(lstatSync(at(LEGACY_LAYOUT.home)).isSymbolicLink());
  assert.equal(readlinkSync(at(LEGACY_LAYOUT.home)), path.basename(next.home));
  // A path Codex recorded under the old home still reaches the file.
  assert.equal(readFileSync(at(`${LEGACY_LAYOUT.home}/.codex/auth.json`), "utf8"), "{}\n");
  assert.equal(readFileSync(at(`${next.workspaceRoot}/project-1/README.md`), "utf8"), "hello\n");
  assert.ok(existsSync(at(next.gateSmokeRoot)));
  // The old workspace root is a link to the new one: OpenCode's sessions
  // recorded their directory under it.
  assert.ok(lstatSync(at(LEGACY_LAYOUT.workspaceRoot)).isSymbolicLink());
  assert.equal(readFileSync(at(`${LEGACY_LAYOUT.workspaceRoot}/project-1/README.md`), "utf8"), "hello\n");
  assert.equal(JSON.parse(readFileSync(at("/etc/infra-cod/runtimes.json"), "utf8")).runtimes.codex.user, next.user);
  assert.equal(JSON.parse(readFileSync(LAYOUT_JOURNAL, "utf8")).state, "applied");

  // Idempotent: a second apply is a no-op.
  assert.deepEqual(applyLayout(), { moved: false, layout: "current" });
});

test("revert puts every part back", () => {
  legacyHost();
  applyLayout();
  revertLayout();
  assert.equal(detectLayout().layout, "legacy");
  assert.equal(readFileSync(at(`${LEGACY_LAYOUT.workspaceRoot}/project-1/README.md`), "utf8"), "hello\n");
  assert.ok(lstatSync(at(LEGACY_LAYOUT.home)).isDirectory());
  assert.ok(!existsSync(at(next.home)));
  assert.equal(JSON.parse(readFileSync(at("/etc/infra-cod/runtimes.json"), "utf8")).runtimes.codex.user, LEGACY_LAYOUT.user);
  assert.equal(JSON.parse(readFileSync(LAYOUT_JOURNAL, "utf8")).state, "reverted");
});

test("a step that fails half-way is undone with everything before it", () => {
  // usermod succeeds, groupmod does not: the account was renamed and its home
  // moved, and the failing step recorded nothing of its own.
  legacyHost();
  writeFileSync(path.join(state, "fail-groupmod"), "");
  assert.throws(() => applyLayout(), /renaming the group failed/);
  assert.equal(detectLayout().layout, "legacy", "a failed apply left the host moved");
  assert.ok(lstatSync(at(LEGACY_LAYOUT.home)).isDirectory());
  assert.equal(JSON.parse(readFileSync(LAYOUT_JOURNAL, "utf8")).state, "reverted");
});

test("nothing moves while the account runs a process or the supervisor is up", () => {
  legacyHost();
  writeFileSync(path.join(state, "running"), `${LEGACY_LAYOUT.user}\n`);
  assert.throws(() => applyLayout(), /processes are running as codex-poc/);
  assert.equal(detectLayout().layout, "legacy");
  rmSync(path.join(state, "running"));
  writeFileSync(path.join(state, "supervisor"), "active\n");
  assert.throws(() => applyLayout(), /the runtime supervisor is running/);
  assert.equal(detectLayout().layout, "legacy");
  assert.ok(!existsSync(LAYOUT_JOURNAL) || JSON.parse(readFileSync(LAYOUT_JOURNAL, "utf8")).state !== "applying");
});

test("a host on neither layout is refused, not guessed at", () => {
  legacyHost();
  mkdirSync(at(next.workspaceRoot), { recursive: true });
  assert.equal(detectLayout().layout, "mixed");
  assert.throws(() => applyLayout(), /the host is on neither layout/);
  assert.ok(existsSync(at(LEGACY_LAYOUT.workspaceRoot)), "a refused apply moved something");
});

test("an unfinished apply must be reverted before another", () => {
  legacyHost();
  writeFileSync(LAYOUT_JOURNAL, `${JSON.stringify({ schema: "infra-cod/layout-migration/1", state: "applying", steps: [] })}\n`);
  assert.throws(() => applyLayout(), /did not finish; run `revert`/);
});
