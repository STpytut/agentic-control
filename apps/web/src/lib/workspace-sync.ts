import { executeJson } from "@/lib/database";

// The project's latest workspace sync with GitHub (0145), for its Workspace page.
export type WorkspaceSync = {
  id: string;
  mode: "sync" | "reset";
  status: "requested" | "claimed" | "synced" | "kept" | "failed";
  outcome: string;
  requestedBy: string;
  requestedAt: string;
  finishedAt: string;
  backupRef: string;
  diverged: boolean;
};

export async function getWorkspaceSync(projectId: string, ownerId: string): Promise<WorkspaceSync | null> {
  const row = await executeJson(`SELECT get_workspace_sync(:'project_id'::uuid,:'owner_id'::uuid)::text;`,
    { project_id: projectId, owner_id: ownerId }) as Record<string, unknown> | null;
  if (!row) return null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const outcome = text(row.outcome);
  return {
    id: text(row.id), mode: (text(row.mode) || "sync") as WorkspaceSync["mode"], status: text(row.status) as WorkspaceSync["status"],
    outcome, requestedBy: text(row.requested_by), requestedAt: text(row.requested_at), finishedAt: text(row.finished_at),
    backupRef: text(row.backup_ref), diverged: row.status === "kept" && /diverged/.test(outcome),
  };
}
