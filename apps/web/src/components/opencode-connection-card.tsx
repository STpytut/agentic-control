"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  humanizeOpenCodeFailure,
  OPENCODE_KEY_PROVIDERS,
  opencodeConnectionStatusLabel,
  opencodeProviderLabel,
  type OpenCodeConnection,
  type OpenCodeEnrollmentStatus,
} from "@/lib/opencode-connections-shared";
import { encryptOpenCodeApiKey } from "@/lib/opencode-crypto";
import { Badge, Button, Card, controlClasses, cx } from "@agentic/design-system";
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
  if (!response.ok || !data.ok) throw new Error(data.error ?? "OpenCode action failed");
  return data.result as Record<string, unknown>;
}

async function fetchBrokerKey() {
  const response = await fetch("/api/control-plane/opencode/broker-key", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error ?? "OpenCode broker key is unavailable");
  return String(data.publicKey);
}

type KeyGateway = (typeof OPENCODE_KEY_PROVIDERS)[number]["gateway"];

// OpenCode Free is the baseline; Go and OpenRouter are API-key providers
// added beside it, each its own connection with its own key, status and
// actions. The card reports what is in effect: a connected paid provider if
// there is one, else Free.
//
// It used to read every row off Go alone. With a failed Go enrollment and a
// working Free connection — where an operator lands after letting a Go
// subscription lapse — the card announced ACTION REQUIRED, plan "Go", account
// "—" and last verified "—", while the executor was connected, verified and
// running. Each provider's trouble is now reported as that provider's.
export function OpenCodeConnectionCard({
  initialFree,
  initialGo,
  initialOpenRouter,
  initialEnrollment,
  operatorDisplayName,
}: {
  initialFree: OpenCodeConnection | null;
  initialGo: OpenCodeConnection | null;
  initialOpenRouter: OpenCodeConnection | null;
  initialEnrollment: OpenCodeEnrollmentStatus;
  operatorDisplayName: string;
}) {
  const [free, setFree] = useState(initialFree);
  const [keyed, setKeyed] = useState<Record<KeyGateway, OpenCodeConnection | null>>({
    opencode_go: initialGo, openrouter: initialOpenRouter,
  });
  const [enrollment, setEnrollment] = useState(initialEnrollment);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const apiKeyRef = useRef<HTMLInputElement>(null);

  const poll = useCallback(async () => {
    const response = await fetch("/api/control-plane/opencode/status", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) return;
    setFree(data.free as OpenCodeConnection | null);
    setKeyed({ opencode_go: data.go as OpenCodeConnection | null, openrouter: data.openrouter as OpenCodeConnection | null });
    setEnrollment(data.enrollment as OpenCodeEnrollmentStatus);
  }, []);

  const connections = Object.values(keyed).filter((item): item is OpenCodeConnection => Boolean(item));
  const enrollmentActive = Boolean(enrollment && ["pending", "provisioned", "claimed"].includes(enrollment.status));
  const shouldPoll = enrollmentActive
    || connections.some((item) => item.status === "pending_finalize" || Boolean(item.requestedAction));

  useEffect(() => {
    if (!shouldPoll) return;
    const initialPoll = window.setTimeout(() => void poll(), 0);
    const interval = window.setInterval(() => void poll(), 2500);
    return () => {
      window.clearTimeout(initialPoll);
      window.clearInterval(interval);
    };
  }, [poll, shouldPoll]);

  async function startEnrollment(kind: "opencode_connect" | "opencode_reconnect", gateway: KeyGateway) {
    setBusy(`${kind}:${gateway}`);
    setError("");
    try {
      const result = await postAction({ kind, accessGateway: gateway });
      await poll();
      if (!result.enrollment_id) throw new Error("Enrollment did not start");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${opencodeProviderLabel(gateway)} enrollment could not start`);
    } finally {
      setBusy("");
    }
  }

  const enrollingLabel = opencodeProviderLabel(enrollment?.accessGateway ?? "opencode_go");

  async function installKey() {
    const apiKey = apiKeyRef.current?.value.trim() ?? "";
    if (!enrollment || !apiKey) {
      setError(`Enter the ${enrollingLabel} API key`);
      return;
    }
    setBusy("install");
    setError("");
    try {
      const publicKey = await fetchBrokerKey();
      const envelope = await encryptOpenCodeApiKey(apiKey, publicKey);
      await postAction({
        kind: "opencode_store_enrollment",
        enrollmentId: enrollment.enrollmentId,
        ciphertext: envelope.ciphertext,
        iv: envelope.iv,
        tag: envelope.tag,
        keyWrap: envelope.keyWrap,
        keyFingerprint: "browser-v1",
      });
      if (apiKeyRef.current) apiKeyRef.current.value = "";
      await poll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `The ${enrollingLabel} key could not be installed`);
    } finally {
      setBusy("");
    }
  }

  async function requestAction(kind: "opencode_verify" | "opencode_disconnect", connection: OpenCodeConnection) {
    const label = opencodeProviderLabel(connection.accessGateway);
    if (
      kind === "opencode_disconnect"
      && !window.confirm(
        `Disconnect ${label}? New ${label} runs will fail until you reconnect. OpenCode Free remains available and existing history stays readable.`,
      )
    ) return;
    setBusy(`${kind}:${connection.accessGateway}`);
    setError("");
    try {
      await postAction({ kind, connectionId: connection.connectionId });
      await poll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${label} action failed`);
    } finally {
      setBusy("");
    }
  }

  const freeConnected = free?.status === "connected";
  const paidConnected = connections.filter((item) => item.status === "connected");
  const effective = paidConnected[0] ?? (freeConnected ? free : null);

  return (
    <Card as="section" className="min-w-0">
      <div className={ui.heading}>
        <div>
          <p className="type-eyebrow text-muted">RUNTIME</p>
          <h2 className="type-section-title mt-1.5">OpenCode</h2>
          <p className={ui.owner}>
            Signed in as {operatorDisplayName}. OpenCode Free is always available; Go and OpenRouter add paid models.
          </p>
        </div>
        <Badge tone={connectionTone(effective?.status)} className="shrink-0">
          {effective ? opencodeConnectionStatusLabel(effective) : "Available"}
        </Badge>
      </div>

      {error && !enrollmentActive && <Notice tone="danger" className="mt-3.5" role="alert">{error}</Notice>}
      {connections.filter((item) => ["action_required", "expired"].includes(item.status)).map((item) => (
        <Notice key={item.connectionId} tone={freeConnected ? "info" : "danger"} className="mt-3.5">
          {freeConnected
            ? `${opencodeProviderLabel(item.accessGateway)}: ${humanizeOpenCodeFailure(item)} Free remains connected and available.`
            : humanizeOpenCodeFailure(item)}
        </Notice>
      ))}

      <dl className={ui.meta}>
        <div className={ui.metaItem}><dt className={ui.metaTerm}>Plan</dt><dd className={ui.metaValue}>{paidConnected.length ? paidConnected.map((item) => opencodeProviderLabel(item.accessGateway)).join(" · ") : "Free"}</dd></div>
        <div className={ui.metaItem}><dt className={ui.metaTerm}>Account</dt><dd className={ui.metaValue}>{effective?.accountLabel || "—"}</dd></div>
        <div className={ui.metaItem}><dt className={ui.metaTerm}>Last verified</dt><dd className={ui.metaValue}>{effective ? formatDate(effective.lastVerifiedAt) : "—"}</dd></div>
        <div className={ui.metaItem}><dt className={ui.metaTerm}>Authentication</dt><dd className={ui.metaValue}>Free: builtin · Go, OpenRouter: API key (VPS broker)</dd></div>
      </dl>

      <div className={ui.boundary}>
        <span className={ui.boundaryLabel}>Credential boundary</span>
        <ul className={ui.boundaryList}>
          <li className={ui.boundaryItem}>
            <strong className={ui.boundaryName}>OpenCode Free</strong>
            <small className={ui.boundaryNote}>{free ? opencodeConnectionStatusLabel(free) : "available without a paid connection"}</small>
          </li>
          {OPENCODE_KEY_PROVIDERS.map((provider) => (
            <li key={provider.gateway} className={ui.boundaryItem}>
              <strong className={cx(ui.boundaryName, "shrink-0")}>{provider.label}</strong>
              <small className={ui.boundaryNote}>{keyed[provider.gateway] ? opencodeConnectionStatusLabel(keyed[provider.gateway] as OpenCodeConnection) : `${provider.note}; key encrypted in-browser, decrypted on the VPS broker`}</small>
            </li>
          ))}
        </ul>
      </div>

      {enrollmentActive && (
        <Notice tone="info" className="mt-3.5 grid gap-2">
          <strong className="font-medium">{enrollment?.status === "pending" ? `Waiting for the ${enrollingLabel} API key` : `Installing the ${enrollingLabel} key…`}</strong>
          {enrollment?.status === "pending" && (
            <>
              <p className="m-0">The key is encrypted in your browser and decrypted only on the VPS broker.</p>
              <div className="grid gap-2">
                <input
                  className={cx(controlClasses(), "h-10")}
                  type="password"
                  autoComplete="off"
                  placeholder={`${enrollingLabel} API key`}
                  aria-label={`${enrollingLabel} API key`}
                  ref={apiKeyRef}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void installKey();
                  }}
                />
                <Button size="sm" className="justify-self-start" type="button" onClick={() => void installKey()} disabled={Boolean(busy)}>
                  {busy === "install" ? "Encrypting…" : "Install key"}
                </Button>
                {error && <Notice tone="danger" role="alert">{error}</Notice>}
              </div>
            </>
          )}
          <small className="text-muted">Enrollment expires {formatDate(enrollment?.expiresAt ?? "")} UTC</small>
        </Notice>
      )}
      {enrollment?.status === "completed" && keyed[enrollment.accessGateway]?.status === "connected" && (
        <Notice tone="info" className="mt-3.5">{enrollingLabel} is connected and verified.</Notice>
      )}

      {OPENCODE_KEY_PROVIDERS.map((provider) => {
        const connection = keyed[provider.gateway];
        const connected = connection?.status === "connected";
        return (
          <div className={ui.actions} key={provider.gateway}>
            {connected && connection ? (
              <>
                <span className={cx(ui.boundaryLabel, "basis-full")}>{provider.label}</span>
                <Button variant="secondary" size="sm" onClick={() => requestAction("opencode_verify", connection)}
                  disabled={Boolean(busy || connection.requestedAction)}>
                  {connection.requestedAction === "verify" ? "Verifying…" : "Verify"}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => startEnrollment("opencode_reconnect", provider.gateway)}
                  disabled={Boolean(busy || connection.requestedAction || enrollmentActive)}>
                  {busy === `opencode_reconnect:${provider.gateway}` ? "Starting…" : "Reconnect"}
                </Button>
                <button className={dangerOutlineClasses} onClick={() => requestAction("opencode_disconnect", connection)}
                  disabled={Boolean(busy || connection.requestedAction)}>
                  {connection.requestedAction === "disconnect" ? "Disconnecting…" : "Disconnect"}
                </button>
              </>
            ) : (
              <Button size="sm" onClick={() => startEnrollment(connection ? "opencode_reconnect" : "opencode_connect", provider.gateway)}
                disabled={Boolean(busy || enrollmentActive)}>
                {busy.endsWith(`:${provider.gateway}`) ? "Starting…" : `Connect ${provider.label}`}
              </Button>
            )}
          </div>
        );
      })}

      <p className={ui.footnote}>
        An API key is encrypted with the VPS broker public key in your browser and never reaches PostgreSQL, events or logs.
      </p>
      <p className={ui.footnote}>
        <a className="inline-flex min-h-8 items-center font-medium underline underline-offset-2" href="/opencode-enroll">Open isolated enrollment screen</a> (OpenCode Go)
      </p>
    </Card>
  );
}
