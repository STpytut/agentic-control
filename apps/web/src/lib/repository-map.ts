import { executeJson } from "@/lib/database";

// The project's repository map (0146): what a new orchestrator session is told
// about the repository before its first turn. Built by the platform from the
// workspace's last commit, after every implementation and sync.
export type RepositoryMap = {
  headSha: string;
  branch: string;
  source: "implementation" | "sync" | "provision";
  builtAt: string;
  filesTotal: number;
  languages: { name: string; files: number }[];
  tree: string;
  manifests: string[];
  readme: string;
  instructions: string[];
  commits: { sha: string; date: string; subject: string }[];
};

export async function getRepositoryMap(projectId: string, ownerId: string): Promise<RepositoryMap | null> {
  const row = await executeJson(`SELECT get_repository_map(:'project_id'::uuid,:'owner_id'::uuid)::text;`,
    { project_id: projectId, owner_id: ownerId }) as Record<string, unknown> | null;
  if (!row || !row.map || typeof row.map !== "object") return null;
  const map = row.map as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const list = (value: unknown) => (Array.isArray(value) ? value : []) as Record<string, unknown>[];
  return {
    headSha: text(row.head_sha), branch: text(map.branch), source: text(row.source) as RepositoryMap["source"],
    builtAt: text(row.built_at), filesTotal: Number(map.files_total) || 0,
    languages: list(map.languages).map((item) => ({ name: text(item.name), files: Number(item.files) || 0 })),
    tree: text(map.tree), manifests: list(map.manifests).map((item) => text(item.path)).filter(Boolean),
    readme: text((map.readme as Record<string, unknown> | null)?.path),
    instructions: (Array.isArray(map.instructions) ? map.instructions : []).filter((item): item is string => typeof item === "string"),
    commits: list(map.commits).map((item) => ({ sha: text(item.sha), date: text(item.date), subject: text(item.subject) })),
  };
}
