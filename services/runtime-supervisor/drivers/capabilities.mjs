// What a runtime driver must be able to do, by the role it plays (WP-5b,
// prework A5).
//
// The registry (runtime-adapters.mjs) says how a runtime is provisioned. A
// driver says how it is *driven*: its sessions, its runs, its stream, its input,
// how it is interrupted, how the platform's tools reach it, and how its native
// events become the product's. The failure this file exists to prevent is the
// shared interface becoming a lowest common denominator — a new runtime that
// connects formally and arrives with its real abilities trimmed off. So:
//
//   * a closed vocabulary of capabilities, each with the sentence it promises;
//   * a mandatory core per role — what an orchestrator must do, what an executor
//     must do — which a driver either declares or is refused;
//   * everything else a driver declares is optional, and can be asked about;
//   * a capability is declared *by* one of the driver's members, and that member
//     must exist — a declaration nothing implements is refused as well;
//   * a driver's capabilities were shown at one exact adapter/runtime version
//     pair, and a different runtime version is unverified until shown again.

// Every member a driver has. All seven, for every runtime: a runtime that cannot
// be interrupted still has to say how it is not, and the core below is what
// decides whether that is acceptable for its role.
export const DRIVER_MEMBERS = Object.freeze([
  "sessions", "run", "stream", "input", "interrupt", "toolBridge", "normalizeEvent",
]);

// The vocabulary. Closed: a capability not named here is a typo or a new idea,
// and either way it is not something the rest of the product can ask about.
export const CAPABILITIES = Object.freeze({
  "sessions.create": "starts a native session and reports its id before the first turn",
  "sessions.resume": "continues a native session by its id through the runtime's own mechanism, never by creating a new one",
  "run.read_only": "runs a turn in a workspace it cannot write",
  "run.workspace_write": "runs in a workspace it writes, under a fenced grant",
  "stream.structured": "reports progress as structured events rather than free text",
  "interrupt": "stops a running turn on request",
  "tools.platform": "calls the control plane's orchestration commands (delegate_task, request_revision)",
  "tools.worker_report": "calls the control plane's terminal worker tools (complete_task, report_blocker, request_user_input)",
  "events.raw": "keeps each native event beside its normalised form, and passes on the ones it does not normalise",
  // Optional — declared where the runtime has them.
  "input.steer": "accepts input into a turn that is still running",
  "input.respond": "answers a structured request inside the turn that asked it, without ending the turn",
  "usage.report": "reports token usage and cost per step",
  "account.device_login": "signs in by a device code, headless",
  "account.api_key": "signs in with a provider key, headless",
  "account.login": "signs in with a code pasted from the browser, headless",
  "catalog.models": "lists the models its credential can use",
  "gate.smoke": "runs the capability gate's smoke test in a scratch workspace",
});

// The core, per role. What the product needs of an orchestrator and of an
// executor in order to run the flow it runs today — nothing that one runtime
// happens to have and the other does not.
export const ROLE_CORE = Object.freeze({
  orchestrator: Object.freeze([
    "sessions.create", "sessions.resume", "run.read_only", "stream.structured",
    "interrupt", "tools.platform", "events.raw",
  ]),
  executor: Object.freeze([
    "sessions.create", "sessions.resume", "run.workspace_write", "stream.structured",
    "interrupt", "tools.worker_report", "events.raw",
  ]),
  // Stage 12 (0147): reads a snapshot and answers once — no session to resume,
  // no tool to call, nothing to write.
  analyst: Object.freeze(["run.read_only", "stream.structured", "interrupt"]),
});

// Each problem as one sentence naming the driver and what it is missing, like
// registryGaps: the list is the work.
export function driverProblems(driver, { roles = [] } = {}) {
  const problems = [];
  const name = driver?.name ?? "(unnamed driver)";
  for (const member of DRIVER_MEMBERS) {
    const value = driver?.[member];
    const ok = member === "normalizeEvent" ? typeof value === "function" : value && typeof value === "object";
    if (!ok) problems.push(`${name} has no ${member}`);
  }
  const declared = driver?.capabilities ?? {};
  for (const [capability, how] of Object.entries(declared)) {
    if (!Object.hasOwn(CAPABILITIES, capability)) {
      problems.push(`${name} declares ${capability}, which is not a capability this product knows`);
      continue;
    }
    if (!DRIVER_MEMBERS.includes(how?.by)) {
      problems.push(`${name} declares ${capability} by ${JSON.stringify(how?.by)}, which is not a driver member`);
    } else if (!driver?.[how.by]) {
      problems.push(`${name} declares ${capability} by ${how.by}, and has no ${how.by}`);
    }
    if (typeof how?.native !== "string" || how.native.length === 0) {
      problems.push(`${name} declares ${capability} without naming the native mechanism`);
    }
  }
  for (const role of roles) {
    const core = ROLE_CORE[role];
    if (!core) {
      problems.push(`${name} plays ${role}, which has no capability core`);
      continue;
    }
    for (const capability of core) {
      if (!Object.hasOwn(declared, capability)) {
        problems.push(`${name} plays ${role} and does not declare ${capability}, which every ${role} must`);
      }
    }
  }
  problems.push(...verificationProblems(driver));
  return problems;
}

// A capability is verified at one pair. The pair is exact, like every version
// this installation handles (assertExactVersion): a range would be a claim
// about versions nobody ran.
function verificationProblems(driver) {
  const name = driver?.name ?? "(unnamed driver)";
  const verified = driver?.verified;
  const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  if (!verified || typeof verified !== "object") return [`${name} names no verified adapter/runtime version pair`];
  const problems = [];
  if (!exact.test(String(verified.adapterVersion ?? ""))) problems.push(`${name}'s verified adapterVersion is not exact`);
  if (!exact.test(String(verified.runtimeVersion ?? ""))) problems.push(`${name}'s verified runtimeVersion is not exact`);
  for (const capability of Object.keys(driver.capabilities ?? {})) {
    const evidence = verified.evidence?.[capability];
    if (typeof evidence !== "string" || evidence.length === 0) {
      problems.push(`${name} declares ${capability} with no evidence at ${pairOf(driver)}`);
    }
  }
  for (const capability of Object.keys(verified.evidence ?? {})) {
    if (!Object.hasOwn(driver.capabilities ?? {}, capability)) {
      problems.push(`${name} has evidence for ${capability} at ${pairOf(driver)} and does not declare it`);
    }
  }
  return problems;
}

export function pairOf(driver) {
  return `${driver.name} adapter ${driver.verified?.adapterVersion} / runtime ${driver.verified?.runtimeVersion}`;
}

// Whether a runtime version is the one the driver was shown to work with.
// Anything else — a patch release included — is `unverified`, and says which
// pair would make it verified. Reported, not refused: RUNTIME_CONTRACT §13
// blocks only an unknown *major* version, and doctor is where an operator reads
// the difference.
// Verified two ways (Stage 12 W3c, RUNTIMES_AND_MODELS_DESIGN §3.3): the
// driver's baseline — the pair its code was proven at, in the gate and at
// release ("automated proof") — or a complete passed qualification of that
// exact version on this host, under this adapter version ("live proof"),
// recorded by root in the inventory. A qualification made under another
// adapter version does not count: the driver changed since.
export function capabilityVerification(driver, runtimeVersion, { qualification = null } = {}) {
  const baseline = typeof runtimeVersion === "string" && runtimeVersion === driver.verified.runtimeVersion;
  const qualified = !baseline && typeof runtimeVersion === "string"
    && qualification?.result === "passed"
    && qualification.version === runtimeVersion
    && qualification.adapterVersion === driver.verified.adapterVersion;
  return {
    runtime: driver.name,
    adapter_version: driver.verified.adapterVersion,
    runtime_version: runtimeVersion ?? null,
    verified_runtime_version: driver.verified.runtimeVersion,
    status: baseline || qualified ? "verified" : "unverified",
    verified_by: baseline ? "baseline" : qualified ? `host qualification ${qualification.id}` : null,
  };
}

// The qualification recorded on the installation the inventory names as active.
export function activeQualification(entry) {
  const installation = (entry?.installed ?? []).find((installed) => installed.directory === entry?.active?.directory);
  return installation?.qualification ?? null;
}

export function hasCapability(driver, capability) {
  if (!Object.hasOwn(CAPABILITIES, capability)) throw new Error(`unknown capability ${JSON.stringify(capability)}`);
  return Object.hasOwn(driver.capabilities ?? {}, capability);
}

// What a driver declares beyond the core of the roles it plays: the part the
// abstraction must not trim, listed so that the panel and the control plane
// can ask for it by name.
export function optionalCapabilities(driver, roles) {
  const core = new Set(roles.flatMap((role) => ROLE_CORE[role] ?? []));
  return Object.keys(driver.capabilities ?? {}).filter((capability) => !core.has(capability)).sort();
}

// Refused at the boundary, with the product reason a caller can branch on.
export function assertCapability(driver, capability) {
  if (!hasCapability(driver, capability)) {
    throw Object.assign(new Error(`${driver.name} does not declare ${capability}`), {
      code: "capability_not_declared", retryable: false,
    });
  }
}
