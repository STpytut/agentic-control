// One cgroup per run, and the kill that reaches everything in it (sprint C, K1).
//
// The supervisor used to stop a run with `kill(-pgid)`: the runtime was spawned
// detached, so it led its own process group, and the group was signalled. A
// Claude Code PoC on the VPS showed the hole in that: the runtime starts its
// shell tools in process groups of their own, SIGTERM worked only because the
// runtime's own handler cleaned up, and SIGKILL to the runtime's group left
// `bash` and `sleep` alive — a delayed `sleep 5 && touch marker` landed after
// the run had been reported stopped. Anything that calls `setsid`, or is a
// daemon, is outside the group, and the process group was never a boundary the
// kernel enforced on the runtime's behalf. Decision C4: a cgroup per run, for
// every runtime, because a process cannot leave its cgroup without write access
// to the cgroup filesystem, which the runtime's user does not have.
//
// Why a leaf under the supervisor's own delegated subtree, and not a transient
// systemd scope:
//
//   * The unit's stop semantics stay what the acceptance relied on: a restart of
//     the supervisor ends every process it launched, because they are still in
//     its unit's cgroup. A scope is a sibling of the unit, not part of it; a
//     supervisor killed by systemd (TimeoutStopSec, the OOM killer) would leave
//     its scopes running, and every restart would have to find them over D-Bus.
//   * `TasksMax=256` and `MemoryMax=1G` keep bounding the runtimes as they did,
//     because those are counted over the unit's subtree. K3's per-run budget
//     can read `memory.current` of a leaf, or move the supervisor into a leaf
//     of its own and enable the controller — both are subtree operations.
//   * It is a filesystem protocol — mkdir, write a pid, read `cgroup.events`,
//     write `cgroup.kill`, rmdir — under the unit's existing sandbox: root, and
//     `ProtectSystem=strict` leaves `/sys` writable. It needs no D-Bus client,
//     no unit names, no polkit, and it can be exercised against a directory in
//     a test. The gate's container mounts the cgroup filesystem read-only, so
//     the logic is proved against an emulation there and against the kernel
//     wherever cgroup v2 is writable.
//   * `Delegate=yes` in the unit is the whole change. It tells systemd that this
//     subtree is ours to manage; nothing in it is touched by systemd except at
//     the unit's stop, when the whole subtree is killed.
//
// The runtime's process is placed in its cgroup *before* `runuser` drops
// privileges and before anything forks: the launcher is `/bin/sh` writing its
// own pid into the leaf's `cgroup.procs` and `exec`ing the real command, so
// there is no window in which a child could be started outside the cgroup.
// `runuser` without `-l` opens no login session, so pam_systemd does not move
// the process into a session scope of its own. The Landlock wrapper of a
// read-only launch (read-only-launch.mjs) comes after `runuser`, inside the
// cgroup, and is unaffected.
//
// The process_ref a run records is `runtime-supervisor:<pid>:<leaf>`, so a
// liveness question from the database asks the leaf, not the pid: a pid can be
// reused, a leaf that is populated is a run that is still doing something. A
// ref without a leaf is one the previous release wrote, and is probed by pid
// as it always was — those runs ended with that supervisor's restart.
//
// Stopping keeps the grace it had: SIGTERM to every process in the leaf, the
// grace period, then `cgroup.kill`, which SIGKILLs every member atomically,
// including any that are forked while it happens; then the leaf is watched
// until `cgroup.events` says `populated 0`. "Stopped" is said only then.

// Stage 12 M1 — a memory limit of its own for every run. The memory
// controller cannot be enabled for the leaves while a process sits in the
// subtree's root (cgroup v2's "no internal processes" rule), and the
// supervisor's own process is exactly that. So at startup the supervisor moves
// itself into a leaf of its own, `supervisor/`, and writes `+memory` into the
// root's `cgroup.subtree_control`. Every run leaf then has `memory.max`,
// written before the runtime joins it, and `memory.peak` and `memory.events`,
// read before the leaf goes: a run past its limit is OOM-killed inside its own
// leaf (`oom_kill` there), and the runs beside it and the supervisor go on. A
// host where this cannot be done keeps working as before — no per-run limit,
// the sampled peak only — and says so in its log and in doctor.

import { mkdir, readFile, readdir, rmdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { stopProcessGroup } from "./launch-control.mjs";

// A leaf is named for what it carries and the id that identifies it: the run
// id of a task or turn, the channel id of a channel, a fresh id otherwise.
export const LEAF_PATTERN = /^[a-z]+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

// The exit status of a launcher that could not place the run in its cgroup. It
// is refused rather than run unconfined, like a read-only launch whose ruleset
// cannot be built (READ_ONLY_LAUNCH_EXIT is 78).
export const CGROUP_LAUNCH_EXIT = 79;

// What the launcher does before the runtime exists: one write of its own pid,
// then `exec`. `$0` is the leaf's `cgroup.procs`; the rest is the command.
const LAUNCHER = [
  `echo "$$" > "$0" || { echo "infra-cod: the run could not be placed in its cgroup ($0)" >&2; exit ${CGROUP_LAUNCH_EXIT}; }`,
  'exec "$@"',
].join("\n");

export const defaultCgroupFs = { mkdir, rmdir, readdir, readFile, writeFile };

// The supervisor's own cgroup, as the kernel names it: the `0::` line of
// `/proc/self/cgroup` on a cgroup v2 host, under the mount point. A host
// without that line runs the legacy or hybrid hierarchy, which this does not
// support and says so.
export function ownCgroupPath({ mountPoint = "/sys/fs/cgroup", procSelf = "/proc/self/cgroup", read = readFileSync } = {}) {
  const lines = String(read(procSelf, "utf8")).split("\n");
  const unified = lines.find((line) => line.startsWith("0::"));
  if (!unified) throw new Error(`${procSelf} names no cgroup v2 hierarchy; the supervisor needs the unified hierarchy`);
  const relative = unified.slice("0::".length).trim();
  if (!relative.startsWith("/")) throw new Error(`${procSelf} has an unexpected cgroup path: ${unified}`);
  // `/` is the mount point itself: a container's own root, or a test's.
  return relative === "/" ? mountPoint : path.posix.join(mountPoint, relative);
}

// Reads `cgroup.events` and answers `populated`. Exported for the test's
// emulation, so it and the real thing agree on the format.
export function populatedOf(events) {
  const line = String(events).split("\n").find((entry) => entry.startsWith("populated "));
  if (!line) throw new Error("cgroup.events has no populated line");
  return line.trim().endsWith(" 1");
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The isolation of runs by cgroup. `root` is the supervisor's delegated
// subtree; `fs` is the cgroup filesystem, injectable so the logic is proved
// where the real one cannot be written.
// The supervisor's own leaf. Not a run's name (LEAF_PATTERN), so a sweep never
// takes it.
export const SUPERVISOR_LEAF = "supervisor";

const MB = 1024 * 1024;

// A leaf's memory file's number: bytes, "max" as null, anything else null.
function memoryNumber(text) {
  const value = String(text).trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

export function createRunCgroups({
  root, fs = defaultCgroupFs, kill = (pid, signal) => process.kill(pid, signal), spawnProcess = spawn, log = () => {},
  memoryControl = false,
} = {}) {
  if (typeof root !== "string" || !root.startsWith("/")) throw new Error("the run cgroup root must be an absolute path");

  const leafOf = (name) => {
    if (!LEAF_PATTERN.test(name)) throw new Error(`a run cgroup is named <kind>-<uuid>, not ${JSON.stringify(name)}`);
    return { name, path: path.posix.join(root, name) };
  };
  const file = (leaf, entry) => path.posix.join(leaf.path, entry);

  const procs = async (leaf) => String(await fs.readFile(file(leaf, "cgroup.procs"), "utf8"))
    .split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);

  // ENOENT is the one answer that means "over": the leaf was removed after it
  // emptied. Anything else is reported as it is; the callers that must decide
  // treat it as alive.
  const populated = async (leaf) => {
    try {
      return populatedOf(await fs.readFile(file(leaf, "cgroup.events"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  };

  const emptyBy = async (leaf, deadline) => {
    while (await populated(leaf)) {
      if (Date.now() >= deadline) return false;
      await pause(25);
    }
    return true;
  };

  // SIGKILL to every member at once, from the kernel. A kernel without
  // `cgroup.kill` (before 5.14; the product's Ubuntu 24.04 has 6.8) gets the
  // members signalled one by one, repeated while any is left, which is what
  // the file does without the atomicity.
  const killAll = async (leaf) => {
    try {
      await fs.writeFile(file(leaf, "cgroup.kill"), "1");
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (let round = 0; round < 50; round += 1) {
      const pids = await procs(leaf);
      if (!pids.length) return;
      for (const pid of pids) { try { kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      await pause(25);
    }
  };

  const remove = async (leaf) => {
    try {
      await fs.rmdir(leaf.path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };

  // M1: the supervisor into its own leaf, then the memory controller for the
  // leaves. Idempotent: a supervisor restarted alone finds its leaf there.
  const enableMemoryControl = async () => {
    const own = path.posix.join(root, SUPERVISOR_LEAF);
    try {
      await fs.mkdir(own);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const residents = String(await fs.readFile(path.posix.join(root, "cgroup.procs"), "utf8"))
      .split("\n").map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
    for (const pid of residents) await fs.writeFile(path.posix.join(own, "cgroup.procs"), pid);
    await fs.writeFile(path.posix.join(root, "cgroup.subtree_control"), "+memory");
  };

  const isolation = {
    mechanism: "cgroup",
    root,
    // Whether each run's leaf has a memory limit and counters of its own.
    memoryLimits: false,

    // Proves the subtree can be written before anything is launched: a leaf is
    // made and removed. A unit without `Delegate=yes`, or a host whose cgroup
    // filesystem is read-only, fails here with the reason, and the supervisor
    // does not start — a run that could not be killed must not be launched.
    async prepare() {
      const probe = leafOf(`probe-${randomUUID()}`);
      try {
        await fs.mkdir(probe.path);
        await fs.rmdir(probe.path);
      } catch (error) {
        throw new Error(
          `the run cgroup root ${root} is not writable (${error?.code ?? error?.message}); `
          + "the supervisor's unit needs Delegate=yes on a cgroup v2 host, or RUNTIME_CGROUP_ROOT must name a writable cgroup",
        );
      }
      if (!memoryControl) return;
      try {
        await enableMemoryControl();
        isolation.memoryLimits = true;
        log({ type: "run_cgroup.memory_limits", enabled: true, supervisor_leaf: SUPERVISOR_LEAF });
      } catch (error) {
        log({ type: "run_cgroup.memory_limits", enabled: false, error: error?.code ?? error?.message });
      }
    },

    // A supervisor that died took its runs with it — they were in its unit's
    // cgroup — but the leaves it made are still there, and if this is not a
    // restart of the unit but of the process alone, they may still be
    // populated. Every leaf is killed, waited for, and removed.
    async sweep() {
      let entries;
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch (error) {
        throw new Error(`the run cgroup root ${root} cannot be listed: ${error?.code ?? error?.message}`);
      }
      const swept = [];
      for (const entry of entries) {
        if (!entry.isDirectory?.() || !LEAF_PATTERN.test(entry.name)) continue;
        const leaf = leafOf(entry.name);
        const wasPopulated = await populated(leaf);
        if (wasPopulated) {
          await killAll(leaf);
          if (!await emptyBy(leaf, Date.now() + 5_000)) {
            throw new Error(`stale run cgroup ${leaf.name} still has members after SIGKILL`);
          }
        }
        await remove(leaf);
        swept.push({ cgroup: leaf.name, populated: wasPopulated });
      }
      return swept;
    },

    // A leaf, with its memory limit written before anything joins it. A limit
    // that cannot be written is a run that is not started: the leaf goes and
    // the launch fails, rather than running unbounded under a claimed limit.
    async create(name, { memoryMaxBytes = null } = {}) {
      const leaf = leafOf(name);
      await fs.mkdir(leaf.path);
      if (isolation.memoryLimits && Number.isFinite(memoryMaxBytes) && memoryMaxBytes > 0) {
        try {
          await fs.writeFile(file(leaf, "memory.max"), String(Math.floor(memoryMaxBytes)));
          // No swap to hide in: past its limit a run is killed, not slowed.
          await fs.writeFile(file(leaf, "memory.swap.max"), "0").catch((error) => { if (error?.code !== "ENOENT") throw error; });
        } catch (error) {
          await remove(leaf).catch(() => {});
          throw new Error(`the run's memory limit could not be set on ${leaf.name}: ${error?.code ?? error?.message}`);
        }
      }
      return leaf;
    },

    // What the kernel counted for a leaf: its limit, its peak and whether the
    // OOM killer acted inside it. Null without the memory controller.
    async memoryStats(leaf) {
      if (!isolation.memoryLimits) return null;
      const read = (entry) => fs.readFile(file(leaf, entry), "utf8").catch(() => "");
      const [max, peak, events] = await Promise.all([read("memory.max"), read("memory.peak"), read("memory.events")]);
      const count = (key) => Number(new RegExp(`^${key} (\\d+)$`, "m").exec(String(events))?.[1] ?? 0);
      const stats = {
        memory_limit_mb: memoryNumber(max) === null ? null : Math.round(memoryNumber(max) / MB),
        memory_peak_mb: memoryNumber(peak) === null ? null : Math.round(memoryNumber(peak) / MB),
        oom_kill: count("oom_kill"),
      };
      if (stats.oom_kill > 0) log({ type: "run_cgroup.oom_killed", cgroup: leaf.name, ...stats });
      return stats;
    },

    // A leaf known by name alone — from a process_ref — without making it.
    leafNamed: leafOf,

    // The command, wrapped so its first act is to join the leaf.
    launcher(leaf, command, args) {
      return ["/bin/sh", ["-c", LAUNCHER, file(leaf, "cgroup.procs"), command, ...args]];
    },

    // Spawns `command` in the leaf. The child is the launcher, which becomes
    // the command by `exec`, so `child.pid` is the runtime's pid.
    launch(leaf, command, args, options = {}) {
      const [launcher, argv] = isolation.launcher(leaf, command, args);
      return spawnProcess(launcher, argv, options);
    },

    // The record a run keeps of itself in the database.
    refOf(leaf, pid) {
      return `runtime-supervisor:${pid}:${leaf.name}`;
    },

    procs,
    populated,

    // Whether a run named by a leaf is still doing anything. Fail-closed: only
    // a leaf that is absent or empty is gone; a leaf that cannot be read is
    // alive, because the alternative is deleting a workspace under a writer.
    async alive(name) {
      let leaf;
      try { leaf = leafOf(name); } catch { return true; }
      try {
        return await populated(leaf);
      } catch (error) {
        log({ type: "run_cgroup.unreadable", cgroup: name, error: error?.code ?? error?.message });
        return true;
      }
    },

    // A signal to every member. SIGKILL goes through `cgroup.kill`, which is
    // atomic over forks; anything else is delivered pid by pid, since the
    // kernel offers no file for it.
    async signal(leaf, signal = "SIGTERM") {
      if (signal === "SIGKILL") return killAll(leaf);
      let pids;
      try {
        pids = await procs(leaf);
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      for (const pid of pids) { try { kill(pid, signal); } catch { /* already gone */ } }
    },

    // Ends a run and waits until nothing of it is left. SIGTERM, one grace
    // period for the whole tree, then `cgroup.kill`, then the wait that makes
    // "stopped" true. `child`, when given, is the launcher: its close is the
    // early sign that the grace need not run out, but not the end — the
    // members finish dying on their own schedule, and the leaf says when.
    async stop(leaf, { child = null, graceMs = 2_000, killWaitMs = 5_000 } = {}) {
      const graceDeadline = Date.now() + graceMs;
      await isolation.signal(leaf, "SIGTERM");
      if (child && child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          new Promise((resolve) => child.once("close", resolve)),
          pause(graceMs),
        ]);
      }
      if (await emptyBy(leaf, graceDeadline)) return { escalated: false };
      await killAll(leaf);
      if (!await emptyBy(leaf, Date.now() + killWaitMs)) {
        throw new Error(`run cgroup ${leaf.name} still has members after SIGKILL`);
      }
      return { escalated: true };
    },

    // The run is over — its process has exited — and the leaf goes. Whatever is
    // still in it after a short grace is exactly what this exists for: a tool
    // that outlived the runtime. It is killed and counted. The grace is for
    // members that are exiting as the runtime does — a tool ending on the same
    // SIGTERM — so that an ordinary end is not reported as leftovers.
    async release(leaf, { graceMs = 250, killWaitMs = 5_000 } = {}) {
      let leftovers = 0;
      if (!await emptyBy(leaf, Date.now() + graceMs)) {
        try { leftovers = (await procs(leaf)).length || 1; } catch { leftovers = 1; }
        await killAll(leaf);
        if (!await emptyBy(leaf, Date.now() + killWaitMs)) {
          throw new Error(`run cgroup ${leaf.name} still has members after SIGKILL`);
        }
        log({ type: "run_cgroup.leftovers_killed", cgroup: leaf.name, processes: leftovers });
      }
      await remove(leaf);
      return { leftovers };
    },

    // For a leaf known by name alone — a process_ref from the database.
    async stopByName(name, options) {
      const leaf = leafOf(name);
      await isolation.stop(leaf, options);
      await isolation.release(leaf);
    },
  };
  return isolation;
}

// The isolation the previous release had: the process group, signalled with
// `kill(-pgid)`. It exists for one place — the gate's container, whose cgroup
// filesystem is read-only, where the end-to-end suite runs the real supervisor
// — and is chosen only by `RUNTIME_RUN_ISOLATION=process_group`, which no unit
// sets. It records the pid-only process_ref, so a liveness question about its
// runs is answered the old way, by pid. The supervisor says at startup that it
// is running with it.
export function createProcessGroupIsolation({ spawnProcess = spawn, kill = (pid, signal) => process.kill(pid, signal) } = {}) {
  const isolation = {
    mechanism: "process_group",
    root: null,
    async prepare() {},
    async sweep() { return []; },
    async create(name) {
      if (!LEAF_PATTERN.test(name)) throw new Error(`a run cgroup is named <kind>-<uuid>, not ${JSON.stringify(name)}`);
      return { name, path: null, child: null };
    },
    leafNamed(name) { return { name, path: null, child: null }; },
    launcher(leaf, command, args) { return [command, args]; },
    launch(leaf, command, args, options = {}) {
      leaf.child = spawnProcess(command, args, { ...options, detached: true });
      return leaf.child;
    },
    refOf(leaf, pid) { return `runtime-supervisor:${pid}`; },
    async alive() { return true; },
    async signal(leaf, signal = "SIGTERM") {
      const child = leaf.child;
      if (!child || !Number.isInteger(child.pid)) return;
      try { kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
    },
    async stop(leaf, { child = leaf.child, graceMs = 2_000, killWaitMs = 5_000 } = {}) {
      if (!child) return { escalated: false };
      await stopProcessGroup(child, { graceMs, killWaitMs });
      return { escalated: null };
    },
    async release() { return { leftovers: 0 }; },
    async stopByName() { throw new Error("a process group cannot be stopped by name"); },
  };
  return isolation;
}

// What the supervisor uses, from its environment: the cgroup by default, its
// root derived from the supervisor's own cgroup unless RUNTIME_CGROUP_ROOT
// names one; the process group only when asked for by name.
export function runIsolationFromEnvironment(env = process.env, { log = () => {} } = {}) {
  const mode = env.RUNTIME_RUN_ISOLATION ?? "cgroup";
  if (mode === "process_group") return createProcessGroupIsolation();
  if (mode !== "cgroup") throw new Error(`RUNTIME_RUN_ISOLATION must be cgroup or process_group, not ${JSON.stringify(mode)}`);
  return createRunCgroups({ root: env.RUNTIME_CGROUP_ROOT || ownCgroupPath(), log,
    memoryControl: env.RUNTIME_RUN_MEMORY_LIMITS !== "off" });
}
