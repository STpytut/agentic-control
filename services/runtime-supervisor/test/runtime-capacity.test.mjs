// A run waits for memory instead of being OOM-killed (sprint C K3). What this
// holds: the tighter of the host and the unit decides; a launch admitted a
// moment ago counts until it has had time to grow; a refusal is raised before
// anything exists and is the one the workers hand back or wait out; and a run
// records what it took.

import test from "node:test";
import assert from "node:assert/strict";

import { takeLaunchPlace, resetAdmission, inFlightCount } from "../runtime-admission.mjs";
import {
  RuntimeCapacityError, capacityDecision, capacitySettings, createCapacityGate, parseMemAvailable, watchRunMemory,
} from "../runtime-capacity.mjs";
import { deferReasonFor } from "../workspace-grant.mjs";

const MB = 1024 * 1024;
const settings = { hostReserveBytes: 512 * MB, unitMarginBytes: 64 * MB, growthWindowMs: 45_000, enabled: true };

test("the tighter of the host and the unit decides", () => {
  const roomy = { memAvailable: 3000 * MB, unitCurrent: 100 * MB, unitMax: 1024 * MB };
  assert.equal(capacityDecision({ readings: roomy, settings, estimateBytes: 300 * MB }).admit, true);
  // The unit near its MemoryMax: the host has room, the unit does not.
  const unitFull = { memAvailable: 3000 * MB, unitCurrent: 800 * MB, unitMax: 1024 * MB };
  const refused = capacityDecision({ readings: unitFull, settings, estimateBytes: 300 * MB });
  assert.deepEqual([refused.admit, refused.limit], [false, "unit"]);
  // The host short, after its reserve.
  const hostShort = { memAvailable: 700 * MB, unitCurrent: 0, unitMax: 1024 * MB };
  assert.deepEqual(Object.values(capacityDecision({ readings: hostShort, settings, estimateBytes: 300 * MB })).slice(0, 2), [false, "host"]);
  // Nothing readable is not a refusal of every run.
  assert.equal(capacityDecision({ readings: { memAvailable: null, unitCurrent: null, unitMax: null }, settings, estimateBytes: 300 * MB }).admit, true);
  assert.equal(parseMemAvailable("MemTotal: 4009864 kB\nMemAvailable:    2993876 kB\n"), 2993876 * 1024);
  assert.equal(capacitySettings({ RUNTIME_MEMORY_RESERVE_MB: "256" }).hostReserveBytes, 256 * MB);
  assert.equal(capacitySettings({ RUNTIME_MEMORY_ADMISSION: "off" }).enabled, false);
});

test("a launch admitted a moment ago counts until it has had time to grow", async () => {
  let clock = 0;
  // Room for two 300 MB runs by the reading, which does not move yet.
  const gate = createCapacityGate({
    settings, now: () => clock, estimateOf: () => 300 * MB,
    read: async () => ({ memAvailable: (512 + 700) * MB, unitCurrent: null, unitMax: null }),
  });
  await gate.check("claude");
  await gate.check("claude");
  await assert.rejects(gate.check("claude"), (error) => error instanceof RuntimeCapacityError
    && error.code === "runtime_capacity" && error.retryable === true && /no memory for another claude run/.test(error.message));
  clock += 46_000;
  await gate.check("claude");
});

test("a refused launch holds nothing, and is the refusal a worker defers or waits out", async () => {
  resetAdmission();
  const full = { check: async (name) => { throw new RuntimeCapacityError(name, "host headroom 100 MB, a run needs 300 MB"); } };
  let fenced = false;
  await assert.rejects(takeLaunchPlace("opencode", { capacity: full, hold: async () => { fenced = true; return { release() {} }; } }),
    (error) => error.code === "runtime_capacity");
  assert.equal(fenced, false, "the fence is not taken for a launch refused for memory");
  assert.equal(inFlightCount("opencode"), 0, "nor is it counted as in flight");
  assert.equal(deferReasonFor(new RuntimeCapacityError("codex", "x")), "runtime_capacity");
  const place = await takeLaunchPlace("opencode", { capacity: { check: async () => ({ admit: true }) }, hold: async () => ({ release() {} }) });
  assert.equal(inFlightCount("opencode"), 1);
  place.release();
  resetAdmission();
});

// Stage 12 W6 (§2.8): a model check or a qualification is admitted only with
// room left for one more task run of the largest estimate after it; what it is
// remembered as growing into is still only its own estimate.
test("a background run leaves room for one more task run, and holds back only its own size", async () => {
  let reading = (512 + 900) * MB;
  const gate = createCapacityGate({
    settings, now: () => 0, estimateOf: () => 350 * MB, taskReserveBytes: 600 * MB,
    read: async () => ({ memAvailable: reading, unitCurrent: null, unitMax: null }),
  });
  // 900 MB free: a 350 MB check would leave 550, less than a 600 MB task run.
  await assert.rejects(gate.check("codex", { background: true }), (error) => error instanceof RuntimeCapacityError
    && error.code === "runtime_capacity" && /background codex run/.test(error.message) && /task run 600 MB/.test(error.message));
  // The same launch as a task run fits.
  await gate.check("codex");
  // With room for both, the check is admitted, and it counts as 350 MB growing,
  // not 950: a task run of 600 MB still fits right after it.
  reading = (512 + 350 + 350 + 600) * MB;
  await gate.check("codex", { background: true });
  const task = createCapacityGate({ settings, now: () => 0, estimateOf: () => 600 * MB, read: async () => ({ memAvailable: reading, unitCurrent: null, unitMax: null }) });
  await task.check("opencode");
  assert.equal((await gate.reading()).growing_bytes, 700 * MB);
});

test("admission asks the memory gate for a background run as one", async () => {
  resetAdmission();
  const asked = [];
  const capacity = { check: async (name, options) => { asked.push([name, options]); return { admit: true }; } };
  const hold = async () => ({ release() {} });
  (await takeLaunchPlace("codex", { capacity, hold, background: true })).release();
  (await takeLaunchPlace("codex", { capacity, hold })).release();
  assert.deepEqual(asked, [["codex", { background: true }], ["codex", { background: false }]]);
  resetAdmission();
});

test("a run records the peak its processes reached and the host's lowest point", async () => {
  const rss = { 11: 150_000, 12: 60_000 };
  let round = 0;
  const watch = watchRunMemory({
    intervalMs: 5,
    procsOf: async () => (round++ === 0 ? [11] : [11, 12]),
    readProc: async (file) => `Name: x\nVmRSS:\t${rss[Number(file.split("/")[2])]} kB\n`,
    readMeminfo: async () => `MemAvailable: ${round > 1 ? 2_400_000 : 2_900_000} kB\n`,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const memory = await watch.stop();
  assert.equal(memory.sampled_peak_rss_mb, Math.round((210_000 * 1024) / MB));
  assert.equal(memory.peak_processes, 2);
  assert.equal(memory.host_mem_available_min_mb, Math.round((2_400_000 * 1024) / MB));
  assert.ok(memory.samples >= 2);
});

// rc.85 on the host: a 1 GB unit with 19 MB used and 2.9 GB free on the host.
// Asking the unit for a check plus a task run after it refused every check
// forever; the reserve is the host's to hold.
test("a background run's reserve is asked of the host, not of the unit", async () => {
  const MB = 1024 * 1024;
  const gate = createCapacityGate({
    settings: { hostReserveBytes: 512 * MB, unitMarginBytes: 64 * MB, growthWindowMs: 45_000, enabled: true },
    read: async () => ({ memAvailable: 2992 * MB, unitCurrent: 19 * MB, unitMax: 1024 * MB }),
    estimateOf: (name) => ({ codex: 350, opencode: 600 }[name] * MB),
    taskReserveBytes: 600 * MB,
  });
  const admitted = await gate.check("codex", { background: true });
  assert.equal(admitted.admit, true);

  const tight = createCapacityGate({
    settings: { hostReserveBytes: 512 * MB, unitMarginBytes: 64 * MB, growthWindowMs: 45_000, enabled: true },
    read: async () => ({ memAvailable: 1200 * MB, unitCurrent: 19 * MB, unitMax: 1024 * MB }),
    estimateOf: () => 350 * MB,
    taskReserveBytes: 600 * MB,
  });
  await assert.rejects(tight.check("codex", { background: true }), /host headroom 688 MB, a run needs 350 MB and a task run 600 MB after it/);
  // A task run itself is not held to the reserve.
  assert.equal((await tight.check("codex")).admit, true);
});

test("the unit's inactive page cache is not counted as used", async () => {
  // rc.110: 387 MB current, 73 MB anonymous, 203 MB inactive file — every
  // background run refused for headroom the kernel would have made.
  const { hostReadings, reclaimableBytes } = await import("../runtime-capacity.mjs");
  const MB_ = 1024 * 1024;
  assert.equal(reclaimableBytes("anon 76546048\nfile 295698432\ninactive_file 212860928\nactive_file 82837504\n"), 212860928);
  assert.equal(reclaimableBytes(""), 0);
  const files = {
    "/proc/meminfo": "MemAvailable:    2048000 kB\n",
    "/cg/memory.current": `${387 * MB_}\n`,
    "/cg/memory.max": `${1024 * MB_}\n`,
    "/cg/memory.stat": `anon ${73 * MB_}\ninactive_file ${203 * MB_}\n`,
  };
  const readings = await hostReadings({ cgroupRoot: "/cg", read: async (file) => files[file] ?? "" })();
  assert.equal(readings.unitCurrent, 184 * MB_);
  assert.equal(readings.unitMax, 1024 * MB_);
});
