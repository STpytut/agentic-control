import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// ADR-0011 decision 3: the provisioner coordinates, the Runtime Supervisor acts.
// The point of the split is that this unit can then run as infra-control rather
// than as the sandboxed agent's own account, so it must hold no capability that
// would tempt it back. Asserted structurally, because a reintroduced chown would
// otherwise only surface as a permission error on a server.

const source = readFileSync(
  path.resolve(import.meta.dirname, "../project-provisioner.mjs"), "utf8");

test("the provisioner imports nothing that can touch the filesystem", () => {
  const imports = [...source.matchAll(/^import .*? from "([^"]+)";$/gm)].map((match) => match[1]);
  const privileged = ["node:fs", "node:fs/promises", "node:child_process", "node:os"];
  for (const module of privileged) {
    assert.ok(!imports.includes(module), `provisioner imports ${module}`);
  }
  // An allowlist, not an exact set. The guarantee is that no privileged module
  // gets in, and pinning the list exactly made removing an import — which is
  // strictly safer — fail the test that exists to keep the provisioner
  // unprivileged.
  const allowed = new Set(["node:url"]);
  const unexpected = imports.filter((name) => name.startsWith("node:") && !allowed.has(name));
  assert.deepEqual(unexpected, [], `provisioner imports ${unexpected.join(", ")}`);
});

test("the provisioner runs no filesystem or git commands", () => {
  const code = source.replace(/^\s*\/\/.*$/gm, "");
  for (const pattern of [
    /execFileSync|execSync|\bspawn\b/,
    /\bmkdir\s*\(|\brm\s*\(|\brmdir\s*\(|writeFile\s*\(/,
    /\/usr\/bin\/(git|chown|chmod)|\brunuser\b/,
  ]) {
    assert.ok(!pattern.test(code), `provisioner still calls ${pattern}`);
  }
});

test("workspace work is requested through the supervisor contract", () => {
  // The two system operation types, and nothing that writes to
  // workspace_operations directly.
  assert.match(source, /request_workspace_provisioning/);
  assert.match(source, /workspace_operation_state/);
  assert.match(source, /provision_workspace/);
  assert.match(source, /inspect_workspace/);
  assert.ok(!/INSERT INTO workspace_operations/i.test(source),
    "the provisioner writes workspace_operations directly instead of using the contract");
});
