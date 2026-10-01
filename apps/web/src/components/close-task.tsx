"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClasses } from "@agentic/design-system";
import { dangerOutlineClasses } from "@/components/ui/danger-button";

// Every button here carries its own size: the heading is not a button row.
const secondary = buttonClasses({ variant: "secondary", size: "sm" });
// A quiet button: no frame until hovered. The package has no such variant (a
// candidate for @agentic/design-system).
const quiet = "touch-target inline-flex h-9 items-center rounded-md px-3 text-[0.875rem] font-medium whitespace-nowrap text-ink/75 transition-colors duration-150 hover:bg-wash hover:text-ink aria-expanded:bg-wash aria-expanded:text-ink disabled:opacity-60 phone:w-full phone:justify-start";

// The operator archives a chat it abandoned: its newest task is closed (0090). Asked twice, in the page
// rather than a browser dialog: the second click says what closing does. The
// database refuses while the task's work runs, at a version the heading no
// longer shows, or for a stranger, and the refusal is shown as it came.
export function CloseTask({ projectId, taskId, taskVersion }: { projectId: string; taskId: string; taskVersion: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function close() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/control-plane/actions", {
        method: "POST",
        headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ kind: "task_close", projectId, taskId, taskVersion }),
      });
      const answer = await response.json();
      if (!response.ok || !answer.ok) {
        if (response.status === 409) router.refresh();
        throw new Error(answer.error ?? "The chat was not archived");
      }
      setConfirming(false);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The chat was not archived");
    } finally {
      setBusy(false);
    }
  }

  // In the top bar the button is quiet; the second question opens under it as
  // a small panel (inline inside the phone's "⋯" menu), not in a browser dialog.
  return <div className="relative">
    <button type="button" className={quiet} disabled={busy} aria-expanded={confirming} onClick={() => { setError(""); setConfirming(!confirming); }}>Archive chat</button>
    {confirming && <div className="absolute top-full right-0 z-40 mt-2 grid w-80 gap-2.5 rounded-lg border border-line bg-canvas p-3 text-ink shadow-popover phone:static phone:mt-1 phone:w-auto phone:border-0 phone:p-2 phone:shadow-none">
      <span className="type-meta text-muted">Queued work for it is dropped; running work must be stopped first.</span>
      <div className="flex justify-end gap-1.5">
        <button type="button" className={secondary} disabled={busy} onClick={() => setConfirming(false)}>Keep</button>
        <button type="button" className={dangerOutlineClasses} disabled={busy} onClick={close}>{busy ? "Archiving…" : "Archive it"}</button>
      </div>
      {error && <p role="alert" className="type-meta m-0 text-danger [overflow-wrap:anywhere]">{error}</p>}
    </div>}
  </div>;
}
