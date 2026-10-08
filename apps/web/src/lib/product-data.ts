import { hasDatabaseConnection, queryJsonRows } from "@/lib/database";
import { projectTeamFromRow, type ProjectTeam } from "@/lib/team";
import { reasoningLevelsFrom, type ReasoningLevel } from "@/lib/reasoning";
import type { ActionTarget } from "@/lib/control-plane";
import type { TaskUsage } from "@/lib/usage";
import { getTaskUsage } from "@/lib/usage-data";
import { knownRuntimes, runtimeForRole, runtimeLabel, runtimePlays } from "@/lib/runtime-labels";
import type { AssignmentReadiness, PrerequisiteState, ProjectReadiness, ReadinessBlocker } from "@/lib/readiness";
export type { AssignmentReadiness, PrerequisiteState, ProjectReadiness, ReadinessBlocker } from "@/lib/readiness";
export { taskAssignmentReadiness } from "@/lib/readiness";

type Json = Record<string, unknown>;

export type ProjectSummary = {
  id: string;
  name: string;
  slug: string;
  status: string;
  repository: string;
  workspacePath: string;
  defaultBranch: string;
  provisioningStatus: string;
  provisioningError: string;
  taskCount: number;
  attentionCount: number;
  updatedAt: string;
  version: number;
  /** The owner's check command, run by the platform after each implementation (0143); "" when none. */
  checkCommand: string;
  checkTimeoutSeconds: number;
  /** How the platform reaches the repository: "github_app" is the one it syncs and publishes. */
  credentialMode: string;
};

export type RuntimeChoice = {
  profileId: string;
  runtimeType: string;
  providerType: string;
  model: string;
  canOrchestrate: boolean;
  canExecute: boolean;
  displayName?: string;
  providerBadge?: string;
  planBadge?: string;
  reasoningEfforts?: string[];
  reasoningLevels?: ReasoningLevel[];
  defaultReasoningEffort?: string;
  serviceTiers?: string[];
  billingBoundary?: string;
  lastVerifiedAt?: string;
  selectionSource?: "catalog" | "legacy";
  /** What an alias resolved to at its last check (or, before one, in a run). */
  resolvedModel?: string;
};

export type AgentAssignmentSummary = RuntimeChoice & {
  assignmentId: string;
  agentId: string;
  agentName: string;
  assignmentRole: "orchestrator" | "executor";
  isDefault: boolean;
};

export type TaskSummary = {
  id: string;
  title: string;
  objective: string;
  status: string;
  version: number;
  agentName: string;
  orchestratorRuntime: string;
  orchestratorModel: string;
  activeAgentId: string;
  acceptanceCriteria: unknown[];
  followUpOfTaskId: string;
  conversationId: string;
  /** The project assignments this task's implementation is bound to (U1: their readiness is shown on the task). */
  executorAssignmentIds: string[];
  orchestratorAssignmentId: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionSummary = {
  id: string;
  agentName: string;
  runtimeType: string;
  nativeSessionId: string;
  purpose: string;
  status: string;
  updatedAt: string;
};

export type EventSummary = {
  id: string;
  eventType: string;
  taskId: string;
  actorType: string;
  actorId: string;
  payload: Json;
  occurredAt: string;
  // Who handed off to whom, for a workflow event: the handoff's agents, and
  // the runtime the recorded dispatch actually ran (0071).
  actors?: Json;
  // An agent message's model, from its job's selection.
  selectedModel?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "agent" | "system";
  author: string;
  content: string;
  occurredAt: string;
  eventType: string;
  // The part the author plays in the task, said next to its name: "Codex" alone
  // did not say whether it planned, reviewed or wrote the code.
  actorRole?: "orchestrator" | "reviewer" | "executor";
  // The model the message was written with, as the runtime recorded it.
  model?: string;
  // A workflow record the operator should not miss (a run that ended without
  // its report, a job that stopped for good) rather than a step of the routine.
  notice?: boolean;
};

export type TaskActivity = {
  activityId: string;
  source: "runtime_job" | "task_run";
  status: string;
  phase: string;
  detail: string;
  agentName: string;
  runtimeType: string;
  model: string;
  attemptCount: number;
  queuedAt: string;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string;
  lastError: string;
  active: boolean;
  eventCursor: string;
  canInterrupt: boolean;
  events: Array<{ id: string; eventType: string; summary: string; occurredAt: string }>;
};

export type RuntimeUsage = {
  runtimeType: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  modelSteps: number;
  attempts: number;
  cost: number;
  updatedAt: string;
};

function countOrNull(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function unpublishedOf(value: unknown): WorkspaceState["unpublished"] {
  if (!value || typeof value !== "object") return null;
  const row = value as Json;
  return {
    commitCount: Number(row.commit_count ?? 0), fileCount: Number(row.file_count ?? 0),
    additions: Number(row.additions ?? 0), deletions: Number(row.deletions ?? 0),
    commits: Array.isArray(row.commits) ? row.commits.map((commit) => ({ sha: String((commit as Json).sha ?? ""), subject: String((commit as Json).subject ?? "") })) : [],
    files: Array.isArray(row.files) ? row.files.map((file) => ({ path: String((file as Json).path ?? ""),
      additions: countOrNull((file as Json).additions), deletions: countOrNull((file as Json).deletions) })) : [],
  };
}

export type TaskChanges = {
  additions: number;
  deletions: number;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
};

export type WorkspaceState = {
  branch: string;
  headSha: string;
  upstream: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  changedFiles: Array<{ path: string; status: string }>;
  diffSummary: { files: number; additions: number; deletions: number; untracked: number; truncated: boolean };
  /** What a publish would push: HEAD's commits no remote-tracking branch has (the supervisor's snapshot). Null before a snapshot carried it. */
  unpublished: {
    commitCount: number; fileCount: number; additions: number; deletions: number;
    commits: Array<{ sha: string; subject: string }>;
    files: Array<{ path: string; additions: number | null; deletions: number | null }>;
  } | null;
  observedAt: string;
  collector: string;
  lockStatus: string;
  lockOwner: string;
  lockRunId: string;
  lockLeaseExpiresAt: string;
  checksSummary: Json;
  checksRunId: string;
  checksObservedAt: string;
  handoffObjective: string;
  handoffRevision: number;
  handoffFrom: string;
  handoffTo: string;
  handoffPaths: string[];
  activeOperation: string;
};

// Where an approved task's publish stands (battle test, chat 2). The two stages
// that ask something — ready, stopped — are action cards; this is the rest.
export type PublishState =
  | { stage: "preparing"; since: string }
  | { stage: "refused"; message: string }
  | { stage: "unavailable" }
  | { stage: "ready" }
  | { stage: "publishing"; sha: string; repository: string; since: string }
  | { stage: "failed" }
  | { stage: "published"; sha: string; repository: string; prNumber: number | null; prUrl: string; initialisedBase: string; at: string }
  | null;

function publishStateOf(row: Json): PublishState {
  const sha = String(row.head_commit_sha ?? row.pushed_sha ?? "").slice(0, 12);
  const repository = String(row.repository ?? "");
  if (row.preparation_status === "requested" || row.preparation_status === "claimed") return { stage: "preparing", since: String(row.requested_at ?? "") };
  if (row.preparation_status === "refused") {
    const note = row.refusal_note ? `${String(row.refusal_note).charAt(0).toUpperCase()}${String(row.refusal_note).slice(1)}.` : "";
    return { stage: "refused", message: [note, String(row.refusal_message ?? "")].filter(Boolean).join(" — ") || "The approved commit could not be prepared for publishing." };
  }
  if (row.credential_mode !== "github_app") return { stage: "unavailable" };
  if (!row.intent_id) return { stage: "ready" };
  if (row.intent_status === "requested" || row.intent_status === "claimed") return { stage: "publishing", sha, repository, since: String(row.intent_requested_at ?? "") };
  if (row.intent_status === "failed") return { stage: "failed" };
  return { stage: "published", sha, repository, prNumber: row.pr_number == null ? null : Number(row.pr_number),
    prUrl: String(row.pr_url ?? ""), initialisedBase: String(row.initialised_base_ref ?? "").replace(/^refs\/heads\//, ""), at: String(row.finished_at ?? "") };
}

export type ProjectWorkspace = {
  project: ProjectSummary;
  tasks: TaskSummary[];
  sessions: SessionSummary[];
  events: EventSummary[];
  activeTask: TaskSummary | null;
  messages: ChatMessage[];
  agentRoster: AgentAssignmentSummary[];
  taskActivity: TaskActivity | null;
  usage: RuntimeUsage[];
  // Per member, live (Stage 12, 0114); null before 0114 or without a task.
  taskUsage: TaskUsage | null;
  workspaceState: WorkspaceState;
  attention: ActionTarget[];
  publishState: PublishState;
  // Files in the active task's latest reviewed diff; null before its first review.
  taskFiles: number | null;
  // That diff's files with their line counts, for the step card; null before
  // its first review.
  taskChanges: TaskChanges | null;
};

const emptyWorkspaceState: WorkspaceState = {
  branch: "Awaiting VPS snapshot", headSha: "", upstream: "", ahead: 0, behind: 0, dirty: false,
  changedFiles: [], diffSummary: { files: 0, additions: 0, deletions: 0, untracked: 0, truncated: false }, unpublished: null,
  observedAt: "", collector: "", lockStatus: "released", lockOwner: "", lockRunId: "",
  lockLeaseExpiresAt: "", checksSummary: {}, checksRunId: "", checksObservedAt: "", activeOperation: "",
  handoffObjective: "", handoffRevision: 0, handoffFrom: "", handoffTo: "", handoffPaths: [],
};

const demoProject: ProjectSummary = {
  id: "demo",
  name: "infra-cod",
  slug: "infra-cod",
  status: "active",
  repository: "github.com/STpytut/agentic-control",
  workspacePath: "/srv/infra-cod/workspaces/demo",
  defaultBranch: "main",
  provisioningStatus: "ready",
  provisioningError: "",
  taskCount: 1,
  attentionCount: 0,
  updatedAt: new Date().toISOString(),
  version: 1,
  checkCommand: "",
  checkTimeoutSeconds: 600,
  credentialMode: "",
};

function projectFromRow(row: Json): ProjectSummary {
  const settings = (row.settings ?? {}) as Json;
  const rawProvisioningError = String(settings.provisioning_error ?? "");
  const provisioningError = /could not read Username|Authentication failed|deploy key/i.test(rawProvisioningError)
    ? "Private repository access is not configured for this project."
    : rawProvisioningError.slice(0, 300);
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    status: String(row.status),
    repository: String(row.repository_url ?? "Empty Git workspace"),
    workspacePath: String(row.workspace_path),
    defaultBranch: String(row.default_branch),
    provisioningStatus: String(settings.provisioning_status ?? (row.status === "active" ? "ready" : row.status)),
    provisioningError,
    taskCount: Number(row.task_count ?? 0),
    attentionCount: Number(row.attention_count ?? 0),
    updatedAt: String(row.updated_at),
    version: Number(row.version ?? 1),
    checkCommand: typeof row.check_command === "string" ? row.check_command : "",
    checkTimeoutSeconds: Number(row.check_timeout_seconds ?? 600),
    credentialMode: typeof row.credential_mode === "string" ? row.credential_mode : "",
  };
}

// An agent is shown by the runtime it runs on, which every caller reads from
// the database — a session's profile, a handoff's agent, a recorded dispatch.
// Guessing it from the agent's name ("codex-…", "worker-…") was the fallback
// that made every unrecognised agent an orchestrator.
function agentDisplayName(name: unknown, runtime?: unknown) {
  const runtimeType = String(runtime ?? "").toLowerCase();
  if (runtimeType) return runtimeLabel(runtimeType);
  return String(name ?? "Agent");
}

function taskFromRow(row: Json): TaskSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    objective: String(row.objective),
    status: String(row.status),
    version: Number(row.version),
    agentName: agentDisplayName(row.agent_name, row.orchestrator_runtime),
    orchestratorRuntime: String(row.orchestrator_runtime ?? ""),
    orchestratorAssignmentId: String(row.orchestrator_assignment_id ?? ""),
    executorAssignmentIds: Array.isArray(row.executor_assignment_ids) ? (row.executor_assignment_ids as unknown[]).map(String) : [],
    orchestratorModel: String(row.orchestrator_model ?? "Default model"),
    activeAgentId: String(row.active_agent_id ?? ""),
    acceptanceCriteria: Array.isArray(row.acceptance_criteria) ? row.acceptance_criteria : [],
    followUpOfTaskId: String(row.followup_of_task_id ?? ""),
    conversationId: String(row.conversation_id ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// A conversation is a line of tasks (ADR-0014): its newest task is where it
// continues.
function latestTaskInConversation(tasks: TaskSummary[], selected: TaskSummary) {
  return tasks
    .filter((task) => task.conversationId === selected.conversationId)
    .sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? selected;
}

export async function getRuntimeCatalog(ownerId?: string): Promise<RuntimeChoice[]> {
  if (!hasDatabaseConnection()) {
    // The demo page's catalog: one entry per runtime the registry declares.
    return knownRuntimes().map((runtimeType) => ({
      profileId: `demo-${runtimeType}`, runtimeType, providerType: "demo", model: "demo-model",
      canOrchestrate: runtimePlays(runtimeType, "orchestrator"), canExecute: runtimePlays(runtimeType, "executor"),
      selectionSource: "legacy" as const,
    }));
  }
  if (!ownerId) return [];
  const verifiedCatalog = await queryJsonRows(`
    SELECT jsonb_build_object(
      'entry_id',m.id,'runtime_type',m.runtime_type,'provider_id',m.provider_id,
      'model_id',m.model_id,'display_name',m.display_name,'provider_badge',m.provider_badge,
      'plan_badge',m.plan_badge,'reasoning_efforts',m.reasoning_efforts,
      'reasoning_levels',m.reasoning_levels,'default_reasoning_effort',m.default_reasoning_effort,
      'service_tiers',m.service_tiers,'billing_boundary',m.billing_boundary,
      'adapter_version',m.adapter_version,'runtime_version',m.runtime_version,
      'last_verified_at',m.last_verified_at,
      'resolved_model',COALESCE(NULLIF(m.resolved_model,''),NULLIF(m.observed_model,''))
    )::text FROM provider_model_catalog m
    JOIN provider_connections c ON c.id=m.connection_id
    WHERE m.operator_id=:'owner_id'::uuid AND m.status='verified' AND c.status='connected'
    ORDER BY m.last_verified_at DESC,m.id;
  `, { owner_id: ownerId });
  const hasVerifiedOrchestrator = verifiedCatalog.some((row) => runtimePlays(String(row.runtime_type), "orchestrator"));
  const hasVerifiedExecutor = verifiedCatalog.some((row) => runtimePlays(String(row.runtime_type), "executor"));

  // The catalog is the preferred source, but a newly connected account can
  // have verified runtime adapters before its first catalog gate completes.
  // Keep project creation usable in that short transition window by falling
  // back to those already verified legacy adapters. Once both runtime types
  // have catalog entries, selectors become catalog-only.
  if (!hasVerifiedOrchestrator || !hasVerifiedExecutor) {
    const legacyProfiles = await queryJsonRows(`
      SELECT jsonb_build_object(
        'id',id,'runtime_type',runtime_type,'provider_type',provider_type,
        'model',model,'adapter_version',adapter_version,'last_verified_at',last_verified_at
      )::text
      FROM runtime_profiles
      WHERE enabled AND last_verified_at IS NOT NULL
        AND runtime_type = ANY(string_to_array(:'runtimes', ','))
      ORDER BY runtime_type, last_verified_at DESC NULLS LAST, created_at, id;
    `, { runtimes: knownRuntimes().join(",") });
    return legacyProfiles.map((row) => {
      const runtimeType = String(row.runtime_type);
      return {
        profileId: String(row.id),
        runtimeType,
        providerType: String(row.provider_type),
        model: String(row.model),
        lastVerifiedAt: row.last_verified_at ? String(row.last_verified_at) : undefined,
        canOrchestrate: runtimePlays(runtimeType, "orchestrator"),
        canExecute: runtimePlays(runtimeType, "executor"),
        selectionSource: "legacy" as const,
      };
    });
  }

  return verifiedCatalog.map((row) => {
    const runtimeType = String(row.runtime_type);
    return {
      profileId: String(row.entry_id),
      runtimeType,
      providerType: String(row.provider_id),
      model: String(row.model_id),
      displayName: row.display_name ? String(row.display_name) : undefined,
      providerBadge: row.provider_badge ? String(row.provider_badge) : undefined,
      planBadge: row.plan_badge ? String(row.plan_badge) : undefined,
      reasoningEfforts: Array.isArray(row.reasoning_efforts) ? row.reasoning_efforts.map(String) : [],
      reasoningLevels: reasoningLevelsFrom(row.reasoning_levels ?? row.reasoning_efforts),
      defaultReasoningEffort: row.default_reasoning_effort ? String(row.default_reasoning_effort) : undefined,
      serviceTiers: Array.isArray(row.service_tiers) ? row.service_tiers.map(String) : [],
      billingBoundary: row.billing_boundary ? String(row.billing_boundary) : undefined,
      lastVerifiedAt: row.last_verified_at ? String(row.last_verified_at) : undefined,
      resolvedModel: row.resolved_model ? String(row.resolved_model) : undefined,
      canOrchestrate: runtimePlays(runtimeType, "orchestrator"),
      canExecute: runtimePlays(runtimeType, "executor"),
      selectionSource: "catalog" as const,
    };
  });
}

export async function getProjectRuntimeDefaults(projectId: string, ownerId: string): Promise<Json | null> {
  if (!hasDatabaseConnection()) return null;
  const { executeJson } = await import("@/lib/database");
  const value = await executeJson(
    `SELECT get_project_runtime_defaults(:'project_id'::uuid,:'owner_id'::uuid)::text;`,
    { project_id: projectId, owner_id: ownerId },
  );
  return value && typeof value === "object" && Object.keys(value).length ? value : null;
}

export async function getOperatorDeletionTombstones(ownerId: string): Promise<Json[]> {
  if (!hasDatabaseConnection()) return [];
  const { executeJson } = await import("@/lib/database");
  const value = await executeJson(
    `SELECT get_operator_project_deletion_status(:'owner_id'::uuid)::text;`,
    { owner_id: ownerId },
  );
  return Array.isArray(value) ? value as Json[] : [];
}

export async function getProjectDeletionState(projectId: string, ownerId: string): Promise<Json | null> {
  if (!hasDatabaseConnection()) return null;
  const rows = await queryJsonRows(
    `SELECT jsonb_build_object(
       'project_id',p.id,'status',p.status,'version',p.version,
       'deletion_requested_at',p.deletion_requested_at,
       'deletion_not_before',p.deletion_not_before,
       'deleted_at',p.deleted_at,'deprovisioned_at',p.deprovisioned_at,
       'deletion_failure_code',p.deletion_failure_code,
       'deletion_failure_message',p.deletion_failure_message,
       'deletion_attempt_count',p.deletion_attempt_count,
       'cleanup_leased_by',p.cleanup_leased_by,'cleanup_leased_until',p.cleanup_leased_until
     )::text FROM projects p
     WHERE p.id=:'project_id'::uuid AND p.owner_id=:'owner_id'::uuid;`,
    { project_id: projectId, owner_id: ownerId },
  );
  return rows.at(-1) ?? null;
}

// Who an event is about, from what was recorded: the handoff's agents and the
// runtime its dispatch ran. Before 0071 every delegation read "Codex delegated
// implementation to OpenCode.", whoever the task had selected.
function actorName(event: EventSummary, side: "from" | "to", fallback: string) {
  const actors = (event.actors ?? {}) as Json;
  const runtime = String(actors[`${side}_runtime`] ?? "");
  return runtime ? runtimeLabel(runtime) : String(actors[`${side}_agent`] ?? fallback);
}

// The names a workflow event falls back to when its own row does not carry
// them: the sides of the conversation's latest handoff.
type Sides = { orchestrator: string; executor: string; revision?: boolean };

function contentForEvent(event: EventSummary, task?: TaskSummary, sides: Sides = { orchestrator: "The orchestrator", executor: "the executor" }) {
  const payload = event.payload;
  if (event.eventType === "chat.user_message") return String(payload.content ?? task?.objective ?? "New task");
  if (event.eventType === "chat.agent_message") return String(payload.content ?? "Agent response recorded");
  const from = actorName(event, "from", sides.orchestrator);
  const to = actorName(event, "to", sides.executor);
  // Each line says who did what to whom, in the roles the team plays: the
  // orchestrator plans and reviews, the executor writes the code.
  const labels: Record<string, string> = {
    // After a review sent the work back, the next handoff is the revision, not
    // a new piece of work.
    "implementation.requested": sides.revision ? `${from} handed the requested changes to ${to}.` : `${from} handed the work to ${to} to implement.`,
    "implementation.started": `${to} started implementing in the project workspace.`,
    "implementation.completed": `${to} finished and handed the work back for review.`,
    "implementation.blocked": `${to} reported a blocker.`,
    "run.input_requested": `${to} is waiting for your answer.`,
    "interaction.resolved": "Your answer was recorded and the workflow resumed.",
    // Written by approve_task_review, always as the operator.
    "review.approved": "You approved the implementation.",
    "task.ready": "The plan is ready; implementation can start.",
    "task.cancelled": "You closed this task. Nothing more runs for it; a message here starts a linked follow-up.",
    "changes.requested": `${sides.orchestrator} reviewed the work and sent it back to ${sides.executor} for changes.`,
    "revision.started": `${to} started on the requested changes.`,
    "revision.completed": `${to} finished the changes and handed the work back for review.`,
    "project.created": "Project metadata was created. Workspace provisioning is queued.",
    "project.provisioned": "The VPS workspace is ready.",
  };
  const line = labels[event.eventType] ?? event.eventType.replaceAll(".", " ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

// A question the implementation asked, and the answer, are part of the
// conversation: the answer is usually typed into this chat (0061 routes it), and
// showing only "your answer was recorded" made the message the operator just
// sent disappear. A question marked sensitive keeps its answer out of the chat.
function interactionMessage(event: EventSummary, sensitive: boolean): ChatMessage | null {
  const payload = event.payload as Record<string, unknown>;
  const base = { id: event.id, occurredAt: event.occurredAt, eventType: event.eventType };
  if (event.eventType === "run.input_requested" && typeof payload.question === "string") {
    const context = typeof payload.context === "string" && payload.context.trim() ? `\n\n${payload.context}` : "";
    return { ...base, role: "agent", author: actorName(event, "to", "The executor"), actorRole: "executor", content: `${payload.question}${context}` };
  }
  // An implementation that ended without its report (0066): the question it
  // opens for the operator, said by the control plane.
  if (event.eventType === "run.unreported" && typeof payload.question === "string") {
    return { ...base, role: "system", author: "", notice: true, content: payload.question };
  }
  // A job that ended for good (0072) — its runtime removed, its credential
  // gone, its attempts run out — says why, in the vocabulary's words.
  if (event.eventType === "runtime_job.dead_lettered" && typeof payload.message === "string") {
    return { ...base, role: "system", author: "", notice: true, content: payload.message };
  }
  // Sprint B P1: what the publish did — requested, pushed, the pull request,
  // or why it stopped — in the control plane's words.
  if (event.eventType.startsWith("publish.") && event.eventType !== "publish.prepared" && typeof payload.message === "string") {
    return { ...base, role: "system", author: "", notice: ["publish.failed", "publish.refused"].includes(event.eventType), content: payload.message };
  }
  if (event.eventType === "implementation.blocked" && typeof payload.reason === "string") {
    const action = typeof payload.requested_action === "string" && payload.requested_action.trim() ? `\n\n${payload.requested_action}` : "";
    return { ...base, role: "agent", author: actorName(event, "to", "The executor"), actorRole: "executor", content: `Blocked: ${payload.reason}${action}` };
  }
  if (event.eventType === "interaction.resolved") {
    const response = (payload.response as Record<string, unknown> | undefined)?.response;
    if (typeof response !== "string") return null;
    return { ...base, role: "user", author: "You", content: sensitive ? "Answer recorded (hidden: the question was marked sensitive)." : response };
  }
  return null;
}

export function conversationMessages(events: EventSummary[], task?: TaskSummary): ChatMessage[] {
  let sensitive = false;
  const sides: Sides = { orchestrator: task?.orchestratorRuntime ? runtimeLabel(task.orchestratorRuntime) : "The orchestrator", executor: "the executor" };
  return events.map((event) => {
    if (event.eventType === "run.input_requested") sensitive = (event.payload as Record<string, unknown>).sensitivity === "sensitive";
    const actors = (event.actors ?? {}) as Json;
    if (actors.from_runtime) sides.orchestrator = runtimeLabel(String(actors.from_runtime));
    if (actors.to_runtime) sides.executor = runtimeLabel(String(actors.to_runtime));
    const message = interactionMessage(event, sensitive) ?? messageFromEvent(event, task, { ...sides });
    if (event.eventType === "changes.requested") sides.revision = true;
    if (event.eventType === "implementation.requested" || event.eventType === "chat.user_message") sides.revision = false;
    return message;
  });
}

function messageFromEvent(event: EventSummary, task: TaskSummary | undefined, sides: Sides): ChatMessage {
  const isUser = event.eventType === "chat.user_message";
  // Only what an agent said is its message. A workflow event an agent caused —
  // task.ready, a delegation — is the control plane's record of it, and showed
  // as a message from an "Orchestrator" nobody had heard of (P-5). It has no
  // author of its own: the chat shows it as a line in the timeline.
  const isAgent = event.eventType === "chat.agent_message";
  const payload = event.payload as Record<string, unknown>;
  return {
    id: event.id,
    role: isUser ? "user" : isAgent ? "agent" : "system",
    author: isUser ? "You" : isAgent ? agentDisplayName(payload.agent_name, payload.runtime_type) : "",
    content: contentForEvent(event, task, sides),
    occurredAt: event.occurredAt,
    eventType: event.eventType,
    // Every agent message is the orchestrator's (0077); the turn that resumes it
    // after an implementation is its review (orchestrator-worker REVIEW_JOB_TYPES).
    ...(isAgent ? {
      actorRole: payload.source_job_type === "resume_orchestrator" ? "reviewer" as const : "orchestrator" as const,
      ...(event.selectedModel ? { model: event.selectedModel } : {}),
    } : {}),
  };
}

export async function getProjects(ownerId: string): Promise<ProjectSummary[]> {
  if (!hasDatabaseConnection()) return [demoProject];
  const rows = await queryJsonRows(`
    SELECT jsonb_build_object(
      'id',p.id,'name',p.name,'slug',p.slug,'status',p.status,
      'repository_url',p.repository_url,'workspace_path',p.workspace_path,
      'default_branch',p.default_branch,'settings',p.settings,'updated_at',p.updated_at,
      'version',p.version,
      'task_count',count(t.id),
      'attention_count',count(t.id) FILTER (WHERE t.status='needs_attention')
    )::text
    FROM projects p LEFT JOIN tasks t ON t.project_id=p.id
    WHERE p.owner_id=:'owner_id'::uuid
      AND p.status NOT IN ('archived','deleting','deletion_failed','deleted')
    GROUP BY p.id
    ORDER BY p.updated_at DESC;
  `, { owner_id: ownerId });
  return rows.map(projectFromRow);
}

function getAttentionRows(ownerId: string, projectId: string, taskId: string) {
  const variables = { project_id: projectId, owner_id: ownerId, task_id: taskId };
  return Promise.all([
    queryJsonRows(`SELECT jsonb_build_object('id',a.id,'action_type',a.action_type,'requested_at',a.requested_at)::text
      FROM approvals a JOIN projects p ON p.id=a.project_id
      WHERE a.project_id=:'project_id'::uuid AND p.owner_id=:'owner_id'::uuid
        AND a.status='pending' AND a.expires_at>clock_timestamp()
        AND (a.task_id IS NULL OR a.task_id=:'task_id'::uuid) ORDER BY a.requested_at;`,variables),
    queryJsonRows(`SELECT jsonb_build_object('id',r.id,'report_type',r.report_type,'payload',r.payload,
        'agent_name',ra.name,'runtime_type',rp.runtime_type,
        'finalized_at',r.finalized_at)::text FROM worker_interaction_reports r JOIN projects p ON p.id=r.project_id
      JOIN agents ra ON ra.id=r.agent_id
      LEFT JOIN task_runs rr ON rr.id=r.run_id
      LEFT JOIN agent_sessions rs ON rs.id=rr.session_id
      LEFT JOIN runtime_profiles rp ON rp.id=rs.runtime_profile_id
      WHERE r.project_id=:'project_id'::uuid AND r.task_id=:'task_id'::uuid AND p.owner_id=:'owner_id'::uuid
        AND r.status='finalized' AND r.resolved_at IS NULL ORDER BY r.finalized_at;`,variables),
    queryJsonRows(`SELECT jsonb_build_object('id',j.id,'job_type',j.job_type,'last_error',j.last_error,
        'completed_at',j.completed_at,'attempt',j.attempt_count,'failure_reason',j.failure_reason,
        'reason_note',fr.note)::text FROM runtime_jobs j JOIN projects p ON p.id=j.project_id
      LEFT JOIN failure_reasons fr ON fr.reason=j.failure_reason
      WHERE j.project_id=:'project_id'::uuid AND j.task_id=:'task_id'::uuid AND p.owner_id=:'owner_id'::uuid
        AND j.status='dead_letter' AND j.resolved_at IS NULL ORDER BY j.id;`,variables),
    // Sprint B P1: the task's latest prepared publish and its intent, if any.
    // Offered only for a GitHub App repository; the others stay prepare-only.
    // Every stage after the approval, not only the ones that ask something:
    // between Approve and "Ready to publish", and while a publish runs, the
    // chat said nothing and looked broken (battle test, chat 2).
    queryJsonRows(`SELECT jsonb_build_object('preparation_id',pp.id,'head_commit_sha',pp.head_commit_sha,
        'prepared_at',pp.finished_at,'default_branch',p.default_branch,'repository',p.repository_full_name,
        'preparation_status',pp.status,'refusal_message',pp.refusal_message,'refusal_note',rr.note,
        'credential_mode',p.credential_mode,'requested_at',pp.requested_at,
        'intent_id',i.id,'intent_status',i.status,'attempt',i.attempt_count,'failure_reason',i.failure_reason,
        'failure_message',i.failure_message,'reason_note',fr.note,'finished_at',i.finished_at,
        'pushed_sha',i.pushed_sha,'pr_number',i.pr_number,'pr_url',i.pr_url,'initialised_base_ref',i.initialised_base_ref,
        'intent_requested_at',i.requested_at)::text
      FROM publish_preparations pp JOIN projects p ON p.id=pp.project_id
      JOIN tasks t ON t.id=pp.task_id AND t.status='approved'
      LEFT JOIN publish_intents i ON i.preparation_id=pp.id
      LEFT JOIN failure_reasons fr ON fr.reason=i.failure_reason
      LEFT JOIN failure_reasons rr ON rr.reason=pp.refusal_reason
      WHERE pp.project_id=:'project_id'::uuid AND pp.task_id=:'task_id'::uuid AND p.owner_id=:'owner_id'::uuid
      ORDER BY pp.requested_at DESC LIMIT 1;`,variables),
    // The task's own diff from its review evidence (0131): the step card
    // counts these files, not the project workspace's, which after a publish
    // sits on the base or on another chat's branch.
    queryJsonRows(`SELECT jsonb_build_object('files',(e.diffstat->>'files_changed')::int,
        'additions',(e.diffstat->>'insertions')::int,'deletions',(e.diffstat->>'deletions')::int,
        'changed',e.changed_files)::text
      FROM review_evidence e JOIN projects p ON p.id=e.project_id
      WHERE e.project_id=:'project_id'::uuid AND e.task_id=:'task_id'::uuid AND p.owner_id=:'owner_id'::uuid
      ORDER BY e.recorded_at DESC LIMIT 1;`,variables),
  ]);
}

export async function getProjectWorkspace(ownerId: string, projectId: string, requestedTaskId?: string): Promise<ProjectWorkspace | null> {
  if (!hasDatabaseConnection()) {
    const orchestrator = runtimeForRole("orchestrator");
    const task: TaskSummary = { id: "demo-task", title: "Describe the next change", objective: "Use the chat to create and guide a task.", status: "draft", version: 1, agentName: runtimeLabel(orchestrator), orchestratorRuntime: orchestrator, orchestratorModel: "demo-model", activeAgentId: "", acceptanceCriteria: [], followUpOfTaskId: "", conversationId: "demo-conversation", executorAssignmentIds: [], orchestratorAssignmentId: "", createdAt: demoProject.updatedAt, updatedAt: demoProject.updatedAt };
    return { project: demoProject, tasks: [task], sessions: [], events: [], activeTask: task, messages: [{ id: "demo-message", role: "agent", author: runtimeLabel(orchestrator), content: "Tell me what we should build next. I will turn the conversation into a task contract and coordinate implementation.", occurredAt: demoProject.updatedAt, eventType: "chat.agent_message" }], agentRoster: [], taskActivity: null, usage: [], taskUsage: null, workspaceState: emptyWorkspaceState, attention: [], publishState: null, taskFiles: null, taskChanges: null };
  }
  const projectRows = await queryJsonRows(`
    SELECT jsonb_build_object(
      'id',p.id,'name',p.name,'slug',p.slug,'status',p.status,
      'repository_url',p.repository_url,'workspace_path',p.workspace_path,
      'default_branch',p.default_branch,'settings',p.settings,'updated_at',p.updated_at,
      'version',p.version,'credential_mode',p.credential_mode,
      'check_command',p.check_command,'check_timeout_seconds',p.check_timeout_seconds,
      'task_count',(SELECT count(*) FROM tasks t WHERE t.project_id=p.id),
      'attention_count',(SELECT count(*) FROM tasks t WHERE t.project_id=p.id AND t.status='needs_attention')
    )::text FROM projects p WHERE p.id=:'project_id'::uuid
      AND p.owner_id=:'owner_id'::uuid AND p.status<>'archived';
  `, { project_id: projectId, owner_id: ownerId });
  if (!projectRows.length) return null;
  const [taskRows,sessionRows,rosterRows,eventRows] = await Promise.all([
  queryJsonRows(`
    SELECT jsonb_build_object(
       'id',t.id,'title',t.title,'objective',t.objective,'status',t.status,
       'version',t.version,'agent_name',oa.name,'orchestrator_runtime',orp.runtime_type,
       'orchestrator_model',COALESCE(snapshot.orchestrator->>'model_id',orp.model),
       'active_agent_id',t.active_agent_id,
      'acceptance_criteria',t.acceptance_criteria,'followup_of_task_id',t.followup_of_task_id,'conversation_id',t.conversation_id,
      'orchestrator_assignment_id',t.orchestrator_assignment_id,
      'executor_assignment_ids',COALESCE((SELECT jsonb_agg(tea.project_agent_assignment_id ORDER BY tea.priority,tea.created_at)
        FROM task_executor_assignments tea WHERE tea.task_id=t.id AND tea.enabled),'[]'::jsonb),
      'created_at',t.created_at,'updated_at',t.updated_at
    )::text FROM tasks t
    JOIN project_agent_assignments opa ON opa.id=t.orchestrator_assignment_id
    JOIN agents oa ON oa.id=opa.agent_id
     JOIN runtime_profiles orp ON orp.id=opa.runtime_profile_id
     LEFT JOIN task_runtime_snapshots snapshot ON snapshot.task_id=t.id
    WHERE t.project_id=:'project_id'::uuid
    ORDER BY CASE WHEN t.status IN ('approved','deployed','completed','cancelled','failed') THEN 1 ELSE 0 END,t.updated_at DESC;
  `, { project_id: projectId }),
  queryJsonRows(`
    SELECT jsonb_build_object(
      'id',s.id,'agent_name',a.name,'runtime_type',rp.runtime_type,
      'native_session_id',s.native_session_id,'purpose',s.purpose,'status',s.status,'updated_at',s.updated_at
    )::text FROM agent_sessions s JOIN agents a ON a.id=s.agent_id
    JOIN runtime_profiles rp ON rp.id=s.runtime_profile_id
    WHERE s.project_id=:'project_id'::uuid ORDER BY s.updated_at DESC;
  `, { project_id: projectId }),
   queryJsonRows(`
     WITH executor_assignments AS (
       SELECT pa.id, row_number() OVER (PARTITION BY pa.project_id ORDER BY pa.created_at,pa.id) AS ordinal
       FROM project_agent_assignments pa
       WHERE pa.assignment_role='executor'
     ), executor_defaults AS (
       SELECT d.project_id,d.catalog_entry_id,
         row_number() OVER (PARTITION BY d.project_id ORDER BY d.priority,d.catalog_entry_id) AS ordinal
       FROM project_runtime_default_executors d
     )
     SELECT jsonb_build_object(
       'assignment_id',pa.id,'agent_id',a.id,'agent_name',a.name,
       'assignment_role',pa.assignment_role,'is_default',pa.is_default,
       'profile_id',rp.id,'runtime_type',rp.runtime_type,
       'provider_type',COALESCE(CASE WHEN pa.assignment_role='orchestrator' THEN orchestrator_catalog.provider_id ELSE executor_catalog.provider_id END,rp.provider_type),
       'model',COALESCE(CASE WHEN pa.assignment_role='orchestrator' THEN orchestrator_catalog.model_id ELSE executor_catalog.model_id END,rp.model)
     )::text
     FROM project_agent_assignments pa
     JOIN agents a ON a.id=pa.agent_id
     JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
     LEFT JOIN project_runtime_defaults defaults ON defaults.project_id=pa.project_id
     LEFT JOIN provider_model_catalog orchestrator_catalog
       ON orchestrator_catalog.id=defaults.orchestrator_entry_id
       AND pa.assignment_role='orchestrator'
     LEFT JOIN executor_assignments assignment_order ON assignment_order.id=pa.id
       AND pa.assignment_role='executor'
     LEFT JOIN executor_defaults selected_default
       ON selected_default.project_id=pa.project_id
       AND selected_default.ordinal=assignment_order.ordinal
       AND pa.assignment_role='executor'
     LEFT JOIN provider_model_catalog executor_catalog
       ON executor_catalog.id=selected_default.catalog_entry_id
     WHERE pa.project_id=:'project_id'::uuid AND pa.enabled AND a.enabled AND rp.enabled
    ORDER BY pa.assignment_role DESC,pa.is_default DESC,pa.created_at;
  `, { project_id: projectId }),
  queryJsonRows(`
    SELECT jsonb_build_object(
      'id',timeline.id,'event_type',timeline.event_type,'task_id',timeline.task_id,
      'actor_type',timeline.actor_type,'actor_id',timeline.actor_id,
      'payload',timeline.payload,'occurred_at',timeline.occurred_at
    )::text FROM (
      SELECT e.id,e.event_type,e.task_id,e.actor_type,e.actor_id,e.payload,e.occurred_at
      FROM domain_events e WHERE e.project_id=:'project_id'::uuid
      UNION ALL
      SELECT a.id,'audit.'||a.action,a.task_id,a.actor_type,a.actor_id,
        a.details||jsonb_build_object('policy_decision',a.policy_decision,
          'target_type',a.target_type,'target_id',a.target_id),a.occurred_at
      FROM audit_events a WHERE a.project_id=:'project_id'::uuid
    ) timeline ORDER BY timeline.occurred_at DESC LIMIT 100;
  `, { project_id: projectId }),
  ]);
  const tasks = taskRows.map(taskFromRow);
  const selectedTask = requestedTaskId ? tasks.find((task) => task.id === requestedTaskId) ?? tasks[0] ?? null : tasks[0] ?? null;
  const activeTask = selectedTask ? latestTaskInConversation(tasks,selectedTask) : null;
  const toEvent = (row: Json): EventSummary => ({ id: String(row.id), eventType: String(row.event_type), taskId: String(row.task_id ?? ""), actorType: String(row.actor_type), actorId: String(row.actor_id), payload: (row.payload ?? {}) as Json, occurredAt: String(row.occurred_at) });
  const events: EventSummary[] = eventRows.map(toEvent);
  // The chat is its conversation's domain events, in the order the database
  // numbered them (ADR-0014): every task event takes the next number of its
  // conversation when it is written, so two writers in the same second cannot
  // trade places on screen, and a clock is not the order. Read on its own rather
  // than out of the project's Events & audit window, which audit rows fill.
  const conversationEventRows = activeTask ? await queryJsonRows(`
    SELECT jsonb_build_object(
      'id',recent.id,'event_type',recent.event_type,'task_id',recent.task_id,
      'actor_type',recent.actor_type,'actor_id',recent.actor_id,
      'payload',recent.payload,'occurred_at',recent.occurred_at,'actors',actors.actors,
      -- The model an agent message was written with: its job's selection (0071).
      -- The payload's model is the runtime profile's, "selected per task" when
      -- the assignment chooses it.
      'selected_model',(SELECT s.model FROM runtime_job_selections s
        WHERE recent.event_type='chat.agent_message' AND s.job_id=NULLIF(recent.payload->>'job_id','')::bigint
          AND NOT EXISTS (SELECT 1 FROM runtime_job_selections later WHERE later.supersedes=s.id)
        LIMIT 1)
    )::text FROM (
      SELECT e.id,e.event_type,e.task_id,e.run_id,e.actor_type,e.actor_id,e.payload,e.occurred_at,e.conversation_sequence
      FROM domain_events e
      WHERE e.project_id=:'project_id'::uuid
        AND e.conversation_id=:'conversation_id'::uuid
      ORDER BY e.conversation_sequence DESC
      LIMIT 1000
    ) recent
    -- A workflow event's two sides: the handoff it belongs to — named by its
    -- payload, or the one whose run it is — and, for the side that ran, the
    -- runtime its recorded dispatch ran (0071), before the one it was assigned.
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object(
        'from_agent',fa.name,'from_runtime',frp.runtime_type,'to_agent',ta.name,
        'to_runtime',COALESCE((SELECT a.runtime_type FROM runtime_dispatch_attempts a
                               WHERE a.run_id=COALESCE(recent.run_id,h.target_run_id) ORDER BY a.id DESC LIMIT 1),
                              trp.runtime_type)) AS actors
      FROM handoffs h
      JOIN agents fa ON fa.id=h.from_agent_id JOIN runtime_profiles frp ON frp.id=fa.runtime_profile_id
      JOIN agents ta ON ta.id=h.to_agent_id JOIN runtime_profiles trp ON trp.id=ta.runtime_profile_id
      WHERE h.task_id=recent.task_id
        AND (h.id=NULLIF(recent.payload->>'handoff_id','')::uuid
             OR (recent.run_id IS NOT NULL AND h.target_run_id=recent.run_id))
      ORDER BY h.revision_number DESC LIMIT 1
    ) actors ON recent.event_type IN ('implementation.requested','implementation.started','implementation.completed',
      'implementation.blocked','run.input_requested','revision.started','revision.completed')
    ORDER BY recent.conversation_sequence;
  `, { project_id: projectId, conversation_id: activeTask.conversationId }) : [];
  const activeEvents = conversationEventRows.map((row) => ({ ...toEvent(row), actors: (row.actors ?? undefined) as Json | undefined,
    selectedModel: typeof row.selected_model === "string" ? row.selected_model : undefined }));
  const hasInitialMessage = activeEvents.some((event) => event.eventType === "chat.user_message");
  const messages = conversationMessages(activeEvents, activeTask ?? undefined);
  if (activeTask && !hasInitialMessage) messages.unshift({ id: `objective-${activeTask.id}`, role: "user", author: "You", content: activeTask.objective, occurredAt: activeTask.createdAt, eventType: "task.objective" });
  const taskActivityPromise = activeTask ? getTaskActivity(ownerId,projectId,activeTask.id) : Promise.resolve(null);
  const usagePromise = activeTask ? getConversationUsage(ownerId,projectId,activeTask.id) : Promise.resolve([]);
  const taskUsagePromise = activeTask ? getTaskUsage(ownerId,projectId,activeTask.id) : Promise.resolve(null);
  const attentionRowsPromise = activeTask ? getAttentionRows(ownerId,projectId,activeTask.id) : Promise.resolve([[],[],[],[],[]] as Json[][]);
  const workspaceRowsPromise = queryJsonRows(`
    SELECT jsonb_build_object(
      'branch',COALESCE(s.branch,p.default_branch),'head_sha',COALESCE(s.head_sha,''),
      'upstream',COALESCE(s.upstream,''),'ahead',COALESCE(s.ahead,0),'behind',COALESCE(s.behind,0),
      'dirty',COALESCE(s.dirty,false),'changed_files',COALESCE(s.changed_files,'[]'::jsonb),
      'diff_summary',COALESCE(s.diff_summary,'{}'::jsonb),'collector',COALESCE(s.collector,''),
      'observed_at',s.observed_at,'lock_status',COALESCE(l.status,'released'),
      'lock_owner',a.name,'lock_owner_runtime',arp.runtime_type,'lock_run_id',l.owner_run_id,'lock_lease_expires_at',l.lease_expires_at,
      'checks_summary',COALESCE(h.checks_summary,'{}'::jsonb),'checks_run_id',h.target_run_id,
      'checks_observed_at',h.completed_at,'handoff_objective',h.objective,
      'handoff_revision',h.revision_number,'handoff_from',h.from_agent,
      'handoff_from_runtime',h.from_runtime,'handoff_to',h.to_agent,'handoff_to_runtime',h.to_runtime,'handoff_paths',COALESCE(h.relevant_paths,'[]'::jsonb),
      'active_operation',op.operation_type
    )::text
    FROM projects p
    LEFT JOIN project_workspace_states s ON s.project_id=p.id
    LEFT JOIN workspace_locks l ON l.project_id=p.id
    LEFT JOIN task_runs lr ON lr.id=l.owner_run_id LEFT JOIN agents a ON a.id=lr.agent_id
    LEFT JOIN runtime_profiles arp ON arp.id=a.runtime_profile_id
    LEFT JOIN LATERAL (
      SELECT h.checks_summary,h.target_run_id,h.completed_at,h.objective,h.revision_number,h.relevant_paths,
        fa.name AS from_agent,ta.name AS to_agent,frp.runtime_type AS from_runtime,trp.runtime_type AS to_runtime
      FROM handoffs h
      JOIN agents fa ON fa.id=h.from_agent_id JOIN agents ta ON ta.id=h.to_agent_id
      JOIN runtime_profiles frp ON frp.id=fa.runtime_profile_id JOIN runtime_profiles trp ON trp.id=ta.runtime_profile_id
      WHERE h.task_id IN(SELECT id FROM tasks WHERE project_id=p.id) AND h.checks_summary IS NOT NULL
      ORDER BY h.completed_at DESC NULLS LAST LIMIT 1
    ) h ON true
    LEFT JOIN LATERAL (
      SELECT operation_type FROM workspace_operations WHERE project_id=p.id AND status IN ('pending','running')
      ORDER BY requested_at DESC LIMIT 1
    ) op ON true
    WHERE p.id=:'project_id'::uuid AND p.owner_id=:'owner_id'::uuid;
  `, { project_id: projectId, owner_id: ownerId });
  const [taskActivity,usage,taskUsage,workspaceRows,attentionRows] = await Promise.all([taskActivityPromise,usagePromise,taskUsagePromise,workspaceRowsPromise,attentionRowsPromise]);
  const workspaceRow = workspaceRows[0] ?? {};
  const diff = (workspaceRow.diff_summary ?? {}) as Json;
  const workspaceState: WorkspaceState = {
    branch: String(workspaceRow.branch ?? emptyWorkspaceState.branch), headSha: String(workspaceRow.head_sha ?? ""),
    upstream: String(workspaceRow.upstream ?? ""), ahead: Number(workspaceRow.ahead ?? 0), behind: Number(workspaceRow.behind ?? 0),
    dirty: Boolean(workspaceRow.dirty), changedFiles: Array.isArray(workspaceRow.changed_files)
      ? workspaceRow.changed_files.map((file) => ({ path: String((file as Json).path), status: String((file as Json).status) })) : [],
    diffSummary: { files: Number(diff.files ?? 0), additions: Number(diff.additions ?? 0),
      deletions: Number(diff.deletions ?? 0), untracked: Number(diff.untracked ?? 0), truncated: Boolean(diff.truncated) },
    unpublished: unpublishedOf(diff.unpublished),
    observedAt: String(workspaceRow.observed_at ?? ""), collector: String(workspaceRow.collector ?? ""),
    lockStatus: String(workspaceRow.lock_status ?? "released"),
    lockOwner: workspaceRow.lock_owner ? agentDisplayName(workspaceRow.lock_owner, workspaceRow.lock_owner_runtime) : "", lockRunId: String(workspaceRow.lock_run_id ?? ""),
    lockLeaseExpiresAt: String(workspaceRow.lock_lease_expires_at ?? ""),
    checksSummary: (workspaceRow.checks_summary ?? {}) as Json, checksRunId: String(workspaceRow.checks_run_id ?? ""),
    checksObservedAt: String(workspaceRow.checks_observed_at ?? ""),
    handoffObjective: String(workspaceRow.handoff_objective ?? ""), handoffRevision: Number(workspaceRow.handoff_revision ?? 0),
    handoffFrom: workspaceRow.handoff_from ? agentDisplayName(workspaceRow.handoff_from, workspaceRow.handoff_from_runtime) : "",
    handoffTo: workspaceRow.handoff_to ? agentDisplayName(workspaceRow.handoff_to, workspaceRow.handoff_to_runtime) : "",
    handoffPaths: Array.isArray(workspaceRow.handoff_paths) ? workspaceRow.handoff_paths.map(String) : [],
    activeOperation: String(workspaceRow.active_operation ?? ""),
  };
  const attention: ActionTarget[] = [];
  let publishState: PublishState = null;
  let taskFiles: number | null = null;
  let taskChanges: TaskChanges | null = null;
  if (activeTask) {
    const [approvalRows,interactionRows,incidentRows,publishRows,evidenceRows] = attentionRows;
    const reviewed = evidenceRows?.[0]?.files;
    if (typeof reviewed === "number" && Number.isFinite(reviewed)) taskFiles = reviewed;
    const evidence = evidenceRows?.[0];
    if (evidence && Array.isArray(evidence.changed)) taskChanges = {
      additions: Number(evidence.additions ?? 0), deletions: Number(evidence.deletions ?? 0),
      files: (evidence.changed as Json[]).map((file) => ({ path: String(file.path ?? ""), status: String(file.status ?? ""),
        additions: Number(file.added ?? 0), deletions: Number(file.deleted ?? 0) })).filter((file) => file.path),
    };
    for (const row of approvalRows) attention.push({ type: "approval", id: String(row.id), projectId, taskId: activeTask.id,
      taskVersion: activeTask.version, title: `${String(row.action_type).replaceAll("_"," ")} approval`,
      description: "A protected action is waiting for your decision.", time: String(row.requested_at) });
    for (const row of interactionRows) {
      const payload = (row.payload ?? {}) as Json;
      attention.push({ type: "interaction", id: String(row.id), projectId, taskId: activeTask.id,
        taskVersion: activeTask.version, reportType: String(row.report_type),
        // The executor is whichever runtime the task assigned, and has been
        // more than OpenCode since the roster became configurable; the card
        // said "OpenCode" whoever asked.
        title: `${agentDisplayName(row.agent_name,row.runtime_type)} ${row.report_type === "input_request" ? "needs input" : "is blocked"}`,
        description: String(payload.question ?? payload.reason ?? payload.message ?? "Provide instructions to resume the workflow."),
        time: String(row.finalized_at) });
    }
    // A dead letter says why it died in the vocabulary's words first, then the
    // last error, and carries the attempt it died at: the buttons answer that
    // death and no other (0072).
    for (const row of incidentRows) attention.push({ type: "incident", id: String(row.id), projectId,
      taskId: activeTask.id, taskVersion: activeTask.version, title: `${String(row.job_type).replaceAll("_"," ")} stopped`,
      attempt: Number(row.attempt ?? 0), failureReason: String(row.failure_reason ?? ""),
      description: [row.reason_note ? `${String(row.reason_note).charAt(0).toUpperCase()}${String(row.reason_note).slice(1)}.` : "",
        String(row.last_error ?? "")].filter(Boolean).join(" — ") || "Runtime work requires operator reconciliation.",
      time: String(row.completed_at ?? "") });
    // Sprint B P1: an approved task's prepared commit, offered for publishing,
    // or its failed publish offered again. A publish in progress or done asks
    // nothing; the conversation says how it went.
    for (const row of publishRows ?? []) {
      publishState = publishStateOf(row);
      if (row.preparation_status !== "prepared" || row.credential_mode !== "github_app") continue;
      const sha = String(row.head_commit_sha ?? "").slice(0, 12);
      if (!row.intent_id) attention.push({ type: "publish", id: String(row.preparation_id), projectId,
        taskId: activeTask.id, taskVersion: activeTask.version, title: "Ready to publish",
        description: `Push ${sha} to a branch for this task on ${String(row.repository ?? "GitHub")} and open a pull request against ${String(row.default_branch ?? "main")}.`,
        time: String(row.prepared_at ?? activeTask.updatedAt) });
      else if (row.intent_status === "failed") attention.push({ type: "publish_failed", id: String(row.intent_id), projectId,
        taskId: activeTask.id, taskVersion: activeTask.version, title: "Publish stopped",
        attempt: Number(row.attempt ?? 0), failureReason: String(row.failure_reason ?? ""),
        description: [row.reason_note ? `${String(row.reason_note).charAt(0).toUpperCase()}${String(row.reason_note).slice(1)}.` : "",
          String(row.failure_message ?? "")].filter(Boolean).join(" — ") || "The publish did not complete.",
        time: String(row.finished_at ?? activeTask.updatedAt) });
    }
    // Only a GitHub App repository is published by the platform (0085): the
    // card offers "Approve & open PR" for those.
    if (activeTask.status === "awaiting_review") attention.push({ type: "review", id: activeTask.id, projectId,
      taskId: activeTask.id, taskVersion: activeTask.version, reviewerAgentId: activeTask.activeAgentId,
      canPublish: projectRows[0]?.credential_mode === "github_app",
      title: "Ready for your approval",
      description: `${activeTask.orchestratorRuntime ? runtimeLabel(activeTask.orchestratorRuntime) : "The orchestrator"} reviewed the changes. Check the diff, then approve them or ask for changes. Once approved, you can publish them to GitHub as a pull request.`,
      time: activeTask.updatedAt });
  }
  return {
    project: projectFromRow(projectRows[0]),
    tasks,
    sessions: sessionRows.map((row) => ({ id: String(row.id), agentName: String(row.agent_name), runtimeType: String(row.runtime_type), nativeSessionId: String(row.native_session_id ?? "Not started"), purpose: String(row.purpose), status: String(row.status), updatedAt: String(row.updated_at) })),
    events,
    activeTask,
    messages,
    taskActivity,
    usage,
    taskUsage,
    workspaceState,
    attention,
    publishState: activeTask?.status === "approved" ? publishState : null,
    taskFiles,
    taskChanges,
    agentRoster: rosterRows.map((row) => {
      const runtimeType = String(row.runtime_type);
      return {
        assignmentId: String(row.assignment_id), agentId: String(row.agent_id),
        agentName: agentDisplayName(row.agent_name, runtimeType), assignmentRole: String(row.assignment_role) as "orchestrator" | "executor",
        isDefault: Boolean(row.is_default), profileId: String(row.profile_id), runtimeType,
        providerType: String(row.provider_type), model: String(row.model),
        canOrchestrate: runtimePlays(runtimeType, "orchestrator"),
        canExecute: runtimePlays(runtimeType, "executor"),
      };
    }),
  };
}

export async function getConversationUsage(ownerId: string, projectId: string, taskId: string): Promise<RuntimeUsage[]> {
  if (!hasDatabaseConnection()) return [];
  // By what ran (0071): tokens by the runtime whose steps reported them,
  // attempts by the runtime each job's selection recorded. The job type decides
  // nothing — it used to decide everything: every implementation was OpenCode's
  // and every other job Codex's, whoever the task had selected.
  const rows = await queryJsonRows(
    `SELECT u::text FROM conversation_runtime_usage(:'project_id'::uuid,:'task_id'::uuid,:'owner_id'::uuid) u;`,
    { owner_id: ownerId, project_id: projectId, task_id: taskId });
  return rows.map((row) => ({
    runtimeType: String(row.runtime_type),inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),reasoningTokens: Number(row.reasoning_tokens ?? 0),
    cacheReadTokens: Number(row.cache_read_tokens ?? 0),cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),modelSteps: Number(row.model_steps ?? 0),
    attempts: Number(row.attempts ?? 0),cost: Number(row.cost ?? 0),updatedAt: String(row.updated_at ?? ""),
  }));
}

export async function getTaskActivity(ownerId: string, projectId: string, taskId: string): Promise<TaskActivity | null> {
  if (!hasDatabaseConnection()) return null;
  const rows = await queryJsonRows(`
    WITH activity AS (
      SELECT 'runtime_job'::text AS source,j.id::text AS activity_id,j.status,
        -- Since 0060 a Codex turn waits while a writer holds the workspace. A
        -- wait that looks like an idle queue is worse than the race it replaced,
        -- so it is named: phase and detail both say what the message is waiting
        -- for, and it is checked first because a retried job carries the detail
        -- of its last attempt.
        -- A lock in reconciliation_required has no writer to wait for: it waits
        -- for the operator. Shown as "waiting for the implementation" it looked
        -- like a hang (the rc.27 panel run, P-6), so it says what to do instead.
        CASE WHEN waiting_for_writer.blocked AND waiting_for_writer.recovery THEN 'waiting_for_recovery'
             WHEN waiting_for_writer.blocked THEN 'waiting_for_workspace'
             WHEN waiting_for_run.blocked THEN 'waiting_for_run'
             WHEN j.status='pending' AND j.attempt_count>0 THEN 'retrying'
             WHEN j.status='pending' THEN 'queued'
             WHEN j.status='completed' THEN 'completed'
             WHEN j.status='dead_letter' THEN 'failed'
             ELSE j.activity_phase END AS phase,
        CASE WHEN waiting_for_writer.blocked AND waiting_for_writer.recovery THEN
          'The workspace needs recovery after a failed run. Open Workspace and use "Recover stale lock"; the message will be answered after it'
        WHEN waiting_for_writer.blocked THEN
          'Waiting for the running implementation to release the workspace; the message will be answered after it'
        -- 0070: a message, handoff or resume waits for the run in front of it
        -- in its conversation, and becomes a run of its own after it.
        WHEN waiting_for_run.blocked THEN
          'Waiting for the current run in this conversation to finish; this becomes a new run after it'
        ELSE COALESCE(j.activity_detail,
          CASE j.status WHEN 'pending' THEN 'Waiting for an available runtime worker'
            WHEN 'in_flight' THEN 'The runtime worker owns this job'
            WHEN 'completed' THEN 'The runtime job completed'
            ELSE 'The runtime job needs operator attention' END) END AS detail,
         -- What ran, where it was recorded (0071), before what was assigned.
         COALESCE(sa.name,ra.name,ea.name,oa.name) AS agent_name,
         COALESCE(sel.runtime_type,rrp.runtime_type,erp.runtime_type,orp.runtime_type) AS runtime_type,
         COALESCE(
           sel.model,
           CASE WHEN j.job_type='implementation_run' THEN snapshot_executor.model_id END,
           CASE WHEN j.job_type<>'implementation_run' THEN snapshot.orchestrator->>'model_id' END,
           rrp.model,erp.model,orp.model
         ) AS model,
        -- The Stop button: whether the driver recorded for this job declares
        -- interrupt — the same answer request_runtime_interrupt gives. It read
        -- runtime_profiles.capabilities, and on rc.38 a running Codex turn had no
        -- button while Codex's driver declares interrupt in its mandatory core.
        runtime_job_can_interrupt(j.id) AS can_interrupt,
        j.attempt_count,j.created_at AS queued_at,
        -- The clock runs from the attempt now running. A dead letter retried
        -- nine days later showed "Elapsed 14359:36", timed from the job's first
        -- start; the attempt count already says it is not the first. A job from
        -- before provenance (0071) has no attempt row and keeps its own start.
        COALESCE((SELECT max(d.started_at) FROM runtime_dispatch_attempts d WHERE d.job_id=j.id),
          j.started_at) AS started_at,
        j.heartbeat_at,
        -- A dead-lettered job has no completed_at. Without an end the panel's
        -- clock ran on from its start for days; the end is when its run
        -- finished, or failing that the last sign of life.
        COALESCE(j.completed_at,CASE WHEN j.status NOT IN ('pending','in_flight')
          THEN COALESCE(tr.finished_at,j.interrupted_at,j.heartbeat_at,j.started_at,j.created_at) END) AS finished_at,
        COALESCE(j.last_error,'') AS last_error,
        j.status IN ('pending','in_flight') AS active
      FROM runtime_jobs j
      JOIN tasks t ON t.id=j.task_id
      JOIN project_agent_assignments opa ON opa.id=t.orchestrator_assignment_id
      JOIN agents oa ON oa.id=opa.agent_id
       JOIN runtime_profiles orp ON orp.id=opa.runtime_profile_id
       LEFT JOIN task_runtime_snapshots snapshot ON snapshot.task_id=t.id
      LEFT JOIN LATERAL (
        SELECT s.runtime_type,s.model,s.agent_id FROM runtime_job_selections s
        WHERE s.job_id=j.id AND NOT EXISTS (SELECT 1 FROM runtime_job_selections later WHERE later.supersedes=s.id)
        ORDER BY s.id DESC LIMIT 1
      ) sel ON true
      LEFT JOIN agents sa ON sa.id=sel.agent_id
      LEFT JOIN LATERAL (
        SELECT j.status='pending' AND j.job_type IN ('orchestrator_turn','resume_orchestrator') AND EXISTS (
          SELECT 1 FROM workspace_locks wl
          WHERE wl.project_id=j.project_id AND wl.status IN ('held','reconciliation_required')
        ) AS blocked,
        EXISTS (
          SELECT 1 FROM workspace_locks wl
          WHERE wl.project_id=j.project_id AND wl.status='reconciliation_required'
        ) AS recovery
      ) waiting_for_writer ON true
      LEFT JOIN LATERAL (
        SELECT j.status='pending' AND EXISTS (
          SELECT 1 FROM conversation_ingress mine
          JOIN conversation_ingress other ON other.conversation_id=mine.conversation_id AND other.job_id<>mine.job_id
          JOIN runtime_jobs oj ON oj.id=other.job_id
          WHERE mine.job_id=j.id
            AND (oj.status='in_flight' OR ((other.conversation_sequence,other.job_id)<(mine.conversation_sequence,mine.job_id)
                                          AND oj.status='pending'))
        ) AS blocked
      ) waiting_for_run ON true
      -- A review job is born pointing at the implementation run it reviews:
      -- route_outbox_message copies the source event's run_id, and
      -- implementation.completed carries the executor's run (0059 says so in
      -- its header). Until a worker claims the job and the trigger replaces
      -- run_id with the review turn, reading the agent from that run named the
      -- executor: a waiting Codex review was shown as "OpenCode", with the
      -- executor's model. A turn is never write-capable and an implementation
      -- always is, so the run is read only when it is this job's own.
      LEFT JOIN task_runs tr ON tr.id=j.run_id
        AND NOT (j.job_type IN ('orchestrator_turn','resume_orchestrator') AND tr.write_capable)
      LEFT JOIN agents ra ON ra.id=tr.agent_id
      LEFT JOIN agent_sessions rs ON rs.id=tr.session_id
      LEFT JOIN runtime_profiles rrp ON rrp.id=rs.runtime_profile_id
      LEFT JOIN domain_events source_event ON source_event.id=j.source_event_id
      LEFT JOIN handoffs h ON j.job_type='implementation_run'
        AND h.id=NULLIF(source_event.payload->>'handoff_id','')::uuid
      LEFT JOIN project_agent_assignments epa ON epa.id=h.executor_assignment_id
      LEFT JOIN agents ea ON ea.id=epa.agent_id
       LEFT JOIN runtime_profiles erp ON erp.id=epa.runtime_profile_id
       LEFT JOIN LATERAL (
         SELECT entry->>'model_id' AS model_id
         FROM jsonb_array_elements(snapshot.executors) entry
         WHERE entry->'assignment_ids' @> to_jsonb(epa.id::text)
         LIMIT 1
       ) snapshot_executor ON true
      JOIN projects jp ON jp.id=j.project_id
      WHERE j.project_id=:'project_id'::uuid AND j.task_id=:'task_id'::uuid
        AND jp.owner_id=:'owner_id'::uuid
        AND j.status IN ('pending','in_flight','dead_letter')
    ), selected AS (
      -- The running job first. Since 0070 a message typed during a run is a
      -- job of its own waiting behind it, and newest-first showed that waiting
      -- job — and hid the running one's Stop button exactly while it ran.
      SELECT * FROM activity ORDER BY (status='in_flight') DESC,active DESC,activity_id::bigint DESC LIMIT 1
    ), cursor AS (
      SELECT COALESCE(max(occurred_at)::text,'') AS event_cursor
      FROM domain_events e JOIN projects p ON p.id=e.project_id
      WHERE e.project_id=:'project_id'::uuid AND e.task_id=:'task_id'::uuid
        AND p.owner_id=:'owner_id'::uuid
    )
    SELECT jsonb_build_object(
      'activity_id',a.activity_id,'source',a.source,'status',a.status,'phase',a.phase,
      'detail',a.detail,'agent_name',a.agent_name,'runtime_type',a.runtime_type,
      'model',a.model,'can_interrupt',a.can_interrupt,'attempt_count',a.attempt_count,'queued_at',a.queued_at,
      'started_at',a.started_at,'heartbeat_at',a.heartbeat_at,'finished_at',a.finished_at,
      'last_error',a.last_error,'active',a.active,'event_cursor',c.event_cursor,'events',re.events
    )::text
    FROM selected a CROSS JOIN cursor c
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id',e.id,'event_type',e.event_type,'summary',e.summary,'occurred_at',e.occurred_at
      ) ORDER BY e.id DESC),'[]'::jsonb) AS events FROM (
        SELECT ae.id,ae.event_type,ae.summary,ae.occurred_at
        FROM runtime_activity_events ae
        -- Stage 12: Codex's per-call usage and the windows' updates are the
        -- usage card's, and would push what the run did out of these five.
        WHERE ae.job_id=a.activity_id::bigint
          AND ae.event_type NOT IN ('runtime.usage.updated','runtime.limits.updated')
        ORDER BY ae.id DESC LIMIT 5
      ) e
    ) re ON true;
  `, { owner_id: ownerId, project_id: projectId, task_id: taskId });
  if (!rows.length) return null;
  const row = rows[0];
  const activityEvents = Array.isArray(row.events) ? row.events as Json[] : [];
  return {
    activityId: String(row.activity_id), source: String(row.source) as TaskActivity["source"],
    status: String(row.status), phase: String(row.phase), detail: String(row.detail),
    agentName: agentDisplayName(row.agent_name,row.runtime_type), runtimeType: String(row.runtime_type ?? ""),
    model: String(row.model ?? ""), attemptCount: Number(row.attempt_count ?? 0),
    queuedAt: String(row.queued_at ?? ""), startedAt: String(row.started_at ?? ""),
    heartbeatAt: String(row.heartbeat_at ?? ""), finishedAt: String(row.finished_at ?? ""),
    lastError: String(row.last_error ?? ""), active: Boolean(row.active),
    eventCursor: String(row.event_cursor ?? ""),
    canInterrupt: Boolean(row.can_interrupt),
    events: activityEvents.map((event) => ({ id: String(event.id), eventType: String(event.event_type),
      summary: String(event.summary), occurredAt: String(event.occurred_at) })),
  };
}

// The agent runtimes, as the host last reported them.
//
// Read from `runtime_health` — the snapshot the root health timer writes — and
// never from `/etc/infra-cod/runtimes.json` or a runtime user's home. The web
// tier runs as `infra_web`, which has no business opening either, and giving it
// a reason to would undo the boundary the rest of the installation is built on.
//
// The four states stay four fields. "The binary is there" and "a task can start"
// are different claims, and an operator who is shown one number is being told to
// fix the wrong thing — so `installed`, `authenticated`, `capabilityVerified`
// and `ready` are carried separately all the way to the markup.
//
// `observedAt` and `stale` travel with them because a snapshot is a statement
// about a moment. The bound matches the one dispatch enforces in SQL
// (`runtime_dispatch_staleness()`, ten minutes against a timer that fires every
// minute), so the panel and the refusal cannot disagree about what "current"
// means.
export type RuntimeReadiness = {
  runtime: string;
  version: string | null;
  installed: boolean;
  authenticated: boolean;
  capabilityVerified: boolean;
  ready: boolean;
  selfUpdateManaged: boolean;
};

export type RuntimeReadinessReport = {
  runtimes: RuntimeReadiness[];
  observedAt: string | null;
  stale: boolean;
  /** True when the host has never reported, or reported without runtime information. */
  unreported: boolean;
};

const RUNTIME_SNAPSHOT_STALE_MS = 10 * 60 * 1000;

export async function getRuntimeReadiness(): Promise<RuntimeReadinessReport> {
  const empty: RuntimeReadinessReport = { runtimes: [], observedAt: null, stale: false, unreported: true };
  if (!hasDatabaseConnection()) return empty;
  const rows = await queryJsonRows(`
    SELECT jsonb_build_object('observed_at',observed_at,'runtimes',snapshot->'runtimes')::text
    FROM runtime_health WHERE singleton=true;
  `);
  const row = rows[0];
  if (!row) return empty;
  const observedAt = typeof row.observed_at === "string" ? row.observed_at : null;
  const reported = Array.isArray(row.runtimes) ? row.runtimes as Json[] : null;
  if (!observedAt || !reported) return empty;

  const age = Date.now() - new Date(observedAt).getTime();
  return {
    observedAt,
    // A timestamp that does not parse is not a fresh one. `NaN > bound` is false,
    // which would have read as current.
    stale: !Number.isFinite(age) || age > RUNTIME_SNAPSHOT_STALE_MS,
    unreported: false,
    runtimes: reported.map((entry) => ({
      runtime: String(entry.runtime ?? "unknown"),
      version: typeof entry.version === "string" ? entry.version : null,
      installed: entry.installed === true,
      authenticated: entry.authenticated === true,
      capabilityVerified: entry.capability_verified === true,
      ready: entry.ready === true,
      selfUpdateManaged: entry.self_update_managed === true,
    })),
  };
}

// Newer upstream versions of each runtime, as the host's daily watch saw them
// (Stage 12 W2, migration 0095). Read-only: installing one stays a command on
// the server, which the card names.
export type RuntimeNewerVersion = { version: string; publishedAt: string | null; offeredFrom: string | null; offered: boolean };
export type RuntimeVersionWatch = {
  runtime: string;
  activeVersion: string | null;
  checkedAt: string | null;
  error: string | null;
  newer: RuntimeNewerVersion[];
  /** The version this release's driver was verified at (0105, from the health report). */
  baselineVersion: string | null;
  /** What verifies the active version: "baseline", "host qualification <id>", or null for neither. */
  verifiedBy: string | null;
};

export async function getRuntimeVersions(): Promise<RuntimeVersionWatch[]> {
  if (!hasDatabaseConnection()) return [];
  const { executeJson } = await import("@/lib/database");
  const value = await executeJson(`SELECT get_runtime_versions()::text;`, {});
  if (!Array.isArray(value)) return [];
  return (value as Json[]).map((entry) => ({
    runtime: String(entry.runtime ?? "unknown"),
    activeVersion: typeof entry.active_version === "string" ? entry.active_version : null,
    checkedAt: typeof entry.checked_at === "string" ? entry.checked_at : null,
    error: typeof entry.error === "string" ? entry.error : null,
    baselineVersion: typeof entry.baseline_version === "string" ? entry.baseline_version : null,
    verifiedBy: typeof entry.verified_by === "string" ? entry.verified_by : null,
    newer: (Array.isArray(entry.newer) ? entry.newer as Json[] : []).map((newer) => ({
      version: String(newer.version ?? ""),
      publishedAt: typeof newer.published_at === "string" ? newer.published_at : null,
      offeredFrom: typeof newer.offered_from === "string" ? newer.offered_from : null,
      offered: newer.offered === true,
    })),
  }));
}

// The host's qualifications of runtime versions (Stage 12 W3, migration 0096):
// the latest of each version, with its checks. Read-only — `infra-cod runtime
// qualify` writes them.
export type RuntimeQualificationCheck = {
  check: string; result: string; failureClass: string | null; detail: string; durationMs: number | null;
};
export type RuntimeQualification = {
  id: string; runtime: string; version: string; result: "running" | "passed" | "failed" | "incomplete" | "refused" | string;
  startedAt: string | null; finishedAt: string | null; summary: string; checks: RuntimeQualificationCheck[];
  /** What the candidate's model list read against the active one's (its catalog.list check), when it read one. */
  catalog: { count: number | null; added: string[]; removed: string[] } | null;
};

export async function getRuntimeQualifications(): Promise<RuntimeQualification[]> {
  if (!hasDatabaseConnection()) return [];
  const { executeJson } = await import("@/lib/database");
  const value = await executeJson(`SELECT get_runtime_qualifications()::text;`, {});
  if (!Array.isArray(value)) return [];
  return (value as Json[]).map((entry) => ({
    id: String(entry.id ?? ""), runtime: String(entry.runtime ?? ""), version: String(entry.version ?? ""),
    result: String(entry.result ?? ""),
    startedAt: typeof entry.started_at === "string" ? entry.started_at : null,
    finishedAt: typeof entry.finished_at === "string" ? entry.finished_at : null,
    summary: typeof entry.summary === "string" ? entry.summary : "",
    checks: (Array.isArray(entry.checks) ? entry.checks as Json[] : []).map((check) => ({
      check: String(check.check ?? ""), result: String(check.result ?? ""),
      failureClass: typeof check.failure_class === "string" ? check.failure_class : null,
      detail: typeof check.detail === "string" ? check.detail : "",
      durationMs: Number.isFinite(Number(check.duration_ms)) && check.duration_ms !== null ? Number(check.duration_ms) : null,
    })),
    catalog: entry.catalog && typeof entry.catalog === "object" ? {
      count: Number.isFinite(Number((entry.catalog as Json).count)) && (entry.catalog as Json).count !== null ? Number((entry.catalog as Json).count) : null,
      added: Array.isArray((entry.catalog as Json).added) ? ((entry.catalog as Json).added as unknown[]).map(String) : [],
      removed: Array.isArray((entry.catalog as Json).removed) ? ((entry.catalog as Json).removed as unknown[]).map(String) : [],
    } : null,
  }));
}

// Every promotion and rollback on this host (Stage 12 W4, migration 0097),
// newest first, at most 50.
export type RuntimeActivation = {
  runtime: string; kind: "promote" | "rollback" | string; version: string; from: string;
  qualificationId: string | null; acceptedUnqualified: boolean; reason: string | null; actor: string; at: string | null;
};

export async function getRuntimeActivations(): Promise<RuntimeActivation[]> {
  if (!hasDatabaseConnection()) return [];
  const { executeJson } = await import("@/lib/database");
  const value = await executeJson(`SELECT get_runtime_activations()::text;`, {});
  if (!Array.isArray(value)) return [];
  return (value as Json[]).map((entry) => ({
    runtime: String(entry.runtime ?? ""), kind: String(entry.kind ?? ""), version: String(entry.version ?? ""),
    from: String(entry.from ?? ""),
    qualificationId: typeof entry.qualification_id === "string" ? entry.qualification_id : null,
    acceptedUnqualified: entry.accepted_unqualified === true,
    reason: typeof entry.reason === "string" ? entry.reason : null,
    actor: String(entry.actor ?? ""), at: typeof entry.at === "string" ? entry.at : null,
  }));
}

// The Qualify and Promote buttons' requests (0127): per runtime the open one
// and the last finished, which the host's update pass picks up every five
// minutes and answers.
export type RuntimeUpdateRequest = {
  id: string; runtime: string; version: string; kind: "qualify" | "promote" | string;
  status: "requested" | "running" | "done" | "failed" | string; message: string; createdAt: string; finishedAt: string | null;
};

export async function getRuntimeUpdateRequests(): Promise<RuntimeUpdateRequest[]> {
  if (!hasDatabaseConnection()) return [];
  const { executeJson } = await import("@/lib/database");
  const value = await executeJson(`SELECT get_runtime_update_requests()::text;`, {}).catch(() => null);
  if (!Array.isArray(value)) return [];
  return (value as Json[]).map((entry) => ({
    id: String(entry.id ?? ""), runtime: String(entry.runtime ?? ""), version: String(entry.version ?? ""),
    kind: String(entry.kind ?? ""), status: String(entry.status ?? ""), message: String(entry.message ?? ""),
    createdAt: String(entry.created_at ?? ""), finishedAt: typeof entry.finished_at === "string" ? entry.finished_at : null,
  }));
}

// GitHub issues as chats (0132): the project's settings and the issues waiting
// for the owner. Null before 0132, or for a project that is not the owner's.
export type WaitingIssue = { id: string; number: number; title: string; url: string; author: string; firstSeenAt: string };
export type IssueIntake = {
  available: boolean; repository: string; enabled: boolean; label: string;
  polledAt: string | null; errorCode: string | null; error: string | null;
  waiting: WaitingIssue[]; ignored: number;
};

export async function getIssueIntake(projectId: string, ownerId: string): Promise<IssueIntake | null> {
  if (!hasDatabaseConnection()) return null;
  const { executeJson } = await import("@/lib/database");
  const value = await executeJson(`SELECT get_issue_intake(:'project_id'::uuid,:'owner_id'::uuid)::text;`,
    { project_id: projectId, owner_id: ownerId }).catch(() => null) as Json | null;
  if (!value || typeof value !== "object") return null;
  const text = (entry: unknown) => typeof entry === "string" && entry ? entry : null;
  return {
    available: Boolean(value.available), repository: String(value.repository ?? ""),
    enabled: Boolean(value.enabled), label: String(value.label ?? "agent"),
    polledAt: text(value.polled_at), errorCode: text(value.error_code), error: text(value.error),
    waiting: (Array.isArray(value.waiting) ? value.waiting as Json[] : []).map((entry) => ({
      id: String(entry.id ?? ""), number: Number(entry.number ?? 0), title: String(entry.title ?? ""),
      url: String(entry.url ?? ""), author: String(entry.author ?? ""), firstSeenAt: String(entry.first_seen_at ?? ""),
    })),
    ignored: Number(value.ignored ?? 0),
  };
}

// Whether work can be started at all, and the sentence to show when it cannot.
//
// This is the panel's half of the rule SQL enforces at dispatch: same states,
// same staleness bound, same treatment of silence. The panel warns; the database
// refuses. Neither is a substitute for the other — a page is a statement about
// when it was rendered, and the seconds between reading it and pressing a button
// are exactly where a runtime gets removed.
export function dispatchBlockers(report: RuntimeReadinessReport): string[] {
  if (report.unreported) {
    return ["This host has not reported which agent runtimes can run. Run `infra-cod doctor` on the server."];
  }
  if (report.stale) {
    return ["The host stopped reporting runtime readiness. Check `infra-cod-health.timer` on the server."];
  }
  return report.runtimes
    .filter((runtime) => !runtime.installed || !runtime.authenticated)
    .map((runtime) => runtime.installed
      ? `${runtime.runtime} holds no usable credential — connect it in Settings.`
      : `${runtime.runtime} is not provisioned — run \`infra-cod runtime install ${runtime.runtime} --version <exact>\` on the server.`);
}

// The readiness read model lives in ./readiness.ts, which the client-side
// composer shares (it must not import this module, which opens the database);
// only the database read is here, and the types are re-exported at the top.
function prerequisiteState(value: unknown): PrerequisiteState {
  return value === "ready" || value === "missing" ? value : "unknown";
}

function assignmentReadinessFromRow(row: Json): AssignmentReadiness {
  const blocked = row.blocked_by && typeof row.blocked_by === "object" ? row.blocked_by as Json : null;
  const runtime = String(row.runtime ?? "");
  return {
    assignmentId: String(row.assignment_id), agentId: String(row.agent_id),
    agentName: agentDisplayName(row.agent_name, runtime),
    role: row.role === "orchestrator" || row.role === "executor" ? row.role : "other",
    isDefault: row.is_default === true,
    runtime, runtimeVersion: typeof row.runtime_version === "string" ? row.runtime_version : null,
    entryId: typeof row.entry_id === "string" ? row.entry_id : null,
    modelId: String(row.model_id ?? ""), displayName: String(row.display_name ?? ""), providerId: String(row.provider_id ?? ""),
    runtimeInstalled: prerequisiteState(row.runtime_installed),
    runtimeAuthenticated: prerequisiteState(row.runtime_authenticated),
    modelVerified: prerequisiteState(row.model_verified),
    connectionConnected: prerequisiteState(row.connection_connected),
    ready: row.ready === true,
    blockedBy: blocked ? {
      prerequisite: String(blocked.prerequisite) as ReadinessBlocker["prerequisite"],
      reason: String(blocked.reason ?? ""), message: String(blocked.message ?? ""),
      action: String(blocked.action ?? ""), note: String(blocked.note ?? ""),
    } : null,
  };
}

// The Team tab's reading (0089): the team, its roles and what may be picked.
export async function getProjectTeam(projectId: string, ownerId: string): Promise<ProjectTeam | null> {
  if (!hasDatabaseConnection()) return null;
  // The team and, beside it, each member's reasoning level and the levels of
  // the models the tab offers (0111).
  const rows = await queryJsonRows(`SELECT (project_team(:'project_id'::uuid,:'owner_id'::uuid)
      || jsonb_build_object('reasoning',project_team_reasoning(:'project_id'::uuid,:'owner_id'::uuid)))::text;`,
    { project_id: projectId, owner_id: ownerId });
  return rows[0] ? projectTeamFromRow(rows[0]) : null;
}

export async function getProjectReadiness(projectId: string, ownerId: string): Promise<ProjectReadiness | null> {
  if (!hasDatabaseConnection()) return null;
  const rows = await queryJsonRows(`
    SELECT project_readiness(:'project_id'::uuid,:'owner_id'::uuid)::text;
  `, { project_id: projectId, owner_id: ownerId });
  const row = rows[0];
  if (!row) return null;
  return {
    projectId: String(row.project_id),
    observedAt: typeof row.observed_at === "string" ? row.observed_at : null,
    hasDefaults: row.has_defaults === true,
    ready: row.ready === true,
    assignments: Array.isArray(row.assignments) ? (row.assignments as Json[]).map(assignmentReadinessFromRow) : [],
  };
}
