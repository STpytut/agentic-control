"use client";

import { createPortal } from "react-dom";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, TextInput } from "@agentic/design-system";
import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { Notice } from "@/components/ui/notice";

// The sidebar ⋯ menu's Rename and Archive (0120), each confirmed in a dialog
// shaped like the delete one. The menu owns the open state.

async function projectAction(body: Record<string, unknown>) {
  const response = await fetch("/api/control-plane/actions", {
    method: "POST", headers: controlPlaneActionHeaders(), body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error ?? "The action could not be done");
  return data;
}

function Dialog({ open, busy, onClose, labelledBy, children }: { open: boolean; busy: boolean; onClose: () => void; labelledBy: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", escape);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", escape); };
  }, [open, busy, onClose]);
  if (!open) return null;
  return createPortal(<>
    <button className="fixed inset-0 z-100 bg-overlay" type="button" aria-label="Close the dialog" onClick={() => { if (!busy) onClose(); }}/>
    <div className="fixed top-1/2 left-1/2 z-101 max-h-[calc(100dvh-32px)] w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line bg-canvas p-6 text-ink shadow-popover phone:p-5"
      role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      {children}
    </div>
  </>, document.body);
}

export function ProjectRenameDialog({ projectId, projectName, projectVersion, open, onOpenChange }: {
  projectId: string; projectName: string; projectVersion: number; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(projectName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- each opening starts from the current name
    setName(projectName); setError("");
  }, [open, projectName]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await projectAction({ kind: "rename_project", projectId, projectVersion, name: name.trim() });
      onOpenChange(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The project could not be renamed");
    } finally {
      setBusy(false);
    }
  }

  const trimmed = name.trim();
  return <Dialog open={open} busy={busy} onClose={() => onOpenChange(false)} labelledBy="project-rename-title">
    <h2 id="project-rename-title" className="type-section-title m-0">Rename project</h2>
    <p className="type-meta mt-1.5 text-muted">Only the name changes. Its links, workspace and repository stay as they are.</p>
    <form onSubmit={submit} className="mt-4 grid gap-3">
      <label className="type-meta grid gap-1.5 font-medium"><span>Name</span>
        <TextInput value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoComplete="off" autoFocus disabled={busy}
          onFocus={(event) => event.currentTarget.select()}/>
      </label>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="mt-1 flex justify-end gap-2 phone:[&>*]:flex-1">
        <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy || trimmed.length < 2 || trimmed === projectName}>{busy ? "Renaming…" : "Rename"}</Button>
      </div>
    </form>
  </Dialog>;
}

export function ProjectArchiveDialog({ projectId, projectName, projectVersion, open, onOpenChange, afterArchive }: {
  projectId: string; projectName: string; projectVersion: number; open: boolean; onOpenChange: (open: boolean) => void;
  /** Where to go once archived, when the page shown was this project's. */
  afterArchive?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- each opening starts clean
    if (open) setError("");
  }, [open]);

  async function archive() {
    setBusy(true); setError("");
    try {
      await projectAction({ kind: "archive_project", projectId, projectVersion });
      onOpenChange(false);
      if (afterArchive) router.push(afterArchive);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The project could not be archived");
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open={open} busy={busy} onClose={() => onOpenChange(false)} labelledBy="project-archive-title">
    <h2 id="project-archive-title" className="type-section-title m-0">Archive “{projectName}”?</h2>
    <p className="type-app-body mt-2 text-muted">It leaves the sidebar and takes no new chats. Nothing is deleted: its workspace, chats and history stay, and Settings → Projects restores it.</p>
    <p className="type-meta mt-2 text-muted">A project with work queued or running cannot be archived until that work ends.</p>
    {error && <Notice tone="danger" className="mt-3">{error}</Notice>}
    <div className="mt-5 flex justify-end gap-2 phone:[&>*]:flex-1">
      <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
      <Button onClick={() => void archive()} disabled={busy}>{busy ? "Archiving…" : "Archive"}</Button>
    </div>
  </Dialog>;
}

// Settings → Projects: an archived project back into the sidebar.
export function ProjectRestoreButton({ projectId, projectVersion }: { projectId: string; projectVersion: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <span className="flex items-center gap-2">
    {error && <span className="type-meta text-danger" role="alert">{error}</span>}
    <Button variant="secondary" size="sm" disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try {
        await projectAction({ kind: "unarchive_project", projectId, projectVersion });
        router.refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The project could not be restored");
      } finally {
        setBusy(false);
      }
    }}>{busy ? "Restoring…" : "Restore"}</Button>
  </span>;
}
