"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { createPortal } from "react-dom";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, TextInput } from "@agentic/design-system";
import { DangerButton } from "@/components/ui/danger-button";
import { Notice } from "@/components/ui/notice";

// The one way to delete a project (the owner, 2026-09-29): Delete… in the
// project's ⋯ menu in the sidebar, confirmed in this dialog. The menu owns the
// open state; the action and its body are the ones this dialog always sent.
export function ProjectDeleteDialog({
  projectId,
  projectName,
  projectSlug,
  projectVersion,
  open,
  onOpenChange,
  afterDelete,
}: {
  projectId: string;
  projectName: string;
  projectSlug: string;
  projectVersion: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where to go once deletion is requested, when the page shown was this project's. */
  afterDelete?: string;
}) {
  const router = useRouter();
  const setOpen = onOpenChange;
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, busy, setOpen]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- each opening starts empty
    setError(""); setConfirmation("");
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (confirmation !== projectName && confirmation !== projectSlug) {
      setError("Enter the project name or slug exactly as shown.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/control-plane/actions", {
        method: "POST",
        headers: controlPlaneActionHeaders(),
        body: JSON.stringify({
          kind: "delete_project",
          projectId,
          projectVersion,
          confirmName: confirmation,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Project deletion could not be requested");
      setOpen(false);
      if (afterDelete) router.push(afterDelete);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Project deletion could not be requested");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {open && createPortal(
        <>
          <button className="fixed inset-0 z-100 bg-overlay" type="button" aria-label="Close delete project dialog" onClick={() => { if (!busy) setOpen(false); }} />
          <div className="fixed top-1/2 left-1/2 z-101 max-h-[calc(100dvh-32px)] w-[min(500px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line bg-canvas p-6 text-ink shadow-popover phone:p-5" role="dialog" aria-modal="true" aria-labelledby="project-delete-title" aria-describedby="project-delete-description">
            <div className="flex items-start justify-between">
              <span className="grid h-9 w-9 place-items-center rounded-md bg-danger-soft font-display text-[1.0625rem] font-medium text-danger" aria-hidden="true">!</span>
              <Button variant="secondary" size="sm" className="w-9 px-0" onClick={() => { if (!busy) setOpen(false); }} aria-label="Close">×</Button>
            </div>
            <p className="type-eyebrow mt-4 text-muted">DELETE PROJECT</p>
            <h2 id="project-delete-title" className="type-section-title mt-2">Delete “{projectName}”?</h2>
            <p id="project-delete-description" className="type-app-body mt-2 text-muted">Active work will stop and the project workspace will be removed after the safety grace period. The remote GitHub repository and shared provider connections will not be deleted.</p>
            <div className="type-meta my-5 grid gap-1.5 rounded-md border border-line p-3.5 text-ink/80">
              <span className="block"><b className="inline-block min-w-16 font-medium text-ink">Removed</b> local workspace, project deploy keys, new chat access</span>
              <span className="block"><b className="inline-block min-w-16 font-medium text-ink">Kept</b> chat, run and audit history, remote repository</span>
            </div>
            <form onSubmit={submit} className="grid gap-3">
              <label className="type-meta grid gap-1.5 font-medium"><span>Type <strong className="font-mono font-medium">{projectName}</strong> or <strong className="font-mono font-medium">{projectSlug}</strong> to confirm</span>
                <TextInput value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={projectName} autoComplete="off" autoFocus disabled={busy} />
              </label>
              {error && <Notice tone="danger">{error}</Notice>}
              <div className="mt-1 flex justify-end gap-2 phone:[&>*]:flex-1">
                <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
                <DangerButton type="submit" disabled={busy || !confirmation.trim()}>{busy ? "Requesting…" : "Delete project"}</DangerButton>
              </div>
            </form>
            <small className="type-meta mt-4 block text-muted">Deletion can be undone before cleanup starts. Physical cleanup begins after 24 hours.</small>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
