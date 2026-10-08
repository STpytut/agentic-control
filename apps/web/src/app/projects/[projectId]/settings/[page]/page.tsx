import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Card, cx } from "@agentic/design-system";
import { ControlPlaneShell } from "@/components/control-plane-shell";
import { SettingsMenu, SettingsPageHeader } from "@/components/settings-menu";
import { ProvisioningRetry } from "@/components/provisioning-retry";
import { ProjectDangerZone } from "@/components/project-danger-zone";
import { ProjectRuntimeDefaultsCard } from "@/components/project-runtime-defaults-card";
import { AssignmentReadinessCard } from "@/components/assignment-readiness";
import { ProjectTeamTab } from "@/components/project-team";
import { ChangedFilesCard, HandoffCard, UnpublishedCommitsCard, WorkspaceCleanBadge, WorkspaceLockCard, WorkspaceMetrics } from "@/components/workspace-state";
import { IssueIntakeSettings } from "@/components/issue-intake";
import { ProjectCheckCard } from "@/components/project-check-card";
import { Notice } from "@/components/ui/notice";
import { statusTone } from "@/components/ui/status-tone";
import { getProjectDeletionState, getProjectReadiness, getProjectRuntimeDefaults, getProjectTeam, getProjectWorkspace, getRuntimeCatalog , getIssueIntake } from "@/lib/product-data";
import { getOperatorModels } from "@/lib/model-checks";
import { formatTimestamp } from "@/lib/format-timestamp";
import { runtimeLabel } from "@/lib/runtime-labels";
import { requireOperator } from "@/lib/auth";
import { ProjectMark } from "@/components/ui/project-mark";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  return { title: `${PAGES.find((item) => item.id === page)?.label ?? "Settings"} · Project settings · infra-cod` };
}

// Project settings (Stage 12 N6): one page per part, each with its own URL,
// with the same controls — and the same actions — the project's tabs had.
const PAGES = [
  { id: "general", label: "General" },
  { id: "team", label: "Team" },
  { id: "defaults", label: "Runtime defaults" },
  { id: "issues", label: "GitHub issues" },
  { id: "workspace", label: "Workspace" },
  { id: "activity", label: "Activity" },
  // Only for a project being deleted (undo, retry cleanup, delete now), reached
  // from Settings → Projects. Deleting itself is the sidebar's ⋯ → Delete…
  { id: "danger", label: "Deletion" },
] as const;
type PageId = typeof PAGES[number]["id"];

const settingsRow = "grid grid-cols-[160px_minmax(0,1fr)] gap-5 border-b border-line px-1 py-3 last:border-b-0 phone:grid-cols-[110px_minmax(0,1fr)] phone:gap-3";
const stateLabel = (value: string) => value.replaceAll("_", " ");

export default async function ProjectSettingsPage({ params, searchParams }: { params: Promise<{ projectId: string; page: string }>; searchParams: Promise<{ show?: string }> }) {
  const [{ projectId, page }, query] = await Promise.all([params, searchParams]);
  if (!PAGES.some((item) => item.id === page)) notFound();
  const current = page as PageId;
  const operator = await requireOperator();
  const workspace = await getProjectWorkspace(operator.userId, projectId);
  if (!workspace) notFound();
  const { project } = workspace;
  const deleting = ["deleting", "deletion_failed"].includes(project.status);
  if (current === "danger" && !deleting) redirect(`/projects/${project.id}/settings/general`);
  // Each page reads what it shows, after the workspace has answered for the owner.
  const [projectReadiness, projectTeam, operatorModels, runtimeCatalog, runtimeDefaults, deletionState, issueIntake] = await Promise.all([
    current === "team" ? getProjectReadiness(projectId, operator.userId) : null,
    current === "team" ? getProjectTeam(projectId, operator.userId) : null,
    // The Team picker's not-checked models (Stage 12 W7); null before W6's migrations.
    current === "team" ? getOperatorModels(operator.userId) : null,
    current === "defaults" ? getRuntimeCatalog(operator.userId) : null,
    current === "defaults" ? getProjectRuntimeDefaults(projectId, operator.userId) : null,
    current === "danger" ? getProjectDeletionState(projectId, operator.userId) : null,
    current === "issues" ? getIssueIntake(projectId, operator.userId) : null,
  ]);
  const catalogReady = runtimeCatalog?.some((choice) => choice.selectionSource === "catalog") ?? false;
  const title = PAGES.find((item) => item.id === current)?.label ?? "";
  const showSessions = query.show === "sessions";

  return <ControlPlaneShell operator={operator} projectId={project.id}>
    <header className="cp-topbar">
      <div className="cp-breadcrumbs flex-1"><Link href={`/projects/${project.id}`} className="flex items-center gap-2 font-medium"><ProjectMark id={project.id} name={project.name} size={20}/>{project.name}</Link><span>›</span><span>Settings</span><span>›</span><strong>{title}</strong></div>
      <div className="flex shrink-0 items-center gap-2.5">
        <Badge tone={statusTone(project.provisioningStatus)} className="phone:hidden">{stateLabel(project.provisioningStatus)}</Badge>
        {project.provisioningStatus === "failed" && <ProvisioningRetry projectId={project.id}/>}
      </div>
    </header>
    <div className="mx-auto grid w-full max-w-[1200px] grid-cols-[200px_minmax(0,1fr)] gap-10 px-8 pt-10 pb-14 text-ink tablet:gap-6 phone:grid-cols-1 phone:gap-5 phone:px-3.5 phone:pt-5 phone:pb-10">
      <SettingsMenu label="Project settings" className="phone:order-none" items={PAGES.filter((item) => item.id !== "danger" || deleting).map((item) => ({ href: `/projects/${project.id}/settings/${item.id}`, label: item.label, current: item.id === current }))}/>
      <div className="min-w-0">
        {current === "general" && <>
          <SettingsPageHeader title="General" description="The project's name, repository and branch. Runtime-managed values are shown here and changed through audited commands."/>
          <Card><dl className="type-meta m-0">{[["Name", project.name, false], ["Repository", project.repository, true], ["Default branch", project.defaultBranch, true], ["Project ID", project.id, true], ["Slug", project.slug, true], ["Workspace path", project.workspacePath, true], ["Provisioning", project.provisioningStatus, false]].map(([term, value, mono]) => <div className={settingsRow} key={String(term)}><dt className="text-muted">{term}</dt><dd className={cx("m-0 min-w-0 font-medium [overflow-wrap:anywhere]", mono && "type-mono-small")}>{value}</dd></div>)}</dl></Card>
          {project.provisioningError && <Notice tone="danger" className="mt-4">{project.provisioningError}</Notice>}
        </>}

        {current === "team" && <>
          <SettingsPageHeader title="Team" description="Who runs this project's chats, on which runtime and model, and what each role may do. Changes apply to new chats; running ones keep their team."/>
          {projectTeam ? <ProjectTeamTab projectId={project.id} team={projectTeam} readiness={projectReadiness} models={operatorModels}/> : <Notice tone="info">The team cannot be read right now.</Notice>}
          {projectReadiness && <div className="mt-6"><AssignmentReadinessCard readiness={projectReadiness}/></div>}
        </>}

        {current === "defaults" && <>
          <SettingsPageHeader title="Runtime defaults" description="The models and runtimes a new chat starts with."/>
          <div className="grid max-w-[820px] gap-4">
            <Card><dl className="type-meta m-0">{workspace.agentRoster.map((assignment) => <div className={settingsRow} key={assignment.assignmentId}><dt className="text-muted">{assignment.assignmentRole === "orchestrator" ? "Orchestrator" : "Executor"}</dt><dd className="m-0 min-w-0 truncate font-medium">{runtimeLabel(assignment.runtimeType)} · {assignment.model} · {assignment.providerType}</dd></div>)}{!workspace.agentRoster.length && <p className="text-muted">This project has no enabled assignments.</p>}</dl></Card>
            {catalogReady ? <ProjectRuntimeDefaultsCard projectId={project.id} catalog={runtimeCatalog ?? []} defaults={runtimeDefaults ?? null} roster={workspace.agentRoster}/> : <Notice tone="info">Project defaults will be available after both Codex and OpenCode models finish verification. The connected runtime adapters are available for new chats in the meantime.</Notice>}
          </div>
        </>}

        {current === "issues" && <>
          <SettingsPageHeader title="GitHub issues" description="Take work from the repository's issues: an open issue with the label waits on the project's page until you start it as a chat."/>
          {issueIntake ? <IssueIntakeSettings projectId={project.id} intake={issueIntake}/> : <Notice tone="info">The issue settings cannot be read right now.</Notice>}
        </>}

        {current === "workspace" && <>
          <SettingsPageHeader title="Workspace" description="The repository as the host sees it: Git state, executor checks and single-writer ownership." action={<WorkspaceCleanBadge state={workspace.workspaceState}/>}/>
          <div className="grid gap-3">
            <ProjectCheckCard projectId={project.id} command={project.checkCommand} timeoutSeconds={project.checkTimeoutSeconds}/>
            <WorkspaceMetrics state={workspace.workspaceState}/>
            <WorkspaceLockCard state={workspace.workspaceState} projectId={project.id} writeEnabled/>
            <UnpublishedCommitsCard state={workspace.workspaceState}/>
            <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(300px,.7fr)] gap-3 tablet:grid-cols-1">
              <ChangedFilesCard state={workspace.workspaceState}/>
              <HandoffCard state={workspace.workspaceState}/>
            </div>
          </div>
        </>}

        {current === "activity" && <>
          <SettingsPageHeader title="Activity" description="The project's durable timeline and its agents' native sessions."/>
          <div className="mb-4 flex gap-1.5" role="group" aria-label="Show">
            <Link href={`/projects/${project.id}/settings/activity`} aria-current={!showSessions ? "page" : undefined} className={cx("touch-target inline-flex h-9 items-center rounded-full border px-3.5 text-[0.8125rem] font-medium phone:h-11", !showSessions ? "border-ink bg-ink text-on-ink" : "border-line-strong text-ink hover:border-ink")}>Events &amp; audit</Link>
            <Link href={`/projects/${project.id}/settings/activity?show=sessions`} aria-current={showSessions ? "page" : undefined} className={cx("touch-target inline-flex h-9 items-center rounded-full border px-3.5 text-[0.8125rem] font-medium phone:h-11", showSessions ? "border-ink bg-ink text-on-ink" : "border-line-strong text-ink hover:border-ink")}>Sessions ({workspace.sessions.length})</Link>
          </div>
          {!showSessions && <div className="grid gap-2.5">{workspace.events.map((event) => <Card as="article" className="flex min-w-0 items-center gap-3" key={event.id}><span className="h-2 w-2 shrink-0 rounded-full bg-ink/40"/><div className="min-w-0 flex-1"><strong className="type-meta block truncate font-medium">{stateLabel(event.eventType)}</strong><p className="type-mono-small mt-0.5 truncate text-muted">{event.actorType} · {event.actorId}</p></div><time className="type-meta shrink-0 text-muted tabular-nums">{formatTimestamp(event.occurredAt)}</time></Card>)}{!workspace.events.length && <Card className="type-meta py-9 text-center text-muted">Nothing has happened in this project yet.</Card>}</div>}
          {showSessions && <div className="grid gap-2.5">{workspace.sessions.map((session) => <Card as="article" className="flex min-w-0 items-center gap-3" key={session.id}><span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-ink text-[0.8125rem] font-medium text-on-ink">{runtimeLabel(session.runtimeType).slice(0, 1)}</span><div className="min-w-0 flex-1"><strong className="type-meta block truncate font-medium">{session.agentName}</strong><p className="type-mono-small mt-0.5 truncate text-muted">{session.purpose} · {session.nativeSessionId}</p></div><Badge tone={statusTone(session.status)}>{session.status}</Badge></Card>)}{!workspace.sessions.length && <Card className="type-meta py-9 text-center text-muted">Sessions will appear after the first runtime turn.</Card>}</div>}
        </>}

        {current === "danger" && <>
          <SettingsPageHeader title="Deletion" description="This project is being deleted: its workspace leaves the host after a grace period; its chats and audit stay readable."/>
          <div className="max-w-[820px]"><ProjectDangerZone projectId={project.id} projectVersion={project.version} projectStatus={project.status} deletionState={deletionState ?? null}/></div>
        </>}
      </div>
    </div>
  </ControlPlaneShell>;
}
