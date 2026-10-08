// Which models the Team picker offers for a role, and in which group (Stage 12
// W7; docs/RUNTIMES_AND_MODELS_DESIGN.md §2.5, §2.7): ready on the role's
// runtimes; not checked yet; not available for this role, with the reason.
//
// Pure, and with type-only imports, so services/control-plane/test can load it
// as it is. The words (runtime labels, held-back reasons) are passed in.
//
// Two sources, one entry each: `project_team` (0089) — what the database will
// accept for each role today, and why not the rest — and `get_operator_models`
// (the W6 contract) — the pinned, in-use and small-list models with their
// check state, plus whatever the operator searched for. A ready model the team
// read already offers wins over the same entry from the check list.
import type { ProjectTeam, TeamAssignment, TeamModel } from "@/lib/team";
import type { ModelRow, OperatorModels } from "@/lib/models";

export type PickerMode = { kind: "add" } | { kind: "change"; assignment: TeamAssignment } | { kind: "analyst" };
// The picker for an analyst's model (0147).
export const ANALYST_PICKER: PickerMode = Object.freeze({ kind: "analyst" });

export type Words = { runtime: (runtime: string) => string; heldBack: Record<string, string>; gateway?: Record<string, string> };

export type Candidate = {
  entryId: string; name: string; modelId: string; runtime: string; where: string; billing: string;
  group: "ready" | "unchecked" | "unavailable"; row: ModelRow | null; why: string | null; current: boolean;
  /** What a Claude alias resolves to ("claude-opus-5"), from the check list; null for other models. */
  resolved: string | null;
};

export type PickerRole = "orchestrator" | "executor" | "analyst";

export function roleOf(mode: PickerMode): PickerRole {
  if (mode.kind === "analyst") return "analyst";
  return mode.kind === "change" && mode.assignment.roleKey === "orchestrator" ? "orchestrator" : "executor";
}

// An analyst (0147) needs what an executor's model needs — verified, its
// connection connected — on a runtime that plays the analyst, which
// `allowed` checks from the runtimes' roles.
function teamUnavailable(model: TeamModel, role: PickerRole) {
  if (role === "analyst") return model.executorUnavailable === "runtime_cannot_play_role" ? null : model.executorUnavailable;
  return role === "orchestrator" ? model.orchestratorUnavailable : model.executorUnavailable;
}

export function candidatesFor(team: ProjectTeam, models: OperatorModels | null, mode: PickerMode, words: Words,
  searched: ModelRow[] = [], searchedRuntime: Record<string, string> = {}): Candidate[] {
  const runtimeLabel = words.runtime;
  const HELD_BACK_WORDS = words.heldBack;
  const role = roleOf(mode);
  const runtimePlays = (runtime: string) => team.runtimes.find((entry) => entry.runtime === runtime)?.plays.includes(role) ?? false;
  const allowed = (runtime: string) => (mode.kind === "change" ? runtime === mode.assignment.runtime : runtimePlays(runtime));
  const currentEntry = mode.kind === "change" ? mode.assignment.entryId : "";
  const executorsInUse = new Set(team.assignments.filter((a) => a.roleKey === "executor").map((a) => a.entryId));
  const out = new Map<string, Candidate>();
  // The team's read names a model by its alias; the check list knows what it resolves to.
  const resolved = new Map<string, string>();
  for (const row of [...(models?.connections ?? []).flatMap((connection) => connection.models), ...searched]) {
    if (row.resolvedModel && row.resolvedModel !== row.modelId) resolved.set(row.entryId, row.resolvedModel);
  }

  for (const model of team.models) {
    const why = teamUnavailable(model, role);
    if (mode.kind === "add" && executorsInUse.has(model.entryId)) continue;
    const base = { entryId: model.entryId, name: model.displayName || model.modelId, modelId: model.modelId, runtime: model.runtime,
      where: (model.gateway && (words.gateway?.[model.gateway] ?? model.gateway)) || runtimeLabel(model.runtime), billing: model.billing, row: null, current: model.entryId === currentEntry,
      resolved: resolved.get(model.entryId) ?? null };
    if (why === null && allowed(model.runtime)) out.set(model.entryId, { ...base, group: "ready", why: null });
    else if (why === "runtime_cannot_play_role" || why === "runtime_lacks_capability" || (why === null && !allowed(model.runtime))) {
      out.set(model.entryId, { ...base, group: "unavailable",
        why: why === "runtime_cannot_play_role" ? `${runtimeLabel(model.runtime)} cannot hold this role`
          : why ? `${runtimeLabel(model.runtime)}: ${HELD_BACK_WORDS[why] ?? why}` : `another runtime than this member’s (${runtimeLabel(model.runtime)})` });
    }
  }

  const consider = (row: ModelRow, runtime: string, where: string, billing: string) => {
    if (out.has(row.entryId)) return;
    if (mode.kind === "add" && executorsInUse.has(row.entryId)) return;
    const base = { entryId: row.entryId, name: row.displayName || row.modelId, modelId: row.modelId, runtime, where, billing, row,
      current: row.entryId === currentEntry, resolved: resolved.get(row.entryId) ?? null };
    if (!allowed(runtime)) {
      out.set(row.entryId, { ...base, group: "unavailable",
        why: mode.kind === "change" && runtimePlays(runtime) ? `another runtime than this member’s (${runtimeLabel(runtime)})`
          : `${runtimeLabel(runtime)} cannot hold this role` });
    } else {
      out.set(row.entryId, { ...base, group: row.state === "ready" ? "ready" : "unchecked", why: null });
    }
  };
  for (const connection of models?.connections ?? []) {
    for (const row of connection.models) consider(row, connection.runtimeType, connection.label || connection.provider, connection.billing);
  }
  for (const row of searched) {
    const connection = models?.connections.find((entry) => entry.connectionId === searchedRuntime[row.entryId]);
    if (connection) consider(row, connection.runtimeType, connection.label || connection.provider, connection.billing);
  }
  return [...out.values()];
}

