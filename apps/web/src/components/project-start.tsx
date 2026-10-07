import { WaitingIssues } from "@/components/issue-intake";
import type { WaitingIssue } from "@/lib/product-data";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, ButtonLink, cx } from "@agentic/design-system";
import type { Operator } from "@/lib/auth";
import type { ProjectReadiness, ProjectWorkspace, RuntimeReadinessReport } from "@/lib/product-data";
import { modelDisplayWithResolved, type ProjectTeam } from "@/lib/team";
import type { OperatorModels } from "@/lib/models";
import { resolvedModelOf } from "@/lib/models";
import type { SidebarChat } from "@/lib/sidebar-data";
import { runtimeLabel } from "@/lib/runtime-labels";
import { ControlPlaneShell } from "@/components/control-plane-shell";
import { ChatComposer } from "@/components/chat-composer";
import { ProvisioningRetry } from "@/components/provisioning-retry";
import { RuntimeDispatchWarning } from "@/components/runtime-readiness-card";
import { ReadinessBlockerNote } from "@/components/assignment-readiness";
import { Notice } from "@/components/ui/notice";
import { statusTone } from "@/components/ui/status-tone";
import { chatStatusDot, chatStatusLabel } from "@/components/ui/chat-status";
import { chatsOf } from "@/components/ui/conversations";
import { ChatUsageProvider } from "@/components/chat-usage";
import { LimitsStrip, type TeamConnectionHint } from "@/components/limits-strip";
import { ProjectMark } from "@/components/ui/project-mark";
import type { OperatorUsage } from "@/lib/usage";

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

const SETTLED = ["approved", "deployed", "completed", "cancelled", "failed"];

function SummaryCard({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <section aria-label={label} className={cx("flex min-w-0 flex-col gap-1 rounded-lg border border-line px-4 py-3", className)}>
    <p className="type-eyebrow m-0 text-muted">{label}</p>
    {children}
  </section>;
}

// Each member as the start screen's chips and cards name it: the model (with
// what an alias resolved to) and its reasoning level.
export function memberLabels(roster: ProjectWorkspace["agentRoster"], readiness: ProjectReadiness | null, team: ProjectTeam | null, models: OperatorModels | null) {
  return Object.fromEntries(roster.map((member) => {
    const reading = readiness?.assignments.find((assignment) => assignment.assignmentId === member.assignmentId);
    const entryId = reading?.entryId ?? team?.assignments.find((assignment) => assignment.assignmentId === member.assignmentId)?.entryId ?? "";
    const model = reading?.modelId || member.model;
    const resolved = entryId ? resolvedModelOf(models, entryId) : null;
    const level = team?.reasoning.members[member.assignmentId]?.level ?? null;
    return [member.assignmentId, `${model ? modelDisplayWithResolved(team, model, resolved) : runtimeLabel(member.runtimeType)}${level ? ` · reasoning ${level}` : ""}`];
  }));
}

// What the limits strip filters the operator's connections by: each member's
// runtime and, where its model is known, the gateway it runs through.
export function teamConnectionHints(roster: ProjectWorkspace["agentRoster"], readiness: ProjectReadiness | null, team: ProjectTeam | null): TeamConnectionHint[] {
  return roster.map((member) => {
    const entryId = readiness?.assignments.find((assignment) => assignment.assignmentId === member.assignmentId)?.entryId
      ?? team?.assignments.find((assignment) => assignment.assignmentId === member.assignmentId)?.entryId ?? "";
    const gateway = team?.models.find((model) => model.entryId === entryId)?.gateway || undefined;
    return { runtime: member.runtimeType, gateway };
  });
}

// The project's start screen (Stage 12 N4): what should the team do — the
// new-chat composer with the team as chips, the limits strip under it, and the
// project in three cards: its repository, its team's readiness, and the chats
// that wait for the operator. It replaces the Overview tab.
export function ProjectStart({ operator, workspace, writeEnabled, runtimeReadiness, projectReadiness, projectTeam, operatorModels, waiting, operatorUsage, waitingIssues = [] }: {
  operator: Operator;
  workspace: ProjectWorkspace;
  writeEnabled: boolean;
  runtimeReadiness?: RuntimeReadinessReport;
  projectReadiness: ProjectReadiness | null;
  projectTeam: ProjectTeam | null;
  operatorModels: OperatorModels | null;
  waiting: SidebarChat[];
  operatorUsage: OperatorUsage | null;
  waitingIssues?: WaitingIssue[];
}) {
  const { project, workspaceState: state, agentRoster } = workspace;
  const labels = memberLabels(agentRoster, projectReadiness, projectTeam, operatorModels);
  const chats = chatsOf(workspace.tasks);
  const open = chats.filter((chat) => !SETTLED.includes(chat.latest.status));
  const ready = Boolean(projectReadiness && projectReadiness.assignments.length > 0 && projectReadiness.assignments.every((assignment) => assignment.ready));
  const lastEvent = workspace.events[0];
  return <ControlPlaneShell operator={operator} projectId={project.id}>
    <header className="cp-topbar">
      <div className="cp-breadcrumbs flex-1 gap-2.5"><ProjectMark id={project.id} name={project.name} size={24}/><strong className="max-w-[40ch] truncate text-[0.9375rem] font-semibold">{project.name}</strong></div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge tone={statusTone(project.provisioningStatus)} className="phone:hidden">{project.provisioningStatus.replaceAll("_", " ")}</Badge>
        <ButtonLink as={Link} variant="secondary" size="sm" href={`/projects/${project.id}/settings/general`}>Project settings</ButtonLink>
      </div>
    </header>
    {!writeEnabled && <div className="type-meta border-b border-line bg-warning-soft px-7 py-2.5 text-center text-warning">This deployment is read-only until operator authentication is enabled. Navigation and live state remain available.</div>}
    {/* Fits a laptop's height without scrolling (the owner, 2026-09-29): the
        space above shrinks with the window, the gaps stay tight. */}
    <div className="flex justify-center px-7 pt-[clamp(16px,5vh,48px)] pb-6 text-ink phone:px-3.5 phone:pt-5 phone:pb-8">
      <div className="grid w-full max-w-[760px] gap-5 phone:gap-4">
        <div>
          <p className="type-meta m-0 mb-2 flex items-center gap-2 font-medium text-muted"><ProjectMark id={project.id} name={project.name} size={16}/>New chat in <span className="text-ink">{project.name}</span></p>
          <h1 className="type-page-title m-0 text-[2.125rem] leading-tight phone:text-[1.75rem]">What should the team do?</h1>
          <p className="type-app-body mt-1.5 mb-0 text-muted">The orchestrator plans, an executor writes on a task branch, you approve.</p>
        </div>
        <div className="grid gap-2">
          {runtimeReadiness && !projectReadiness && <RuntimeDispatchWarning report={runtimeReadiness}/>}
          <ChatComposer projectId={project.id} variant="start" className="w-full px-4 pt-3.5 pb-3"
            agentRoster={agentRoster} readiness={projectReadiness} memberLabels={labels}
            enabled={writeEnabled && project.provisioningStatus === "ready"}
            disabledReason={!writeEnabled ? "Operator authentication is required to send messages" : project.provisioningStatus === "failed" ? "Workspace setup failed. Configure repository access and retry setup." : "Workspace setup is still in progress."}/>
          <ChatUsageProvider projectId={project.id} initialOperatorUsage={operatorUsage}>
            <LimitsStrip team={teamConnectionHints(agentRoster, projectReadiness, projectTeam)} className="-mt-0.5"/>
          </ChatUsageProvider>
        </div>
        <WaitingIssues issues={waitingIssues}/>
        <div className="grid grid-cols-3 gap-3 tablet:grid-cols-1">
          <SummaryCard label="Repository">
            <span className="type-mono-small [overflow-wrap:anywhere]">{project.repository}</span>
            <span className="type-meta">branch <code className="type-mono-small">{project.defaultBranch}</code> · {state.observedAt ? (state.dirty ? "changes present" : "clean") : "not observed yet"}</span>
            <span className="type-meta flex flex-wrap items-center gap-1.5">workspace <Badge tone={statusTone(project.provisioningStatus)}>{project.provisioningStatus.replaceAll("_", " ")}</Badge></span>
            {project.provisioningError && <Notice tone="danger">{project.provisioningError}</Notice>}
            {project.provisioningStatus === "failed" && <div><ProvisioningRetry projectId={project.id}/></div>}
            <Link href={`/projects/${project.id}/settings/workspace`} className="type-meta mt-auto inline-flex min-h-8 items-center font-medium underline-offset-4 hover:underline">Workspace →</Link>
          </SummaryCard>
          <SummaryCard label="Team">
            {agentRoster.map((member) => <span key={member.assignmentId} className="type-meta min-w-0 [overflow-wrap:anywhere]">
              <span className="text-muted">{member.assignmentRole === "orchestrator" ? "Orchestrator" : "Executor"}</span> · {runtimeLabel(member.runtimeType)} · {labels[member.assignmentId]}
            </span>)}
            {!agentRoster.length && <span className="type-meta text-muted">This project has no enabled assignments.</span>}
            {projectReadiness
              ? ready
                ? <span className="type-meta font-medium text-success">● ready</span>
                : projectReadiness.assignments.filter((assignment) => assignment.blockedBy).map((assignment) => assignment.blockedBy && <ReadinessBlockerNote key={assignment.assignmentId} blocker={assignment.blockedBy} projectId={project.id}
                    subject={`${assignment.role === "orchestrator" ? "Orchestrator" : "Executor"} ${runtimeLabel(assignment.runtime)}`}/>)
              : <span className="type-meta text-muted">The team&apos;s readiness cannot be read right now.</span>}
            <Link href={`/projects/${project.id}/settings/team`} className="type-meta mt-auto inline-flex min-h-8 items-center font-medium underline-offset-4 hover:underline">Team settings →</Link>
          </SummaryCard>
          <SummaryCard label="Waiting for you">
            {waiting.length
              ? <ul className="m-0 grid min-w-0 list-none gap-0.5 p-0">{waiting.map((chat) => <li key={chat.conversationId} className="min-w-0">
                  <Link href={`/projects/${project.id}?task=${chat.taskId}`} className="type-meta -mx-1.5 flex min-h-8 min-w-0 items-center gap-2 rounded-sm px-1.5 transition-colors duration-150 hover:bg-wash">
                    <span className={cx("h-[7px] w-[7px] shrink-0 rounded-full", chatStatusDot(chat.status))} aria-hidden="true"/>
                    <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                    <span className="max-w-[45%] shrink-0 truncate text-muted">{chatStatusLabel(chat.status)}</span>
                  </Link>
                </li>)}</ul>
              : waitingIssues.length
                ? <span className="type-meta text-muted">{waitingIssues.length} GitHub {waitingIssues.length === 1 ? "issue waits" : "issues wait"} to be started — above.</span>
                : <span className="type-meta text-muted">Nothing waits for you in this project.</span>}
          </SummaryCard>
        </div>
        <p className="type-meta m-0 text-muted">
          {chats.length} chat{chats.length === 1 ? "" : "s"} · {open.length} open · {workspace.sessions.length} agent session{workspace.sessions.length === 1 ? "" : "s"}
          {lastEvent ? ` · last event ${relativeTime(lastEvent.occurredAt)}` : ""} · <Link href={`/projects/${project.id}/settings/activity`} className="font-medium text-ink underline-offset-4 hover:underline">Activity</Link> · <Link href={`/projects/${project.id}/chats`} className="font-medium text-ink underline-offset-4 hover:underline">All chats</Link>
        </p>
      </div>
    </div>
  </ControlPlaneShell>;
}
