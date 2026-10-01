// The main guard, through the symlink an installed host actually uses.
//
// Nine services exited 0 without doing anything on every installed host because
// `process.argv[1] === fileURLToPath(import.meta.url)` compares the path as
// written against the path Node resolved, and /opt/infra-cod/current is a
// symlink. A `Type=simple` unit that exits 0 is `inactive (success)`, which
// `Restart=on-failure` leaves alone — so the failure looked like a service that
// had finished its work.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTROL_PLANE = path.resolve(HERE, "..");

function sandbox(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), "infra-cod-entry-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  // `releases/<version>/` with a `current` symlink pointing at it: the layout
  // the installer produces and every unit is started through.
  const release = path.join(base, "releases", "0.0.0-test");
  mkdirSync(release, { recursive: true });
  // The real helper, not a copy of it.
  symlinkSync(path.join(CONTROL_PLANE, "entrypoint.mjs"), path.join(release, "entrypoint.mjs"));

  writeFileSync(path.join(release, "worker.mjs"), `
import { isMain } from "./entrypoint.mjs";
export const loaded = true;
if (isMain(import.meta.url)) {
  process.stdout.write("worker ran\\n");
}
`);
  const current = path.join(base, "current");
  symlinkSync(release, current);
  return { base, release, current };
}

function run(file) {
  return spawnSync(process.execPath, [file], { encoding: "utf8" });
}

test("a module started directly is main", (t) => {
  const { release } = sandbox(t);
  const result = run(path.join(release, "worker.mjs"));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /worker ran/);
});

test("a module started through the current symlink is main", (t) => {
  const { current } = sandbox(t);
  const result = run(path.join(current, "worker.mjs"));
  assert.equal(result.status, 0, result.stderr);
  // This is the assertion the nine services failed: exit 0 with no output was
  // indistinguishable from success.
  assert.match(result.stdout, /worker ran/, "the worker exited without running main");
});

test("a module that is imported is not main", (t) => {
  const { current } = sandbox(t);
  const importer = path.join(path.dirname(current), "importer.mjs");
  writeFileSync(importer, `
import { loaded } from "${path.join(current, "worker.mjs")}";
process.stdout.write(loaded ? "imported\\n" : "not loaded\\n");
`);
  const result = run(importer);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /imported/);
  assert.doesNotMatch(result.stdout, /worker ran/, "importing the module ran its main");
});

test("every control-plane entrypoint uses the shared guard", () => {
  // A new worker that spells the comparison itself is a worker that will not
  // start on an installed host, and nothing else in this suite would notice.
  const offenders = [];
  for (const name of readdirSync(CONTROL_PLANE)) {
    if (!name.endsWith(".mjs")) continue;
    // The helper's own comment quotes the broken spelling, which is the point.
    if (name === "entrypoint.mjs") continue;
    const source = readFileSync(path.join(CONTROL_PLANE, name), "utf8");
    if (/process\.argv\[1\]\s*===\s*fileURLToPath/.test(source)) offenders.push(name);
    if (/path\.resolve\(process\.argv\[1\]\)\s*===/.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `these compare paths without resolving symlinks: ${offenders.join(", ")}`);
});
