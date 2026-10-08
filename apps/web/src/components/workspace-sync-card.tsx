"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import type { WorkspaceSync } from "@/lib/workspace-sync";
import { formatTimestamp } from "@/lib/format-timestamp";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge, Button, Card } from "@agentic/design-system";
import { Notice } from "@/components/ui/notice";

const TONE = { synced: "success", kept: "warning", failed: "danger", requested: "info", claimed: "info" } as const;
const WORD = { synced: "Up to date", kept: "Kept as it is", failed: "Failed", requested: "Waiting", claimed: "Syncing…" } as const;

// Project settings → Workspace (0145): the workspace and GitHub's base branch.
// A new chat syncs on its own; this says how the last sync went, syncs now,
// and resets to GitHub when they diverged.
export function WorkspaceSyncCard({ projectId, initial, baseBranch }: { projectId: string; initial: WorkspaceSync | null; baseBranch: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const open = initial?.status === "requested" || initial?.status === "claimed";

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [open, router]);

  async function request(mode: "sync" | "reset") {
    if (mode === "reset" && !window.confirm(`Reset the workspace to GitHub's ${baseBranch}? The local commits are kept on a backup branch.`)) return;
    setBusy(mode);
    setError("");
    try {
      const response = await fetch("/api/control-plane/actions", { method: "POST", headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ kind: "workspace_sync", projectId, mode }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "The sync could not be asked for");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sync could not be asked for");
    } finally {
      setBusy("");
    }
  }

  return <Card as="section" className="min-w-0">
    <div className="flex items-start justify-between gap-4 phone:flex-col phone:gap-2">
      <div>
        <p className="type-eyebrow text-muted">GITHUB</p>
        <h2 className="type-section-title mt-1.5">Sync with GitHub</h2>
        <p className="type-meta mt-1.5 text-muted">Every new chat starts from GitHub&apos;s {baseBranch}: merged pull requests and commits pushed elsewhere reach the workspace. Local commits are never lost.</p>
      </div>
      {initial && <Badge tone={TONE[initial.status]} className="shrink-0">{WORD[initial.status]}</Badge>}
    </div>
    {error && <Notice tone="danger" className="mt-3.5">{error}</Notice>}
    {initial
      ? <p className="type-app-body mt-3.5 mb-0">{initial.outcome || (open ? "Fetching GitHub's branch…" : "")}
          {initial.finishedAt && <span className="type-meta text-muted"> · {formatTimestamp(initial.finishedAt)}</span>}</p>
      : <p className="type-meta mt-3.5 mb-0 text-muted">Not synced yet: the next chat syncs it, or sync now.</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={Boolean(busy) || open} onClick={() => void request("sync")}>{busy === "sync" ? "Asking…" : "Sync now"}</Button>
      {initial?.diverged && <Button size="sm" disabled={Boolean(busy) || open} onClick={() => void request("reset")}>{busy === "reset" ? "Asking…" : "Reset to GitHub"}</Button>}
    </div>
  </Card>;
}
