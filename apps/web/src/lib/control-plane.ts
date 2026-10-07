import { hasDatabaseConnection, queryJsonRows } from "@/lib/database";

type Json = Record<string, unknown>;

export type ActionTarget = {
  type: "approval" | "review" | "interaction" | "incident" | "publish" | "publish_failed" | "none";
  id: string;
  projectId: string;
  taskId: string;
  taskVersion: number;
  reviewerAgentId?: string;
  reportType?: string;
  // A dead letter (0072): the attempt it died at, which is what a retry or a
  // dismissal answers, and the reason from the vocabulary.
  attempt?: number;
  failureReason?: string;
  // A review whose project the platform can publish (0138): offer "Approve & open PR".
  canPublish?: boolean;
  title: string;
  description: string;
  time: string;
};

export type ControlPlaneSnapshot = {
  generatedAt: string;
  dataSource: "live" | "demo";
  health: { status: string; detail?: string };
  projects: Array<{ id: string; name: string; repository: string; lastActivity: string; taskCount: number; attentionCount: number }>;
  metrics: { activeWorkflow: string; activeTitle: string; progress: number; stage: string; checksPassed: number; checksTotal: number; checkDuration: string };
  lock: { owner: string; status: string; since: string; session: string };
  task: {
    id: string; projectId: string; reviewerAgentId: string; status: string; version: number;
    title: string; contractVersion: number; contract: string; branch: string;
    filesChanged: number; additions: number; deletions: number; shortSession: string;
    acceptanceCriteria: unknown[];
  };
  terminal: Array<{ time: string; prefix: string; text: string; kind: string }>;
  terminalNow: string;
  attention: ActionTarget[];
  primaryAction: ActionTarget;
  events: Array<{ id: string; title: string; detail: string; time: string; tone: string; icon: string }>;
};

function timeAgo(value?: string) {
  if (!value) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function clock(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Athens" }).format(new Date(value));
}

function eventPresentation(type: string, payload: Json) {
  const map: Record<string, [string, string, string]> = {
    "implementation.completed": ["Implementation completed", "green-event", "check"],
    "revision.completed": ["Revision completed", "green-event", "check"],
    "implementation.started": ["OpenCode run started", "violet-event", "spark"],
    "revision.started": ["Revision run started", "violet-event", "spark"],
    "implementation.requested": ["Task delegated", "blue-event", "arrow"],
    "changes.requested": ["Changes requested", "amber-event", "spark"],
    "run.input_requested": ["Input requested", "amber-event", "spark"],
    "implementation.blocked": ["Worker blocked", "amber-event", "lock"],
    "interaction.resolved": ["Operator response sent", "blue-event", "arrow"],
    "review.approved": ["Review approved", "green-event", "check"],
  };
  const [title, tone, icon] = map[type] ?? [type.replaceAll(".", " "), "blue-event", "timeline"];
  const detail = String(
    payload.summary ?? payload.response ?? (payload.revision_number ? `Revision ${payload.revision_number}` : "State recorded"),
  );
  return { title, tone, icon, detail };
}

async function getLiveSnapshot(ownerId: string, requestedProjectId?: string): Promise<ControlPlaneSnapshot> {
  const projectFilter = requestedProjectId ?? process.env.CONTROL_PLANE_PROJECT_ID;
  const projects = await queryJsonRows(`
    SELECT jsonb_build_object(
      'id',p.id,'name',p.name,'repository',COALESCE(p.repository_url,p.workspace_path),
      'updated_at',COALESCE(max(t.updated_at),p.updated_at),'task_count',count(t.id),
      'attention_count',count(t.id) FILTER (WHERE t.status='needs_attention')
    )::text
    FROM projects p LEFT JOIN tasks t ON t.project_id=p.id
    WHERE p.owner_id=:'owner_id'::uuid AND p.status<>'archived'
    GROUP BY p.id
    ORDER BY (count(t.id) FILTER (WHERE t.status IN ('awaiting_review','needs_attention','implementing','revising'))) DESC,
      COALESCE(max(t.updated_at),p.updated_at) DESC LIMIT 30;
  `, { owner_id: ownerId });
  if (!projects.length) throw new Error("No control-plane projects are available");
  const selected = projectFilter ? projects.find((item) => item.id === projectFilter) ?? projects[0] : projects[0];
  const projectId = String(selected.id);

  const task = (await queryJsonRows(`
    SELECT jsonb_build_object(
      'id',t.id,'project_id',t.project_id,'title',t.title,'objective',t.objective,'status',t.status,
      'version',t.version,'active_agent_id',t.active_agent_id,'agent_name',a.name,
      'acceptance_criteria',t.acceptance_criteria,'updated_at',t.updated_at,
      'revision_number',COALESCE(h.revision_number,1),'result_summary',COALESCE(h.result_summary,'{}'),
      'checks_summary',COALESCE(h.checks_summary,'{}'),'relevant_paths',COALESCE(h.relevant_paths,'[]'),
      'workspace_ref',COALESCE(h.workspace_ref,p.workspace_path),'native_session_id',s.native_session_id,
      'run_status',r.status,'run_started_at',r.started_at
    )::text
    FROM tasks t JOIN projects p ON p.id=t.project_id
    LEFT JOIN agents a ON a.id=t.active_agent_id
    LEFT JOIN LATERAL (SELECT * FROM handoffs WHERE task_id=t.id ORDER BY revision_number DESC LIMIT 1) h ON true
    -- The latest *writing* run. Since 0059 every Codex turn is a run as well, and
    -- a chat message after an implementation would otherwise replace its status
    -- and its session here with those of a conversation turn.
    LEFT JOIN LATERAL (SELECT * FROM task_runs WHERE task_id=t.id AND write_capable ORDER BY created_at DESC LIMIT 1) r ON true
    LEFT JOIN agent_sessions s ON s.id=r.session_id
    WHERE t.project_id=:'project_id'::uuid
    ORDER BY CASE t.status WHEN 'awaiting_review' THEN 0 WHEN 'needs_attention' THEN 1
      WHEN 'implementing' THEN 2 WHEN 'revising' THEN 3 ELSE 4 END,t.updated_at DESC LIMIT 1;
  `, { project_id: projectId }))[0];
  if (!task) throw new Error("Selected project has no tasks");
  const taskId = String(task.id);

  const lock = (await queryJsonRows(`
    SELECT jsonb_build_object('status',l.status,'owner',COALESCE(a.name,'Released'),
      'heartbeat_at',l.heartbeat_at,'session',s.native_session_id)::text
    FROM workspace_locks l LEFT JOIN task_runs r ON r.id=l.owner_run_id
    LEFT JOIN agents a ON a.id=r.agent_id LEFT JOIN agent_sessions s ON s.id=r.session_id
    WHERE l.project_id=:'project_id'::uuid;
  `, { project_id: projectId }))[0] ?? { status: "released", owner: "Released" };

  const rawEvents = await queryJsonRows(`
    SELECT jsonb_build_object('id',id,'event_type',event_type,'payload',payload,'occurred_at',occurred_at)::text
    FROM domain_events WHERE project_id=:'project_id'::uuid ORDER BY occurred_at DESC LIMIT 12;
  `, { project_id: projectId });
  const interactionRows = await queryJsonRows(`
    SELECT jsonb_build_object('id',r.id,'task_id',r.task_id,'report_type',r.report_type,'payload',r.payload,
      'finalized_at',r.finalized_at,'task_version',t.version,'title',t.title)::text
    FROM worker_interaction_reports r JOIN tasks t ON t.id=r.task_id
    WHERE r.project_id=:'project_id'::uuid AND r.status='finalized' AND r.resolved_at IS NULL
    ORDER BY r.finalized_at DESC;
  `, { project_id: projectId });
  const approvalRows = await queryJsonRows(`
    SELECT jsonb_build_object('id',id,'task_id',task_id,'action_type',action_type,'requested_at',requested_at)::text
    FROM approvals WHERE project_id=:'project_id'::uuid AND status='pending' AND expires_at>clock_timestamp()
    ORDER BY requested_at DESC;
  `, { project_id: projectId });

  const healthRow = (await queryJsonRows(`
    SELECT jsonb_build_object('status',status,'observed_at',observed_at,'snapshot',snapshot)::text
    FROM runtime_health WHERE singleton=true;
  `))[0];
  const health = ((healthRow?.snapshot as Json | undefined) ?? healthRow ?? {}) as Json;
  const checks = (task.checks_summary ?? {}) as Json;
  const checkValues = Object.values(checks);
  const passed = checkValues.filter((value) => value === "passed" || (typeof value === "object" && value && (value as Json).status === "passed")).length;
  const changedFiles = Array.isArray((task.result_summary as Json)?.changed_files) ? (task.result_summary as Json).changed_files as unknown[] : [];
  const status = String(task.status);
  const progress: Record<string, number> = { ready: 10, implementation_requested: 25, implementing: 55, revising: 62, awaiting_review: 82, approved: 92, completed: 100, needs_attention: 68 };

  const attention: ActionTarget[] = [];
  for (const row of approvalRows) attention.push({
    type: "approval", id: String(row.id), projectId, taskId: String(row.task_id ?? ""), taskVersion: Number(task.version),
    title: `${row.action_type} approval`, description: "A protected action is waiting for an operator decision.", time: timeAgo(String(row.requested_at)),
  });
  for (const row of interactionRows) {
    const payload = (row.payload ?? {}) as Json;
    attention.push({
      type: "interaction", id: String(row.id), projectId, taskId: String(row.task_id), taskVersion: Number(row.task_version),
      reportType: String(row.report_type), title: row.report_type === "input_request" ? "Worker needs input" : "Worker is blocked",
      description: String(payload.question ?? payload.reason ?? payload.message ?? "Open the task and provide an operator response."),
      time: timeAgo(String(row.finalized_at)),
    });
  }
  if (status === "awaiting_review") attention.push({
    type: "review", id: taskId, projectId, taskId, taskVersion: Number(task.version), reviewerAgentId: String(task.active_agent_id),
    title: "Review requested", description: String((task.result_summary as Json)?.summary ?? "The worker completed implementation and requests review."),
    time: timeAgo(String(task.updated_at)),
  });
  const noAction: ActionTarget = { type: "none", id: "", projectId, taskId, taskVersion: Number(task.version), title: "No action required", description: "The workflow is progressing normally.", time: "now" };
  const presentationEvents = rawEvents.map((event) => {
    const shown = eventPresentation(String(event.event_type), (event.payload ?? {}) as Json);
    return { id: String(event.id), ...shown, time: timeAgo(String(event.occurred_at)) };
  });
  const terminal = rawEvents.slice(0, 7).reverse().map((event) => {
    const shown = eventPresentation(String(event.event_type), (event.payload ?? {}) as Json);
    const success = String(event.event_type).includes("completed") || String(event.event_type).includes("approved");
    return { time: clock(String(event.occurred_at)), prefix: success ? "✓" : "→", text: `${shown.title} — ${shown.detail}`, kind: success ? "success" : "info" };
  });

  return {
    generatedAt: new Date().toISOString(), dataSource: "live",
    health: { status: String(health.status ?? "unknown").replace(/^./, (letter) => letter.toUpperCase()), detail: String(health.observed_at ?? "") },
    projects: projects.map((item) => ({ id: String(item.id), name: String(item.name), repository: String(item.repository), lastActivity: timeAgo(String(item.updated_at)), taskCount: Number(item.task_count), attentionCount: Number(item.attention_count) })),
    metrics: { activeWorkflow: ["approved","completed"].includes(status) ? "0" : "1", activeTitle: String(task.title), progress: progress[status] ?? 35, stage: status.replaceAll("_", " "), checksPassed: passed, checksTotal: checkValues.length, checkDuration: "recorded" },
    lock: { owner: String(lock.owner), status: String(lock.status), since: clock(String(lock.heartbeat_at ?? "")), session: String(lock.session ?? "No active native session") },
    task: { id: taskId.slice(0, 8).toUpperCase(), projectId, reviewerAgentId: String(task.active_agent_id), status, version: Number(task.version), title: String(task.title), contractVersion: Number(task.revision_number), contract: String(task.objective), branch: String(task.workspace_ref).split("/").at(-1) ?? "workspace", filesChanged: changedFiles.length, additions: 0, deletions: 0, shortSession: String(task.native_session_id ?? "No active session"), acceptanceCriteria: Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : [] },
    terminal, terminalNow: clock(new Date().toISOString()), attention: attention.length ? attention : [noAction], primaryAction: attention[0] ?? noAction,
    events: presentationEvents,
  };
}

export const demoSnapshot: ControlPlaneSnapshot = {
  generatedAt: "2026-07-17T10:48:00Z", dataSource: "demo", health: { status: "Healthy" },
  projects: [{ id: "demo", name: "infra-cod", repository: "github.com/stepantsybin/infra-cod", lastActivity: "2 min ago", taskCount: 1, attentionCount: 0 }],
  metrics: { activeWorkflow: "1", activeTitle: "Add approval workflow", progress: 68, stage: "worker implementation", checksPassed: 12, checksTotal: 12, checkDuration: "42s" },
  lock: { owner: "OpenCode", status: "held", since: "10:42", session: "ses_091a…M1k" },
  task: { id: "TASK-024", projectId: "demo", reviewerAgentId: "codex", status: "awaiting_review", version: 2, title: "Add approval workflow", contractVersion: 2, contract: "Implement the approval gate for production actions. Add durable approval records, audit events and resume the native session after a decision.", branch: "feat/approval-flow", filesChanged: 8, additions: 284, deletions: 31, shortSession: "ses_091a…M1k", acceptanceCriteria: [] },
  terminal: [
    { time: "10:46", prefix: "●", text: "Reading task contract", kind: "info" },
    { time: "10:46", prefix: "→", text: "Inspecting existing approval schema", kind: "normal" },
    { time: "10:46", prefix: "+", text: "Created services/approvals/decision.mjs", kind: "success" },
    { time: "10:46", prefix: "✓", text: "npm test — 12 checks passed", kind: "success" },
  ],
  terminalNow: "10:46",
  attention: [{ type: "review", id: "demo", projectId: "demo", taskId: "demo", taskVersion: 2, reviewerAgentId: "codex", title: "Review requested", description: "The worker completed the implementation and requests review.", time: "2 min ago" }],
  primaryAction: { type: "review", id: "demo", projectId: "demo", taskId: "demo", taskVersion: 2, reviewerAgentId: "codex", title: "Review requested", description: "The worker completed the implementation and requests review.", time: "2 min ago" },
  events: [
    { id: "evt-4", title: "Review requested", detail: "OpenCode completed implementation", time: "2 min ago", tone: "amber-event", icon: "spark" },
    { id: "evt-3", title: "Checks completed", detail: "12 of 12 required checks passed", time: "4 min ago", tone: "green-event", icon: "check" },
  ],
};

export async function getControlPlaneSnapshot(ownerId: string, projectId?: string): Promise<ControlPlaneSnapshot> {
  if (process.env.CONTROL_PLANE_LIVE === "true" || hasDatabaseConnection()) {
    try { return await getLiveSnapshot(ownerId,projectId); } catch (error) { console.error("Live control-plane read failed", error); }
  }
  return demoSnapshot;
}
