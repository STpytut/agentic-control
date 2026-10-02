"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeChoice } from "@/lib/product-data";
import { isGitHubVerifying, type GitHubConnection, type GitHubRepository } from "@/lib/github-connections-shared";
import { formatTimestamp } from "@/lib/format-timestamp";
import { runtimeLabel } from "@/lib/runtime-labels";
import { modelWithResolved } from "@/lib/models";
import { Badge, Button, Checkbox, Field, Select, TextInput, cx } from "@agentic/design-system";
import { Notice } from "@/components/ui/notice";
import { ReasoningSelect } from "@/components/reasoning-select";

type SelectedRepo = {
  connectionId: string;
  githubRepositoryId: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
};

const REPOSITORY_LIST_MAX_AGE_MS = 10 * 60 * 1000;

/** The list was read from GitHub long enough ago that a repository may be missing. */
function isStale(lastVerifiedAt: string) {
  const at = Date.parse(lastVerifiedAt);
  return !Number.isFinite(at) || Date.now() - at > REPOSITORY_LIST_MAX_AGE_MS;
}

// A dialog opened from a button, or (Stage 12 N1: the sidebar's New project)
// a page of its own in the centre, where Cancel goes back to `closeHref`.
export function ProjectCreateForm({
  enabled,
  runtimeCatalog,
  githubConnections,
  presentation = "dialog",
  closeHref = "/projects",
}: {
  enabled: boolean;
  runtimeCatalog: RuntimeChoice[];
  githubConnections: GitHubConnection[];
  presentation?: "dialog" | "page";
  closeHref?: string;
}) {
  const inPage = presentation === "page";
  const router = useRouter();
  const orchestrators = runtimeCatalog.filter((choice) => choice.canOrchestrate);
  const executors = runtimeCatalog.filter((choice) => choice.canExecute);
  const orchestratorRuntimes = [...new Set(orchestrators.map((choice) => choice.runtimeType))];
  // A connection whose Verify is running is still the operator's GitHub: its
  // list is only being read again.
  const connectedGithub = useMemo(() => githubConnections.filter((connection) => connection.status === "connected" || isGitHubVerifying(connection)), [githubConnections]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const open = inPage || dialogOpen;
  const setOpen = (value: boolean) => { if (inPage) { if (!value) router.push(closeHref); } else setDialogOpen(value); };
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("main");
  const [source, setSource] = useState<"github" | "manual" | "empty">(connectedGithub.length ? "github" : "empty");
  const [selectedConnectionId, setSelectedConnectionId] = useState(connectedGithub[0]?.connectionId ?? "");
  const [repoSearch, setRepoSearch] = useState("");
  const [repoResults, setRepoResults] = useState<GitHubRepository[]>([]);
  const [repoLoading, setRepoLoading] = useState(false);
  // The list is GitHub's answer at the last Verify, kept in the database. A
  // repository given to the App since then is missing until it is read again.
  const [repoRefreshing, setRepoRefreshing] = useState(false);
  const [repoRefreshTick, setRepoRefreshTick] = useState(0);
  const autoRefreshed = useRef(false);
  const [selectedRepo, setSelectedRepo] = useState<SelectedRepo | null>(null);
  const [repository, setRepository] = useState("");
  const [orchestratorRuntime, setOrchestratorRuntime] = useState(orchestratorRuntimes[0] ?? "");
  const [orchestratorProfileId, setOrchestratorProfileId] = useState(orchestrators[0]?.profileId ?? "");
  const [orchestratorReasoning, setOrchestratorReasoning] = useState("");
  // None chosen until the operator chooses (the owner, 2026-09-29): every
  // executor ticked by default made a team nobody had picked.
  const [executorProfileIds, setExecutorProfileIds] = useState<string[]>([]);
  const [executorReasoning, setExecutorReasoning] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open || inPage) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setOpen follows `inPage`, fixed for the component's life
  }, [open, inPage]);

  useEffect(() => {
    if (!open || source !== "github" || !selectedConnectionId) return;
    const controller = new AbortController();
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setRepoLoading(true);
      fetch(`/api/control-plane/github/repositories?search=${encodeURIComponent(repoSearch)}&connectionId=${encodeURIComponent(selectedConnectionId)}`, { signal: controller.signal })
        .then((response) => response.json())
        .then((data) => {
          if (!data.ok) return;
          // During a Verify the list reads empty: keep what is shown.
          if (data.verifying) { setRepoRefreshing(true); return; }
          setRepoRefreshing(false);
          setRepoResults(Array.isArray(data.repositories) ? data.repositories : []);
          if (!autoRefreshed.current && !repoSearch && isStale(data.lastVerifiedAt)) {
            autoRefreshed.current = true;
            void refreshRepositories();
          }
        })
        .catch(() => undefined)
        .finally(() => setRepoLoading(false));
    }, 220);
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshRepositories only reads state set here
  }, [open, source, selectedConnectionId, repoSearch, repoRefreshTick]);

  // While GitHub is read again, ask for the list every few seconds until the
  // check ends; the broker takes up to a minute.
  useEffect(() => {
    if (!repoRefreshing) return;
    const timer = setTimeout(() => setRepoRefreshTick((tick) => tick + 1), 4000);
    return () => clearTimeout(timer);
  }, [repoRefreshing, repoRefreshTick]);

  async function refreshRepositories() {
    if (!selectedConnectionId) return;
    setRepoRefreshing(true);
    try {
      const response = await fetch("/api/control-plane/actions", {
        method: "POST",
        headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ kind: "github_verify", connectionId: selectedConnectionId }),
      });
      if (!response.ok) setRepoRefreshing(false);
    } catch {
      setRepoRefreshing(false);
    }
    setRepoRefreshTick((tick) => tick + 1);
  }

  const selectedOrchestrator = orchestrators.find((choice) => choice.profileId === orchestratorProfileId);
  const chosenExecutors = executors.filter((choice) => executorProfileIds.includes(choice.profileId));
  const executorGroups = [...new Set(executors.map((choice) => choice.runtimeType))]
    .map((runtimeType) => [runtimeType, executors.filter((choice) => choice.runtimeType === runtimeType && !executorProfileIds.includes(choice.profileId))] as const)
    .filter(([, choices]) => choices.length > 0);
  const orchestratorCatalogMode = selectedOrchestrator?.selectionSource === "catalog";
  const serviceTiers = selectedOrchestrator?.serviceTiers ?? [];
  const executorRow = (choice: RuntimeChoice) => <div key={choice.profileId} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
    <Checkbox className="min-w-0 flex-1 [overflow-wrap:anywhere]" label={runtimeLabel(choice.runtimeType)} description={`${modelWithResolved(choice.model, choice.resolvedModel)} · ${choice.providerType}${choice.planBadge ? ` · ${choice.planBadge}` : ""}`} checked={executorProfileIds.includes(choice.profileId)} onChange={() => toggleExecutor(choice.profileId)}/>
    {orchestratorCatalogMode && executorProfileIds.includes(choice.profileId) && <ReasoningSelect id={`create-executor-reasoning-${choice.profileId}`}
      label={`Reasoning level for ${choice.model}`} className="w-[11rem] phone:w-full"
      levels={choice.reasoningLevels ?? []} defaultLevel={choice.defaultReasoningEffort}
      value={executorReasoning[choice.profileId] ?? ""} onChange={(value) => setExecutorReasoning((current) => ({ ...current, [choice.profileId]: value }))}/>}
  </div>;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload: Record<string, unknown> = {
        kind: "create_project", name,
        defaultBranch: source === "github" && selectedRepo ? selectedRepo.defaultBranch : branch,
      };
      if (orchestratorCatalogMode) {
        payload.orchestratorEntryId = orchestratorProfileId;
        payload.executorEntryIds = executorProfileIds;
        if (orchestratorReasoning) payload.reasoningEffort = orchestratorReasoning;
        payload.executorReasoningEfforts = Object.fromEntries(executorProfileIds.map((id) => [id, executorReasoning[id] ?? ""]));
        if (selectedOrchestrator?.serviceTiers?.length) payload.serviceTier = serviceTiers[0];
      } else {
        payload.orchestratorProfileId = orchestratorProfileId;
        payload.executorProfileIds = executorProfileIds;
      }
      if (source === "github" && selectedRepo) {
        payload.providerConnectionId = selectedRepo.connectionId;
        payload.githubRepositoryId = selectedRepo.githubRepositoryId;
      } else if (source === "manual" && repository.trim()) {
        payload.repository = repository.trim();
      }
      const response = await fetch("/api/control-plane/actions", {
        method: "POST",
        headers: controlPlaneActionHeaders(),
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "Project creation failed");
      router.push(`/projects/${body.result.project_id}`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Project creation failed");
    } finally {
      setBusy(false);
    }
  }

  function selectOrchestratorRuntime(value: string) {
    setOrchestratorRuntime(value);
    setOrchestratorReasoning("");
    setOrchestratorProfileId(orchestrators.find((choice) => choice.runtimeType === value)?.profileId ?? "");
  }

  function toggleExecutor(profileId: string) {
    setExecutorProfileIds((current) => current.includes(profileId)
      ? current.filter((id) => id !== profileId)
      : [...current, profileId]);
  }

  function chooseRepo(repo: GitHubRepository) {
    if (repo.archived) return;
    setSelectedRepo({
      connectionId: repo.connectionId,
      githubRepositoryId: repo.githubRepositoryId,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch || "main",
      private: repo.private,
      archived: repo.archived,
    });
    setBranch(repo.defaultBranch || "main");
  }

  const repoSummary = (() => {
    if (source === "github") {
      if (!connectedGithub.length) return "Connect GitHub in Settings to pick a repository.";
      if (selectedRepo) return `${selectedRepo.fullName} · ${selectedRepo.private ? "Private" : "Public"} · ${selectedRepo.defaultBranch}`;
      return "Select a GitHub repository to clone.";
    }
    if (source === "manual") {
      if (repository.trim()) return `${repository.trim()} · ${branch}`;
      return "Enter a GitHub repository URL or switch to Empty workspace.";
    }
    return "Empty Git workspace (no repository).";
  })();

  if (!open) {
    return <Button size="sm" disabled={!enabled} onClick={() => setOpen(true)}>＋ New project</Button>;
  }

  const sourceTab = (active: boolean) => cx(
    "touch-target h-9 min-w-0 flex-1 rounded-sm px-2 text-[0.8125rem] font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50",
    active ? "bg-ink text-on-ink" : "text-ink/75 hover:bg-wash hover:text-ink",
  );

  const body = <div className={inPage
      ? "flex w-full max-w-[560px] flex-col overflow-hidden rounded-lg border border-line bg-canvas text-ink"
      : "absolute top-[52px] right-7 z-40 flex max-h-[calc(100dvh-80px)] w-[460px] flex-col overflow-hidden overscroll-contain rounded-lg border border-line bg-canvas text-ink shadow-popover phone:fixed phone:inset-x-3 phone:top-[max(12px,env(safe-area-inset-top))] phone:bottom-[calc(12px+env(safe-area-inset-bottom))] phone:z-101 phone:max-h-none phone:w-auto"}
      role={inPage ? "region" : "dialog"} aria-modal={inPage ? undefined : true} aria-labelledby="create-project-title">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 pt-5 pb-4">
        <div><p className="type-eyebrow text-muted">PROJECT WORKSPACE</p><h2 id="create-project-title" className="type-section-title mt-1.5">Create project</h2></div>
        <Button variant="secondary" size="sm" className="w-9 px-0" onClick={() => setOpen(false)} aria-label="Close">×</Button>
      </div>
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        {/* Only the popover scrolls inside itself. On the page the form is as tall
            as it is, and overscroll-contain on it swallowed the wheel: the page
            did not scroll while the cursor was over the form (first clean install). */}
        <div className={inPage ? "grid content-start gap-4 px-5 py-4" : "grid min-h-0 flex-1 content-start gap-4 overflow-y-auto overscroll-contain px-5 py-4"}>
        <Field label="Project name" htmlFor="create-project-name"><TextInput id="create-project-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="My application" required minLength={2} maxLength={80}/></Field>

        <div className="flex gap-1 rounded-md border border-line p-1">
          <button type="button" className={sourceTab(source === "github")} onClick={() => { setSource("github"); setRepository(""); }} disabled={!connectedGithub.length}>
            GitHub App
          </button>
          <button type="button" className={sourceTab(source === "manual")} onClick={() => { setSource("manual"); setSelectedRepo(null); setRepoSearch(""); }}>
            Manual URL <small className="ml-1 font-normal opacity-70">advanced</small>
          </button>
          <button type="button" className={sourceTab(source === "empty")} onClick={() => { setSource("empty"); setSelectedRepo(null); setRepository(""); }}>
            Empty workspace
          </button>
        </div>

        {source === "github" ? (
          connectedGithub.length ? (
            <>
              {connectedGithub.length > 1 && (
                <Field label="GitHub connection" htmlFor="create-project-connection">
                  <Select id="create-project-connection" value={selectedConnectionId} onChange={(event) => { setSelectedConnectionId(event.target.value); setSelectedRepo(null); }}>
                    {connectedGithub.map((connection) => <option value={connection.connectionId} key={connection.connectionId}>{connection.accountLabel || connection.installationLabel || connection.connectionId.slice(0, 8)}</option>)}
                  </Select>
                </Field>
              )}
              {selectedRepo ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-ink/30 bg-wash px-3.5 py-2.5">
                  <div className="flex min-w-0 flex-col"><strong className="type-mono-id truncate">{selectedRepo.fullName}</strong><small className="type-meta text-muted">{selectedRepo.private ? "Private" : "Public"} · default branch {selectedRepo.defaultBranch}</small></div>
                  <Button variant="secondary" size="sm" className="w-9 shrink-0 px-0" onClick={() => setSelectedRepo(null)} aria-label="Remove repository">×</Button>
                </div>
              ) : (
                <div className="grid gap-2">
                  <TextInput value={repoSearch} onChange={(event) => setRepoSearch(event.target.value)} placeholder="Search owner/repository…"/>
                  <div className="max-h-[220px] overflow-auto overscroll-contain rounded-md border border-line phone:max-h-[180px]">
                    {repoRefreshing && !repoResults.length ? <div className="type-meta px-3.5 py-3.5 text-center text-muted">Reading the repositories from GitHub…</div> : null}
                    {!repoRefreshing && repoLoading && !repoResults.length ? <div className="type-meta px-3.5 py-3.5 text-center text-muted">Loading repositories…</div> : null}
                    {!repoRefreshing && !repoLoading && !repoResults.length ? <div className="type-meta px-3.5 py-3.5 text-center text-muted">No repositories available to this installation.</div> : null}
                    {repoResults.map((repo) => (
                      <button type="button" className="touch-target flex w-full items-center justify-between gap-3 border-b border-line px-3.5 py-2.5 text-left transition-colors duration-150 last:border-b-0 hover:bg-wash disabled:cursor-not-allowed disabled:opacity-60 phone:flex-col phone:items-start phone:gap-1.5" key={repo.githubRepositoryId} onClick={() => chooseRepo(repo)} disabled={repo.archived}>
                        <span className="flex min-w-0 flex-col">
                          <strong className="type-mono-id truncate">{repo.fullName}</strong>
                          <small className="type-meta text-muted">default {repo.defaultBranch || "main"}</small>
                        </span>
                        <span className="flex flex-none flex-wrap gap-1.5">
                          <Badge>{repo.private ? "Private" : "Public"}</Badge>
                          {repo.archived ? <Badge tone="warning">Archived</Badge> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                  <p className="type-meta m-0 text-muted">
                    {repoRefreshing ? "Reading the list again from GitHub — up to a minute. " : (
                      <>Not listed? <button type="button" className="font-medium underline underline-offset-2" onClick={() => void refreshRepositories()}>Read the list again</button>, or give the GitHub App the repository in </>
                    )}
                    {repoRefreshing ? null : <><Link href="/settings/connections" className="font-medium underline underline-offset-2">Settings → Connections → Repository access</Link>.</>}
                  </p>
                </div>
              )}
              <Field label="Default branch" htmlFor="create-project-branch"><TextInput id="create-project-branch" value={selectedRepo?.defaultBranch || branch} onChange={(event) => setBranch(event.target.value)} required/></Field>
            </>
          ) : (
            <Notice tone="info">Connect GitHub in <Link href="/settings/connections" className="font-medium underline underline-offset-2">Settings</Link> to pick a private repository without a deploy key. You can still create an empty workspace or use a manual URL.</Notice>
          )
        ) : source === "manual" ? (
          <details className="rounded-md border border-dashed border-line-strong p-3.5" open>
            <summary className="type-meta cursor-pointer font-medium text-muted">Manual repository URL (advanced / legacy deploy-key path)</summary>
            <Field label="GitHub repository" labelSuffix="optional · public HTTPS or private with a project-scoped deploy key" htmlFor="create-project-repository" className="mt-3">
              <TextInput id="create-project-repository" value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="https://github.com/owner/repository.git"/>
            </Field>
            <Field label="Default branch" htmlFor="create-project-branch" className="mt-3"><TextInput id="create-project-branch" value={branch} onChange={(event) => setBranch(event.target.value)} required/></Field>
            <Notice tone="warning" className="mt-3">A project made from a URL can clone, but it cannot open pull requests unless the GitHub App reaches that repository — then it is taken as the App&apos;s repository. Give the App access in <Link href="/settings/connections" className="font-medium underline underline-offset-2">Settings → Connections</Link>.</Notice>
          </details>
        ) : (
          <Notice tone="info">The VPS will create a fresh Git workspace. You can attach a repository later through the project Settings.</Notice>
        )}

        <fieldset className="m-0 min-w-0 border-0 border-t border-line p-0 pt-3">
          <legend className="type-meta float-left mb-2 w-full p-0 font-medium">Default orchestrator</legend>
          <div className="clear-left grid grid-cols-2 gap-3 phone:grid-cols-1">
            <Field label="Runtime" htmlFor="create-orchestrator-runtime"><Select id="create-orchestrator-runtime" value={orchestratorRuntime} onChange={(event) => selectOrchestratorRuntime(event.target.value)} required>
              {orchestratorRuntimes.map((runtime) => <option value={runtime} key={runtime}>{runtimeLabel(runtime)}</option>)}
            </Select></Field>
            <Field label="Model" htmlFor="create-orchestrator-model"><Select id="create-orchestrator-model" value={orchestratorProfileId} onChange={(event) => { setOrchestratorProfileId(event.target.value); setOrchestratorReasoning(""); }} required>
              {orchestrators.filter((choice) => choice.runtimeType === orchestratorRuntime).map((choice) => <option value={choice.profileId} key={choice.profileId}>{modelWithResolved(choice.model, choice.resolvedModel)} · {choice.providerType}{choice.planBadge ? ` · ${choice.planBadge}` : ""}</option>)}
            </Select></Field>
            {orchestratorCatalogMode && (selectedOrchestrator?.reasoningLevels ?? []).length > 0 && (
              <Field label="Reasoning" htmlFor="create-orchestrator-reasoning"><ReasoningSelect id="create-orchestrator-reasoning"
                levels={selectedOrchestrator?.reasoningLevels ?? []} defaultLevel={selectedOrchestrator?.defaultReasoningEffort}
                value={orchestratorReasoning} onChange={setOrchestratorReasoning}/></Field>
            )}
            {orchestratorCatalogMode && selectedOrchestrator?.serviceTiers && selectedOrchestrator.serviceTiers.length > 0 && (
              <Field label="Service tier" htmlFor="create-orchestrator-tier"><Select id="create-orchestrator-tier" value={serviceTiers[0]} disabled>
                {serviceTiers.map((tier) => <option value={tier} key={tier}>{tier}</option>)}
              </Select></Field>
            )}
          </div>
          {orchestratorCatalogMode
             ? <small className="type-meta mt-2.5 block text-muted">Verified catalog selection · verification {selectedOrchestrator?.lastVerifiedAt ? formatTimestamp(selectedOrchestrator.lastVerifiedAt) : ""}</small>
             : <small className="type-meta mt-2.5 block text-muted">Using the connected runtime adapter while model verification finishes. You can switch to catalog models after verification.</small>}
        </fieldset>
        <fieldset className="m-0 min-w-0 border-0 border-t border-line p-0 pt-3">
          <legend className="type-meta float-left mb-2 w-full p-0 font-medium">Executors <span className="font-normal text-muted">— choose one or more</span></legend>
          {/* With every connected model listed flat, the one chosen sank among
              fifteen others (the owner, 2026-10-01): the chosen come first, the
              rest wait folded by runtime. */}
          <div className="clear-left grid gap-2">
            {chosenExecutors.length > 0 && <div className="grid divide-y divide-line rounded-md border border-ink/30 bg-wash px-3">
              {chosenExecutors.map(executorRow)}
            </div>}
            {executorGroups.map(([runtimeType, choices]) => <details key={runtimeType} className="group rounded-md border border-line px-3">
              <summary className="type-meta flex cursor-pointer list-none items-center justify-between gap-3 py-2.5 font-medium">
                <span>{runtimeLabel(runtimeType)}</span>
                <span className="font-normal text-muted">{choices.length} {choices.length === 1 ? "model" : "models"} <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">›</span></span>
              </summary>
              <div className="grid divide-y divide-line border-t border-line">{choices.map(executorRow)}</div>
            </details>)}
            {!executors.length && <p className="type-meta text-muted">No executor model is available.</p>}
          </div>
        </fieldset>
         <p className="type-meta text-muted">{repoSummary}. The VPS will provision an isolated workspace for this project.</p>
         {!orchestrators.length && <Notice tone="danger">No Codex model is available yet. Connect Codex and update the model list in Settings.</Notice>}
         {!executors.length && <Notice tone="danger">No executor model is available yet. Connect OpenCode or Claude Code and update the model list in Settings.</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
        </div>
         <div className="flex shrink-0 justify-end gap-2 border-t border-line bg-canvas px-5 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] phone:[&>*]:flex-1"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={busy || name.trim().length < 2 || !orchestratorProfileId || !executorProfileIds.length || (source === "github" && !!connectedGithub.length && !selectedRepo) || (source === "github" && repoRefreshing)}>{busy ? "Creating…" : "Create project"}</Button></div>
      </form>
    </div>;

  if (inPage) return body;
  return createPortal(
    <><button className="fixed inset-0 z-39 bg-overlay phone:z-100" onClick={() => setOpen(false)} aria-label="Close create project dialog"/>
    {body}</>,
    document.body,
  );
}
