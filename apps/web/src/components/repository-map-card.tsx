import type { RepositoryMap } from "@/lib/repository-map";
import { formatTimestamp } from "@/lib/format-timestamp";
import { Card } from "@agentic/design-system";

const SOURCE = { implementation: "after a task", sync: "after a sync with GitHub", provision: "when the workspace was set up" } as const;

// Project settings → Workspace (0146): the map a new chat's orchestrator is
// given, so it starts from the project instead of exploring it.
export function RepositoryMapCard({ map }: { map: RepositoryMap | null }) {
  return <Card as="section" className="min-w-0">
    <p className="type-eyebrow text-muted">ORCHESTRATOR</p>
    <h2 className="type-section-title mt-1.5">Repository map</h2>
    <p className="type-meta mt-1.5 text-muted">A new chat&apos;s orchestrator starts with this map and what earlier tasks changed, instead of exploring the project first. It is rebuilt from the last commit after every task and sync.</p>
    {map
      ? <>
          <p className="type-app-body mt-3.5 mb-0">
            Commit <code className="type-mono-small">{map.headSha.slice(0, 7)}</code>{map.branch && <> on {map.branch}</>} · {map.filesTotal} files
            {map.languages.length > 0 && <> · {map.languages.slice(0, 3).map((language) => language.name).join(", ")}</>}
            <span className="type-meta text-muted"> · built {SOURCE[map.source] ?? ""}, {formatTimestamp(map.builtAt)}</span>
          </p>
          {(map.manifests.length > 0 || map.readme || map.instructions.length > 0) && <p className="type-meta mt-1.5 mb-0 text-muted">
            Reads {[...map.manifests, map.readme, ...map.instructions.map((name) => `${name} (named)`)].filter(Boolean).join(", ")}
          </p>}
          <details className="mt-3">
            <summary className="type-meta cursor-pointer">Show the layout and latest commits</summary>
            <pre className="type-mono-small mt-2 max-h-96 overflow-auto rounded-md border border-line bg-canvas p-3 whitespace-pre text-ink">{map.tree}</pre>
            {map.commits.length > 0 && <pre className="type-mono-small mt-2 overflow-auto rounded-md border border-line bg-canvas p-3 whitespace-pre text-ink">
              {map.commits.map((commit) => `${commit.sha} ${commit.date} ${commit.subject}`).join("\n")}
            </pre>}
          </details>
        </>
      : <p className="type-meta mt-3.5 mb-0 text-muted">Not built yet: it is built after the next task or sync.</p>}
  </Card>;
}
