// Whether the host has room for one more run (sprint C K3; exit criterion 12).
//
// Two limits bound every run the supervisor starts. The host's memory: a 4 GB
// box carrying the product, PostgreSQL and the runtimes, where the kernel's OOM
// killer is the failure this refuses to rely on. And the unit's own:
// `MemoryMax=1G` counts every runtime process, because they all live in leaves
// of the supervisor's cgroup (run-cgroup.mjs) — past it, the kernel kills
// inside the unit, which is the same failure one level down.
//
// So a launch is admitted only if both leave room for what a run of that
// runtime is expected to take, after a reserve for the host and after what the
// launches admitted a moment ago will still grow into. Otherwise it is refused
// with `runtime_capacity`, before anything is spawned, owned or reserved —
// which is what makes the refusal safe to repeat, and why the workers hand the
// job back to the queue instead of spending an attempt (defer_runtime_job).
//
// The expected size is the registry's (`memoryEstimateMb`), from the PoC and
// the host's measurements; every run records the peak it actually reached
// (watchRunMemory), so the estimate can be checked against what happened.

import { readFile } from "node:fs/promises";
import path from "node:path";

const MB = 1024 * 1024;

export class RuntimeCapacityError extends Error {
  constructor(name, detail, { background = false } = {}) {
    super(background
      ? `there is no memory for a background ${name} run right now (${detail}); it waits so a task run is never short of it`
      : `there is no memory for another ${name} run right now (${detail}); it waits for a run to finish`);
    this.name = "RuntimeCapacityError";
    this.retryable = true;
    this.code = "runtime_capacity";
  }
}

export function parseMemAvailable(meminfo) {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(String(meminfo));
  return match ? Number(match[1]) * 1024 : null;
}

// A cgroup file's number, or null for "max" and for anything unreadable.
function cgroupNumber(text) {
  const value = String(text).trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

export function capacitySettings(env = process.env) {
  const number = (key, fallback) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    hostReserveBytes: number("RUNTIME_MEMORY_RESERVE_MB", 512) * MB,
    unitMarginBytes: number("RUNTIME_UNIT_MEMORY_MARGIN_MB", 64) * MB,
    // How long a launch counts as not yet grown into its estimate.
    growthWindowMs: number("RUNTIME_MEMORY_GROWTH_WINDOW_MS", 45_000),
    enabled: env.RUNTIME_MEMORY_ADMISSION !== "off",
  };
}

// The page cache the kernel gives back first, from a cgroup's memory.stat.
// memory.current counts the unit's file cache with its processes, and the
// supervisor reads and writes runtime trees: after a qualification unpacked a
// 160 MB package the unit read 387 MB "used" with 73 MB of it anonymous, and
// every OpenCode run and catalog refresh was refused for headroom it had
// (rc.110). Inactive file pages are reclaimed before anything is refused.
export function reclaimableBytes(stat) {
  const match = /^inactive_file (\d+)$/m.exec(String(stat ?? ""));
  return match ? Number(match[1]) : 0;
}

// The readings. Injectable, so the rule is tested without a host.
export function hostReadings({ cgroupRoot = null, read = readFile } = {}) {
  return async () => {
    const memAvailable = parseMemAvailable(await read("/proc/meminfo", "utf8").catch(() => ""));
    let unitCurrent = null;
    let unitMax = null;
    if (cgroupRoot) {
      const current = cgroupNumber(await read(path.posix.join(cgroupRoot, "memory.current"), "utf8").catch(() => ""));
      const reclaimable = reclaimableBytes(await read(path.posix.join(cgroupRoot, "memory.stat"), "utf8").catch(() => ""));
      unitCurrent = Number.isFinite(current) ? Math.max(0, current - reclaimable) : current;
      unitMax = cgroupNumber(await read(path.posix.join(cgroupRoot, "memory.max"), "utf8").catch(() => ""));
    }
    return { memAvailable, unitCurrent, unitMax };
  };
}

// The decision, pure: the readings, the settings, the size of this launch and
// of the ones still growing. `headroom` is what is left for this launch.
//
// `hostReserveExtraBytes` is a background run's reserve for a task run after
// it, asked of the host only. The unit's MemoryMax (1 GB on the host) cannot
// hold a check and the largest task run at once — 350 + 600 MB against about
// 940 free — so asking it of the unit refused every check on the host forever
// (rc.85). Inside the unit a check only has to fit; a task that arrives while
// it runs waits for it, as it waits for any other run.
export function capacityDecision({ readings, settings, estimateBytes, growingBytes = 0, hostReserveExtraBytes = 0 }) {
  const limits = [];
  if (Number.isFinite(readings.memAvailable)) {
    limits.push({ limit: "host", headroom: readings.memAvailable - settings.hostReserveBytes - growingBytes, needs: estimateBytes + hostReserveExtraBytes });
  }
  if (Number.isFinite(readings.unitMax) && Number.isFinite(readings.unitCurrent)) {
    limits.push({ limit: "unit", headroom: readings.unitMax - readings.unitCurrent - settings.unitMarginBytes - growingBytes, needs: estimateBytes });
  }
  // Nothing readable is not a reason to refuse every run: the unit's own
  // MemoryMax still holds, and the reading's absence is reported.
  if (!limits.length) return { admit: true, limit: null, headroom: null, estimate: estimateBytes };
  const short = limits.find((entry) => entry.headroom < entry.needs);
  const reported = short ?? limits.reduce((a, b) => (b.headroom - b.needs < a.headroom - a.needs ? b : a));
  return { admit: !short, limit: reported.limit, headroom: reported.headroom, estimate: estimateBytes };
}

// The gate the supervisor asks at every launch. It remembers the launches it
// admitted for the growth window, because a run started a second ago has not
// yet taken the memory it will.
//
// A background run — a model check, a runtime qualification (Stage 12 W6, the
// design's §2.8) — is admitted only if, after it, there is still room for one
// more task run of the largest estimate (`taskReserveBytes`). It never takes
// the memory a task was about to need; it waits instead. The reserve is asked
// of the decision only: what the launch is remembered as growing into is its
// own estimate, so a check admitted a moment ago does not hold back the next
// launch by more than it will take.
export function createCapacityGate({ settings = capacitySettings(), read = hostReadings(), estimateOf, now = Date.now,
  taskReserveBytes = 0 } = {}) {
  const recent = [];
  const growing = () => {
    const cutoff = now() - settings.growthWindowMs;
    while (recent.length && recent[0].at < cutoff) recent.shift();
    return recent.reduce((sum, launch) => sum + launch.bytes, 0);
  };
  return {
    async check(name, { background = false } = {}) {
      const estimateBytes = estimateOf(name);
      if (!settings.enabled) return { admit: true, limit: null, headroom: null, estimate: estimateBytes };
      const reserve = background ? taskReserveBytes : 0;
      const decision = capacityDecision({ readings: await read(), settings, estimateBytes, growingBytes: growing(), hostReserveExtraBytes: reserve });
      if (!decision.admit) {
        throw new RuntimeCapacityError(name,
          `${decision.limit} headroom ${Math.max(0, Math.round(decision.headroom / MB))} MB, a run needs ${Math.round(estimateBytes / MB)} MB`
            + (reserve && decision.limit === "host" ? ` and a task run ${Math.round(reserve / MB)} MB after it` : ""), { background });
      }
      recent.push({ at: now(), bytes: estimateBytes });
      return decision;
    },
    async reading() {
      return { ...(await read()), growing_bytes: growing() };
    },
  };
}

// What a run actually took: the resident memory of every process in its leaf,
// summed, sampled while it runs, and the host's lowest MemAvailable meanwhile.
// Sampled: a sample every two seconds misses a spike shorter than that, and
// says so by its name. Since Stage 12 M1 the leaf also has the kernel's own
// `memory.peak` and `oom_kill` (run-cgroup.mjs memoryStats), reported beside
// this; the sample stays for a host where the memory controller is off.
export function watchRunMemory({ procsOf, readProc = readFile, readMeminfo = () => readFile("/proc/meminfo", "utf8"), intervalMs = 2_000 } = {}) {
  let peakBytes = 0;
  let peakProcesses = 0;
  let minAvailable = null;
  let samples = 0;
  let stopped = false;
  const sample = async () => {
    let pids = [];
    try { pids = await procsOf(); } catch { return; }
    let rss = 0;
    for (const pid of pids) {
      const status = await readProc(`/proc/${pid}/status`, "utf8").catch(() => "");
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(String(status));
      if (match) rss += Number(match[1]) * 1024;
    }
    const available = parseMemAvailable(await readMeminfo().catch(() => ""));
    samples += 1;
    peakBytes = Math.max(peakBytes, rss);
    peakProcesses = Math.max(peakProcesses, pids.length);
    if (Number.isFinite(available)) minAvailable = minAvailable === null ? available : Math.min(minAvailable, available);
  };
  let pending = sample();
  const timer = setInterval(() => { if (!stopped) pending = pending.then(sample); }, intervalMs);
  timer.unref?.();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending.catch(() => {});
      return {
        sampled_peak_rss_mb: Math.round(peakBytes / MB),
        peak_processes: peakProcesses,
        host_mem_available_min_mb: minAvailable === null ? null : Math.round(minAvailable / MB),
        samples,
      };
    },
  };
}
