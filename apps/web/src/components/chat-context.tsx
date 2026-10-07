import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, cx } from "@agentic/design-system";
import type { AssignmentReadiness, ProjectReadiness } from "@/lib/readiness";
import type { ChatMessage, EventSummary, ProjectSummary, ProjectWorkspace } from "@/lib/product-data";
import type { ProjectTeam } from "@/lib/team";
import type { OperatorModels } from "@/lib/models";
import { modelWithResolved, resolvedModelOf } from "@/lib/models";
import { runtimeLabel } from "@/lib/runtime-labels";
import { formatTimestamp } from "@/lib/format-timestamp";
import { ReadinessBlockerNote } from "@/components/assignment-readiness";
import { MemberTokens } from "@/components/chat-usage";

// The context panel's three tabs (Stage 12 N3) and the long views they open in
// the centre. Each tab is one compact view that fits the panel's height: what
// is long — every changed file, every event, every check — opens in the centre.

const eyebrow = "type-eyebrow text-muted";
const centreLink = "touch-target inline-flex h-9 w-full items-center justify-center rounded-md border border-line-strong px-3 text-[0.8125rem] font-medium text-ink transition-colors duration-150 hover:border-ink hover:bg-ink hover:text-on-ink phone:h-11";
const settingsLink = "type-meta inline-flex min-h-8 items-center font-medium text-info underline-offset-4 hover:underline";

function roleWord(role: string) {
  return role === "orchestrator" ? "Orchestrator" : role === "executor" ? "Executor" : "Assignment";
}

const CHECKS: Array<keyof Pick<AssignmentReadiness, "runtimeInstalled" | "runtimeAuthenticated" | "modelVerified" | "connectionConnected">> =
  ["runtimeInstalled", "runtimeAuthenticated", "modelVerified", "connectionConnected"];

export function chatViewHref(projectId: string, taskId: string, view?: "changes" | "log" | "checks") {
  return `/projects/${projectId}?task=${taskId}${view ? `&view=${view}` : ""}`;
}

// ------------------------------------------------------------------ Team

type RosterMember = ProjectWorkspace["agentRoster"][number];

export function TeamTab({ projectId, taskId, readiness, roster, team, models }: {
  projectId: string; taskId: string; readiness: ProjectReadiness | null; roster: RosterMember[];
  team: ProjectTeam | null; models: OperatorModels | null;
}) {
  const ready = Boolean(readiness && readiness.assignments.length > 0 && readiness.assignments.every((assignment) => assignment.ready));
  const checks = readiness?.assignments.flatMap((assignment) => CHECKS.map((key) => assignment[key])) ?? [];
  const passing = checks.filter((state) => state === "ready").length;
  return <div className="grid gap-3">
    <div className="flex items-center justify-between gap-2">
      <span className={eyebrow}>Team</span>
      {readiness && (ready ? <Badge dot tone="success">ready</Badge> : <Badge dot tone="danger">not ready</Badge>)}
    </div>
    {readiness
      ? readiness.assignments.map((assignment) => {
          const teamMember = team?.assignments.find((member) => member.assignmentId === assignment.assignmentId);
          const entryId = assignment.entryId ?? teamMember?.entryId ?? "";
          const resolved = entryId ? resolvedModelOf(models, entryId) : null;
          const level = team?.reasoning.members[assignment.assignmentId]?.level ?? null;
          const model = assignment.modelId ? modelWithResolved(assignment.modelId, resolved) : "";
          return <section key={assignment.assignmentId} aria-label={`${roleWord(assignment.role)} readiness`} className="grid min-w-0 gap-0.5 rounded-lg border border-line px-3.5 py-3">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <strong className="type-meta font-semibold">{roleWord(assignment.role)}{assignment.isDefault && assignment.role === "orchestrator" ? " · default" : ""}</strong>
              {assignment.ready ? <Badge tone="success">ready</Badge> : <Badge tone="danger">blocked</Badge>}
            </div>
            <span className="type-meta">{runtimeLabel(assignment.runtime)}{assignment.runtimeVersion ? ` ${assignment.runtimeVersion}` : ""}</span>
            {model
              ? <span className="type-mono-small min-w-0 [overflow-wrap:anywhere]">{model}</span>
              : <span className="type-meta text-muted">No model chosen for this assignment yet.</span>}
            <span className="type-meta text-muted">reasoning: {level ?? "default"}<span aria-hidden="true"> · </span><MemberTokens assignmentId={assignment.assignmentId}/></span>
            {assignment.blockedBy && <ReadinessBlockerNote blocker={assignment.blockedBy} projectId={projectId}/>}
          </section>;
        })
      : roster.map((member) => <section key={member.assignmentId} className="grid gap-0.5 rounded-lg border border-line px-3.5 py-3">
          <strong className="type-meta font-semibold">{roleWord(member.assignmentRole)}</strong>
          <span className="type-meta">{runtimeLabel(member.runtimeType)}</span>
          <span className="type-mono-small [overflow-wrap:anywhere]">{member.model}</span>
          <span className="type-meta text-muted"><MemberTokens assignmentId={member.assignmentId}/></span>
        </section>)}
    {readiness && readiness.assignments.length === 0 && <p className="type-meta text-muted">This project has no enabled assignments.</p>}
    {readiness && <p className="type-meta m-0 flex flex-wrap items-center justify-between gap-x-2 text-muted">
      <span>All checks: {passing} of {checks.length} pass · {readiness.observedAt ? `host reported ${new Date(readiness.observedAt).toISOString().slice(11, 16)} UTC` : "host never reported"}</span>
      <Link href={chatViewHref(projectId, taskId, "checks")} className={settingsLink}>Full list</Link>
    </p>}
    <Link href={`/projects/${projectId}/settings/team`} className={settingsLink}>Change the team in project settings →</Link>
  </div>;
}

// ------------------------------------------------------------------ Changes

const FILES_IN_PANEL = 8;
const statusTone: Record<string, string> = { A: "text-success", M: "text-warning", D: "text-danger", R: "text-info" };

export function ChangesTab({ project, workspace, taskId }: { project: ProjectSummary; workspace: ProjectWorkspace["workspaceState"]; taskId: string }) {
  const files = workspace.changedFiles;
  return <div className="grid gap-3">
    <span className={eyebrow}>Changes</span>
    <p className="type-meta m-0 [overflow-wrap:anywhere]">
      <code className="type-mono-small">{workspace.branch}</code> from <code className="type-mono-small">{project.defaultBranch}</code>
      {workspace.upstream ? <> · {workspace.ahead} ahead, {workspace.behind} behind</> : null}
    </p>
    <p className="type-meta m-0 text-muted">
      {workspace.headSha ? <>head <code className="type-mono-small">{workspace.headSha.slice(0, 12)}</code> · </> : null}
      <span className="text-success">+{workspace.diffSummary.additions}</span> <span className="text-danger">−{workspace.diffSummary.deletions}</span> in {workspace.diffSummary.files} file{workspace.diffSummary.files === 1 ? "" : "s"}
      {workspace.observedAt ? ` · seen ${formatTimestamp(workspace.observedAt)}` : " · no snapshot yet"}
    </p>
    {files.length > 0
      ? <ul className="m-0 grid list-none overflow-hidden rounded-lg border border-line p-0">
          {files.slice(0, FILES_IN_PANEL).map((file) => <li key={`${file.status}:${file.path}`} className="flex min-h-9 min-w-0 items-center gap-2 border-b border-line px-3 last:border-b-0">
            <b className={cx("type-mono-small w-5 shrink-0 font-medium", statusTone[file.status.charAt(0)] ?? "text-muted")} title={`git status ${file.status}`}>{file.status}</b>
            <code className="type-mono-small min-w-0 flex-1 truncate" title={file.path}>{file.path}</code>
          </li>)}
          {files.length > FILES_IN_PANEL && <li className="type-meta px-3 py-2 text-muted">and {files.length - FILES_IN_PANEL} more</li>}
        </ul>
      : <p className="type-meta m-0 text-muted">No changed files in the latest snapshot.</p>}
    {project.provisioningError && <p className="type-meta m-0 text-danger">{project.provisioningError}</p>}
    <Link href={chatViewHref(project.id, taskId, "changes")} className={centreLink}>Open the full changes in the centre</Link>
  </div>;
}

// ------------------------------------------------------------------ Activity

function firstLine(text: string) {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function hhmm(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 16) : "";
}

export function activityLine(message: ChatMessage) {
  const text = firstLine(message.content);
  return message.role === "system" ? text : `${message.author}: ${text}`;
}

export function ActivityTab({ projectId, taskId, messages }: { projectId: string; taskId: string; messages: ChatMessage[] }) {
  const last = messages.slice(-5);
  return <div className="grid gap-3">
    <span className={eyebrow}>Activity · last {last.length}</span>
    {last.length
      ? <ol className="m-0 grid list-none gap-2 p-0">
          {last.map((message) => <li key={message.id} className="type-meta flex min-w-0 gap-2.5">
            <time className="type-mono-small w-11 shrink-0 text-muted tabular-nums" dateTime={message.occurredAt} title={formatTimestamp(message.occurredAt)}>{hhmm(message.occurredAt)}</time>
            <span className="min-w-0 flex-1 truncate" title={activityLine(message)}>{activityLine(message)}</span>
          </li>)}
        </ol>
      : <p className="type-meta m-0 text-muted">Nothing has happened in this chat yet.</p>}
    <p className="type-meta m-0 text-muted">Times in UTC.</p>
    <Link href={chatViewHref(projectId, taskId, "log")} className={centreLink}>Open the full log in the centre</Link>
  </div>;
}

// ------------------------------------------------------------------ centre views

export function CentreView({ title, backHref, children }: { title: string; backHref: string; children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    <div className="mx-auto grid w-full max-w-[860px] gap-5 px-7 py-7 phone:px-4 phone:py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="type-section-title m-0">{title}</h2>
        <Link href={backHref} className="touch-target inline-flex h-9 items-center rounded-md border border-line-strong px-3 text-[0.875rem] font-medium text-ink transition-colors duration-150 hover:border-ink hover:bg-ink hover:text-on-ink">← Back to the chat</Link>
      </div>
      {children}
    </div>
  </div>;
}

export function LogView({ messages, events, taskIds, taskActivity }: { messages: ChatMessage[]; events: EventSummary[]; taskIds: string[]; taskActivity: ProjectWorkspace["taskActivity"] }) {
  const audit = events.filter((event) => taskIds.includes(event.taskId));
  return <>
    <section className="grid gap-2" aria-labelledby="log-conversation">
      <h3 id="log-conversation" className={eyebrow}>This chat, in order</h3>
      <ol className="m-0 grid list-none overflow-hidden rounded-lg border border-line p-0">
        {messages.map((message) => <li key={message.id} className="type-meta grid grid-cols-[150px_minmax(0,1fr)] gap-3 border-b border-line px-4 py-2.5 last:border-b-0 phone:grid-cols-1 phone:gap-0.5">
          <time className="text-muted tabular-nums">{formatTimestamp(message.occurredAt)}</time>
          <span className="min-w-0 [overflow-wrap:anywhere]">{message.author && <><strong className="font-medium">{message.author}</strong> · </>}{firstLine(message.content)} <code className="type-mono-small text-muted">{message.eventType}</code></span>
        </li>)}
        {!messages.length && <li className="type-meta px-4 py-4 text-muted">Nothing yet.</li>}
      </ol>
    </section>
    {taskActivity && <section className="grid gap-2" aria-labelledby="log-run">
      <h3 id="log-run" className={eyebrow}>The latest run</h3>
      <p className="type-meta m-0">{runtimeLabel(taskActivity.runtimeType)} · {taskActivity.model} · {taskActivity.status} · attempt {taskActivity.attemptCount}{taskActivity.startedAt ? ` · started ${formatTimestamp(taskActivity.startedAt)}` : ""}{taskActivity.finishedAt ? ` · finished ${formatTimestamp(taskActivity.finishedAt)}` : ""}</p>
      {taskActivity.lastError && <p className="type-meta m-0 text-danger [overflow-wrap:anywhere]">{taskActivity.lastError}</p>}
      <ol className="m-0 grid list-none overflow-hidden rounded-lg border border-line p-0">
        {taskActivity.events.map((event) => <li key={event.id} className="type-meta grid grid-cols-[150px_minmax(0,1fr)] gap-3 border-b border-line px-4 py-2 last:border-b-0 phone:grid-cols-1 phone:gap-0.5">
          <time className="text-muted tabular-nums">{formatTimestamp(event.occurredAt)}</time>
          <span className="min-w-0 [overflow-wrap:anywhere]">{event.summary} <code className="type-mono-small text-muted">{event.eventType}</code></span>
        </li>)}
      </ol>
    </section>}
    <section className="grid gap-2" aria-labelledby="log-audit">
      <h3 id="log-audit" className={eyebrow}>Events &amp; audit for this chat</h3>
      <ol className="m-0 grid list-none overflow-hidden rounded-lg border border-line p-0">
        {audit.map((event) => <li key={event.id} className="type-meta grid grid-cols-[150px_minmax(0,1fr)] gap-3 border-b border-line px-4 py-2.5 last:border-b-0 phone:grid-cols-1 phone:gap-0.5">
          <time className="text-muted tabular-nums">{formatTimestamp(event.occurredAt)}</time>
          <span className="min-w-0 [overflow-wrap:anywhere]"><strong className="font-medium">{event.eventType.replaceAll("_", " ")}</strong> <span className="type-mono-small text-muted">{event.actorType} · {event.actorId}</span></span>
        </li>)}
        {!audit.length && <li className="type-meta px-4 py-4 text-muted">No events for this chat among the project&apos;s latest 100.</li>}
      </ol>
      <p className="type-meta m-0 text-muted">The whole project&apos;s timeline is in project settings → Activity.</p>
    </section>
  </>;
}
