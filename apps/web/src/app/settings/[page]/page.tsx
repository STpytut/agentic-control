import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@agentic/design-system";
import { ControlPlaneShell } from "@/components/control-plane-shell";
import { SettingsMenu, SettingsPageHeader } from "@/components/settings-menu";
import { BackToChats } from "@/components/last-chat";
import { GitHubConnectionCard } from "@/components/github-connection-card";
import { ClaudeConnectionCard } from "@/components/claude-connection-card";
import { CodexConnectionCard } from "@/components/codex-connection-card";
import { OpenCodeConnectionCard } from "@/components/opencode-connection-card";
import { OperatorAccountCard, type OperatorSessionRow } from "@/components/operator-account-card";
import { ModelsCard } from "@/components/models-card";
import { RuntimeReadinessCard } from "@/components/runtime-readiness-card";
import { UsageLimitsCard } from "@/components/usage-limits-card";
import { statusTone } from "@/components/ui/status-tone";
import { getOperatorClaudeState } from "@/lib/claude-connections";
import { getOperatorCodexState } from "@/lib/codex-connections";
import { getGitHubAppConfig, getGitHubAppManifestStatus, getOperatorGitHubConnections } from "@/lib/github-connections";
import { getOperatorOpenCodeState } from "@/lib/opencode-connections";
import { getArchivedProjects } from "@/lib/sidebar-data";
import { ProjectRestoreButton } from "@/components/project-menu-dialogs";
import { getOperatorDeletionTombstones, getProjects, getRuntimeActivations, getRuntimeQualifications, getRuntimeReadiness, getRuntimeUpdateRequests, getRuntimeVersions } from "@/lib/product-data";
import { getSidebarProjects } from "@/lib/sidebar-data";
import { getOperatorModels } from "@/lib/model-checks";
import { getOperatorUsageLimits } from "@/lib/usage-data";
import { formatTimestamp } from "@/lib/format-timestamp";
import { listOperatorSessions, readSessionCsrfToken, requireOperator } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  return { title: `${PAGES.find((item) => item.id === page)?.label ?? "Settings"} · Settings · infra-cod` };
}

// Settings (Stage 12 N7): one page per part, each with its own URL, in a menu
// that takes the sidebar's place; every control of the old single page is on
// exactly one of them.
const PAGES = [
  { id: "account", label: "Account" },
  { id: "connections", label: "Connections" },
  { id: "models", label: "Models" },
  { id: "runtimes", label: "Runtimes" },
  { id: "usage", label: "Limits & usage" },
  { id: "projects", label: "Projects" },
] as const;
type PageId = typeof PAGES[number]["id"];

const NEEDS_ACTION = new Set(["action_required", "expired"]);
const stateLabel = (value: string) => value.replaceAll("_", " ");

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ page: string }>; searchParams: Promise<{ github?: string; account?: string }> }) {
  const [{ page }, { github, account }] = await Promise.all([params, searchParams]);
  if (!PAGES.some((item) => item.id === page)) notFound();
  const current = page as PageId;
  const operator = await requireOperator();
  // The connections are read on every page: the menu says when one needs action.
  const [connections, codex, opencode, claude] = await Promise.all([
    getOperatorGitHubConnections(operator.userId),
    getOperatorCodexState(operator.userId),
    getOperatorOpenCodeState(operator.userId),
    getOperatorClaudeState(operator.userId),
  ]);
  const runtimeUpdateRequests = current === "runtimes" ? await getRuntimeUpdateRequests() : [];
  const [githubApp, githubManifest] = current === "connections"
    ? await Promise.all([getGitHubAppConfig(), getGitHubAppManifestStatus(operator.userId)])
    : [null, null];
  const needAction = [
    ...connections.map((connection) => connection.status),
    codex.connection?.status, opencode.free?.status, opencode.go?.status, opencode.openrouter?.status, claude.connection?.status,
  ].filter((status): status is string => Boolean(status) && NEEDS_ACTION.has(String(status))).length;

  const [sessionList, csrfToken, models, runtimeReadiness, runtimeVersions, runtimeQualifications, runtimeActivations, usageLimits, projects, sidebar, tombstones, archived] = await Promise.all([
    current === "account" ? listOperatorSessions() : null,
    current === "account" ? readSessionCsrfToken() : null,
    // The Models card reads `get_operator_models` (Stage 12 W6/W7).
    current === "models" ? getOperatorModels(operator.userId) : null,
    current === "runtimes" ? getRuntimeReadiness() : null,
    current === "runtimes" ? getRuntimeVersions() : null,
    current === "runtimes" ? getRuntimeQualifications() : null,
    current === "runtimes" ? getRuntimeActivations() : null,
    current === "usage" ? getOperatorUsageLimits(operator.userId) : null,
    current === "projects" ? getProjects(operator.userId) : null,
    current === "projects" ? getSidebarProjects(operator.userId) : null,
    current === "projects" ? getOperatorDeletionTombstones(operator.userId) : null,
    current === "projects" ? getArchivedProjects(operator.userId) : null,
  ]);

  const nav = <nav aria-label="Settings" className="fixed inset-y-0 left-0 z-30 flex w-[280px] flex-col border-r border-line bg-canvas text-ink phone:static phone:w-auto phone:border-r-0 phone:border-b phone:pb-3">
    <div className="flex items-center gap-1.5 px-3 pt-3.5 pb-3">
      <BackToChats className="touch-target grid h-9 w-9 shrink-0 place-items-center rounded-md text-ink transition-colors duration-150 hover:bg-wash phone:h-11 phone:w-11">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
        <span className="sr-only">Back to chats</span>
      </BackToChats>
      <span className="font-display text-[1.0625rem] font-semibold">Settings</span>
    </div>
    <SettingsMenu label="Settings pages" className="px-2" items={PAGES.map((item) => ({
      href: `/settings/${item.id}`, label: item.label, current: item.id === current,
      badge: item.id === "connections" && needAction > 0
        ? <span className="type-meta rounded-full bg-warning-soft px-1.5 font-semibold text-warning tabular-nums" title={`${needAction} connection${needAction === 1 ? " needs" : "s need"} action`}>{needAction}<span className="sr-only"> need action</span></span>
        : undefined,
    }))}/>
  </nav>;

  return <ControlPlaneShell operator={operator} nav={nav}>
    <div className="mx-auto w-full max-w-[960px] px-10 pt-10 pb-14 text-ink tablet:px-6 phone:px-3.5 phone:pt-5 phone:pb-10">
      {current === "account" && <>
        <SettingsPageHeader title="Account" description="Your sign-in: username, password and the sessions signed in as you."/>
        <OperatorAccountCard operator={operator} csrfToken={csrfToken ?? ""} sessions={(sessionList?.sessions ?? []) as unknown as OperatorSessionRow[]} notice={account}/>
      </>}

      {current === "connections" && <>
        <SettingsPageHeader title="Connections" description="The providers used to clone repositories and run coding agents."/>
        <div className="grid grid-cols-2 items-start gap-4 tablet:grid-cols-1">
          <GitHubConnectionCard connections={connections} notice={github} operatorDisplayName={operator.displayName} app={githubApp} manifest={githubManifest}/>
          <CodexConnectionCard initialConnection={codex.connection} initialLogin={codex.login} operatorDisplayName={operator.displayName}/>
          <OpenCodeConnectionCard initialFree={opencode.free} initialGo={opencode.go} initialOpenRouter={opencode.openrouter} initialEnrollment={opencode.enrollment} operatorDisplayName={operator.displayName}/>
          <ClaudeConnectionCard initial={claude}/>
        </div>
      </>}

      {current === "models" && <>
        <SettingsPageHeader title="Models" description="What each connection offers your projects, and which are checked."/>
        {models ? <ModelsCard models={models}/> : <p className="type-app-body text-muted">Models are not available on this server yet.</p>}
      </>}

      {current === "runtimes" && runtimeReadiness && <>
        <SettingsPageHeader title="Runtimes" description="The host's agent runtimes: what this server can run, for every project."/>
        <RuntimeReadinessCard report={runtimeReadiness} versions={runtimeVersions ?? []} qualifications={runtimeQualifications ?? []} activations={runtimeActivations ?? []} requests={runtimeUpdateRequests}/>
      </>}

      {current === "usage" && <>
        <SettingsPageHeader title="Limits & usage" description="Each model connection's windows as its provider last reported them, and what this platform used on it."/>
        <UsageLimitsCard initial={usageLimits}/>
      </>}

      {current === "projects" && projects && <>
        <SettingsPageHeader title="Projects" description="Every project you own. Its chats are in the sidebar; rename, archive or delete one from its ⋯ menu there."
          action={<Link href="/projects/new" className="touch-target inline-flex h-9 items-center rounded-md bg-ink px-3.5 text-[0.875rem] font-medium text-on-ink transition-colors duration-150 hover:bg-accent hover:text-on-accent">＋ New project</Link>}/>
        <ul className="m-0 grid list-none overflow-hidden rounded-lg border border-line p-0">
          {projects.map((project) => {
            const chats = sidebar?.find((item) => item.id === project.id)?.chatCount ?? 0;
            return <li key={project.id} className="flex min-h-14 min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5 last:border-b-0">
              <Link href={`/projects/${project.id}`} className="type-meta min-w-0 flex-1 truncate font-medium text-ink underline-offset-4 hover:underline">{project.name}</Link>
              <span className="type-meta w-24 text-muted tabular-nums phone:w-auto">{chats} chat{chats === 1 ? "" : "s"}</span>
              <code className="type-mono-small w-24 truncate text-muted phone:w-auto">{project.defaultBranch}</code>
              <Badge tone={statusTone(project.provisioningStatus)}>{stateLabel(project.provisioningStatus)}</Badge>
            </li>;
          })}
          {!projects.length && <li className="type-meta px-4 py-9 text-center text-muted">No projects yet. <Link href="/projects/new" className="font-medium text-ink underline underline-offset-4">Create the first one</Link>.</li>}
        </ul>
        {archived && archived.length > 0 && <section className="mt-10" aria-labelledby="archived-title">
          <h2 id="archived-title" className="type-section-title m-0">Archived</h2>
          <p className="type-app-body mt-2 max-w-[60ch] text-muted">Out of the sidebar and taking no new chats; nothing in them is deleted. Restore one to work in it again.</p>
          <ul className="m-0 mt-4 grid list-none overflow-hidden rounded-lg border border-line p-0">
            {archived.map((project) => <li key={project.id} className="flex min-h-14 min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5 last:border-b-0">
              <span className="type-meta min-w-0 flex-1 truncate font-medium text-ink">{project.name}</span>
              <span className="type-meta text-muted">archived {project.archivedAt ? formatTimestamp(project.archivedAt) : "—"}</span>
              <ProjectRestoreButton projectId={project.id} projectVersion={project.version}/>
            </li>)}
          </ul>
        </section>}
        {tombstones && tombstones.length > 0 && <section className="mt-10" aria-labelledby="tombstones-title">
          <h2 id="tombstones-title" className="type-section-title m-0">Deleted and deleting</h2>
          <p className="type-app-body mt-2 max-w-[60ch] text-muted">Deleted and deleting projects remain attributable here; their chat, run and audit history stays readable.</p>
          <ul className="m-0 mt-4 grid list-none overflow-hidden rounded-lg border border-line p-0">
            {tombstones.map((tombstone) => <li key={String(tombstone.project_id)} className="border-b border-line last:border-b-0">
              <Link href={`/projects/${String(tombstone.project_id)}/settings/danger`} className="type-meta flex min-h-14 min-w-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 transition-colors duration-150 hover:bg-wash">
                <span className="flex min-w-0 flex-1 flex-col"><strong className="truncate font-medium text-ink">{String(tombstone.name)}</strong><small className="type-mono-small truncate text-muted">{String(tombstone.slug)} · {String(tombstone.workspace_path ?? "")}</small></span>
                <Badge tone={statusTone(String(tombstone.status))}>{stateLabel(String(tombstone.status))}</Badge>
                {String(tombstone.deletion_failure_code ?? "") && <small className="type-mono-small text-danger">{String(tombstone.deletion_failure_code)}</small>}
                <span className="text-muted">requested {tombstone.deletion_requested_at ? formatTimestamp(String(tombstone.deletion_requested_at)) : "—"}</span>
                <span className="text-muted">deprovisioned {tombstone.deprovisioned_at ? formatTimestamp(String(tombstone.deprovisioned_at)) : "—"}</span>
              </Link>
            </li>)}
          </ul>
        </section>}
      </>}
    </div>
  </ControlPlaneShell>;
}
