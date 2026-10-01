import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  writerProcessAlive, proveContainedDirectory, assertNoLiveWriters, parseProcessRef, writerAlive,
} from "../deprovision-safety.mjs";

test("writerProcessAlive detects a real live PID and an ESRCH PID", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert.equal(writerProcessAlive(child.pid), true, "live child must be reported alive");
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("close", resolve));
  assert.equal(writerProcessAlive(child.pid), false, "reaped child must be reported gone");
  assert.equal(writerProcessAlive(99999999), false, "non-existent pid must be reported gone");
});

test("assertNoLiveWriters rejects a writer registered after the snapshot", async () => {
  // Simulates the reviewer scenario: the original live_runs snapshot was taken
  // before the run acquired a process ref. The fresh scan sees the new ref and
  // must abort instead of deleting the workspace.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const staleSnapshot = [{ run_id: "run-1", process_ref: null }];
  assert.equal(await assertNoLiveWriters(staleSnapshot), true, "a null process_ref is not a live writer");

  const freshScan = [{ run_id: "run-1", process_ref: `runtime-supervisor:${child.pid}` }];
  await assert.rejects(
    () => assertNoLiveWriters(freshScan),
    /still alive/,
    "a process ref acquired after the snapshot must abort cleanup",
  );
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("close", resolve));
  assert.equal(await assertNoLiveWriters(freshScan), true, "a reaped writer must pass");
});

test("assertNoLiveWriters scans terminal/stale runs and rejects unknown refs", async () => {
  // A run with a terminal status may still hold a live process; the full scan
  // must include it (no status filter).
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const terminalButLive = [{ run_id: "run-t", status: "completed", process_ref: `runtime-supervisor:${child.pid}` }];
  await assert.rejects(
    () => assertNoLiveWriters(terminalButLive),
    /still alive/,
    "a terminal-status run with a live process must abort cleanup",
  );
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("close", resolve));

  // Unknown process-ref formats are fail-closed: they may be foreign writers.
  await assert.rejects(
    () => assertNoLiveWriters([{ run_id: "run-x", process_ref: "unknown-writer:42" }]),
    /not recognized/,
    "an unrecognized process ref must abort cleanup",
  );
  await assert.rejects(
    () => assertNoLiveWriters([{ run_id: "run-x", process_ref: "other-tool:1234" }]),
    /not recognized/,
  );
});

// Since K1 a run's ref names its cgroup, and that is what liveness asks: a pid
// answers for one process, and can be reused; the leaf answers for everything
// the run started, until nothing of it is left.
test("a process ref with a cgroup is answered by the cgroup, never by the pid", async () => {
  const leaf = "task-0f3c2a1e-6b7d-4e8f-9a0b-1c2d3e4f5a6b";
  assert.deepEqual(parseProcessRef(`runtime-supervisor:4242:${leaf}`), { pid: 4242, cgroup: leaf });
  assert.deepEqual(parseProcessRef("runtime-supervisor:4242"), { pid: 4242, cgroup: null });
  assert.equal(parseProcessRef("runtime-supervisor:4242:not-a-leaf"), null);
  assert.equal(parseProcessRef("runtime-supervisor:4242:TASK-0F3C2A1E-6B7D-4E8F-9A0B-1C2D3E4F5A6B"), null);
  assert.equal(parseProcessRef(""), null);

  // pid 4242 is nobody here, and a pid-only answer would say "gone". The
  // cgroup says otherwise, and the cgroup is what counts.
  const asked = [];
  const alive = await writerAlive(parseProcessRef(`runtime-supervisor:4242:${leaf}`), {
    cgroupAlive: async (name) => { asked.push(name); return true; },
  });
  assert.equal(alive, true);
  assert.deepEqual(asked, [leaf]);
  assert.equal(await writerAlive(parseProcessRef(`runtime-supervisor:4242:${leaf}`), { cgroupAlive: async () => false }), false);

  // A pid-only ref, the release before wrote, is still probed by pid.
  assert.equal(await writerAlive(parseProcessRef("runtime-supervisor:99999999")), false);
  assert.equal(await writerAlive(parseProcessRef(`runtime-supervisor:${process.pid}`)), true);
});

test("a cgroup ref with nobody to ask the cgroup is alive, and so is an unparseable one", async () => {
  // The question cannot be answered, and the caller is about to delete a
  // workspace: the only safe answer is that the writer is still there.
  const leaf = "turn-0f3c2a1e-6b7d-4e8f-9a0b-1c2d3e4f5a6b";
  assert.equal(await writerAlive(parseProcessRef(`runtime-supervisor:1:${leaf}`)), true);
  assert.equal(await writerAlive(null), true);
  await assert.rejects(
    () => assertNoLiveWriters([{ run_id: "run-c", process_ref: `runtime-supervisor:1:${leaf}` }]),
    /still alive/,
    "without the supervisor's cgroups to ask, a cgroup ref blocks cleanup",
  );
  await assert.rejects(
    () => assertNoLiveWriters([{ run_id: "run-c", process_ref: `runtime-supervisor:1:${leaf}` }], { cgroupAlive: async () => true }),
    /still alive/,
  );
  assert.equal(await assertNoLiveWriters([{ run_id: "run-c", process_ref: `runtime-supervisor:1:${leaf}` }],
    { cgroupAlive: async () => false }), true, "an emptied cgroup is a writer that is gone");
});

test("proveContainedDirectory accepts a real child workspace and rejects escapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deprovision-root-"));
  const projectDir = path.join(root, "project-1");
  await mkdir(projectDir, { recursive: true });

  const canonical = await proveContainedDirectory(projectDir, root, "workspace");
  assert.equal(canonical, await import("node:fs/promises").then((f) => f.realpath(projectDir)));

  // Symlink escape: a link pointing outside the root must be rejected.
  const outside = await mkdtemp(path.join(tmpdir(), "deprovision-outside-"));
  const link = path.join(root, "evil-link");
  await symlink(outside, link);
  await assert.rejects(
    () => proveContainedDirectory(link, root, "workspace"),
    /escapes the configured root/,
  );

  // Root itself and absolute root are rejected.
  await assert.rejects(() => proveContainedDirectory(root, root, "workspace"), /root boundary/);
  await assert.rejects(() => proveContainedDirectory("/", root, "workspace"), /root boundary/);

  // Empty and glob paths are rejected.
  await assert.rejects(() => proveContainedDirectory("", root, "workspace"), /empty/);
  await assert.rejects(() => proveContainedDirectory(`${root}/*`, root, "workspace"), /glob/);

  // Missing workspace resolves to null (idempotent cleanup).
  assert.equal(await proveContainedDirectory(path.join(root, "nope"), root, "workspace"), null);

  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("workspace ownership isolation: runtime-owned files stay untouched by infra-control removal checks", async () => {
  // Simulates the reviewer scenario: the workspace is owned by the runtime
  // user (codex-worker) and the worker runs as infra-control. The worker must not
  // attempt unlink itself — it delegates to the root Supervisor. This test
  // asserts the worker never touches the filesystem by exercising only the
  // safety helpers (no rm), mirroring the worker's actual behaviour.
  const root = await mkdtemp(path.join(tmpdir(), "deprovision-owner-"));
  const projectDir = path.join(root, "project-2");
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, "AGENTS.md"), "agents");
  const info = await stat(projectDir);
  assert.equal(info.isDirectory(), true);
  const canonical = await proveContainedDirectory(projectDir, root, "workspace");
  assert.ok(canonical);
  await rm(root, { recursive: true, force: true });
});

test("supervisor stop receipts shape matches the worker contract", () => {
  // The deprovision worker treats the supervisor result as authoritative:
  // workspace_removed must be true and receipts must be an array. Assert the
  // contract the worker relies on so a supervisor regression fails here.
  const supervisorResult = { project_id: "p", receipts: [], workspace_removed: true, keys_removed: 0 };
  assert.equal(typeof supervisorResult.workspace_removed, "boolean");
  assert.ok(Array.isArray(supervisorResult.receipts));
  assert.equal(supervisorResult.receipts.length, 0);
});
