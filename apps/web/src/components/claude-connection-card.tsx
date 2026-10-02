"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import type { ClaudeConnectionState } from "@/lib/claude-connections";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, TextInput } from "@agentic/design-system";
import { connection as ui, connectionTone } from "@/components/ui/connection-card";
import { dangerOutlineClasses } from "@/components/ui/danger-button";
import { Notice } from "@/components/ui/notice";

// Claude Code (sprint C K2; decisions C2 and C3; rc.123). The sign-in runs on
// the host as the runtime's user — `claude auth login`, started from here
// (0136): this card shows its link and passes the code the owner pastes to
// that process. The credential itself stays in claude-worker's home and never
// reaches the panel or the database. Once the host reports it signed in, the
// subscription is connected for the team without another click.
const OPEN = new Set(["requested", "awaiting_code", "verifying"]);

async function action(body: Record<string, unknown>) {
  const response = await fetch("/api/control-plane/actions", {
    method: "POST",
    headers: controlPlaneActionHeaders(),
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error ?? "Claude Code action failed");
  return data;
}

export function ClaudeConnectionCard({ initial }: { initial: ClaudeConnectionState }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const autoConnected = useRef(false);
  const { runtime, login } = initial;
  const connected = initial.connection?.status === "connected";
  const signingIn = Boolean(login && OPEN.has(login.status));
  const justSignedIn = login?.status === "succeeded" && runtime.authenticated !== true;

  // While the sign-in moves, or the host has yet to report it, read again.
  useEffect(() => {
    if (!signingIn && !justSignedIn) return;
    const timer = window.setInterval(() => router.refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [signingIn, justSignedIn, router]);

  async function act(kind: string, extra: Record<string, unknown> = {}) {
    setBusy(kind);
    setError("");
    try {
      await action({ kind, ...extra });
      if (kind === "claude_login_code") setCode("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Claude Code action failed");
    } finally {
      setBusy("");
    }
  }

  // Signed in from here and reported by the host: connect it for the team.
  useEffect(() => {
    if (autoConnected.current || connected || runtime.authenticated !== true || login?.status !== "succeeded") return;
    autoConnected.current = true;
    void act("claude_connect");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the host's report arrives
  }, [connected, runtime.authenticated, login?.status]);

  const installed = runtime.known && runtime.installed === true;
  const signedIn = runtime.authenticated === true;

  return (
    <Card as="section" className="min-w-0">
      <div className={ui.heading}>
        <div>
          <p className="type-eyebrow text-muted">AGENT</p>
          <h2 className="type-section-title mt-1.5">Claude Code</h2>
          <p className={ui.owner}>Your Claude subscription, signed in on the host.</p>
        </div>
        <Badge tone={connectionTone(connected ? "connected" : "disconnected")} className="shrink-0">
          {connected ? "Connected" : "Not connected"}
        </Badge>
      </div>

      {error && <Notice tone="danger" className="mt-3.5">{error}</Notice>}
      {!runtime.known && <Notice tone="info" className="mt-3.5">The host has not reported Claude Code recently.</Notice>}
      {runtime.known && !installed && <Notice tone="info" className="mt-3.5">Install it on the host: infra-cod runtime install claude</Notice>}

      {installed && !signedIn && !signingIn && !justSignedIn && login?.status === "failed" && (
        <Notice tone="danger" className="mt-3.5">The last sign-in did not complete: {login.failure}</Notice>
      )}
      {installed && login?.status === "requested" && (
        <Notice tone="info" className="mt-3.5">Starting the sign-in on the host…</Notice>
      )}
      {installed && login?.status === "awaiting_code" && (
        <Notice tone="info" className="mt-3.5 grid gap-2.5">
          <strong className="font-medium">Sign in to Claude</strong>
          <p className="m-0">1. Open the sign-in page and allow access.</p>
          <a className="inline-flex min-h-8 w-fit items-center font-medium underline underline-offset-2" href={login.authorizeUrl} target="_blank" rel="noreferrer">
            Open Claude sign-in
          </a>
          <p className="m-0">2. Paste the code it shows here.</p>
          <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void act("claude_login_code", { sessionId: login.id, code }); }}>
            <TextInput className="min-w-0 flex-1 font-mono" value={code} onChange={(event) => setCode(event.target.value)}
              placeholder="Paste the code" aria-label="Claude sign-in code" autoComplete="off" spellCheck={false} disabled={login.codeSubmitted}/>
            <Button size="sm" type="submit" disabled={Boolean(busy) || login.codeSubmitted || code.trim().length < 8}>
              {login.codeSubmitted || busy === "claude_login_code" ? "Checking…" : "Submit"}
            </Button>
          </form>
        </Notice>
      )}
      {installed && login?.status === "verifying" && <Notice tone="info" className="mt-3.5">Checking the code with Claude…</Notice>}
      {justSignedIn && <Notice tone="success" className="mt-3.5">Signed in. The host reports it within a minute.</Notice>}

      <dl className={ui.meta}>
        <div className={ui.metaItem}><dt className={ui.metaTerm}>On the host</dt><dd className={ui.metaValue}>{!runtime.known ? "unknown" : !installed ? "not installed"
          : signedIn ? `signed in · ${runtime.version}` : `signed out · ${runtime.version}`}</dd></div>
        <div className={ui.metaItem}><dt className={ui.metaTerm}>Role</dt><dd className={ui.metaValue}>Orchestrator or executor</dd></div>
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
          <button className={dangerOutlineClasses} onClick={() => act("claude_disconnect", { connectionId: initial.connection?.connectionId })} disabled={Boolean(busy)}>
            {busy === "claude_disconnect" ? "Disconnecting…" : "Disconnect"}
          </button>
        ) : signedIn ? (
          <Button size="sm" onClick={() => act("claude_connect")} disabled={Boolean(busy)}>
            {busy === "claude_connect" ? "Connecting…" : "Connect Claude Code"}
          </Button>
        ) : installed && !signingIn && !justSignedIn ? (
          <Button size="sm" onClick={() => act("claude_login_start")} disabled={Boolean(busy)}>
            {busy === "claude_login_start" ? "Starting…" : "Sign in with Claude"}
          </Button>
        ) : null}
      </div>

      <p className={ui.footnote}>
        The login stays in the isolated claude-worker account on the VPS; the code you paste goes only to the sign-in it was made for. Disconnecting here stops dispatch to it.
      </p>
    </Card>
  );
}
