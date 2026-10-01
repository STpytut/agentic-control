// The cgroup per run, against processes and against the kernel.
//
// Two halves. The first runs everywhere the gate runs: the cgroup filesystem is
// emulated over a temporary directory whose `cgroup.procs` holds real pids, so
// "populated" is whether any of them is alive and `cgroup.kill` is SIGKILL to
// each — enough to prove the stop sequence, the grace, the escalation, the
// sweep and the fail-closed answers against children that really exist. The
// gate's container mounts the real cgroup filesystem read-only, so that is the
// half it can run.
//
// The second half is the PoC's finding itself, reproduced in a form a test can
// run: a process tree whose child moves to a session of its own and schedules
// a delayed side effect. `kill(-pgid)` — the stop the supervisor used to do —
// lets the side effect land; the cgroup kill does not. It runs wherever cgroup
// v2 is writable for this process — a privileged container, root on a host, a
// user's delegated subtree (`systemd-run --user --scope -p Delegate=yes node
// --test ...`) — and skips with the reason otherwise.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir, rmdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CGROUP_LAUNCH_EXIT, LEAF_PATTERN, SUPERVISOR_LEAF, createProcessGroupIsolation, createRunCgroups, ownCgroupPath, populatedOf,
  runIsolationFromEnvironment,
} from "../run-cgroup.mjs";
import { parseProcessRef } from "../../control-plane/deprovision-safety.mjs";
import { stopProcessGroup } from "../launch-control.mjs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const spawned = (child) => new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
const leafName = (kind = "task") => `${kind}-${randomUUID()}`;

// ---------------------------------------------------------------------------
// The emulation: a directory per leaf, real pids in `cgroup.procs`.
// ---------------------------------------------------------------------------

function emulatedCgroupFs({ killFile = true } = {}) {
  const pidsIn = async (procsPath) => {
    const text = await readFile(procsPath, "utf8");
    return text.split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
  };
  const enoent = (target) => Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });
  return {
    mkdir: (target) => mkdir(target),
    readdir: (target, options) => readdir(target, options),
    async rmdir(target) {
      const procs = path.join(target, "cgroup.procs");
      if (existsSync(procs)) {
        if ((await pidsIn(procs)).some(alive)) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        await rm(procs, { force: true });
      }
      await rmdir(target);
    },
    async readFile(target) {
      const entry = path.basename(target);
      if (entry === "cgroup.procs") {
        if (!existsSync(path.dirname(target))) throw enoent(target);
        if (!existsSync(target)) return "";
        return `${(await pidsIn(target)).filter(alive).join("\n")}\n`;
      }
      if (entry === "cgroup.events") {
        if (!existsSync(path.dirname(target))) throw enoent(target);
        const procs = path.join(path.dirname(target), "cgroup.procs");
        const populated = existsSync(procs) && (await pidsIn(procs)).some(alive);
        return `populated ${populated ? 1 : 0}\nfrozen 0\n`;
      }
      return readFile(target, "utf8");
    },
    async writeFile(target, data) {
      const entry = path.basename(target);
      if (entry === "cgroup.kill") {
        if (!killFile) throw enoent(target);
        if (!existsSync(path.dirname(target))) throw enoent(target);
        const procs = path.join(path.dirname(target), "cgroup.procs");
        if (existsSync(procs)) for (const pid of await pidsIn(procs)) { try { process.kill(pid, "SIGKILL"); } catch {} }
        return;
      }
      return writeFile(target, data);
    },
    // What a real cgroup does by itself when a member forks: the member is in
    // the leaf too. The emulation is told.
    async attach(leaf, pid) {
      const procs = path.join(leaf.path, "cgroup.procs");
      const current = existsSync(procs) ? await readFile(procs, "utf8") : "";
      await writeFile(procs, `${current}${pid}\n`);
    },
  };
}

async function emulated(options) {
  const root = await mkdtemp(path.join(tmpdir(), "run-cgroup-"));
  const fs = emulatedCgroupFs(options);
  const logged = [];
  const cgroups = createRunCgroups({ root, fs, log: (line) => logged.push(line) });
  return { root, fs, cgroups, logged, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("a launched run is in its leaf, named by its ref, and alive until nothing of it is left", async () => {
  const { cgroups, cleanup } = await emulated();
  try {
    const leaf = await cgroups.create(leafName("task"));
    const child = cgroups.launch(leaf, "/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
    await spawned(child);
    // The launcher wrote its own pid and became the command: one process, in
    // the leaf, and `child.pid` is its pid.
    await pause(150);
    assert.deepEqual(await cgroups.procs(leaf), [child.pid]);
    assert.equal(await cgroups.populated(leaf), true);
    assert.equal(await cgroups.alive(leaf.name), true);

    const ref = cgroups.refOf(leaf, child.pid);
    assert.deepEqual(parseProcessRef(ref), { pid: child.pid, cgroup: leaf.name });
    assert.ok(ref.length < 200, "task_runs.process_ref is CHECKed at 200 characters");

    const outcome = await cgroups.stop(leaf, { child, graceMs: 2_000 });
    assert.equal(outcome.escalated, false, "sleep dies on SIGTERM; no SIGKILL was needed");
    assert.equal(alive(child.pid), false);
    assert.equal(await cgroups.populated(leaf), false);
    await cgroups.release(leaf);
    assert.equal(existsSync(leaf.path), false, "the leaf is removed once it is empty");
    assert.equal(await cgroups.alive(leaf.name), false, "a removed leaf is a run that is over");
  } finally {
    await cleanup();
  }
});

test("a run that ignores SIGTERM is killed through the cgroup after the grace, and stopped means gone", async () => {
  const { cgroups, cleanup } = await emulated();
  try {
    const leaf = await cgroups.create(leafName("turn"));
    const child = cgroups.launch(leaf, "/bin/sh", ["-c", "trap '' TERM; sleep 30"], { stdio: "ignore" });
    await spawned(child);
    await pause(150);
    const started = Date.now();
    const outcome = await cgroups.stop(leaf, { child, graceMs: 300, killWaitMs: 2_000 });
    assert.equal(outcome.escalated, true);
    assert.equal(alive(child.pid), false, "the process is actually gone when this returns");
    assert.ok(Date.now() - started < 2_000, "it took the grace and SIGKILL, not the whole kill budget");
    await cgroups.release(leaf);
  } finally {
    await cleanup();
  }
});

test("a member left behind after the runtime exits is killed with the leaf, and counted", async () => {
  // The PoC's shape, in the emulation: the runtime is gone, its tool is not.
  const { cgroups, fs, logged, cleanup } = await emulated();
  try {
    const leaf = await cgroups.create(leafName("task"));
    const runtime = cgroups.launch(leaf, "/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
    await spawned(runtime);
    await new Promise((resolve) => runtime.once("close", resolve));
    const tool = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30"], { stdio: "ignore" });
    await spawned(tool);
    await fs.attach(leaf, tool.pid);
    assert.equal(await cgroups.alive(leaf.name), true, "the run is alive while its tool is");

    const { leftovers } = await cgroups.release(leaf, { killWaitMs: 2_000 });
    assert.equal(leftovers, 1);
    assert.equal(alive(tool.pid), false, "the tool did not outlive the leaf");
    assert.equal(existsSync(leaf.path), false);
    assert.deepEqual(logged.map((line) => line.type), ["run_cgroup.leftovers_killed"]);
  } finally {
    await cleanup();
  }
});

test("a stop with no child to watch still waits for the leaf: a member still exiting is not left behind", async () => {
  // The leader obeys SIGTERM; a member takes a moment to die from the same
  // signal. Probing once as the leader goes reported "still has members";
  // waiting on `populated` until the grace runs out does not.
  const { cgroups, fs, cleanup } = await emulated();
  try {
    const leaf = await cgroups.create(leafName("task"));
    const leader = cgroups.launch(leaf, "/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
    await spawned(leader);
    const member = spawn("/bin/sh", ["-c", "trap 'sleep 0.4; exit 0' TERM; while :; do sleep 0.05; done"], { stdio: "ignore" });
    await spawned(member);
    await pause(200);
    await fs.attach(leaf, member.pid);

    const outcome = await cgroups.stop(leaf, { graceMs: 2_000 });
    assert.equal(outcome.escalated, false, "the member finished exiting inside the grace");
    assert.equal(alive(leader.pid), false);
    assert.equal(alive(member.pid), false);
    await cgroups.release(leaf);
  } finally {
    await cleanup();
  }
});

test("a signal other than SIGKILL reaches every member, one by one", async () => {
  const { cgroups, fs, cleanup } = await emulated();
  try {
    const leaf = await cgroups.create(leafName("gate"));
    const leader = cgroups.launch(leaf, "/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
    await spawned(leader);
    // The launcher's write lands first; the emulation's `attach` appends to
    // it, where a real cgroup would simply have the member.
    await pause(150);
    const member = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
    await spawned(member);
    await fs.attach(leaf, member.pid);
    await cgroups.signal(leaf, "SIGTERM");
    await pause(300);
    assert.equal(alive(leader.pid), false);
    assert.equal(alive(member.pid), false);
    await cgroups.release(leaf);
    // And a leaf that is gone takes a signal without complaint.
    await cgroups.signal(leaf, "SIGTERM");
  } finally {
    await cleanup();
  }
});

test("a kernel without cgroup.kill gets the members signalled until none is left", async () => {
  const { cgroups, cleanup } = await emulated({ killFile: false });
  try {
    const leaf = await cgroups.create(leafName("task"));
    const child = cgroups.launch(leaf, "/bin/sh", ["-c", "trap '' TERM; sleep 30"], { stdio: "ignore" });
    await spawned(child);
    await pause(150);
    const outcome = await cgroups.stop(leaf, { child, graceMs: 200, killWaitMs: 2_000 });
    assert.equal(outcome.escalated, true);
    assert.equal(alive(child.pid), false);
    await cgroups.release(leaf);
  } finally {
    await cleanup();
  }
});

test("a stop whose members survive SIGKILL is reported as not stopped", async () => {
  // The emulation's SIGKILL is a no-op here, standing in for a process in
  // uninterruptible sleep. `stopped` must not be said.
  const { root, fs, cleanup } = await emulated();
  const cgroups = createRunCgroups({ root, fs: { ...fs, writeFile: async () => {} }, kill: () => {} });
  try {
    const leaf = await cgroups.create(leafName("task"));
    const child = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
    await spawned(child);
    await fs.attach(leaf, child.pid);
    await assert.rejects(() => cgroups.stop(leaf, { child, graceMs: 100, killWaitMs: 300 }), /still has members after SIGKILL/);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
    await cgroups.release(leaf);
  } finally {
    await cleanup();
  }
});

test("the leaves a previous supervisor left are killed and removed at startup", async () => {
  const { cgroups, fs, cleanup } = await emulated();
  try {
    const populated = await cgroups.create(leafName("task"));
    const stale = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30"], { stdio: "ignore" });
    await spawned(stale);
    await fs.attach(populated, stale.pid);
    const empty = await cgroups.create(leafName("channel"));
    // Not a leaf of ours: left alone.
    mkdirSync(path.join(cgroups.root, "not-a-run"));

    const swept = await cgroups.sweep();
    assert.deepEqual(
      swept.sort((a, b) => a.cgroup.localeCompare(b.cgroup)),
      [{ cgroup: populated.name, populated: true }, { cgroup: empty.name, populated: false }]
        .sort((a, b) => a.cgroup.localeCompare(b.cgroup)),
    );
    assert.equal(alive(stale.pid), false, "the stale run's process was killed");
    assert.equal(existsSync(populated.path), false);
    assert.equal(existsSync(empty.path), false);
    assert.equal(existsSync(path.join(cgroups.root, "not-a-run")), true);
  } finally {
    await cleanup();
  }
});

test("liveness fails closed: a leaf that cannot be read is alive, a bad name is alive, an absent leaf is gone", async () => {
  const { root, fs, logged, cleanup } = await emulated();
  try {
    const refusing = createRunCgroups({
      root, log: (line) => logged.push(line),
      fs: { ...fs, readFile: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } },
    });
    assert.equal(await refusing.alive(leafName("task")), true, "an unreadable cgroup filesystem is not proof of absence");
    assert.equal(logged.at(-1)?.type, "run_cgroup.unreadable");

    const cgroups = createRunCgroups({ root, fs });
    assert.equal(await cgroups.alive(leafName("task")), false, "a leaf that does not exist was released");
    assert.equal(await cgroups.alive("../../etc"), true, "a name that is not a leaf's is nobody's, and blocks");
    assert.equal(await cgroups.alive("task-not-a-uuid"), true);
    await assert.rejects(() => cgroups.create("../escape"), /named <kind>-<uuid>/);
  } finally {
    await cleanup();
  }
});

test("a root that cannot be written is refused before anything is launched, naming Delegate=", async () => {
  const { root, fs, cleanup } = await emulated();
  try {
    await createRunCgroups({ root, fs }).prepare();
    const readOnly = createRunCgroups({
      root, fs: { ...fs, mkdir: async () => { throw Object.assign(new Error("EROFS"), { code: "EROFS" }); } },
    });
    await assert.rejects(() => readOnly.prepare(), /not writable \(EROFS\).*Delegate=yes/);
    assert.deepEqual(await readdir(root), [], "the probe leaf did not survive prepare");
  } finally {
    await cleanup();
  }
});

// Stage 12 M1: the supervisor into its own leaf, the memory controller for
// the leaves, a limit on every run's leaf, and the kernel's count read back.
test("memory control moves the supervisor into its own leaf and enables memory for the leaves", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-cgroup-"));
  const fs = emulatedCgroupFs();
  const logged = [];
  try {
    await writeFile(path.join(root, "cgroup.procs"), `${process.pid}\n`);
    const cgroups = createRunCgroups({ root, fs, log: (line) => logged.push(line), memoryControl: true });
    await cgroups.prepare();
    assert.equal(cgroups.memoryLimits, true);
    assert.equal((await readFile(path.join(root, SUPERVISOR_LEAF, "cgroup.procs"), "utf8")).trim(), String(process.pid));
    assert.equal(await readFile(path.join(root, "cgroup.subtree_control"), "utf8"), "+memory");
    // A second prepare — the process restarted alone — finds its leaf there.
    await cgroups.prepare();
    // The supervisor's leaf is not a run's: a sweep leaves it.
    assert.deepEqual(await cgroups.sweep(), []);
    assert.ok((await readdir(root)).includes(SUPERVISOR_LEAF));

    const leaf = await cgroups.create(leafName("task"), { memoryMaxBytes: 700 * 1024 * 1024 });
    assert.equal(await readFile(path.join(leaf.path, "memory.max"), "utf8"), String(700 * 1024 * 1024));
    assert.equal(await readFile(path.join(leaf.path, "memory.swap.max"), "utf8"), "0");
    await writeFile(path.join(leaf.path, "memory.peak"), String(612 * 1024 * 1024));
    await writeFile(path.join(leaf.path, "memory.events"), "low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\noom_group_kill 0\n");
    assert.deepEqual(await cgroups.memoryStats(leaf), { memory_limit_mb: 700, memory_peak_mb: 612, oom_kill: 1 });
    assert.ok(logged.some((line) => line.type === "run_cgroup.oom_killed" && line.cgroup === leaf.name));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a host that refuses the memory controller keeps running without per-run limits, and says so", async () => {
  const { root, fs, cleanup } = await emulated();
  const logged = [];
  try {
    await writeFile(path.join(root, "cgroup.procs"), `${process.pid}\n`);
    const refusing = { ...fs, writeFile: async (target, data) => {
      if (path.basename(target) === "cgroup.subtree_control") throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return fs.writeFile(target, data);
    } };
    const cgroups = createRunCgroups({ root, fs: refusing, log: (line) => logged.push(line), memoryControl: true });
    await cgroups.prepare();
    assert.equal(cgroups.memoryLimits, false);
    assert.deepEqual(logged.find((line) => line.type === "run_cgroup.memory_limits"), { type: "run_cgroup.memory_limits", enabled: false, error: "EBUSY" });
    const leaf = await cgroups.create(leafName("task"), { memoryMaxBytes: 700 * 1024 * 1024 });
    assert.equal(existsSync(path.join(leaf.path, "memory.max")), false, "a limit was written without the controller");
    assert.equal(await cgroups.memoryStats(leaf), null);
  } finally {
    await cleanup();
  }
});

test("a run whose memory limit cannot be written is not started, and its leaf goes", async () => {
  const { root, fs, cleanup } = await emulated();
  try {
    await writeFile(path.join(root, "cgroup.procs"), `${process.pid}\n`);
    const refusing = { ...fs, writeFile: async (target, data) => {
      if (path.basename(target) === "memory.max") throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
      return fs.writeFile(target, data);
    } };
    const cgroups = createRunCgroups({ root, fs: refusing, memoryControl: true });
    await cgroups.prepare();
    const name = leafName("task");
    await assert.rejects(() => cgroups.create(name, { memoryMaxBytes: 1 }), /memory limit could not be set.*EINVAL/);
    assert.equal(existsSync(path.join(root, name)), false);
  } finally {
    await cleanup();
  }
});

test("a launcher that cannot join its cgroup refuses the run with its own exit status", async () => {
  const { cgroups, cleanup } = await emulated();
  try {
    const leaf = cgroups.leafNamed(leafName("task")); // never created
    const [command, argv] = cgroups.launcher(leaf, "/bin/sh", ["-c", "echo ran"]);
    const child = spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, CGROUP_LAUNCH_EXIT);
    assert.equal(stdout, "", "the command never ran");
    assert.match(stderr, /could not be placed in its cgroup/);
  } finally {
    await cleanup();
  }
});

test("the supervisor's own cgroup is read from the unified hierarchy line, and nothing else", () => {
  const read = (text) => () => text;
  assert.equal(
    ownCgroupPath({ read: read("0::/system.slice/infra-cod-runtime-supervisor.service\n") }),
    "/sys/fs/cgroup/system.slice/infra-cod-runtime-supervisor.service",
  );
  assert.equal(ownCgroupPath({ read: read("0::/\n") }), "/sys/fs/cgroup");
  assert.throws(() => ownCgroupPath({ read: read("12:memory:/system.slice\n1:name=systemd:/system.slice\n") }), /no cgroup v2/);
  assert.equal(populatedOf("populated 1\nfrozen 0\n"), true);
  assert.equal(populatedOf("populated 0\nfrozen 0\n"), false);
  assert.throws(() => populatedOf("frozen 0\n"), /no populated line/);
  assert.match("channel-0f3c2a1e-6b7d-4e8f-9a0b-1c2d3e4f5a6b", LEAF_PATTERN);
  assert.doesNotMatch("probe", LEAF_PATTERN);
});

test("the process-group fallback exists for the gate's container only, and says so in its refs", async () => {
  assert.throws(() => runIsolationFromEnvironment({ RUNTIME_RUN_ISOLATION: "none" }), /cgroup or process_group/);
  const fallback = runIsolationFromEnvironment({ RUNTIME_RUN_ISOLATION: "process_group" });
  assert.equal(fallback.mechanism, "process_group");
  await fallback.prepare();
  assert.deepEqual(await fallback.sweep(), []);

  const leaf = await fallback.create(leafName("task"));
  const child = fallback.launch(leaf, "/bin/sh", ["-c", "trap '' TERM; sleep 30"], { stdio: "ignore" });
  await spawned(child);
  // A pid-only ref: liveness is answered by the pid, as the release before.
  assert.deepEqual(parseProcessRef(fallback.refOf(leaf, child.pid)), { pid: child.pid, cgroup: null });
  await fallback.stop(leaf, { child, graceMs: 200 });
  assert.equal(alive(child.pid), false);
  await fallback.release(leaf);
  assert.equal(createProcessGroupIsolation().mechanism, "process_group");
});

// ---------------------------------------------------------------------------
// The kernel. The PoC's finding, and the fix, against real cgroups.
// ---------------------------------------------------------------------------

function writableCgroupRoot() {
  if (process.platform !== "linux") return { skip: `real cgroups need Linux, not ${process.platform}` };
  let root;
  try {
    root = process.env.RUN_CGROUP_TEST_ROOT || ownCgroupPath();
  } catch (error) {
    return { skip: error.message };
  }
  const probe = path.join(root, `probe-${randomUUID()}`);
  try {
    mkdirSync(probe);
    rmdirSync(probe);
  } catch (error) {
    return {
      skip: `${root} is not writable for this process (${error.code}); run under a delegated subtree, `
        + "e.g. systemd-run --user --scope -p Delegate=yes, or in a privileged container",
    };
  }
  return { root };
}

// Registered only when asked for (`npm run test:cgroup-kernel`, on the host
// as root). The gate's container mounts the cgroup filesystem read-only, and a
// test it skipped would read as green there; asked for and unable to run, the
// kernel tests fail instead, naming why.
const kernelRequested = process.env.RUN_CGROUP_KERNEL_TESTS === "1";
const kernel = kernelRequested ? writableCgroupRoot() : { skip: "not requested" };
if (kernelRequested && kernel.skip) {
  test("the kernel tests were asked for and cannot run", () => {
    assert.fail(kernel.skip);
  });
}
if (kernelRequested && !kernel.skip) {

  test("the PoC: a tool in its own session outlives kill(-pgid), and a delayed side effect lands", async () => {
    // The control: what the supervisor did before K1, on the tree the PoC
    // described. If this stopped landing, the finding would have gone away and
    // the next test would prove nothing.
    const scratch = await mkdtemp(path.join(tmpdir(), "run-cgroup-poc-"));
    const marker = path.join(scratch, "marker");
    try {
      const child = spawn("/bin/sh", ["-c", `setsid sh -c 'sleep 1; touch "${marker}"' & sleep 60`], { detached: true, stdio: "ignore" });
      await spawned(child);
      await pause(200);
      await stopProcessGroup(child, { graceMs: 200 });
      assert.equal(existsSync(marker), false, "nothing had landed when the stop returned");
      await pause(1_500);
      assert.equal(existsSync(marker), true, "the process group stop let the side effect land");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("the fix: the same tree in a cgroup is ended whole, and the side effect never lands", async () => {
    const cgroups = createRunCgroups({ root: kernel.root });
    const scratch = await mkdtemp(path.join(tmpdir(), "run-cgroup-poc-"));
    const marker = path.join(scratch, "marker");
    const leaf = await cgroups.create(leafName("task"));
    try {
      const child = cgroups.launch(leaf, "/bin/sh", ["-c", `setsid sh -c 'sleep 1; touch "${marker}"' & sleep 60`], { stdio: "ignore" });
      await spawned(child);
      await pause(200);
      // The launcher put itself in the leaf before exec, so the runtime and
      // everything it forked are there — the kernel says so.
      const members = await cgroups.procs(leaf);
      assert.ok(members.includes(child.pid), `the runtime ${child.pid} is in ${leaf.name}: ${members}`);
      assert.ok(members.length >= 2, `the tool that called setsid is in the leaf too: ${members}`);
      assert.match(readFileSync(`/proc/${child.pid}/cgroup`, "utf8"), new RegExp(`/${leaf.name}$`, "m"));

      // SIGTERM goes to every member the leaf lists — the setsid'd shell too,
      // which the process group never reached — so on this tree the grace is
      // enough and nothing escalates. Whether it did is not the point; the
      // marker is.
      const outcome = await cgroups.stop(leaf, { child, graceMs: 200 });
      assert.equal(typeof outcome.escalated, "boolean");
      assert.equal(await cgroups.populated(leaf), false, "cgroup.events says populated 0");
      assert.equal(existsSync(marker), false);
      await pause(1_500);
      assert.equal(existsSync(marker), false, "the delayed side effect never landed");
      await cgroups.release(leaf);
      assert.equal(existsSync(leaf.path), false);
      assert.equal(await cgroups.alive(leaf.name), false);
    } finally {
      await cgroups.release(leaf).catch(() => {});
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("a stale leaf from a dead supervisor is swept by the next one", async () => {
    const cgroups = createRunCgroups({ root: kernel.root });
    const leaf = await cgroups.create(leafName("turn"));
    const child = cgroups.launch(leaf, "/bin/sh", ["-c", "trap '' TERM; sleep 60"], { stdio: "ignore" });
    await spawned(child);
    await pause(200);
    try {
      const next = createRunCgroups({ root: kernel.root });
      await next.prepare();
      const swept = await next.sweep();
      assert.ok(swept.some((entry) => entry.cgroup === leaf.name && entry.populated === true), JSON.stringify(swept));
      assert.equal(alive(child.pid), false);
      assert.equal(existsSync(leaf.path), false);
    } finally {
      await cgroups.release(leaf).catch(() => {});
    }
  });
}
