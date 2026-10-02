// The runtime drivers, keyed like the registry (WP-5b).
//
// The registry says what a runtime is and where it lives; this says how it is
// driven. The two are kept one-to-one: an adapter with no driver is a runtime
// the installation provisions and cannot run, a driver with no adapter runs
// something nobody installed, and a driver that lacks its role's core is the
// abstraction trimming a runtime's abilities. Each is refused when this module
// is loaded — before the supervisor listens, before a worker claims a job.

import { allAdapters } from "../../operations/runtime-adapters.mjs";
import { driverProblems } from "./capabilities.mjs";
import { claudeDriver } from "./claude.mjs";
import { codexDriver } from "./codex.mjs";
import { opencodeDriver } from "./opencode.mjs";

// How the supervisor can carry a surface: a channel the client drives, a batch
// run the supervisor drives to the end, or a loopback server it starts for one
// account operation.
export const SURFACE_TRANSPORTS = Object.freeze(["channel", "batch", "local_server"]);

const DRIVERS = Object.freeze({
  codex: codexDriver,
  opencode: opencodeDriver,
  claude: claudeDriver,
});

// Pure in both lists, like registryGaps, so a test can hand it a fictional
// runtime or a driver with a capability taken away and read what is refused.
export function driverGaps({ adapters, drivers }) {
  const gaps = [];
  const byName = new Map(drivers.map((driver) => [driver.name, driver]));
  for (const adapter of adapters) {
    const driver = byName.get(adapter.name);
    if (!driver) {
      gaps.push(`${adapter.name} is provisioned and has no runtime driver`);
      continue;
    }
    gaps.push(...driverProblems(driver, { roles: adapter.roles ?? [] }));
    if (driver.executable !== adapter.executable) {
      gaps.push(`${adapter.name}'s driver launches ${driver.executable}, and the registry installs ${adapter.executable}`);
    }
    for (const [surface, spec] of Object.entries(driver.surfaces ?? {})) {
      if (!SURFACE_TRANSPORTS.includes(spec.transport)) {
        gaps.push(`${adapter.name}'s ${surface} surface has an unknown transport ${JSON.stringify(spec.transport)}`);
      }
      if (!Object.hasOwn(driver.capabilities ?? {}, spec.capability)) {
        gaps.push(`${adapter.name}'s ${surface} surface exercises ${spec.capability ?? "nothing it names"}, which it does not declare`);
      }
      // The supervisor stops a batch run by killing its cgroup and nothing
      // else (run-cgroup.mjs); a batch driver that said otherwise would be
      // promising an interrupt nobody implements. A driver with channels and
      // batches both (Codex since Stage 12 X2) says so for its batches.
      if (spec.transport === "batch" && driver.interrupt?.mechanism !== "cgroup" && driver.interrupt?.batch !== "cgroup") {
        gaps.push(`${adapter.name}'s ${surface} surface is a batch run, and its interrupt is not the cgroup`);
      }
      // A channel that runs no turn — Claude Code's sign-in — has nothing to
      // interrupt in a protocol; the driver says it is stopped by its cgroup.
      if (spec.transport === "channel" && driver.interrupt?.mechanism !== "protocol" && driver.interrupt?.channel !== "cgroup") {
        gaps.push(`${adapter.name}'s ${surface} surface is a channel, and its interrupt is not in its protocol`);
      }
    }
  }
  const provisioned = new Set(adapters.map((adapter) => adapter.name));
  for (const driver of drivers) {
    if (!provisioned.has(driver.name)) gaps.push(`${driver.name} has a runtime driver and is not provisioned`);
  }
  return gaps;
}

const gaps = driverGaps({ adapters: allAdapters(), drivers: Object.values(DRIVERS) });
if (gaps.length) {
  throw new Error(`the runtime drivers do not match the registry:\n${gaps.join("\n")}`);
}

export function driverFor(name) {
  const driver = DRIVERS[name];
  if (!driver) {
    throw Object.assign(new Error(`no runtime driver for ${JSON.stringify(name)}`), {
      code: "unknown_runtime", retryable: false,
    });
  }
  return driver;
}

export function allDrivers() {
  return Object.values(DRIVERS);
}

// The driver that serves a runtime job, found from the registry's dispatch —
// which is what already decides which runtime a job type belongs to — rather
// than from the job type's spelling.
//
// Only where one runtime serves the type. Since 11.2 N4 two runtimes serve the
// orchestrator's types, and which one runs a turn is the task's assignment
// (orchestrator-worker.mjs reads it from the job's context) — so asking by an
// orchestrator's job type is refused rather than answered with the first.
export function driverForJobType(jobType) {
  const adapters = allAdapters().filter((candidate) => candidate.dispatch?.jobTypes?.includes(jobType));
  if (adapters.length === 0) throw new Error(`no runtime serves the job type ${JSON.stringify(jobType)}`);
  if (adapters.length > 1) {
    throw new Error(`${adapters.length} runtimes serve the job type ${JSON.stringify(jobType)}; the job's assignment says which`);
  }
  return driverFor(adapters[0].name);
}

// The runtime that plays a role, where only one does. Two play the
// orchestrator since 11.2 N4; the assignment says which, and this refuses.
export function driverForRole(role) {
  const adapters = allAdapters().filter((adapter) => adapter.roles.includes(role));
  if (adapters.length !== 1) {
    throw new Error(`${adapters.length} runtimes play ${role}; the caller has to say which`);
  }
  return driverFor(adapters[0].name);
}

// A surface of a driver, or a refusal naming both.
export function surfaceOf(driver, surface) {
  const spec = driver.surfaces[surface];
  if (!spec) {
    throw Object.assign(new Error(`${driver.name} has no ${JSON.stringify(surface)} surface`), {
      code: "unsupported_surface", retryable: false,
    });
  }
  return spec;
}
