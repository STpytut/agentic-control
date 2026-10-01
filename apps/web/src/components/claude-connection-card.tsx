"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import type { ClaudeConnectionState } from "@/lib/claude-connections";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card } from "@agentic/design-system";
import { connection as ui, connectionTone } from "@/components/ui/connection-card";
import { dangerOutlineClasses } from "@/components/ui/danger-button";
import { Notice } from "@/components/ui/notice";

// Claude Code (sprint C K2; decisions C2 and C3). The login is the host's:
// the operator runs `infra-cod runtime login claude` there, as the runtime's
// user, and the credential never reaches the panel or the database. This card
// says which step is missing, and connects the subscription for the team once
// the host reports it signed in. An orchestrator only.
function nextStep(state: ClaudeConnectionState) {
  const { runtime } = state;
  if (!runtime.known) return "The host has not reported Claude Code recently.";
  if (!runtime.installed) return "Install it on the host: infra-cod runtime install claude --version <exact>";
  if (!runtime.authenticated) return "Sign it in on the host: infra-cod runtime login claude";
  return "";
}

export function ClaudeConnectionCard({ initial }: { initial: ClaudeConnectionState }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const connected = initial.connection?.status === "connected";
  const step = nextStep(initial);

  async function act(kind: "claude_connect" | "claude_disconnect") {
    setBusy(kind);
    setError("");
    try {
      const response = await fetch("/api/control-plane/actions", {
        method: "POST",
        headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ kind, connectionId: initial.connection?.connectionId }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Claude Code action failed");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Claude Code action failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <Card as="section" className="min-w-0">
      <div className={ui.heading}>
        <div>
          <p className="type-eyebrow text-muted">ORCHESTRATOR</p>
          <h2 className="type-section-title mt-1.5">Claude Code</h2>
          <p className={ui.owner}>Your Claude subscription, signed in on the host.</p>
        </div>
        <Badge tone={connectionTone(connected ? "connected" : "disconnected")} className="shrink-0">
          {connected ? "Connected" : "Not connected"}
        </Badge>
      </div>

      {error && <Notice tone="danger" className="mt-3.5">{error}</Notice>}
      {step && <Notice tone="info" className="mt-3.5">{step}</Notice>}

      <dl className={ui.meta}>
        <div className={ui.metaItem}><dt className={ui.metaTerm}>On the host</dt><dd className={ui.metaValue}>{!initial.runtime.known ? "unknown" : !initial.runtime.installed ? "not installed"
          : initial.runtime.authenticated ? `signed in · ${initial.runtime.version}` : `signed out · ${initial.runtime.version}`}</dd></div>
        <div className={ui.metaItem}><dt className={ui.metaTerm}>Role</dt><dd className={ui.metaValue}>Orchestrator only</dd></div>
      </dl>

      <div className={ui.boundary}>
        <span className={ui.boundaryLabel}>Credential boundary</span>
        <ul className={ui.boundaryList}>
          <li className={ui.boundaryItem}><strong className={ui.boundaryName}>Claude subscription</strong><small className={ui.boundaryNote}>claude-worker on the host</small></li>
          <li className={ui.boundaryItem}><strong className={ui.boundaryName}>Web application</strong><small className={ui.boundaryNote}>no token access</small></li>
        </ul>
      </div>

      <div className={ui.actions}>
        {connected ? (
          <button className={dangerOutlineClasses} onClick={() => act("claude_disconnect")} disabled={Boolean(busy)}>
            {busy === "claude_disconnect" ? "Disconnecting…" : "Disconnect"}
          </button>
        ) : (
          <Button size="sm" onClick={() => act("claude_connect")} disabled={Boolean(busy) || Boolean(step)}>
            {busy === "claude_connect" ? "Connecting…" : "Connect Claude Code"}
          </Button>
        )}
      </div>

      <p className={ui.footnote}>
        The login stays in the isolated claude-worker account on the VPS; disconnecting here stops dispatch to it, and signing out is done on the host.
      </p>
    </Card>
  );
}
