// GitHub App credential-broker client.
//
// This module runs only inside the trusted VPS control-plane broker. It mints
// short-lived GitHub App JSON Web Tokens and installation access tokens, and
// performs the minimal read-only repository metadata calls required for
// connection verification and clone. Installation tokens are never written to
// the database, never placed in a remote URL, and never returned to the web
// layer. Every thrown error and log line is sanitized so tokens, JWTs and raw
// HTTP headers cannot leak.

import { createDecipheriv, createSign, randomBytes } from "node:crypto";

const DEFAULT_API_VERSION = "2022-11-28";
const GITHUB_API = "https://api.github.com";

export class GithubAppError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "GithubAppError";
    this.code = code;
    this.status = status;
  }
}

// Build a list of secret substrings to scrub from any human-readable output.
// The token itself, the JWT, and common Authorization header forms are all
// covered so a leaked string cannot survive redaction.
export function secretPatternsFor({ jwt, installationToken }) {
  const patterns = [];
  if (jwt) patterns.push(jwt);
  if (installationToken) patterns.push(installationToken);
  return patterns.filter(Boolean);
}

// Replace every occurrence of each secret with [REDACTED]. Also strips common
// HTTP authorization header forms so a raw `Authorization: Bearer <token>`
// string is neutralized even if the token substring itself was truncated.
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? "");
  out = out.replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi, "Authorization: [REDACTED]");
  out = out.replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, "Authorization: [REDACTED]");
  out = out.replace(/https:\/\/[A-Za-z0-9._-]+@github\.com/gi, "https://[REDACTED]@github.com");
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

// Map a GitHub API failure to a normalized, actionable code + safe message.
// Raw response bodies and headers are never surfaced to the operator.
export function normalizeGithubError(status, detail, secrets = []) {
  const cleaned = redactSecrets(detail, secrets).slice(0, 300);
  if (status === 401) return { code: "bad_credentials", message: "GitHub rejected the App credentials. Verify the private key and App ID." };
  if (status === 403) return { code: "forbidden", message: "GitHub denied access to this installation. Check the App permissions and repository selection." };
  if (status === 404) return { code: "installation_not_found", message: "The GitHub App installation was not found. It may have been removed." };
  // What GitHub said, not a guess: this read "rejected the installation token
  // request" for every 422, and the pull request of an empty repository —
  // refused for its missing base — looked like lost access (battle test).
  if (status === 422) return { code: "validation_failed", message: `GitHub refused the request as invalid: ${cleaned || "no detail"}.` };
  if (status === 429 || status === 503) return { code: "github_unavailable", message: "GitHub is temporarily unavailable. Try again." };
  if (status >= 500) return { code: "github_unavailable", message: "GitHub is temporarily unavailable. Try again." };
  return { code: "github_error", message: `GitHub returned an unexpected response (status ${status}).` , detail: cleaned };
}

// Canonical https clone URL without any embedded credential. Used both to
// sanitize a remote origin after clone and to reject URLs that smuggle a token.
export function sanitizeCloneUrl(url) {
  if (typeof url !== "string" || url.length === 0) return "";
  const match = url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match) return "";
  return `https://github.com/${match[1]}/${match[2]}.git`;
}

// Generate a GitHub App JWT (RS256). GitHub requires exp - iat <= 600s and
// recommends a 60s negative clock skew on iat.
export function createAppJwt({ appId, privateKeyPem }, now = Date.now()) {
  if (!appId || !privateKeyPem) throw new GithubAppError("invalid_config", "GitHub App ID and private key are required");
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + (9 * 60), iss: String(appId) };
  const base64url = (value) => Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const segment = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(segment);
  const signature = signer.sign(privateKeyPem, "base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment}.${signature}`;
}

// Parse a GitHub installation object into safe metadata. No secrets are present.
export function parseInstallation(installation) {
  const account = installation?.account ?? {};
  const login = account.login ?? "";
  const name = account.name ?? login;
  const type = installation?.target_type ?? account.type ?? "";
  return {
    installation_id: String(installation?.id ?? ""),
    external_account_id: String(account.id ?? ""),
    account_label: name && name !== login ? `${name} (${login})` : login,
    installation_label: type ? `${type} / ${login}` : login,
    repository_selection: installation?.repository_selection ?? "selected",
    permissions: installation?.permissions ?? {},
  };
}

// Convert a raw GitHub repository object into the safe cache row shape. The
// clone_url is always canonicalized so no embedded credential can be stored.
export function parseRepository(repo, verifiedAt) {
  const cloneUrl = sanitizeCloneUrl(repo?.clone_url);
  if (!cloneUrl) return null;
  return {
    github_repository_id: String(repo?.id ?? ""),
    full_name: String(repo?.full_name ?? ""),
    private: Boolean(repo?.private),
    archived: Boolean(repo?.archived),
    default_branch: String(repo?.default_branch ?? "main"),
    clone_url: cloneUrl,
    verified_at: verifiedAt,
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

// Low-level GitHub API call with redaction. The Authorization header is never
// logged; errors carry only a normalized code + safe message.
async function githubRequest(pathname, { method = "GET", bearer, body, apiVersion = DEFAULT_API_VERSION, fetchImpl = fetch, secrets = [] } = {}) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": apiVersion,
  };
  // Without a bearer for a public read (the App's bot user): an App's JWT is
  // accepted only by the /app endpoints.
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  let response;
  try {
    response = await fetchImpl(`${GITHUB_API}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw new GithubAppError("network_error", redactSecrets(cause?.message ?? "GitHub network request failed", secrets));
  }
  const payload = await readJson(response);
  if (!response.ok) {
    const errors = Array.isArray(payload?.errors)
      ? payload.errors.map((item) => [item?.field, item?.code, item?.message].filter(Boolean).join(" ")).filter(Boolean) : [];
    const detail = [payload?.message ? String(payload.message) : JSON.stringify(payload), ...errors].join("; ");
    const normalized = normalizeGithubError(response.status, detail, secrets);
    throw new GithubAppError(normalized.code, normalized.message, response.status);
  }
  return payload;
}

export async function getInstallation({ appId, privateKeyPem, installationId, fetchImpl = fetch }) {
  const jwt = createAppJwt({ appId, privateKeyPem });
  const installation = await githubRequest(`/app/installations/${installationId}`, { bearer: jwt, fetchImpl, secrets: [jwt] });
  return parseInstallation(installation);
}

// GitHub's manifest flow (0125): the one-hour code GitHub hands back after the
// owner pressed Create converts, once and without credentials, into the App —
// its id, slug and client id, and its client secret and private key.
export async function convertManifestCode({ code, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(String(code ?? ""))) throw new GithubAppError("invalid_config", "The GitHub App manifest code is malformed.");
  const app = await githubRequest(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST", fetchImpl, secrets: [code] });
  const id = Number(app?.id);
  const slug = String(app?.slug ?? "");
  if (!Number.isSafeInteger(id) || id <= 0 || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug) || !app?.client_id || !app?.client_secret || !app?.pem) {
    throw new GithubAppError("github_error", "GitHub's answer to the App manifest is incomplete.");
  }
  return {
    appId: id, slug, clientId: String(app.client_id), clientSecret: String(app.client_secret), pem: String(app.pem),
    ownerLogin: String(app.owner?.login ?? ""), htmlUrl: /^https:\/\/github\.com\//.test(String(app.html_url ?? "")) ? String(app.html_url) : null,
  };
}

// Who the App commits as (0124): `<slug>[bot]`, whose noreply address GitHub
// links to the App. GET /app names the slug; the bot is a public user.
export async function getAppIdentity({ appId, privateKeyPem, fetchImpl = fetch }) {
  const jwt = createAppJwt({ appId, privateKeyPem });
  const app = await githubRequest("/app", { bearer: jwt, fetchImpl, secrets: [jwt] });
  const slug = String(app?.slug ?? "");
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) throw new GithubAppError("github_error", "GitHub returned an App without a usable slug.");
  const bot = await githubRequest(`/users/${encodeURIComponent(`${slug}[bot]`)}`, { fetchImpl });
  const botUserId = Number(bot?.id);
  if (!Number.isSafeInteger(botUserId) || botUserId <= 0 || bot?.type !== "Bot") {
    throw new GithubAppError("github_error", `GitHub has no bot user for the App ${slug}.`);
  }
  return { appId: Number(app?.id ?? appId), slug, botUserId };
}

export async function createInstallationToken({ appId, privateKeyPem, installationId, repositoryIds, permissions, fetchImpl = fetch }) {
  const jwt = createAppJwt({ appId, privateKeyPem });
  const body = {};
  if (Array.isArray(repositoryIds) && repositoryIds.length) body.repository_ids = repositoryIds.map(Number);
  body.permissions = permissions ?? { contents: "read", metadata: "read" };
  const tokenResponse = await githubRequest(`/app/installations/${installationId}/access_tokens`, {
    method: "POST", bearer: jwt, body, fetchImpl, secrets: [jwt],
  });
  const token = tokenResponse?.token ?? "";
  if (!token) throw new GithubAppError("installation_token_missing", "GitHub did not return an installation access token.");
  return { token, expires_at: tokenResponse?.expires_at ?? "" };
}

// The pull request a publish opens (sprint B P1), with the installation token
// minted for that publish. GitHub answers 422 when one is already open for the
// branch — a retry after the pull request was opened and not recorded — and
// then the open one is the answer.
function parsePullRequest(pr) {
  const number = Number(pr?.number);
  const url = String(pr?.html_url ?? "");
  if (!Number.isInteger(number) || number <= 0 || !/^https:\/\//.test(url)) {
    throw new GithubAppError("github_error", "GitHub returned a pull request without a number or URL.");
  }
  return { number, url };
}

export async function findOpenPullRequest({ installationToken, repository, head, fetchImpl = fetch, secrets = [] }) {
  const owner = String(repository).split("/")[0];
  const list = await githubRequest(`/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`, {
    bearer: installationToken, fetchImpl, secrets: [...secrets, installationToken],
  });
  const pr = Array.isArray(list) ? list[0] : null;
  return pr ? parsePullRequest(pr) : null;
}

export async function createPullRequest({ installationToken, repository, head, base, title, body, fetchImpl = fetch, secrets = [] }) {
  try {
    const pr = await githubRequest(`/repos/${repository}/pulls`, {
      method: "POST", bearer: installationToken, fetchImpl, secrets: [...secrets, installationToken],
      body: { title, head, base, body, maintainer_can_modify: false },
    });
    return { ...parsePullRequest(pr), existing: false };
  } catch (error) {
    if (!(error instanceof GithubAppError) || error.status !== 422) throw error;
    const open = await findOpenPullRequest({ installationToken, repository, head, fetchImpl, secrets });
    if (open) return { ...open, existing: true };
    throw error;
  }
}

// Open issues carrying one label (0132's intake). GitHub lists pull requests
// among issues; those are left out. The author's association is what the
// database decides trust on, so a row without one is not an issue to offer.
export function parseIssue(issue) {
  if (!issue || issue.pull_request) return null;
  const number = Number(issue.number);
  const id = Number(issue.id);
  const url = String(issue.html_url ?? "");
  if (!Number.isInteger(number) || number <= 0 || !Number.isInteger(id) || id <= 0 || !/^https:\/\//.test(url)) return null;
  return {
    number, id, html_url: url,
    title: String(issue.title ?? "").slice(0, 300),
    body: String(issue.body ?? "").slice(0, 20000),
    author_login: String(issue.user?.login ?? ""),
    author_association: String(issue.author_association ?? "NONE"),
  };
}

export async function listLabelledIssues({ installationToken, repository, label, fetchImpl = fetch, secrets = [] }) {
  const issues = [];
  for (let page = 1; page <= 5; page += 1) {
    const rows = await githubRequest(
      `/repos/${repository}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`,
      { bearer: installationToken, fetchImpl, secrets: [...secrets, installationToken] },
    );
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      const parsed = parseIssue(row);
      if (parsed) issues.push(parsed);
    }
    if (list.length < 100) break;
  }
  return issues;
}

export async function createIssueComment({ installationToken, repository, number, body, fetchImpl = fetch, secrets = [] }) {
  const comment = await githubRequest(`/repos/${repository}/issues/${Number(number)}/comments`, {
    method: "POST", bearer: installationToken, body: { body }, fetchImpl, secrets: [...secrets, installationToken],
  });
  return { id: Number(comment?.id ?? 0), url: String(comment?.html_url ?? "") };
}

// Revoke an installation token so it cannot be reused after the clone or
// repository refresh is complete. Failure to revoke is non-fatal — tokens
// naturally expire after one hour — but successful revocation is a strict
// reduction of the secret surface.
export async function revokeInstallationToken({ installationToken, fetchImpl = fetch, secrets = [] }) {
  const allSecrets = [...secrets, installationToken];
  try {
    await githubRequest(`/installation/token`, { method: "DELETE", bearer: installationToken, fetchImpl, secrets: allSecrets });
    return { revoked: true };
  } catch (error) {
    return { revoked: false, message: redactSecrets(error?.message ?? "", allSecrets) };
  }
}

// Exchange an OAuth authorization code for a user access token. The client
// secret is required here and MUST live on the VPS broker, never in the web
// layer. Returns the user access token and its expiry; callers must redact.
export async function exchangeOAuthCode({ clientId, clientSecret, code, fetchImpl = fetch }) {
  const secrets = [clientSecret];
  const headers = { "Accept": "application/vnd.github+json", "Content-Type": "application/x-www-form-urlencoded" };
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code });
  let response;
  try {
    response = await fetchImpl("https://github.com/login/oauth/access_token", { method: "POST", headers, body: body.toString() });
  } catch (cause) {
    throw new GithubAppError("network_error", redactSecrets(cause?.message ?? "GitHub OAuth network request failed", secrets));
  }
  const payload = await readJson(response);
  if (payload?.error || !payload?.access_token) {
    const code = payload?.error === "bad_verification_code" ? "oauth_bad_verification_code"
      : payload?.error === "incorrect_client_credentials" ? "oauth_bad_client_credentials"
      : "oauth_exchange_failed";
    throw new GithubAppError(code, "GitHub rejected the authorization code. Please reconnect.");
  }
  return { access_token: payload.access_token, expires_at: payload.expires_at ?? "" };
}

// Revoke the short-lived user token used only to prove installation ownership.
// GitHub requires OAuth app client credentials via Basic auth for this endpoint.
export async function revokeOAuthToken({ clientId, clientSecret, accessToken, fetchImpl = fetch }) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const secrets = [clientSecret, accessToken, basic];
  try {
    const response = await fetchImpl(`${GITHUB_API}/applications/${encodeURIComponent(clientId)}/token`, {
      method: "DELETE",
      headers: {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": DEFAULT_API_VERSION,
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    if (!response.ok) return { revoked: false, message: `GitHub OAuth token revocation failed (status ${response.status}).` };
    return { revoked: true };
  } catch (error) {
    return { revoked: false, message: redactSecrets(error?.message ?? "", secrets) };
  }
}

export function decryptOAuthCode({ ciphertext, iv, tag, encryptionKey }) {
  if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey ?? "")) {
    throw new GithubAppError("invalid_config", "GitHub OAuth code encryption key is not configured on the VPS broker.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(encryptionKey, "hex"), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new GithubAppError("oauth_code_decryption_failed", "The GitHub authorization code could not be decrypted. Please reconnect.");
  }
}

// List installations accessible to the authenticated GitHub user. Used by the
// broker to verify that the installation_id from the callback actually belongs
// to the user who completed the install flow (GitHub warns that setup-URL
// installation IDs are spoofable).
export async function listUserInstallations({ userAccessToken, fetchImpl = fetch }) {
  const secrets = [userAccessToken];
  const installations = [];
  let page = 1;
  while (page <= 20) {
    const payload = await githubRequest(`/user/installations?per_page=100&page=${page}`, {
      bearer: userAccessToken, fetchImpl, secrets,
    });
    const rows = Array.isArray(payload?.installations) ? payload.installations : [];
    for (const installation of rows) installations.push(parseInstallation(installation));
    if (rows.length < 100) break;
    page += 1;
  }
  return installations;
}

// Paginate GET /installation/repositories until all accessible repositories are
// collected. Returns safe cache rows only.
export async function listInstallationRepositories({ installationToken, perPage = 100, fetchImpl = fetch, secrets = [] }) {
  const allSecrets = [...secrets, installationToken];
  const repositories = [];
  let page = 1;
  let seen = 0;
  let total = Infinity;
  const verifiedAt = new Date().toISOString();
  while (seen < total && page <= 50) {
    const payload = await githubRequest(`/installation/repositories?per_page=${perPage}&page=${page}`, {
      bearer: installationToken, fetchImpl, secrets: allSecrets,
    });
    total = Number(payload?.total_count ?? repositories.length);
    const rows = Array.isArray(payload?.repositories) ? payload.repositories : [];
    for (const repo of rows) {
      const parsed = parseRepository(repo, verifiedAt);
      if (parsed) repositories.push(parsed);
    }
    seen += rows.length;
    if (rows.length < perPage) break;
    page += 1;
  }
  return repositories;
}

// Cryptographically random state for the login session correlation. The raw
// state is sent to GitHub; only its SHA-256 digest is persisted.
export function generateLoginState() {
  return randomBytes(32).toString("hex");
}

import { createHash } from "node:crypto";
export function stateDigest(state) {
  return createHash("sha256").update(String(state)).digest("hex");
}
