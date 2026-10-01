// Qualifying a runtime version on this host (Stage 12 W3,
// docs/RUNTIMES_AND_MODELS_DESIGN.md §3.2).
//
// A candidate is installed beside the active version — never instead of it —
// and put through a fixed list of checks, one per capability its driver
// claims, so nothing a driver promises goes unchecked. The result is derived by
// the database: passed only when every check of the suite ran and passed. Only
// a passed qualification may promote a version (W4).
//
// W3a runs the checks that need no model: the host's requirements, the
// package's signature, the executable's digest and its version as the runtime's
// own user. The checks that run turns (W3b) are recorded as skipped, which
// leaves the qualification incomplete — it cannot promote anything yet, and it
// says so.

import { readFileSync } from "node:fs";

import { adapterFor, assertExactVersion, hostRequirementsOf } from "./runtime-adapters.mjs";
import { readRuntimes } from "./runtime-inventory.mjs";
import { installRuntime, probeHostRequirement } from "./runtime.mjs";
import { driverFor } from "../runtime-supervisor/drivers/index.mjs";

// The suite, in the order it runs. `capability` ties a check to what a driver
// claims; a check without one applies to every runtime.
export const QUALIFICATION_CHECKS = Object.freeze([
  { key: "host.requirements" },
  { key: "package.signature" },
  { key: "executable.digest" },
  { key: "version.reports" },
  { key: "config.keys" },
  { key: "auth.present" },
  { key: "read_only.shell", capability: "run.read_only" },
  // Stage 12 M0: the model's tools cannot read the login beside them.
  { key: "login.isolated", capability: "run.read_only" },
  { key: "write.commit", capability: "run.workspace_write" },
  { key: "tools.platform", capability: "tools.platform" },
  { key: "tools.report", capability: "tools.worker_report" },
  { key: "stream.parse", capability: "stream.structured" },
  { key: "usage.report", capability: "usage.report" },
  { key: "session.resume", capability: "sessions.resume" },
  { key: "session.resume_from_active", capability: "sessions.resume" },
  { key: "interrupt", capability: "interrupt" },
  { key: "catalog.list", capability: "catalog.models" },
  { key: "models.in_use", capability: "gate.smoke" },
]);

// The checks W3a runs; the rest are recorded as skipped until W3b builds them.
const BUILT = new Set(["host.requirements", "package.signature", "executable.digest", "version.reports"]);

export function suiteFor(driver) {
  const claimed = new Set(Object.keys(driver.capabilities ?? {}));
  return QUALIFICATION_CHECKS.filter((check) => !check.capability || claimed.has(check.capability));
}

// What the result depends on, as facts: read, bounded, never a secret.
export function hostFacts({ readFile = readFileSync } = {}) {
  const read = (file) => {
    try { return readFile(file, "utf8").trim().slice(0, 200); } catch { return null; }
  };
  return {
    lsm: read("/sys/kernel/security/lsm"),
    kernel: read("/proc/sys/kernel/osrelease"),
    apparmor_restrict_unprivileged_userns: read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
  };
}

// Runs one qualification. `recorder` is where the evidence goes (the database
// on a host, a list in a test); `install` is the candidate install.
export async function qualifyRuntime({
  name, version, actor, reporter, recorder, releaseVersion,
  install = (options) => installRuntime({ ...options, activate: false }),
  hostProbe = probeHostRequirement,
  facts = hostFacts(),
  now = () => Date.now(),
  inventory = () => readRuntimes().runtimes,
  turns = null,
}) {
  const adapter = adapterFor(name);
  assertExactVersion(version);
  const active = inventory()[name]?.active ?? null;
  if (!active) throw new Error(`${name} has no active version on this host; a candidate is qualified beside one`);
  const driver = driverFor(name);
  const suite = suiteFor(driver);
  const id = await recorder.begin({ runtime: name, version, adapterVersion: driver.verified.adapterVersion, releaseVersion, actor, facts });
  const results = [];
  const record = async (key, result, { failureClass = "", detail = "", evidence = {}, started = now() } = {}) => {
    const check = suite.find((entry) => entry.key === key);
    const row = { key, capability: check?.capability ?? "", result, failureClass, durationMs: Math.max(0, now() - started), detail: String(detail).slice(0, 1000), evidence };
    results.push(row);
    await recorder.check(id, row);
    reporter.step(`${result === "passed" ? "✓" : result === "failed" ? "✗" : "·"} ${key}${detail ? ` — ${String(detail).split("\n")[0].slice(0, 160)}` : ""}`);
  };
  const finish = async ({ refused = false, summary = "" } = {}) => {
    const outcome = await recorder.finish(id, { suite: suite.map((check) => check.key), refused, summary });
    return { id, runtime: name, version, active: active.version, result: outcome.result, checks: results, summary };
  };

  // Host requirements first: a version that needs what this host lacks is
  // refused before a byte of it is downloaded.
  let started = now();
  const needed = hostRequirementsOf(adapter, version);
  const unmet = needed.map((entry) => ({ ...entry, ...hostProbe(entry.requirement, adapter) })).filter((entry) => !entry.met);
  if (unmet.length > 0) {
    const detail = unmet.map((entry) => `${entry.requirement}: ${entry.detail}`).join("; ");
    await record("host.requirements", "failed", { failureClass: "host", detail, evidence: { unmet: unmet.map((entry) => entry.requirement) }, started });
    return finish({ refused: true, summary: `${name} ${version} needs ${unmet.map((entry) => entry.requirement).join(", ")}, which this host does not provide` });
  }
  await record("host.requirements", "passed", { detail: needed.length ? needed.map((entry) => entry.requirement).join(", ") : "none declared", started });

  // The candidate: resolve, signature, integrity, unpack, digest, smoke test —
  // the install path, stopped before anything is switched.
  started = now();
  let installed;
  try {
    installed = await install({ name, version, actor, reporter });
  } catch (error) {
    const signature = /signature|signed|pinned registry key/i.test(error.message);
    await record(signature ? "package.signature" : "version.reports", "failed", {
      failureClass: signature ? "runtime" : /smoke test/.test(error.message) ? "runtime" : "infrastructure",
      detail: error.message, started,
    });
    return finish({ summary: `the candidate could not be installed: ${error.message.slice(0, 300)}` });
  }
  await record("package.signature", "passed", { detail: `${installed.package}, signed by ${installed.signedBy}`, started });
  await record("executable.digest", "passed", { detail: installed.executableSha256, evidence: { sha256: installed.executableSha256 }, started });
  await record("version.reports", "passed", { detail: installed.smoke, started });

  // The checks that run turns, when a supervisor is there to run them (W3b).
  if (turns) {
    const remaining = suite.filter((check) => !BUILT.has(check.key));
    try {
      await turns({
        name, version, activeVersion: active.version, qualificationId: id, suite: remaining, models: await recorder.modelsInUse(name),
        record: (key, result, options) => record(key, result, options),
      });
    } catch (error) {
      const recorded = new Set(results.map((row) => row.key));
      for (const check of remaining) {
        if (!recorded.has(check.key)) await record(check.key, "inconclusive", { failureClass: "harness", detail: `the checks stopped: ${error.message}` });
      }
    }
  }
  const recorded = new Set(results.map((row) => row.key));
  for (const check of suite) {
    if (recorded.has(check.key)) continue;
    await record(check.key, "skipped", { detail: turns ? "not built yet (Stage 12 W3c)" : "turn checks not run (no supervisor)" });
  }
  const failed = results.filter((row) => row.result === "failed").map((row) => row.key);
  return finish({ summary: failed.length ? `${name} ${version}: ${failed.join(", ")} failed` : `${name} ${version} checked beside ${active.version}` });
}

// Evidence kept in memory: for tests, and for `--no-record`.
export function memoryRecorder() {
  const qualifications = [];
  return {
    qualifications,
    async begin(start) { qualifications.push({ ...start, checks: [] }); return String(qualifications.length); },
    async modelsInUse() { return []; },
    async check(id, row) { qualifications[Number(id) - 1].checks.push(row); },
    async finish(id, { suite, refused }) {
      const { checks } = qualifications[Number(id) - 1];
      const failed = checks.some((check) => check.result === "failed");
      const open = checks.some((check) => check.result === "skipped" || check.result === "inconclusive");
      const missing = suite.some((key) => !checks.some((check) => check.key === key));
      const result = refused ? "refused" : failed ? "failed" : open || missing ? "incomplete" : "passed";
      qualifications[Number(id) - 1].result = result;
      return { result };
    },
  };
}
