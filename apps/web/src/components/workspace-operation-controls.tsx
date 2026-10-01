"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClasses } from "@agentic/design-system";

const secondary = buttonClasses({ variant: "secondary", size: "sm" });

export function WorkspaceOperationControls({ projectId, lockStatus, activeOperation }: {
  projectId: string; lockStatus: string; activeOperation: string;
}) {
  const router = useRouter();
  const [pending,setPending] = useState("");
  const [notice,setNotice] = useState("");

  async function request(operationType: "recover_lock" | "restore_owner") {
    setPending(operationType); setNotice("");
    try {
      const response = await fetch("/api/control-plane/actions", { method: "POST",
        headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ kind: "workspace_operation", projectId, operationType,
          reason: operationType === "recover_lock"
            ? "Operator requested guarded recovery after lease reconciliation"
            : "Operator requested canonical read-owner restoration" }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "Workspace operation failed");
      setNotice("Queued. The VPS will verify process and lock state before changing ownership.");
      router.refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Workspace operation failed"); }
    finally { setPending(""); }
  }

  // Only an operator's own operation hides the buttons. The periodic inspection
  // runs every few minutes and sits pending for about one, and hid "Recover
  // stale lock" a quarter of the time (P-8); it changes no owner and does not
  // conflict with a recovery.
  const operatorOperation = activeOperation === "recover_lock" || activeOperation === "restore_owner";
  if (operatorOperation) return <p className="type-meta m-0 max-w-[340px] text-muted">{activeOperation.replaceAll("_"," ")} is in progress.</p>;
  return <div className="flex flex-wrap items-center gap-2.5">
    {lockStatus === "reconciliation_required" && <button className={secondary} disabled={!!pending} onClick={() => request("recover_lock")}>{pending ? "Queuing…" : "Recover stale lock"}</button>}
    {lockStatus === "released" && <button className={secondary} disabled={!!pending} onClick={() => request("restore_owner")}>{pending ? "Queuing…" : "Restore Codex ownership"}</button>}
    {notice && <p className="type-meta m-0 max-w-[340px] text-muted">{notice}</p>}
  </div>;
}
