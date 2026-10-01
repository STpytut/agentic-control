"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { cx } from "@agentic/design-system";
import { dangerOutlineClasses } from "@/components/ui/danger-button";

export function ProvisioningRetry({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");

  async function retry() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/control-plane/actions", {
        method: "POST",
        headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ kind: "retry_provisioning", projectId }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "Provisioning retry failed");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provisioning retry failed");
    } finally {
      setBusy(false);
    }
  }

  return <span className="relative">
    <button type="button" className={cx(dangerOutlineClasses, "disabled:cursor-wait")} disabled={busy} onClick={retry}>{busy ? "Queuing…" : "Retry setup"}</button>
    {error && <small role="status" className="type-meta absolute top-11 right-0 z-10 w-[260px] rounded-md bg-danger-soft px-2.5 py-2 text-danger">{error}</small>}
  </span>;
}
