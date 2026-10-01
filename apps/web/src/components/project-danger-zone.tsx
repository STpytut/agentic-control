"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatTimestamp } from "@/lib/format-timestamp";
import { Button, Card } from "@agentic/design-system";
import { DangerButton } from "@/components/ui/danger-button";
import { Notice } from "@/components/ui/notice";

function useNowTick(setNow: (value: number) => void) {
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [setNow]);
}

export function ProjectDangerZone({
  projectId,
  projectVersion,
  projectStatus,
  deletionState,
}: {
  projectId: string;
  projectVersion: number;
  projectStatus: string;
  deletionState: Record<string, unknown> | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmNow, setConfirmNow] = useState(false);

  const deleting = projectStatus === "deleting" || deletionState?.status === "deleting";
  const failed = deletionState?.status === "deletion_failed";
  const graceAtRaw = deletionState?.deletion_not_before;
  const graceAt = typeof graceAtRaw === "string" || graceAtRaw instanceof Date ? new Date(String(graceAtRaw)) : null;
  const [now, setNow] = useState(0);
  useNowTick(setNow);
  const graceActive = graceAt !== null && !Number.isNaN(graceAt.getTime()) && graceAt.getTime() > now;

  async function run(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/control-plane/actions", {
        method: "POST",
        headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ kind: body.kind, projectId, projectVersion, ...body }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Action failed");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  if (deleting || failed) {
    return (
      <Card as="section" className="border-danger/40">
        <p className="type-eyebrow text-muted">DANGER ZONE</p><h2 className="type-card-title mt-1.5 text-danger">Deletion in progress</h2>
        {failed && <Notice tone="danger" className="mt-3">Cleanup failed{deletionState?.deletion_failure_message ? `: ${String(deletionState.deletion_failure_message)}` : ""}. You can retry cleanup below.</Notice>}
        <p className="type-app-body mt-3">Status: {String(deletionState?.status ?? projectStatus)}.
          {graceAt && !Number.isNaN(graceAt.getTime()) && <span> Cleanup may start at {formatTimestamp(graceAt)}. Deleting can be undone only before any cleanup attempt.</span>}
          {deletionState?.cleanup_leased_by ? <span> A cleanup worker currently holds this project.</span> : null}
        </p>
        <dl className="my-3 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-x-4 gap-y-2 narrow:grid-cols-2">
          <div><dt className="type-eyebrow text-muted">Requested</dt><dd className="type-meta m-0 font-medium">{deletionState?.deletion_requested_at ? formatTimestamp(String(deletionState.deletion_requested_at)) : "—"}</dd></div>
          <div><dt className="type-eyebrow text-muted">Attempts</dt><dd className="type-meta m-0 font-medium tabular-nums">{String(deletionState?.deletion_attempt_count ?? "—")}</dd></div>
          {deletionState?.deletion_failure_code ? <div><dt className="type-eyebrow text-muted">Failure code</dt><dd className="type-mono-small m-0">{String(deletionState.deletion_failure_code)}</dd></div> : null}
        </dl>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {deleting && !deletionState?.cleanup_leased_by && Number(deletionState?.deletion_attempt_count ?? 0) === 0 && (
            <Button variant="secondary" disabled={busy} onClick={() => void run({ kind: "undo_delete_project" })}>Undo deletion</Button>
          )}
          {failed && (
            <Button variant="secondary" disabled={busy} onClick={() => void run({ kind: "retry_project_cleanup" })}>Retry cleanup</Button>
          )}
          {deleting && graceActive && (
            <>
              <DangerButton disabled={busy || !confirmNow} onClick={() => void run({ kind: "delete_project_now" })}>
                {confirmNow ? "Confirm Delete now" : "Delete now"}
              </DangerButton>
              <label className="type-meta flex max-w-[480px] cursor-pointer items-start gap-2">
                <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-danger)]" checked={confirmNow} onChange={(event) => setConfirmNow(event.target.checked)}/>
                I understand this skips only the grace timer and still stops active work safely
              </label>
            </>
          )}
        </div>
        {error && <Notice tone="danger" className="mt-3">{error}</Notice>}
        <small className="type-meta mt-3 block text-muted">Deleting projects do not appear in the normal project list. History stays readable in the operations view.</small>
      </Card>
    );
  }

  // Requesting deletion is the sidebar's ⋯ → Delete… (ProjectDeleteDialog);
  // this page is only for a project already being deleted.
  return null;
}
