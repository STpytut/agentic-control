"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@agentic/design-system";
import { controlPlaneActionHeaders } from "@/lib/csrf-client";

// Qualify or Promote from Settings → Runtimes (0127). The press records a
// request; the host's update pass runs it as root within five minutes, with the
// CLI's own code, and the card shows how it went (LivePulse refreshes it).
export function RuntimeUpdateButton({ runtime, version, kind, label, primary = false }: {
  runtime: string; version: string; kind: "qualify" | "promote"; label: string; primary?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function request() {
    if (kind === "promote" && !window.confirm(`Switch ${runtime} to ${version}? Running tasks finish on the current version; their next turn uses ${version}. Probation rolls it back on a runtime failure.`)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/control-plane/actions", {
        method: "POST", headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ kind: "runtime_update", runtime, version, updateKind: kind }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error ?? "The request was not accepted");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request was not accepted");
    } finally {
      setBusy(false);
    }
  }
  return <span className="mt-1 inline-flex flex-wrap items-center gap-2">
    <Button size="sm" variant={primary ? "primary" : "secondary"} disabled={busy} onClick={() => void request()}>{busy ? "Asking…" : label}</Button>
    {error && <span role="alert" className="type-meta text-danger">{error}</span>}
  </span>;
}
