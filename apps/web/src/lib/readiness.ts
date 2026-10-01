// The four prerequisites of every assignment of a project (0088, sprint C U1):
// the read model, and the one pure helper the composer and the page share.
//
// This module imports nothing from the database layer on purpose: the chat
// composer is a client component, and a type or helper it takes from
// product-data.ts would drag `pg` into the browser bundle.
//
// Read through `project_readiness`, which is the database's own reading — the
// one `capture_task_runtime_snapshot` refuses a task with and a launch asks
// again — so the panel cannot say "ready" where the database would say no.
// Each state is carried separately to the markup, and `blockedBy` is the first
// missing prerequisite in the order the operator fixes them, with its reason,
// a sentence and the action.
export type PrerequisiteState = "ready" | "missing" | "unknown";

export type ReadinessBlocker = {
  prerequisite: "runtime_installed" | "runtime_authenticated" | "model_verified" | "connection_connected";
  reason: string;
  message: string;
  action: string;
  note: string;
};

export type AssignmentReadiness = {
  assignmentId: string;
  agentId: string;
  agentName: string;
  role: "orchestrator" | "executor" | "other";
  isDefault: boolean;
  runtime: string;
  runtimeVersion: string | null;
  entryId: string | null;
  modelId: string;
  displayName: string;
  providerId: string;
  runtimeInstalled: PrerequisiteState;
  runtimeAuthenticated: PrerequisiteState;
  modelVerified: PrerequisiteState;
  connectionConnected: PrerequisiteState;
  ready: boolean;
  blockedBy: ReadinessBlocker | null;
};

export type ProjectReadiness = {
  projectId: string;
  observedAt: string | null;
  hasDefaults: boolean;
  /** Whether every conversation holder is ready: what the composer needs to know. */
  ready: boolean;
  assignments: AssignmentReadiness[];
};

// The readiness rows of the assignments a task is bound to, in the task's order.
export function taskAssignmentReadiness(readiness: ProjectReadiness | null | undefined, assignmentIds: string[]): AssignmentReadiness[] {
  if (!readiness) return [];
  return assignmentIds
    .map((id) => readiness.assignments.find((assignment) => assignment.assignmentId === id))
    .filter((assignment): assignment is AssignmentReadiness => Boolean(assignment));
}
