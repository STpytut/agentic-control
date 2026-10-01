import { Badge, Card } from "@agentic/design-system";
import type { WorkspaceState } from "@/lib/product-data";
import { formatTimestamp } from "@/lib/format-timestamp";
import { WorkspaceOperationControls } from "@/components/workspace-operation-controls";

// The repository as the host last saw it: what the Workspace tab showed, now
// in two places — the chat's full changes (in the centre) and project
// settings → Workspace, which alone keeps the operations.

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

function stateLabel(value: string) { return value.replaceAll("_", " "); }

const panelTitle = "flex items-start justify-between gap-3";
const metricText = "type-card-title mt-2 block truncate";

export function WorkspaceCleanBadge({ state }: { state: WorkspaceState }) {
  return <Badge tone={state.dirty ? "warning" : "success"}>{state.dirty ? "Changes present" : "Clean"}</Badge>;
}

export function WorkspaceMetrics({ state }: { state: WorkspaceState }) {
  return <div className="grid grid-cols-4 gap-3 tablet:grid-cols-2 narrow:grid-cols-1">
    <Card as="article" className="min-w-0"><span className="type-eyebrow text-muted">Branch</span><strong className={metricText}>{state.branch}</strong><p className="type-mono-small mt-1.5 truncate text-muted">{state.headSha ? state.headSha.slice(0,12) : "No commit yet"}</p></Card>
    <Card as="article" className="min-w-0"><span className="type-eyebrow text-muted">Upstream</span><strong className={metricText}>{state.upstream || "Not configured"}</strong><p className="type-meta mt-1.5 truncate text-muted">{state.upstream || !state.unpublished ? `${state.ahead} ahead · ${state.behind} behind` : `${state.unpublished.commitCount} ${state.unpublished.commitCount === 1 ? "commit" : "commits"} not on GitHub yet`}</p></Card>
    <Card as="article" className="min-w-0"><span className="type-eyebrow text-muted">Diff</span><strong className={metricText}><i className="text-success not-italic">+{state.diffSummary.additions}</i> <b className="font-medium text-danger">−{state.diffSummary.deletions}</b></strong><p className="type-meta mt-1.5 truncate text-muted">{state.diffSummary.files} files · {state.diffSummary.untracked} untracked</p></Card>
    <Card as="article" className="min-w-0"><span className="type-eyebrow text-muted">Snapshot</span><strong className={metricText}>{state.observedAt ? relativeTime(state.observedAt) : "Pending"}</strong><p className="type-meta mt-1.5 truncate text-muted">{state.collector || "Waiting for VPS collector"}</p></Card>
  </div>;
}

// The commits a publish would push, and what they change together: the work
// an approval approves, which the working tree no longer shows once it is
// committed.
export function UnpublishedCommitsCard({ state }: { state: WorkspaceState }) {
  const unpublished = state.unpublished;
  if (!unpublished) return null;
  const hidden = (count: number, shown: number) => count > shown && <p className="type-meta p-3 text-muted">and {count - shown} more</p>;
  return <Card as="section" className="min-w-0"><div className={panelTitle}><div><p className="type-eyebrow text-muted">TO PUBLISH</p><h2 className="type-card-title mt-1.5">Commits not on GitHub yet</h2></div><span className="type-meta tabular-nums text-muted"><i className="text-success not-italic">+{unpublished.additions}</i> <b className="font-medium text-danger">−{unpublished.deletions}</b> · {unpublished.fileCount} files</span></div>
    {!unpublished.commitCount && <p className="type-meta mt-4 text-muted">Every commit is already on GitHub.</p>}
    {unpublished.commitCount > 0 && <div className="mt-4 border-y border-line">
      {unpublished.commits.map((commit) => <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2 border-b border-line px-3 py-2 last:border-b-0" key={commit.sha}><code className="type-mono-small text-muted">{commit.sha}</code><span className="type-meta min-w-0 truncate">{commit.subject}</span></div>)}
      {hidden(unpublished.commitCount, unpublished.commits.length)}
    </div>}
    {unpublished.files.length > 0 && <div className="mt-4 border-y border-line">
      {unpublished.files.map((file) => <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-line px-3 py-2 last:border-b-0" key={file.path}><code className="type-mono-small break-all text-ink/80">{file.path}</code><span className="type-mono-small tabular-nums">{file.additions === null ? <span className="text-muted">binary</span> : <><i className="text-success not-italic">+{file.additions}</i> <b className="font-medium text-danger">−{file.deletions}</b></>}</span></div>)}
      {hidden(unpublished.fileCount, unpublished.files.length)}
    </div>}
  </Card>;
}

export function ChangedFilesCard({ state }: { state: WorkspaceState }) {
  return <Card as="section" className="min-w-0"><div className={panelTitle}><div><p className="type-eyebrow text-muted">CHANGED FILES</p><h2 className="type-card-title mt-1.5">Working tree</h2></div><span className="type-meta tabular-nums text-muted">{state.changedFiles.length}</span></div><div className="mt-4 border-y border-line">{state.changedFiles.map((file) => <div className="grid grid-cols-[34px_minmax(0,1fr)] gap-2 border-b border-line px-3 py-2 last:border-b-0" key={`${file.status}:${file.path}`}><b className="type-mono-small font-medium text-warning">{file.status}</b><code className="type-mono-small break-all text-ink/80">{file.path}</code></div>)}{!state.changedFiles.length && <p className="type-meta p-3 text-muted">No changed files in the latest VPS snapshot.</p>}{state.diffSummary.truncated && <p className="type-meta m-2.5 text-warning">Only the first 200 paths are shown.</p>}</div></Card>;
}

export function HandoffCard({ state }: { state: WorkspaceState }) {
  return <Card as="section" className="min-w-0"><div className={panelTitle}><div><p className="type-eyebrow text-muted">HANDOFF & VERIFICATION</p><h2 className="type-card-title mt-1.5">Executor contract</h2></div><span className="type-meta text-muted">{state.handoffRevision ? `revision ${state.handoffRevision}` : "no handoff"}</span></div>{state.handoffObjective && <div className="mt-4 border-t border-line pt-3"><strong className="type-meta font-medium">{state.handoffFrom} → {state.handoffTo}</strong><p className="type-meta my-1.5 text-ink/80">{state.handoffObjective}</p><small className="type-mono-small text-muted">{state.handoffPaths.length ? state.handoffPaths.join(" · ") : "Entire workspace"}</small></div>}<pre data-theme="dark" className="type-mono-small mt-4 mb-2.5 max-h-[420px] min-h-[150px] overflow-auto rounded-md bg-canvas p-3 whitespace-pre-wrap text-ink">{Object.keys(state.checksSummary).length ? JSON.stringify(state.checksSummary,null,2) : "No executor checks have been reported yet."}</pre><small className="type-meta text-muted">Provenance: durable handoff {state.checksRunId ? `· run ${state.checksRunId.slice(0,8)}` : "· none"}{state.checksObservedAt ? ` · ${relativeTime(state.checksObservedAt)}` : ""}</small></Card>;
}

export function WorkspaceLockCard({ state, projectId, writeEnabled }: { state: WorkspaceState; projectId: string; writeEnabled: boolean }) {
  return <Card as="section" className="flex items-center justify-between gap-5 phone:flex-col phone:items-start"><div><p className="type-eyebrow text-muted">SINGLE-WRITER LOCK</p><h2 className="type-card-title mt-1.5">{stateLabel(state.lockStatus)}</h2><p className="type-meta mt-1 text-muted">{state.lockRunId ? `${state.lockOwner} owns run ${state.lockRunId.slice(0,8)}` : "No active writer owns the workspace."}</p>{state.lockLeaseExpiresAt && <small className="type-meta mt-1 block text-muted">Lease expires {formatTimestamp(state.lockLeaseExpiresAt)}</small>}</div>{writeEnabled && <WorkspaceOperationControls projectId={projectId} lockStatus={state.lockStatus} activeOperation={state.activeOperation}/>}</Card>;
}
