// The project's team as the Team tab shows it (sprint C U2; exit criterion 10).
//
// Pure types and parsing, no database import: the tab is a client component.
// The shape is the database's own answer, `project_team` (0089) — the models
// an operator may pick for each role and, for the rest, the reason they are
// held back — so the tab never invents an option the database would refuse.

import { reasoningLevelsFrom, type ReasoningLevel } from "@/lib/reasoning";

type Json = Record<string, unknown>;

export type TeamRole = { id: string; key: string; name: string; permissions: string[]; capabilities: string[] };
export type TeamRuntime = { runtime: string; capabilities: string[]; plays: string[] };
export type TeamAssignment = {
  assignmentId: string; agentName: string; runtime: string; roleKey: string; roleName: string;
  isDefault: boolean; entryId: string; modelId: string; displayName: string; openTasks: number;
};
export type TeamModel = {
  entryId: string; runtime: string; modelId: string; displayName: string;
  gateway: string; vendor: string; billing: string;
  orchestratorUnavailable: string | null; executorUnavailable: string | null;
};
export type TeamHeldBack = { runtime: string; reason: string; count: number };
// Stage 12 (0111, project_team_reasoning): each member's level — null is the
// runtime's default — and whether its model still lists it; each offered
// model's levels and default, by entry.
export type TeamReasoning = {
  members: Record<string, { level: string | null; supported: boolean }>;
  models: Record<string, { levels: ReasoningLevel[]; defaultLevel: string | null }>;
};
export type ProjectTeam = {
  projectId: string; managed: boolean; version: number;
  roles: TeamRole[]; runtimes: TeamRuntime[]; assignments: TeamAssignment[];
  models: TeamModel[]; heldBack: TeamHeldBack[]; reasoning: TeamReasoning;
};

const strings = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
const text = (value: unknown) => (typeof value === "string" ? value : "");

function teamReasoningFrom(value: unknown): TeamReasoning {
  const row = value && typeof value === "object" ? value as Json : {};
  const list = (key: string) => (Array.isArray(row[key]) ? (row[key] as Json[]) : []);
  return {
    members: Object.fromEntries(list("assignments").map((member) => [text(member.assignment_id), {
      level: typeof member.reasoning_effort === "string" && member.reasoning_effort ? member.reasoning_effort : null,
      supported: member.supported !== false,
    }])),
    models: Object.fromEntries(list("models").map((model) => [text(model.entry_id), {
      levels: reasoningLevelsFrom(model.levels),
      defaultLevel: typeof model.default === "string" && model.default ? model.default : null,
    }])),
  };
}

export function projectTeamFromRow(row: Json): ProjectTeam {
  const list = (key: string) => (Array.isArray(row[key]) ? (row[key] as Json[]) : []);
  return {
    projectId: text(row.project_id),
    managed: row.managed === true,
    version: Number(row.version ?? 0),
    roles: list("roles").map((role) => ({ id: text(role.id), key: text(role.key), name: text(role.name),
      permissions: strings(role.permissions), capabilities: strings(role.capabilities) })),
    runtimes: list("runtimes").map((runtime) => ({ runtime: text(runtime.runtime),
      capabilities: strings(runtime.capabilities), plays: strings(runtime.plays) })),
    assignments: list("assignments").map((assignment) => ({
      assignmentId: text(assignment.assignment_id), agentName: text(assignment.agent_name), runtime: text(assignment.runtime),
      roleKey: text(assignment.role_key), roleName: text(assignment.role_name), isDefault: assignment.is_default === true,
      entryId: text(assignment.entry_id), modelId: text(assignment.model_id), displayName: text(assignment.display_name),
      openTasks: Number(assignment.open_tasks ?? 0),
    })),
    models: list("models").map((model) => ({
      entryId: text(model.entry_id), runtime: text(model.runtime), modelId: text(model.model_id),
      displayName: text(model.display_name), gateway: text(model.gateway), vendor: text(model.vendor), billing: text(model.billing),
      orchestratorUnavailable: typeof model.orchestrator_unavailable === "string" ? model.orchestrator_unavailable : null,
      executorUnavailable: typeof model.executor_unavailable === "string" ? model.executor_unavailable : null,
    })),
    heldBack: list("held_back").map((held) => ({ runtime: text(held.runtime), reason: text(held.reason), count: Number(held.count ?? 0) })),
    reasoning: teamReasoningFrom(row.reasoning),
  };
}

// Why a model is not offered, in the operator's words, with where to fix it.
export const HELD_BACK_WORDS: Record<string, string> = {
  connection_not_connected: "their connection is not connected — reconnect it in Settings",
  model_not_verified: "they are not verified — update the model list and verify them in Settings",
  runtime_cannot_play_role: "their runtime cannot play this role",
  runtime_lacks_capability: "their runtime lacks a capability the role needs",
};
