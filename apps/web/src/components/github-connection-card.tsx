"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, TextInput } from "@agentic/design-system";
import { connection as ui, connectionTone } from "@/components/ui/connection-card";
import { dangerOutlineClasses } from "@/components/ui/danger-button";
import { Notice } from "@/components/ui/notice";
import {
  connectionStatusLabel,
  isGitHubVerifying,
  humanizeConnectionFailure,
  type GitHubConnection,
} from "@/lib/github-connections-shared";

export type GitHubAppSummary = { source: "env" | "panel"; slug: string; ownerLogin: string; htmlUrl: string } | null;
export type GitHubAppManifestSummary = { status: string; failureMessage: string } | null;

type OAuthStatus = {
  codeId: string;
  status: "pending" | "exchanging" | "completed" | "failed" | "expired";
  installationId: string;
  failureCode: string;
  failureMessage: string;
} | null;

// What the App asks for (the manifest, Stage 12 G1): contents and pull
// requests to write, because a publish pushes a branch and opens its PR.
const PERMISSIONS = [
  { key: "metadata", label: "Repository metadata", level: "read-only" },
  { key: "contents", label: "Repository contents", level: "read and write" },
  { key: "pull_requests", label: "Pull requests", level: "read and write" },
];

function formatDate(value: string) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
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
  if (!response.ok || !data.ok) throw new Error(data.error ?? "GitHub action failed");
  return data.result as Record<string, unknown>;
}

// GitHub's "Create GitHub App" page takes the manifest as a form post, not a
// link: the page builds the form and submits it.
function postManifest(postUrl: string, manifest: string) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = postUrl;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = manifest;
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

export function GitHubConnectionCard({
  connections,
  notice,
  operatorDisplayName,
  app,
  manifest,
}: {
  connections: GitHubConnection[];
  notice?: string;
  operatorDisplayName: string;
  app: GitHubAppSummary;
  manifest: GitHubAppManifestSummary;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [oauthStatus, setOAuthStatus] = useState<OAuthStatus>(null);
  const [organization, setOrganization] = useState("");
  const [appManifest, setAppManifest] = useState<GitHubAppManifestSummary>(manifest);

  // Back from "Create GitHub App": the broker converts GitHub's code into the
  // App within a cycle; once it has, installing it is the next step, so the
  // page goes on to GitHub's installation page by itself.
  useEffect(() => {
    if (notice !== "app_creating") return;
    let cancelled = false;
    let done = false;
    const poll = async () => {
      if (cancelled || done) return;
      try {
        const data = await (await fetch("/api/control-plane/github/status", { cache: "no-store" })).json();
        if (cancelled || !data.ok) return;
        setAppManifest(data.manifest ? { status: String(data.manifest.status), failureMessage: String(data.manifest.failureMessage ?? "") } : null);
        if (data.app) {
          done = true;
          const result = await postAction({ kind: "github_install" });
          if (typeof result.install_url === "string") window.location.href = result.install_url;
        } else if (data.manifest && ["failed", "expired"].includes(String(data.manifest.status))) {
          done = true;
          window.history.replaceState({}, "", window.location.pathname);
        }
      } catch { /* keep polling */ }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [notice]);

  // Back from changing the App's repository access: read them again.
  useEffect(() => {
    if (notice !== "updated") return;
    const connected = connections.find((connection) => connection.status === "connected");
    window.history.replaceState({}, "", window.location.pathname);
    if (!connected) return;
    postAction({ kind: "github_verify", connectionId: connected.connectionId }).then(() => router.refresh(), () => undefined);
  }, [notice, connections, router]);

  useEffect(() => {
    if (notice !== "connecting") return;
    let cancelled = false;
    let refreshScheduled = false;
    const poll = async () => {
      if (cancelled || refreshScheduled) return;
      try {
        const response = await fetch("/api/control-plane/github/status", { cache: "no-store" });
        const data = await response.json();
        if (cancelled) return;
        if (!data.ok) return;
        const next: OAuthStatus = data.status;
        setOAuthStatus(next);
        if (next && !["pending", "exchanging"].includes(next.status) && !refreshScheduled) {
          refreshScheduled = true;
          window.history.replaceState({}, "", window.location.pathname);
          setTimeout(() => router.refresh(), 50);
        }
      } catch { /* keep previous */ }
    };
    poll();
    const interval = setInterval(() => { if (!refreshScheduled) poll(); }, 4000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [notice, router]);

  const primary = connections[0];
  const hasConnected = connections.some((connection) => connection.status === "connected");
  const verifying = isGitHubVerifying(primary);
  const needsAttention = primary && ["action_required", "expired"].includes(primary.status) && !verifying;
  const oauthFailure = oauthStatus?.status === "failed" || oauthStatus?.status === "expired";

  async function createApp() {
    setBusy("github_app_create");
    setError("");
    try {
      const result = await postAction({ kind: "github_app_create", organization: organization.trim() });
      if (typeof result.post_url === "string" && typeof result.manifest === "string") postManifest(result.post_url, result.manifest);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The GitHub App could not be started");
      setBusy("");
    }
  }

  async function beginConnect(kind: "github_connect" | "github_reconnect" | "github_install") {
    setBusy(kind);
    setError("");
    try {
      const result = await postAction({ kind });
      const installUrl = typeof result.install_url === "string" ? result.install_url : "";
      if (installUrl) window.location.href = installUrl;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GitHub connection could not start");
    } finally {
      setBusy("");
    }
  }

  async function verify() {
    if (!primary) return;
    setBusy("github_verify");
    setError("");
    try {
      await postAction({ kind: "github_verify", connectionId: primary.connectionId });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GitHub verification could not be requested");
    } finally {
      setBusy("");
    }
  }

  async function disconnect() {
    if (!primary) return;
    if (!window.confirm("Disconnect the GitHub App connection? New private clones will fail until you reconnect. Existing workspaces and history remain readable.")) return;
    setBusy("github_disconnect");
    setError("");
    try {
      await postAction({ kind: "github_disconnect", connectionId: primary.connectionId });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GitHub disconnect failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <Card as="section" className="min-w-0">
      <div className={ui.heading}>
        <div>
          <p className="type-eyebrow text-muted">SOURCE CONTROL</p>
          <h2 className="type-section-title mt-1.5">GitHub</h2>
          <p className={ui.owner}>Signed in as {operatorDisplayName}. GitHub is a connected provider account, not a login method.</p>
        </div>
        <Badge tone={verifying ? "info" : connectionTone(primary?.status)} className="shrink-0">
          {verifying ? "Verifying" : primary ? connectionStatusLabel(primary) : "Disconnected"}
        </Badge>
      </div>

      {notice === "connecting" && (
        <Notice tone="info" className="mt-3.5">
          Verifying the GitHub App installation. This requires GitHub user authorization, which runs inside the VPS broker
          {oauthStatus ? ` (installation ${oauthStatus.installationId || "—"})` : ""}.
        </Notice>
      )}
      {oauthFailure && (
        <Notice tone="danger" className="mt-3.5">
          GitHub connection failed. {oauthStatus?.failureMessage || "Please reconnect."}
        </Notice>
      )}
      {notice === "error" && !oauthFailure && (
        <Notice tone="danger" className="mt-3.5">GitHub connection failed. Reconnect and try again. If the installation was removed on GitHub, choose a new installation.</Notice>
      )}
      {notice === "app_creating" && !["failed", "expired"].includes(appManifest?.status ?? "") && (
        <Notice tone="info" className="mt-3.5">GitHub created the App. The host is taking over its key; installing it comes next.</Notice>
      )}
      {(notice === "app_error" || (!app && ["failed", "expired"].includes(appManifest?.status ?? ""))) && (
        <Notice tone="danger" className="mt-3.5">The GitHub App could not be created. {appManifest?.failureMessage || "Try again."}</Notice>
      )}
      {error && <Notice tone="danger" className="mt-3.5">{error}</Notice>}
      {primary?.status === "pending_finalize" && (
        <Notice tone="info" className="mt-3.5">Verifying the GitHub App installation and listing accessible repositories…</Notice>
      )}
      {verifying && <Notice tone="info" className="mt-3.5">Verifying the installation and reading its repositories again. This takes up to a minute.</Notice>}
      {needsAttention && <Notice tone="danger" className="mt-3.5">{humanizeConnectionFailure(primary)}</Notice>}

      {primary && (
        <dl className={ui.meta}>
          <div className={ui.metaItem}><dt className={ui.metaTerm}>Account</dt><dd className={ui.metaValue}>{primary.accountLabel || "—"}</dd></div>
          <div className={ui.metaItem}><dt className={ui.metaTerm}>Installation</dt><dd className={ui.metaValue}>{primary.installationLabel || "—"}</dd></div>
          <div className={ui.metaItem}><dt className={ui.metaTerm}>Last verified</dt><dd className={ui.metaValue}>{formatDate(primary.lastVerifiedAt)}</dd></div>
          <div className={ui.metaItem}><dt className={ui.metaTerm}>Repository selection</dt><dd className={ui.metaValue}>{primary.repositorySelection || "—"}</dd></div>
        </dl>
      )}

      <div className={ui.boundary}>
        <span className={ui.boundaryLabel}>Permissions</span>
        <ul className={ui.boundaryList}>
          {PERMISSIONS.map((permission) => (
            <li key={permission.key} className={ui.boundaryItem}>
              <strong className={ui.boundaryName}>{permission.label}</strong>
              <small className={ui.boundaryNote}>{permission.level}</small>
            </li>
          ))}
        </ul>
      </div>

      {!app && (
        <div className="mt-4 grid gap-2">
          <p className="type-meta text-muted">
            This panel has no GitHub App yet. Create one from here: GitHub asks you to confirm, and the host keeps its key.
            For repositories of an organization, name it — the App is then the organization&apos;s.
          </p>
          <label className="type-meta grid gap-1.5 font-medium"><span>Organization <small className="font-normal text-muted">optional</small></span>
            <TextInput value={organization} onChange={(event) => setOrganization(event.target.value)} placeholder="your personal account" autoComplete="off" disabled={Boolean(busy)}/>
          </label>
        </div>
      )}
      {app && !primary && (
        <p className="type-meta mt-4 text-muted">
          Install the App on GitHub and choose <strong className="font-medium text-ink">All repositories</strong>, so every repository you have — and the ones you make later — can be picked for a project.
        </p>
      )}

      <div className={ui.actions}>
        {!app ? (
          <Button size="sm" onClick={createApp} disabled={Boolean(busy)}>
            {busy === "github_app_create" ? "Opening GitHub…" : "Create GitHub App"}
          </Button>
        ) : hasConnected ? (
          <>
            <Button variant="secondary" size="sm" onClick={verify} disabled={Boolean(busy)}>
              {busy === "github_verify" ? "Verifying…" : "Verify"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => beginConnect("github_install")} disabled={Boolean(busy)}>
              {busy === "github_install" ? "Opening GitHub…" : "Repository access"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => beginConnect("github_reconnect")} disabled={Boolean(busy)}>
              {busy === "github_reconnect" ? "Opening GitHub…" : "Reconnect"}
            </Button>
            <button className={dangerOutlineClasses} onClick={disconnect} disabled={Boolean(busy)}>
              {busy === "github_disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </>
        ) : (
          <>
            <Button size="sm" onClick={() => beginConnect("github_install")} disabled={Boolean(busy)}>
              {busy === "github_install" ? "Opening GitHub…" : "Install on GitHub"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => beginConnect("github_connect")} disabled={Boolean(busy)}>
              {busy === "github_connect" ? "Opening GitHub…" : "Already installed? Connect"}
            </Button>
          </>
        )}
      </div>

      <p className={ui.footnote}>
        Installation tokens are minted on the VPS only for the moment of clone and are never stored in the database, events or logs.
      </p>
    </Card>
  );
}
