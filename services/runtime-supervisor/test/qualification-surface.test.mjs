// The qualification surface's rules (Stage 12 W3b): a candidate runs only an
// executable the inventory names and whose digest still matches, in a scratch
// home whose paths cannot be steered.
import test from "node:test";
import assert from "node:assert/strict";

import { inScratchHome, qualificationExecutable, qualificationPaths, scratchReadOnlyWritable, stateToCopy, writableStateInHome } from "../qualification-surface.mjs";
import { adapterFor } from "../../operations/runtime-adapters.mjs";
import { driverFor } from "../drivers/index.mjs";

const ID = "3f6c1a52-7a0e-4f4e-9d3a-1c2b3d4e5f60";

test("a qualification's paths come from its uuid and nothing else", () => {
  assert.deepEqual(qualificationPaths("/srv/infra-cod/gate-smoke", ID), {
    root: `/srv/infra-cod/gate-smoke/qualification/${ID}`,
    workspace: `/srv/infra-cod/gate-smoke/qualification/${ID}/workspace`,
    home: `/srv/infra-cod/gate-smoke/qualification/${ID}/home`,
  });
  for (const bad of ["../etc", "", null, `${ID}/..`]) assert.throws(() => qualificationPaths("/srv/g", bad), /not a uuid/);
});

test("only a recorded version's executable runs, and only while its digest matches", () => {
  const codex = adapterFor("codex");
  const inventory = { codex: { installed: [
    { version: "0.154.0", directory: "/opt/infra-cod/runtimes/codex/0.154.0", executableSha256: "a".repeat(64), installedAt: "2026-09-01" },
    { version: "0.157.1", directory: "/opt/infra-cod/runtimes/codex/0.157.1", executableSha256: "b".repeat(64), installedAt: "2026-09-29", candidate: true },
  ] } };
  const digests = { "/opt/infra-cod/runtimes/codex/0.157.1/package/vendor/x86_64-unknown-linux-musl/bin/codex": "b".repeat(64) };
  const digestOf = (file) => digests[file] ?? "0".repeat(64);
  assert.equal(qualificationExecutable(codex, "0.157.1", { inventory, digestOf }),
    "/opt/infra-cod/runtimes/codex/0.157.1/package/vendor/x86_64-unknown-linux-musl/bin/codex");
  assert.throws(() => qualificationExecutable(codex, "0.154.0", { inventory, digestOf }), /not the one recorded at install/);
  assert.throws(() => qualificationExecutable(codex, "0.158.0", { inventory, digestOf }), /not installed on this host/);
  assert.throws(() => qualificationExecutable(codex, "latest", { inventory, digestOf }), /not exact/);
});

test("a candidate's own state moves into the scratch home; nothing else does", () => {
  const opencode = adapterFor("opencode");
  const home = `/srv/g/qualification/${ID}/home`;
  assert.equal(inScratchHome(opencode, home, "/home/opencode-worker/.local"), `${home}/.local`);
  assert.equal(inScratchHome(opencode, home, "/tmp"), "/tmp");
  assert.equal(inScratchHome(opencode, home, "/home/opencode-worker-other/x"), "/home/opencode-worker-other/x", "a prefix is not a parent");
  const writable = scratchReadOnlyWritable(driverFor("opencode"), opencode, home);
  assert.ok(writable.every((file) => !file.startsWith("/home/")), `the real home stays read-only: ${writable}`);
  for (const name of ["codex", "opencode", "claude"]) assert.ok(stateToCopy(adapterFor(name)).length > 0, `${name} declares what a candidate needs`);
  assert.throws(() => stateToCopy({ name: "x", qualificationState: ["../../etc/shadow"] }), /not inside the home/);
});

test("the scratch home gets the runtime's writable directories, which a read-only launch cannot create", () => {
  assert.deepEqual(writableStateInHome(adapterFor("opencode")), [".local", ".config/opencode", ".cache"]);
  assert.deepEqual(writableStateInHome(adapterFor("claude")), [".claude", ".claude.json"]);
  assert.deepEqual(writableStateInHome(adapterFor("codex")), [".codex"]);
});
