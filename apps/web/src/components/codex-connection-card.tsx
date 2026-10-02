"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { useCallback, useEffect, useState } from "react";
import {
  codexConnectionStatusLabel,
  humanizeCodexFailure,
  type CodexConnection,
  type CodexLoginStatus,
} from "@/lib/codex-connections-shared";
import { Badge, Button, Card } from "@agentic/design-system";
import { connection as ui, connectionTone } from "@/components/ui/connection-card";
import { dangerOutlineClasses } from "@/components/ui/danger-button";
import { Notice } from "@/components/ui/notice";

function formatDate(value: string) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

async function postAction(body: Record<string, unknown>) {
  const response = await fetch("/api/control-plane/actions", {
    method: "POST",
    headers: controlPlaneActionHeaders(),
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error ?? "Codex action failed");
  return data.result as Record<string, unknown>;
}

export function CodexConnectionCard({
  initialConnection,
  initialLogin,
  operatorDisplayName,
}: {
  initialConnection: CodexConnection;
  initialLogin: CodexLoginStatus;
  operatorDisplayName: string;
}) {
  const [connection, setConnection] = useState(initialConnection);
  const [login, setLogin] = useState(initialLogin);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const poll = useCallback(async () => {
    const response = await fetch("/api/control-plane/codex/status", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) return;
    setConnection(data.connection as CodexConnection);
    setLogin(data.login as CodexLoginStatus);
  }, []);

  const shouldPoll = (
    login?.status === "pending"
    || connection?.status === "pending_finalize"
    || Boolean(connection?.requestedAction)
  );

  useEffect(() => {
    if (!shouldPoll) return;
    const initialPoll = window.setTimeout(() => void poll(), 0);
    const interval = window.setInterval(() => void poll(), 2500);
    return () => {
      window.clearTimeout(initialPoll);
      window.clearInterval(interval);
    };
  }, [poll, shouldPoll]);

  async function connect(kind: "codex_connect" | "codex_reconnect") {
    setBusy(kind);
    setError("");
    try {
      await postAction({ kind });
      await poll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Codex connection could not start");
    } finally {
      setBusy("");
    }
  }

  async function requestAction(kind: "codex_verify" | "codex_disconnect") {
    if (!connection) return;
    if (
      kind === "codex_disconnect"
      && !window.confirm(
        "Disconnect the Codex account? New Codex runs will fail until you reconnect. Existing history remains readable.",
      )
    ) return;
    setBusy(kind);
    setError("");
    try {
      await postAction({ kind, connectionId: connection.connectionId });
      await poll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Codex account action failed");
    } finally {
      setBusy("");
    }
  }

  const connected = connection?.status === "connected";
  const needsAttention = connection
    && ["action_required", "expired"].includes(connection.status);
  const loginFailed = login && ["failed", "expired"].includes(login.status);
  const deviceReady = login?.status === "pending"
    && Boolean(login.verificationUrl && login.userCode);

  return (
    <Card as="section" className="min-w-0">
      <div className={ui.heading}>
        <div>
          <p className="type-eyebrow text-muted">ORCHESTRATOR</p>
          <h2 className="type-section-title mt-1.5">Codex / ChatGPT</h2>
          <p className={ui.owner}>
            Signed in as {operatorDisplayName}. Codex uses a separate ChatGPT subscription connection.
          </p>
        </div>
        <Badge tone={connectionTone(connection?.status)} className="shrink-0">
          {connection ? codexConnectionStatusLabel(connection) : "Disconnected"}
        </Badge>
      </div>

      {error && <Notice tone="danger" className="mt-3.5">{error}</Notice>}
      {deviceReady && (
        <Notice tone="info" className="mt-3.5 grid gap-2">
          <strong className="font-medium">Complete device authorization</strong>
          <p className="m-0">Open the verification page and enter this one-time code:</p>
          <code className="w-fit rounded-sm border border-line-strong bg-canvas px-2.5 py-1.5 font-mono text-[0.9375rem] font-medium tracking-[1.5px] text-ink tabular-nums select-all">{login.userCode}</code>
          <a className="inline-flex min-h-8 w-fit items-center font-medium underline underline-offset-2" href={login.verificationUrl} target="_blank" rel="noreferrer">
            Open ChatGPT authorization
          </a>
          <small className="text-muted">Expires {formatDate(login.expiresAt)} UTC</small>
          {/* The page OpenAI shows otherwise says only "Something went wrong";
              that is what the first install on a clean server met. */}
          <small className="text-muted">If ChatGPT says “Something went wrong”, allow it first: ChatGPT → Settings → Security → device code authorization for Codex. Then reconnect here for a new code.</small>
        </Notice>
      )}
      {login?.status === "pending" && !deviceReady && (
        <Notice tone="info" className="mt-3.5">Preparing a one-time ChatGPT device authorization code…</Notice>
      )}
      {loginFailed && connection?.status !== "connected" && (
        <Notice tone="danger" className="mt-3.5">
          Codex authorization did not complete. Reconnect to request a new code.
        </Notice>
      )}
      {needsAttention && <Notice tone="danger" className="mt-3.5">{humanizeCodexFailure(connection)}</Notice>}

      {connection && (
        <dl className={ui.meta}>
          <div className={ui.metaItem}><dt className={ui.metaTerm}>Account</dt><dd className={ui.metaValue}>{connection.accountLabel || "—"}</dd></div>
          <div className={ui.metaItem}><dt className={ui.metaTerm}>Plan</dt><dd className={ui.metaValue}>{connection.planLabel || "—"}</dd></div>
          <div className={ui.metaItem}><dt className={ui.metaTerm}>Last verified</dt><dd className={ui.metaValue}>{formatDate(connection.lastVerifiedAt)}</dd></div>
          <div className={ui.metaItem}><dt className={ui.metaTerm}>Authentication</dt><dd className={ui.metaValue}>ChatGPT device authorization</dd></div>
        </dl>
      )}

      <div className={ui.boundary}>
        <span className={ui.boundaryLabel}>Credential boundary</span>
        <ul className={ui.boundaryList}>
          <li className={ui.boundaryItem}><strong className={ui.boundaryName}>ChatGPT subscription</strong><small className={ui.boundaryNote}>native Codex store</small></li>
          <li className={ui.boundaryItem}><strong className={ui.boundaryName}>Web application</strong><small className={ui.boundaryNote}>no token access</small></li>
        </ul>
      </div>

      <div className={ui.actions}>
        {connected ? (
          <>
            <Button
              variant="secondary" size="sm"
              onClick={() => requestAction("codex_verify")}
              disabled={Boolean(busy || connection.requestedAction)}
            >
              {connection.requestedAction === "verify" ? "Verifying…" : "Verify"}
            </Button>
            <Button
              variant="secondary" size="sm"
              onClick={() => connect("codex_reconnect")}
              disabled={Boolean(busy || connection.requestedAction)}
            >
              {busy === "codex_reconnect" ? "Starting…" : "Reconnect"}
            </Button>
            <button
              className={dangerOutlineClasses}
              onClick={() => requestAction("codex_disconnect")}
              disabled={Boolean(busy || connection.requestedAction)}
            >
              {connection.requestedAction === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </>
        ) : (
          <Button
            size="sm"
            onClick={() => connect(connection ? "codex_reconnect" : "codex_connect")}
            disabled={Boolean(busy || login?.status === "pending")}
          >
            {login?.status === "pending" ? "Waiting for authorization…" : "Connect Codex"}
          </Button>
        )}
      </div>

      <p className={ui.footnote}>
        ChatGPT tokens remain under the isolated codex-worker account on the VPS and are never stored in PostgreSQL.
      </p>
    </Card>
  );
}
