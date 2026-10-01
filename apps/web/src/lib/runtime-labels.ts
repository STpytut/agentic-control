// The name the panel shows for each runtime, and the roles it plays.
//
// A copy of `display.label` and `roles` in services/operations/runtime-adapters.mjs:
// the web tier is its own package and does not import the operations code. The
// two are kept equal by services/operations/test/runtime-registry.test.mjs, so a
// runtime added to or renamed in the registry fails a test until it is added here.
//
// This is the only place in the web tier that names a runtime. What a runtime
// may do in a job is read from the job's recorded provenance (0071); what it can
// be offered for comes from its roles here, never from its name.
export const RUNTIME_LABELS: Readonly<Record<string, string>> = {
  codex: "Codex",
  opencode: "OpenCode",
  claude: "Claude Code",
};

export type RuntimeRole = "orchestrator" | "executor";

export const RUNTIME_ROLES: Readonly<Record<string, readonly RuntimeRole[]>> = {
  codex: ["orchestrator", "executor"],
  opencode: ["orchestrator", "executor"],
  claude: ["orchestrator", "executor"],
};

export function runtimeLabel(value: string) {
  return RUNTIME_LABELS[value] ?? value;
}

export function runtimePlays(runtime: string, role: RuntimeRole) {
  return (RUNTIME_ROLES[runtime] ?? []).includes(role);
}

// Every runtime the registry declares, in its order.
export function knownRuntimes() {
  return Object.keys(RUNTIME_LABELS);
}

// The runtime that plays a role, for the demo page without a database.
export function runtimeForRole(role: RuntimeRole) {
  return knownRuntimes().find((runtime) => runtimePlays(runtime, role)) ?? "";
}
