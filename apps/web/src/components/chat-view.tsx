import Link from "next/link";
import { Badge, cx } from "@agentic/design-system";
import type { Operator } from "@/lib/auth";
import type { ProjectReadiness, ProjectWorkspace, RuntimeReadinessReport, TaskSummary } from "@/lib/product-data";
import { taskAssignmentReadiness } from "@/lib/product-data";
import type { ProjectTeam } from "@/lib/team";
import type { OperatorModels } from "@/lib/models";
import type { OperatorUsage } from "@/lib/usage";
import { runtimeLabel } from "@/lib/runtime-labels";
import { ControlPlaneShell } from "@/components/control-plane-shell";
import { ChatComposer } from "@/components/chat-composer";
import { ChatMessage } from "@/components/chat-message";
import { ChatScrollArea } from "@/components/chat-scroll-area";
import { CloseTask } from "@/components/close-task";
import { TaskTitle, TaskTopbarActions } from "@/components/task-topbar";
import { LiveTaskActivity } from "@/components/live-task-activity";
import { ProvisioningRetry } from "@/components/provisioning-retry";
import { RuntimeDispatchWarning } from "@/components/runtime-readiness-card";
import { AssignmentReadinessCard, TaskExecutorReadiness } from "@/components/assignment-readiness";
import { WorkflowActions } from "@/components/workflow-actions";
import { PublishStatusCard } from "@/components/publish-status";
import { StepCard, workSteps } from "@/components/step-card";
import { ChatPanel, ChatPanelProvider, PanelToggle, ShowPanelTab } from "@/components/chat-panel";
import { ChatUsageProvider } from "@/components/chat-usage";
import { LimitsStrip } from "@/components/limits-strip";
import { RememberChat } from "@/components/last-chat";
import { teamConnectionHints } from "@/components/project-start";
import { ActivityTab, CentreView, ChangesTab, LogView, TeamTab, chatViewHref } from "@/components/chat-context";
import { ChangedFilesCard, HandoffCard, UnpublishedCommitsCard, WorkspaceCleanBadge, WorkspaceMetrics } from "@/components/workspace-state";
import { statusTone } from "@/components/ui/status-tone";
import { chatStatusLabel } from "@/components/ui/chat-status";
import { ProjectMark } from "@/components/ui/project-mark";

export type CentreViewName = "changes" | "log" | "checks";

const CLOSED = ["approved", "publishing", "deployed", "completed", "cancelled", "failed"];
const SETTLED = ["approved", "deployed", "completed", "cancelled", "failed"];

function relativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "recently";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// The action card's icon tile: the kind of decision asked, in the status palette.
function actionIconTone(type: string) {
  return type === "review" ? "bg-info-soft text-info"
    : type === "incident" || type === "publish_failed" ? "bg-danger-soft text-danger"
    : type === "publish" ? "bg-success-soft text-success"
    : "bg-warning-soft text-warning";
}

// The chat's first task: its title is the chat's (ADR-0014).
function conversationRoot(tasks: TaskSummary[], selected: TaskSummary) {
  let current = selected;
  const visited = new Set([current.id]);
  while (current.followUpOfTaskId) {
    const parent = tasks.find((task) => task.id === current.followUpOfTaskId);
    if (!parent || visited.has(parent.id)) break;
    current = parent;
    visited.add(current.id);
  }
  return current;
}

// The executors the chat's newest task is bound to, as the step card names them.
function executorLine(roster: ProjectWorkspace["agentRoster"], executorAssignmentIds: string[], modelLabel: (model?: string) => string | undefined) {
  const bound = roster.filter((assignment) => executorAssignmentIds.includes(assignment.assignmentId));
  return bound.map((assignment) => `${runtimeLabel(assignment.runtimeType)} · ${modelLabel(assignment.model)}`).join(", ") || undefined;
}

// A model's name as the team's catalogue gives it ("GPT-6 Luna"), else its id.
function modelLabelFor(team: ProjectTeam | null) {
  const names = new Map<string, string>();
  for (const model of team?.models ?? []) if (model.displayName) names.set(model.modelId, model.displayName);
  for (const assignment of team?.assignments ?? []) if (assignment.displayName) names.set(assignment.modelId, assignment.displayName);
  return (model?: string) => (model ? names.get(model) ?? model : undefined);
}

// Who does what in this chat, said once above it: the messages name their
// runtime, and "Codex" alone did not say it plans and reviews.
function TeamLine({ roster, task, modelLabel }: { roster: ProjectWorkspace["agentRoster"]; task: TaskSummary; modelLabel: (model?: string) => string | undefined }) {
  const member = (assignment: ProjectWorkspace["agentRoster"][number]) => `${runtimeLabel(assignment.runtimeType)} (${modelLabel(assignment.model)})`;
  const orchestrator = roster.find((assignment) => assignment.assignmentId === task.orchestratorAssignmentId);
  const executors = roster.filter((assignment) => task.executorAssignmentIds.includes(assignment.assignmentId));
  if (!orchestrator && !executors.length) return null;
  return <p className="type-meta mb-6 rounded-md border border-line px-3 py-2 text-muted" aria-label="This chat's team">
    <span className="font-medium text-ink">Team</span>
    {orchestrator && <> · <span className="text-ink">{member(orchestrator)}</span> plans and reviews</>}
    {executors.length > 0 && <> · <span className="text-ink">{executors.map(member).join(", ")}</span> {executors.length > 1 ? "write" : "writes"} the code</>}
  </p>;
}

// A chat (Stage 12 N2, N3): its top bar, its stream or one of the long views
// the context panel opens in the centre, the composer, and the panel.
export function ChatView({ operator, workspace, activeTask, writeEnabled, view, runtimeReadiness, projectReadiness, projectTeam, operatorModels, operatorUsage }: {
  operator: Operator;
  workspace: ProjectWorkspace;
  activeTask: TaskSummary;
  writeEnabled: boolean;
  view?: CentreViewName;
  runtimeReadiness?: RuntimeReadinessReport;
  projectReadiness: ProjectReadiness | null;
  projectTeam: ProjectTeam | null;
  operatorModels: OperatorModels | null;
  operatorUsage: OperatorUsage | null;
}) {
  const { project, tasks, messages } = workspace;
  const root = conversationRoot(tasks, activeTask);
  const chatTaskIds = tasks.filter((task) => task.conversationId === activeTask.conversationId).map((task) => task.id);
  const backHref = chatViewHref(project.id, activeTask.id);
  const modelLabel = modelLabelFor(projectTeam);
  const centreTitle = view === "changes" ? "Changes" : view === "log" ? "Activity log" : view === "checks" ? "Team checks" : "";

  return <ControlPlaneShell operator={operator} projectId={project.id} activeConversationId={activeTask.conversationId}>
    <ChatUsageProvider projectId={project.id} taskId={activeTask.id} initialTaskUsage={workspace.taskUsage} initialOperatorUsage={operatorUsage}>
    <ChatPanelProvider>
      <RememberChat href={backHref}/>
      <header className="cp-topbar">
        <div className="cp-breadcrumbs flex-1">
          <Link href={`/projects/${project.id}`} className="flex max-w-64 shrink-0 items-center gap-2 truncate font-medium"><ProjectMark id={project.id} name={project.name} size={20}/><span className="truncate">{project.name}</span></Link><span>›</span>
          <TaskTitle title={root.title}/>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={statusTone(activeTask.status)}>{chatStatusLabel(activeTask.status)}</Badge>
          <TaskTopbarActions>
            {writeEnabled && !CLOSED.includes(activeTask.status)
              && <CloseTask projectId={project.id} taskId={activeTask.id} taskVersion={activeTask.version}/>}
            {project.provisioningStatus === "failed" && <ProvisioningRetry projectId={project.id}/>}
          </TaskTopbarActions>
          <PanelToggle/>
        </div>
      </header>
      {!writeEnabled && <div className="type-meta border-b border-line bg-warning-soft px-7 py-2.5 text-center text-warning">This deployment is read-only until operator authentication is enabled. Navigation and live state remain available.</div>}

      <div className="flex h-[calc(100dvh-60px)] min-h-0 overflow-hidden text-ink phone:h-[calc(100dvh-57px)]">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {view
            ? <CentreView title={centreTitle} backHref={backHref}>
                {view === "changes" && <>
                  <div className="flex items-center gap-2"><WorkspaceCleanBadge state={workspace.workspaceState}/><span className="type-meta text-muted">The repository as the host last saw it. Operations on it are in project settings → Workspace.</span></div>
                  <WorkspaceMetrics state={workspace.workspaceState}/>
                  <UnpublishedCommitsCard state={workspace.workspaceState}/>
                  <ChangedFilesCard state={workspace.workspaceState}/>
                  <HandoffCard state={workspace.workspaceState}/>
                </>}
                {view === "log" && <LogView messages={messages} events={workspace.events} taskIds={chatTaskIds} taskActivity={workspace.taskActivity}/>}
                {view === "checks" && (projectReadiness ? <AssignmentReadinessCard readiness={projectReadiness}/> : <p className="type-meta text-muted">The team&apos;s readiness cannot be read right now.</p>)}
              </CentreView>
            : <>
              {!SETTLED.includes(activeTask.status)
                && <div><TaskExecutorReadiness executors={taskAssignmentReadiness(projectReadiness, activeTask.executorAssignmentIds)} projectId={project.id}/></div>}
              <ChatScrollArea>
                <TeamLine roster={workspace.agentRoster} task={activeTask} modelLabel={modelLabel}/>
                {messages.map((message) => <ChatMessage message={message} timeLabel={relativeTime(message.occurredAt)} modelLabel={modelLabel(message.model)} key={message.id}/>)}
                <StepCard states={workSteps(activeTask.status, messages.map((message) => message.eventType), workspace.publishState?.stage ?? null)}
                  executor={executorLine(workspace.agentRoster, activeTask.executorAssignmentIds, modelLabel)}
                  files={stepFiles(activeTask.status, workspace)}
                  action={<ShowPanelTab tab="changes">View changes</ShowPanelTab>}/>
                <PublishStatusCard state={workspace.publishState}/>
                {workspace.attention.map((action) => <article className="mb-6 grid grid-cols-[34px_minmax(0,1fr)] gap-3 rounded-lg border border-line-strong p-4 phone:grid-cols-[28px_minmax(0,1fr)] phone:p-3" key={`${action.type}:${action.id}`} role="region" aria-labelledby={`action-${action.type}-${action.id}`}>
                  <span className={cx("grid h-8 w-8 place-items-center rounded-sm text-[0.8125rem] font-medium phone:h-7 phone:w-7", actionIconTone(action.type))} aria-hidden="true">{action.type === "approval" ? "!" : action.type === "review" ? "✓" : action.type === "incident" || action.type === "publish_failed" ? "↻" : action.type === "publish" ? "↑" : "?"}</span>
                  <div className="min-w-0"><header className="flex items-start justify-between gap-3 phone:flex-col phone:gap-1.5"><span className="flex flex-col items-start gap-1.5"><Badge tone="attention">ACTION REQUIRED</Badge><strong className="type-card-title" id={`action-${action.type}-${action.id}`}>{action.title}</strong></span><time className="type-meta shrink-0 text-muted">{relativeTime(action.time)}</time></header><p className="type-app-body mt-2 text-ink/80">{action.description}</p><WorkflowActions action={action} acceptanceCriteria={activeTask.acceptanceCriteria}/></div>
                </article>)}
                <LiveTaskActivity projectId={project.id} taskId={activeTask.id} initialActivity={workspace.taskActivity} awaitingResponse={messages.at(-1)?.role === "user"}/>
              </ChatScrollArea>
              {/* The host-wide banner stays only where the project's own reading is
                  not available: with it, the composer names the assignment and the
                  fix, and the banner would say the same of runtimes this project may
                  not even use. */}
              {runtimeReadiness && !projectReadiness && <RuntimeDispatchWarning report={runtimeReadiness}/>}
              <ChatComposer projectId={project.id} taskId={activeTask.id} taskStatus={activeTask.status}
                taskVersion={activeTask.version} taskOrchestratorAssignmentId={activeTask.orchestratorAssignmentId}
                taskExecutorAssignmentIds={activeTask.executorAssignmentIds}
                agentRoster={workspace.agentRoster} readiness={projectReadiness}
                enabled={writeEnabled && project.provisioningStatus === "ready"}
                disabledReason={!writeEnabled ? "Operator authentication is required to send messages" : project.provisioningStatus === "failed" ? "Workspace setup failed. Configure repository access and retry setup." : "Workspace setup is still in progress."}
                className="mx-auto mt-2 mb-1 w-[min(760px,calc(100%-60px))] phone:w-[calc(100%-28px)]"/>
              <LimitsStrip team={teamConnectionHints(workspace.agentRoster, projectReadiness, projectTeam)} className="mx-auto mb-2 w-[min(760px,calc(100%-60px))] phone:mb-1.5 phone:w-[calc(100%-28px)]"/>
            </>}
        </section>
        <ChatPanel
          team={<TeamTab projectId={project.id} taskId={activeTask.id} readiness={projectReadiness} roster={workspace.agentRoster} team={projectTeam} models={operatorModels}/>}
          changes={<ChangesTab project={project} workspace={workspace.workspaceState} taskId={activeTask.id}/>}
          activity={<ActivityTab projectId={project.id} taskId={activeTask.id} messages={messages}/>}/>
      </div>
    </ChatPanelProvider>
    </ChatUsageProvider>
  </ControlPlaneShell>;
}

// While the executor works, the workspace's live diff is the task's; once it
// has handed the work back, its reviewed diff is — a published chat kept
// counting the workspace, which by then held something else ("0 files").
function stepFiles(status: string, workspace: ProjectWorkspace) {
  const working = ["implementing", "revising"].includes(status);
  if (!working && workspace.taskFiles !== null) return workspace.taskFiles;
  const state = workspace.workspaceState;
  return state.dirty ? state.diffSummary.files : state.unpublished?.fileCount ?? state.diffSummary.files;
}
