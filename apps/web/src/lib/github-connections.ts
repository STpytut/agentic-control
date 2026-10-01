import { randomBytes, createCipheriv, createHash } from "node:crypto";
import { queryJsonRows } from "@/lib/database";
import type { GitHubConnection, GitHubRepository } from "@/lib/github-connections-shared";

export type { GitHubConnection, GitHubRepository, GitHubConnectionStatus } from "@/lib/github-connections-shared";

export function generateLoginState() {
  return randomBytes(32).toString("hex");
}

export function stateDigest(state: string) {
  return createHash("sha256").update(String(state)).digest("hex");
}

function oauthCodeEncryptionKey() {
  const encoded = process.env.GITHUB_OAUTH_CODE_ENCRYPTION_KEY?.trim() ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(encoded)) {
    throw new Error("GITHUB_OAUTH_CODE_ENCRYPTION_KEY must be a 64-character hex value");
  }
  return Buffer.from(encoded, "hex");
}

export function encryptGitHubOAuthCode(code: string) {
  if (!code) throw new Error("GitHub OAuth authorization code is missing");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", oauthCodeEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

// A slug as GitHub spells it; an App's URL is read as its last segment (the
// host's env had https://github.com/apps/infra-cod where the slug belongs).
// The broker's twin is github-app-config.mjs normaliseSlug.
export function normaliseSlug(value: string | undefined | null) {
  const text = String(value ?? "").trim().replace(/\/+$/, "");
  const slug = text.includes("/") ? text.slice(text.lastIndexOf("/") + 1) : text;
  return /^[a-z0-9][a-z0-9-]{0,99}$/.test(slug) ? slug : "";
}

export type GitHubAppConfig = {
  source: "env" | "panel";
  slug: string;
  clientId: string;
  ownerLogin: string;
  htmlUrl: string;
} | null;

// The App the panel works with (Stage 12 G1): the one an operator configured
// by hand in web.env, else the one the settings page created (0125). Only its
// public fields: the web never holds the App's key or client secret.
export async function getGitHubAppConfig(): Promise<GitHubAppConfig> {
  const envSlug = normaliseSlug(process.env.GITHUB_APP_SLUG);
  const envClientId = process.env.GITHUB_APP_CLIENT_ID?.trim() ?? "";
  if (envSlug && envClientId) return { source: "env", slug: envSlug, clientId: envClientId, ownerLogin: "", htmlUrl: `https://github.com/apps/${envSlug}` };
  const rows = await queryJsonRows(`SELECT github_app_registration()::text;`, {});
  const row = rows.at(-1) as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== "object" || !row.slug) return null;
  const slug = normaliseSlug(String(row.slug));
  if (!slug) return null;
  return { source: "panel", slug, clientId: String(row.client_id ?? ""), ownerLogin: String(row.owner_login ?? ""),
    htmlUrl: String(row.html_url ?? `https://github.com/apps/${slug}`) };
}

export function buildGitHubInstallUrl(state: string, slug: string) {
  if (!slug) throw new Error("GitHub App is not configured");
  const base = `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}

// The manifest GitHub's "Create GitHub App" page is posted (Stage 12 G1):
// everything OPERATIONS.md used to ask for by hand. Private, so only its owner
// can install it; OAuth on install, so the broker can check an installation
// belongs to whoever connects it; writing contents and pull requests, which a
// publish needs. No webhook: nothing here listens for one.
export function buildGitHubAppManifest(siteUrl: string) {
  const origin = siteUrl.replace(/\/$/, "");
  const host = new URL(origin).hostname;
  const callback = `${origin}/api/control-plane/github/callback`;
  return {
    name: `infra-cod ${host}`.slice(0, 34),
    url: origin,
    redirect_url: `${origin}/api/control-plane/github/app-manifest`,
    callback_urls: [callback],
    setup_url: callback,
    setup_on_update: true,
    request_oauth_on_install: true,
    public: false,
    // issues: GitHub issues become chats (0132) and, from I2, hear back.
    default_permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
    default_events: [],
  };
}

export function gitHubAppCreationUrl(state: string, organization: string) {
  const path = organization
    ? `/organizations/${encodeURIComponent(organization)}/settings/apps/new`
    : "/settings/apps/new";
  return `https://github.com${path}?state=${encodeURIComponent(state)}`;
}

export type GitHubAppManifestStatus = {
  manifestId: string;
  status: "started" | "pending" | "converting" | "registered" | "failed" | "expired";
  slug: string;
  failureMessage: string;
} | null;

export async function getGitHubAppManifestStatus(operatorId: string): Promise<GitHubAppManifestStatus> {
  const rows = await queryJsonRows(`SELECT get_github_app_manifest_status(:'operator_id'::uuid)::text;`, { operator_id: operatorId });
  const row = rows.at(-1) as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== "object" || !row.manifest_id) return null;
  return { manifestId: String(row.manifest_id), status: String(row.status) as NonNullable<GitHubAppManifestStatus>["status"],
    slug: String(row.slug ?? ""), failureMessage: String(row.failure_message ?? "") };
}

export function buildGitHubAuthorizationUrl(state: string, clientId: string) {
  if (!clientId) throw new Error("GitHub App OAuth is not configured");
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("state", state);
  return url.toString();
}

function rowToConnection(row: Record<string, unknown>): GitHubConnection {
  return {
    connectionId: String(row.connection_id ?? ""),
    status: String(row.status ?? "action_required") as GitHubConnection["status"],
    accountLabel: String(row.account_label ?? ""),
    installationLabel: String(row.installation_label ?? ""),
    repositorySelection: String(row.repository_selection ?? ""),
    permissions: (row.permissions ?? {}) as Record<string, string>,
    lastVerifiedAt: String(row.last_verified_at ?? ""),
    verifyRequestedAt: String(row.verify_requested_at ?? ""),
    lastFailureCode: String(row.last_failure_code ?? ""),
    lastFailureMessage: String(row.last_failure_message ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function rowToRepository(row: Record<string, unknown>): GitHubRepository {
  return {
    connectionId: String(row.connection_id ?? ""),
    githubRepositoryId: String(row.github_repository_id ?? ""),
    fullName: String(row.full_name ?? ""),
    private: Boolean(row.private),
    archived: Boolean(row.archived),
    defaultBranch: String(row.default_branch ?? "main"),
    cloneUrl: String(row.clone_url ?? ""),
    verifiedAt: String(row.verified_at ?? ""),
  };
}

export async function getOperatorGitHubConnections(operatorId: string): Promise<GitHubConnection[]> {
  const rows = await queryJsonRows(
    `SELECT get_operator_github_connections(:'operator_id'::uuid)::text;`,
    { operator_id: operatorId },
  );
  const list = rows.at(-1);
  if (!list || !Array.isArray(list)) return [];
  return (list as Record<string, unknown>[]).map(rowToConnection);
}

export async function getActiveGitHubConnection(operatorId: string): Promise<GitHubConnection | null> {
  const connections = await getOperatorGitHubConnections(operatorId);
  return connections.find((connection) => connection.status === "connected") ?? null;
}

export type GitHubOAuthStatusCode = "pending" | "exchanging" | "completed" | "failed" | "expired";

export type GitHubOAuthStatus = {
  codeId: string;
  status: GitHubOAuthStatusCode;
  installationId: string;
  setupAction: string;
  failureCode: string;
  failureMessage: string;
  createdAt: string;
} | null;

export async function getOperatorGitHubOAuthStatus(operatorId: string): Promise<GitHubOAuthStatus> {
  const rows = await queryJsonRows(
    `SELECT get_operator_github_oauth_status(:'operator_id'::uuid)::text;`,
    { operator_id: operatorId },
  );
  const row = rows.at(-1);
  if (!row || typeof row !== "object" || !("code_id" in (row as object))) return null;
  const data = row as Record<string, unknown>;
  return {
    codeId: String(data.code_id ?? ""),
    status: (String(data.status ?? "pending") as GitHubOAuthStatusCode),
    installationId: String(data.installation_id ?? ""),
    setupAction: String(data.setup_action ?? ""),
    failureCode: String(data.failure_code ?? ""),
    failureMessage: String(data.failure_message ?? ""),
    createdAt: String(data.created_at ?? ""),
  };
}

export async function listOperatorGitHubRepositories(
  operatorId: string,
  connectionId: string | null,
  search: string,
): Promise<GitHubRepository[]> {
  const rows = await queryJsonRows(
    `SELECT list_operator_github_repositories(:'operator_id'::uuid,NULLIF(:'connection_id','')::uuid,:'search',100)::text;`,
    { operator_id: operatorId, connection_id: connectionId ?? "", search: search ?? "" },
  );
  const list = rows.at(-1);
  if (!list || !Array.isArray(list)) return [];
  return (list as Record<string, unknown>[]).map(rowToRepository);
}
