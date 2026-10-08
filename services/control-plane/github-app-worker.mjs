// GitHub App credential broker and provisioner for `credential_mode=
// github_app` projects. Runs as a dedicated, privileged VPS service that is
// the only caller allowed to read the GitHub App private key and mint
// installation tokens.
//
// Responsibilities (all secret-bearing work happens here, never in the web tier
// and never in the runtime worker users):
//   1. Finalize/verify a pending GitHub connection: call the GitHub App API
//      with a JWT, fetch the installation metadata and the accessible
//      repositories, activate the connection and refresh the repository cache.
//   2. Exchange a GitHub OAuth authorization code received from the web
//      callback for a user access token, call GET /user/installations and
//      verify that the installation_id actually belongs to that user before
//      creating the provider connection. GitHub warns that setup-URL
//      installation IDs are spoofable, so this step is mandatory.
//   3. Clone a `github_app` project: atomically revalidate the connection
//      immediately before minting a short-lived installation token (to fail
//      closed if the operator disconnected after claim), clone over HTTPS
//      using a one-shot GIT_ASKPASS helper, sanitize the remote origin,
//      revoke the token, verify no secret leaked, then hand ownership to
//      the runtime workspace user.
//
// Tokens are never written to the database, never placed in a remote URL,
// never passed as a process argument, and never inherited by runtime
// workers. The askpass helper and token file live in a broker-only temp
// directory that is removed in a `finally` block even when the clone fails.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isMain } from "./entrypoint.mjs";
import { queryJson, closePool } from "./db.mjs";
import { RuntimeSupervisorClient } from "../runtime-supervisor/client.mjs";
import { runPollLoop, shutdownSignal } from "./worker-loop.mjs";
import { DEFAULT_APP_STATE_DIR, resolveAppConfig, writeAppSecrets } from "./github-app-config.mjs";
import { INSTALLATION_LAYOUT } from "../operations/installation-layout.mjs";
import { PublishError, pullRequestBody, pushApprovedCommit } from "./github-publish.mjs";
import {
  GithubAppError, createInstallationToken, createIssueComment, createPullRequest, decryptOAuthCode, exchangeOAuthCode, getAppIdentity, getInstallation, convertManifestCode,
  listInstallationRepositories, listLabelledIssues, listUserInstallations, redactSecrets,
  revokeInstallationToken, revokeOAuthToken, sanitizeCloneUrl,
} from "./github-app-client.mjs";

const supervisorSocket = process.env.GITHUB_BROKER_SUPERVISOR_SOCKET
  ?? "/run/infra-cod/github-workspace-broker.sock";
const configuredPollMs = Number(process.env.GITHUB_APP_WORKER_POLL_MS ?? 60_000);
// Each idle cycle opens three separate psql/TLS connections. Keep the
// production-safe floor even when an older secrets file still contains the
// former 3-second development interval.
const pollMs = Number.isFinite(configuredPollMs) ? Math.max(configuredPollMs, 60_000) : 60_000;
const workerId = process.env.GITHUB_APP_WORKER_ID ?? "github-app-broker-1";
const appStateDir = process.env.GITHUB_APP_STATE_DIR ?? DEFAULT_APP_STATE_DIR;
const envKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH ?? path.join(INSTALLATION_LAYOUT.githubApp.path, "private-key.pem");
// The App this cycle works with (github-app-config.mjs): the env's when an
// operator configured one by hand, else the one the panel created. Read again
// at the start of every cycle, so an App created from the settings page is in
// use a cycle later without a restart.
let app = { source: null, appId: "", slug: "", clientId: "", clientSecret: "", keyPath: envKeyPath };
async function refreshAppConfig() {
  const env = { ...process.env, GITHUB_APP_PRIVATE_KEY_PATH: envKeyPath };
  const registration = String(env.GITHUB_APP_ID ?? "").trim() ? null : await queryJson(`SELECT github_app_registration()::text;`, {});
  app = await resolveAppConfig({ env, registration, stateDir: appStateDir });
  return app;
}
const oauthCodeEncryptionKey = process.env.GITHUB_OAUTH_CODE_ENCRYPTION_KEY ?? "";
const cloneTimeoutMs = Number(process.env.GITHUB_APP_CLONE_TIMEOUT_MS ?? 180_000);

// GITHUB_APP_PRIVATE_KEY is TEST-ONLY. In production the broker must load the
// PEM from GITHUB_APP_PRIVATE_KEY_PATH so the secret never passes through
// process.env.
const allowInlineKey = process.env.NODE_ENV !== "production" && process.env.GITHUB_APP_ALLOW_INLINE_PRIVATE_KEY === "1";

let cachedPrivateKey = null;
function privateKey() {
  if (cachedPrivateKey) return cachedPrivateKey;
  throw new GithubAppError("private_key_unavailable", "GitHub App private key is not configured on the VPS broker.");
}

function loadPrivateKeyFromFile() {
  cachedPrivateKey = null;
  try {
    const raw = readFileSync(app.keyPath, "utf8");
    if (raw && raw.includes("PRIVATE KEY")) { cachedPrivateKey = raw; return raw; }
  } catch { /* fall through */ }
  if (allowInlineKey) {
    const inline = process.env.GITHUB_APP_PRIVATE_KEY;
    if (inline) { cachedPrivateKey = inline.replace(/\\n/g, "\n"); return cachedPrivateKey; }
  }
  throw new GithubAppError("private_key_unavailable", "GitHub App private key is not configured on the VPS broker.");
}

function git(workspace, args, { env, optional = false } = {}) {
  try {
    return execFileSync("/usr/bin/git", ["-c", `safe.directory=${workspace}`, "-C", workspace, ...args],
      { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }).trim();
  } catch (error) {
    if (optional) return "";
    throw error;
  }
}

function normalizeCloneError(detail, secrets) {
  const redacted = redactSecrets(detail, secrets);
  if (/could not read Username|Authentication failed|not found/i.test(redacted)) {
    return "This repository is no longer available to the GitHub App.";
  }
  if (/_permission|403|forbidden/i.test(redacted)) {
    return "The selected installation does not have read access to this repository.";
  }
  return redacted.slice(0, 300) || "GitHub clone failed. Try again.";
}
export { normalizeCloneError };

async function createAskpassHelper(token) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "github-askpass-"));
  const tokenFile = path.join(tempDir, "token");
  const helperFile = path.join(tempDir, "askpass.sh");
  await writeFile(tokenFile, token, { mode: 0o600 });
  await writeFile(helperFile, `#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token";;\n  Password*) cat "${tokenFile}";;\n  *) exit 1;;\nesac\n`, { mode: 0o700 });
  return { tempDir, helperFile, tokenFile };
}
export { createAskpassHelper };

// Checks git config and the workspace root ownership. Renamed from
// `verifyNoTokenInWorkspace` to reflect the actual scope; a separate
// workspace-file scan lives in the security test suite.
function verifyGitConfigHasNoToken(workspace, token, secrets) {
  const origin = git(workspace, ["config", "--get", "remote.origin.url"], { optional: true });
  if (origin && /@/.test(origin)) {
    throw new Error("remote origin url must not embed credentials");
  }
  if (origin && sanitizeCloneUrl(origin) !== origin) {
    throw new Error("remote origin url is not the canonical sanitized form");
  }
  const configList = git(workspace, ["config", "--list"], { optional: true });
  if (token && configList.includes(token)) {
    throw new Error("github token leaked into git config");
  }
  for (const secret of secrets) {
    if (secret && configList.includes(secret)) {
      throw new Error("github secret leaked into git config");
    }
  }
}
export { verifyGitConfigHasNoToken };
export function verifyNoTokenInWorkspace(workspace, token, secrets) {
  return verifyGitConfigHasNoToken(workspace, token, secrets);
}

async function processConnectionWork(item) {
  const { connection_id, installation_id, work_kind } = item;
  if (!app.appId) throw new GithubAppError("invalid_config", "GitHub App ID is not configured on the VPS broker.");
  loadPrivateKeyFromFile();
  const pem = privateKey();
  const secrets = [];
  let installation;
  try {
    installation = await getInstallation({ appId: app.appId, privateKeyPem: pem, installationId: installation_id });
  } catch (error) {
    const code = error instanceof GithubAppError ? error.code : "github_error";
    const message = error instanceof GithubAppError ? error.message : "GitHub connection verification failed.";
    return await queryJson(`SELECT fail_github_connection(:'connection_id'::uuid,:'worker',:'code',:'message')::text;`,
      { connection_id, worker: workerId, code, message });
  }
  let token = null;
  try {
    const tokenResponse = await createInstallationToken({ appId: app.appId, privateKeyPem: pem, installationId: installation_id });
    token = tokenResponse.token;
    secrets.push(token);
    const repositories = await listInstallationRepositories({ installationToken: token, secrets });
    await queryJson(`SELECT refresh_github_installation_repositories(:'connection_id'::uuid,:'worker',:'repositories'::jsonb)::text;`,
      { connection_id, worker: workerId, repositories: JSON.stringify(repositories) });
    return await queryJson(`SELECT activate_github_connection(:'connection_id'::uuid,:'worker',:'account',:'installation',:'external_account',:'permissions'::jsonb,:'repository_selection')::text;`,
      { connection_id, worker: workerId, account: installation.account_label, installation: installation.installation_label,
        external_account: installation.external_account_id, permissions: JSON.stringify(installation.permissions),
        repository_selection: installation.repository_selection });
  } catch (error) {
    const code = error instanceof GithubAppError ? error.code : "broker_error";
    const message = redactSecrets(error instanceof Error ? error.message : "GitHub connection verification failed.", secrets)
      .slice(0, 500);
    return await queryJson(`SELECT fail_github_connection(:'connection_id'::uuid,:'worker',:'code',:'message')::text;`,
      { connection_id, worker: workerId, code, message });
  } finally {
    if (token) await revokeInstallationToken({ installationToken: token, secrets }).catch(() => undefined);
    token = null;
  }
}

async function processCloneProject(project) {
  const { project_id } = project;
  let snapshot = null;
  let token = null;
  let helper = null;
  let cloneSucceeded = false;
  let workspacePrepared = false;
  let workspaceFinalized = false;
  let workspace = null;
  let result = null;
  const secrets = [];
  const supervisor = new RuntimeSupervisorClient({ socketPath: supervisorSocket });
  try {
    snapshot = await queryJson(`SELECT acquire_github_clone_authorization(:'project_id'::uuid,:'worker')::text;`,
      { project_id, worker: workerId });
    if (!snapshot || !snapshot.installation_id || !snapshot.github_repository_id || !snapshot.connection_id) {
      throw new Error("GitHub connection is required to clone this private repository.");
    }
    if (!app.appId) throw new GithubAppError("invalid_config", "GitHub App ID is not configured on the VPS broker.");
    loadPrivateKeyFromFile();
    const pem = privateKey();
    await supervisor.connect();
    const prepared = await supervisor.prepareGithubAppWorkspace({ projectId: snapshot.project_id });
    workspace = prepared?.workspace;
    if (path.resolve(String(workspace ?? "")) !== path.resolve(String(project.workspace_path ?? ""))) {
      throw new Error("supervisor returned a workspace outside the project allocation");
    }
    workspacePrepared = true;
    const tokenResponse = await createInstallationToken({
      appId: app.appId, privateKeyPem: pem, installationId: snapshot.installation_id,
      repositoryIds: [snapshot.github_repository_id], permissions: { contents: "read", metadata: "read" },
    });
    token = tokenResponse.token;
    secrets.push(token);
    // Re-check after mint while keeping the authorization active for the whole
    // clone. Disconnect refuses to complete while an active authorization
    // exists, closing the disconnect/use race without holding a DB transaction
    // across the network operation.
    const fence = await queryJson(`SELECT validate_github_clone_authorization(:'auth_id'::uuid,:'worker')::text;`,
      { auth_id: snapshot.authorization_id, worker: workerId });
    if (fence?.status !== "active") {
      throw new Error("GitHub connection changed between claim and clone; aborting.");
    }
    const cloneUrl = sanitizeCloneUrl(project.repository_url);
    if (!cloneUrl) {
      throw new Error("repository url is outside the V1 GitHub allowlist");
    }
    helper = await createAskpassHelper(token);
    const cloneEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: helper.helperFile,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: helper.tempDir,
    };
    try {
      execFileSync("/usr/bin/git", ["clone", "--no-tags", "--origin", "origin", cloneUrl, workspace],
        { encoding: "utf8", env: cloneEnv, stdio: ["ignore", "pipe", "pipe"], timeout: cloneTimeoutMs, maxBuffer: 2 * 1024 * 1024 });
    } catch (error) {
      const detail = String(error.stderr ?? error.message ?? "");
      throw new Error(normalizeCloneError(detail, secrets));
    }
    git(workspace, ["remote", "set-url", "origin", cloneUrl], { env: cloneEnv });
    git(workspace, ["config", "--local", "--unset-all", "remote.origin.ghToken"], { env: cloneEnv, optional: true });
    verifyGitConfigHasNoToken(workspace, token, secrets);
    await supervisor.finalizeGithubAppWorkspace({ projectId: snapshot.project_id });
    workspaceFinalized = true;
    result = await queryJson(`SELECT complete_github_app_clone(:'project_id'::uuid,:'worker')::text;`,
      { project_id, worker: workerId });
    cloneSucceeded = true;
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : "GitHub clone failed.", secrets);
    result = await queryJson(`SELECT fail_github_app_clone(:'project_id'::uuid,:'worker',:'error')::text;`,
      { project_id, worker: workerId, error: message });
  } finally {
    if (workspacePrepared && !workspaceFinalized) {
      // `projectId` was never in scope here — the variable is `project_id`. The
      // ReferenceError was thrown synchronously, so `.catch()` never saw it: it
      // escaped the `finally` and replaced whatever error was being handled.
      await supervisor.abortGithubAppWorkspace({ projectId: project_id }).catch(() => undefined);
    }
    supervisor.close();
    if (helper) await rm(helper.tempDir, { recursive: true, force: true }).catch(() => undefined);
    if (token) await revokeInstallationToken({ installationToken: token, secrets }).catch(() => undefined);
    if (snapshot?.authorization_id) {
      try {
        await queryJson(`SELECT finalize_github_clone_authorization(:'auth_id'::uuid,:'worker',:'success'::boolean)::text;`,
          { auth_id: snapshot.authorization_id, worker: workerId, success: String(cloneSucceeded) });
      } catch { /* an expired/revoked fence is already terminal */ }
    }
    token = null;
  }
  return result;
}

// Exchange the OAuth authorization code captured by the web callback for a
// user access token, list the user's installations, and ensure the
// installation_id actually belongs to the authenticated GitHub user. GitHub
// warns that setup-URL installation IDs can be spoofed, so we refuse the
// connection unless the installation appears in /user/installations.
// The row transitions pending → exchanging → completed/failed. PostgreSQL only
// receives an AES-GCM envelope; plaintext exists in broker memory for exchange.
export function resolveAuthorizedInstallationId(installations, requestedInstallationId = "") {
  if (requestedInstallationId) {
    const allowed = installations.some((installation) => installation.installation_id === requestedInstallationId);
    if (!allowed) {
      throw new GithubAppError("installation_not_permitted",
        "The selected GitHub installation is not accessible to the authenticated user. Please reconnect with the correct account.");
    }
    return requestedInstallationId;
  }
  if (installations.length === 0) {
    throw new GithubAppError("app_not_installed",
      "Install the GitHub App on an account or organization before connecting it.");
  }
  if (installations.length > 1) {
    throw new GithubAppError("multiple_installations",
      "More than one GitHub App installation is accessible. Installation selection is required.");
  }
  return installations[0].installation_id;
}

async function processOAuthPending(item) {
  const { code_id, installation_id } = item;
  const secrets = [];
  let userToken = null;
  let codeValue = null;
  let exchangeBegun = false;
  try {
    const envelope = await queryJson(`SELECT begin_github_oauth_exchange(:'code_id'::uuid,:'worker')::text;`,
      { code_id, worker: workerId });
    exchangeBegun = true;
    if (!app.clientId || !app.clientSecret) {
      throw new GithubAppError("invalid_config", "GitHub OAuth client id/secret is not configured on the VPS broker.");
    }
    codeValue = decryptOAuthCode({ ...envelope, encryptionKey: oauthCodeEncryptionKey });
    secrets.push(codeValue);
    const exchanged = await exchangeOAuthCode({ clientId: app.clientId, clientSecret: app.clientSecret, code: codeValue });
    userToken = exchanged.access_token;
    secrets.push(userToken);
    const installations = await listUserInstallations({ userAccessToken: userToken });
    const selectedInstallationId = resolveAuthorizedInstallationId(installations, installation_id);
    if (!installation_id) {
      await queryJson(`SELECT select_github_oauth_installation(:'code_id'::uuid,:'worker',:'installation_id')::text;`,
        { code_id, worker: workerId, installation_id: selectedInstallationId });
    }
    const connectionRow = await queryJson(
      `SELECT complete_github_oauth_connection(:'code_id'::uuid,:'worker')::text;`,
      { code_id, worker: workerId });
    return { code_id, status: "completed", connection_id: connectionRow?.connection_id ?? null };
  } catch (error) {
    const code = error instanceof GithubAppError ? error.code : "github_error";
    const message = redactSecrets(error instanceof GithubAppError ? error.message : "GitHub OAuth verification failed.", secrets);
    if (exchangeBegun) {
      await queryJson(`SELECT fail_github_oauth_exchange(:'code_id'::uuid,:'worker',:'code',:'message')::text;`,
        { code_id, worker: workerId, code, message });
    }
    return { code_id, status: "failed", code, message };
  } finally {
    if (userToken) {
      await revokeOAuthToken({ clientId: app.clientId, clientSecret: app.clientSecret, accessToken: userToken }).catch(() => undefined);
    }
    userToken = null;
    codeValue = null;
  }
}

// Sprint B P1: a publish the operator asked for, claimed with a GitHub
// authorization on the project's connection. A token scoped to the one
// repository with contents and pull request write access, minted for this
// publish and revoked after it; the approved commit exported from the
// workspace by the supervisor; the push by commit id to the task's branch; the
// pull request, or the one already open for the branch. Every refusal is
// recorded with its reason, and the token is named in none of them.
async function mintPublishToken(intent) {
  if (!app.appId) throw new GithubAppError("invalid_config", "GitHub App ID is not configured on the VPS broker.");
  loadPrivateKeyFromFile();
  const response = await createInstallationToken({
    appId: app.appId, privateKeyPem: privateKey(), installationId: intent.installation_id,
    repositoryIds: [intent.github_repository_id],
    permissions: { contents: "write", pull_requests: "write", metadata: "read" },
  });
  return response.token;
}

export async function processPublishIntent(intent, {
  worker = workerId,
  db = queryJson,
  mintToken = mintPublishToken,
  revokeToken = (token, secrets) => revokeInstallationToken({ installationToken: token, secrets }),
  supervisor = new RuntimeSupervisorClient({ socketPath: supervisorSocket }),
  push = pushApprovedCommit,
  openPullRequest = createPullRequest,
  remoteUrlFor = (item) => sanitizeCloneUrl(item.repository_url),
} = {}) {
  const secrets = [];
  let token = null;
  let exported = false;
  let connected = false;
  const said = (error) => redactSecrets(error instanceof Error ? error.message : String(error), secrets).slice(0, 1000);
  const fail = (reason, message) => db(
    `SELECT fail_publish_intent(:'id'::uuid,:'worker',:'reason',:'message')::text;`,
    { id: intent.id, worker, reason, message: redactSecrets(message, secrets).slice(0, 1000) },
  );
  try {
    const remoteUrl = remoteUrlFor(intent);
    if (!remoteUrl) return await fail("publish_unsupported_repository", "the repository URL is outside the GitHub allowlist");
    try {
      token = await mintToken(intent);
      if (!token) throw new Error("GitHub returned no token");
    } catch (error) {
      return await fail("publish_token_unavailable", said(error));
    }
    secrets.push(token);
    // After the mint, as the clone does: a disconnect that landed in between
    // revokes the authorization, and the publish stops here.
    const fence = await db(`SELECT validate_github_clone_authorization(:'auth_id'::uuid,:'worker')::text;`,
      { auth_id: intent.authorization_id, worker });
    if (fence?.status !== "active") {
      return await fail("publish_connection_unavailable", "the GitHub connection changed after the publish was claimed");
    }
    let exportResult;
    try {
      await supervisor.connect();
      connected = true;
      exportResult = await supervisor.exportPublishCommit({ intentId: intent.id });
    } catch (error) {
      return await fail("publish_export_failed", said(error));
    }
    if (exportResult?.refused) return await fail(exportResult.refused, exportResult.message ?? exportResult.refused);
    exported = true;
    let pushed;
    try {
      pushed = await push({ packPath: exportResult.pack_path, sha: intent.head_commit_sha, branch: intent.branch,
        remoteUrl, token, base: intent.base_branch });
    } catch (error) {
      return await fail(error instanceof PublishError ? error.reason : "publish_push_failed", said(error));
    }
    // The repository was empty: the approved commit is its base branch now,
    // and there is nothing to open a pull request against (0126).
    if (pushed.initialisedBase) {
      return await db(`SELECT complete_publish_as_base(:'id'::uuid,:'worker',:'ref',:'sha')::text;`,
        { id: intent.id, worker, ref: pushed.ref, sha: pushed.sha });
    }
    await db(`SELECT record_publish_push(:'id'::uuid,:'worker',:'ref',:'sha')::text;`,
      { id: intent.id, worker, ref: pushed.ref, sha: pushed.sha });
    // A chat started from an issue closes it when merged (0133). Unknown is
    // no issue: the pull request is the same without the line.
    const issue = await db(`SELECT issue_for_task(:'task_id'::uuid)::text;`, { task_id: intent.task_id }).catch(() => null);
    let pr;
    try {
      pr = await openPullRequest({
        installationToken: token, repository: intent.repository_full_name, head: intent.branch,
        base: intent.base_branch, title: intent.title,
        body: pullRequestBody({ ...intent, issue_number: Number(issue?.number) || undefined }), secrets,
      });
    } catch (error) {
      return await fail("publish_pull_request_failed", said(error));
    }
    return await db(`SELECT complete_publish_intent(:'id'::uuid,:'worker',:'number'::integer,:'url')::text;`,
      { id: intent.id, worker, number: String(pr.number), url: pr.url });
  } finally {
    if (exported) await supervisor.releasePublishExport({ intentId: intent.id }).catch(() => undefined);
    if (connected) supervisor.close();
    if (token) await revokeToken(token, secrets).catch(() => undefined);
    token = null;
  }
}

// Who executors commit as (0124): asked of GitHub once per process, again
// after a failure no sooner than IDENTITY_RETRY_MS. Until it is recorded a
// launch commits as the platform, never as whoever the model says.
const IDENTITY_RETRY_MS = 10 * 60_000;
let identityRecordedAt = 0;
let identityTriedAt = 0;
export async function recordAppIdentity({ now = Date.now(), resolve = getAppIdentity, db = queryJson } = {}) {
  if (identityRecordedAt || !app.appId || now - identityTriedAt < IDENTITY_RETRY_MS) return null;
  identityTriedAt = now;
  loadPrivateKeyFromFile();
  const identity = await resolve({ appId: app.appId, privateKeyPem: privateKey() });
  const recorded = await db(
    `SELECT record_github_app_identity(:'worker',:'app_id'::bigint,:'slug',:'bot_user_id'::bigint)::text;`,
    { worker: workerId, app_id: String(identity.appId), slug: identity.slug, bot_user_id: String(identity.botUserId) });
  identityRecordedAt = now;
  return recorded;
}

// The App the settings page asked GitHub for (0125): the sealed one-hour code
// becomes the App. Its key and client secret go to the broker's state
// directory and nowhere else; the database gets its public fields.
export async function processAppManifest({ db = queryJson, convert = convertManifestCode, write = writeAppSecrets } = {}) {
  const claimed = await db(`SELECT claim_github_app_manifest(:'worker')::text;`, { worker: workerId });
  if (!claimed?.manifest_id) return null;
  const secrets = [];
  try {
    const code = decryptOAuthCode({ ciphertext: claimed.ciphertext, iv: claimed.iv, tag: claimed.tag, encryptionKey: oauthCodeEncryptionKey });
    secrets.push(code);
    const created = await convert({ code });
    secrets.push(created.clientSecret, created.pem);
    await write({ stateDir: appStateDir, pem: created.pem, clientSecret: created.clientSecret });
    const registration = await db(
      `SELECT complete_github_app_manifest(:'id'::uuid,:'worker',:'app_id'::bigint,:'slug',:'client_id',:'owner',NULLIF(:'html_url',''))::text;`,
      { id: claimed.manifest_id, worker: workerId, app_id: String(created.appId), slug: created.slug,
        client_id: created.clientId, owner: created.ownerLogin, html_url: created.htmlUrl ?? "" });
    // The bot to commit as is the new App's (0124).
    identityRecordedAt = 0;
    identityTriedAt = 0;
    return { manifest_id: claimed.manifest_id, status: "registered", slug: registration?.slug ?? created.slug };
  } catch (error) {
    const code = error instanceof GithubAppError ? error.code : "github_error";
    const message = redactSecrets(error instanceof Error ? error.message : "The GitHub App could not be created.", secrets);
    await db(`SELECT fail_github_app_manifest(:'id'::uuid,:'worker',:'code',:'message')::text;`,
      { id: claimed.manifest_id, worker: workerId, code, message });
    return { manifest_id: claimed.manifest_id, status: "failed", code, message };
  }
}

// One project's issue poll (0132): a token for that one repository with
// issues:read, the open issues carrying the label, recorded whatever happened.
// GitHub refuses the token (422) or the read (403) while the App lacks the
// Issues permission; that is the one failure the owner can fix, so it says how.
export const ISSUES_PERMISSION_MESSAGE = "The GitHub App cannot read issues yet. On GitHub: the App's Permissions → Repository → Issues: Read and write, then accept the new permissions for the installation.";

export async function processIssuePoll(item, {
  db = queryJson, mintToken = mintIssuesToken, listIssues = listLabelledIssues, revoke = revokeInstallationToken,
} = {}) {
  let token = "";
  let issues = null;
  let errorCode = null;
  let errorMessage = null;
  try {
    token = await mintToken(item);
    issues = await listIssues({ installationToken: token, repository: item.repository_full_name, label: item.label });
  } catch (error) {
    const status = error instanceof GithubAppError ? error.status : undefined;
    if (status === 403 || status === 422) {
      errorCode = "issues_permission_missing";
      errorMessage = ISSUES_PERMISSION_MESSAGE;
    } else {
      errorCode = error?.code ? String(error.code) : "issues_read_failed";
      errorMessage = redactSecrets(error?.message ?? "the issues could not be read", token ? [token] : []);
    }
  } finally {
    if (token) await revoke({ installationToken: token }).catch(() => undefined);
  }
  return db(`SELECT record_issue_poll(:'project_id'::uuid,:'worker',:'issues'::jsonb,NULLIF(:'code',''),NULLIF(:'message',''))::text;`, {
    project_id: item.project_id, worker: workerId, issues: JSON.stringify(issues ?? []),
    code: errorCode ?? "", message: errorMessage ?? "",
  });
}

async function mintIssuesToken(item) {
  if (!app.appId) throw new GithubAppError("invalid_config", "GitHub App ID is not configured on the VPS broker.");
  loadPrivateKeyFromFile();
  const response = await createInstallationToken({
    appId: app.appId, privateKeyPem: privateKey(), installationId: item.installation_id,
    repositoryIds: [item.github_repository_id],
    permissions: { issues: "read", metadata: "read" },
  });
  return response.token;
}

// What an issue hears (0133): that its chat started, and the pull request
// once it opens. Two comments, said plainly, with the links.
export function issueCommentBody(item) {
  if (item.kind === "pull_request") {
    return `Pull request: ${item.pr_url}\n\nReviewed by the orchestrator and approved by the owner. Merging it closes this issue.`;
  }
  return "Started as a chat in Agentic Control: an orchestrator plans the change, an executor implements it, the orchestrator reviews it. The pull request will be linked here once the owner approves the work.";
}

export async function processIssueComment(item, {
  db = queryJson, mintToken = mintIssueCommentToken, comment = createIssueComment, revoke = revokeInstallationToken,
} = {}) {
  let token = "";
  let error = null;
  try {
    token = await mintToken(item);
    await comment({ installationToken: token, repository: item.repository_full_name, number: item.issue_number, body: issueCommentBody(item) });
  } catch (cause) {
    const status = cause instanceof GithubAppError ? cause.status : undefined;
    error = status === 403 || status === 422 ? ISSUES_PERMISSION_MESSAGE
      : redactSecrets(cause?.message ?? "the comment could not be posted", token ? [token] : []);
  } finally {
    if (token) await revoke({ installationToken: token }).catch(() => undefined);
  }
  return db(`SELECT record_issue_comment(:'id'::uuid,:'kind',NULLIF(:'error',''))::text;`,
    { id: item.id, kind: item.kind, error: error ?? "" });
}

async function mintIssueCommentToken(item) {
  if (!app.appId) throw new GithubAppError("invalid_config", "GitHub App ID is not configured on the VPS broker.");
  loadPrivateKeyFromFile();
  const response = await createInstallationToken({
    appId: app.appId, privateKeyPem: privateKey(), installationId: item.installation_id,
    repositoryIds: [item.github_repository_id],
    permissions: { issues: "write", metadata: "read" },
  });
  return response.token;
}

// 0145: GitHub's base branch for a workspace sync. A read-only token, a
// throwaway bare clone of that one branch in this process's private /tmp, and
// a bundle of it written into the inbox the supervisor made — the supervisor
// applies it to the workspace as its owner. Nothing here reads or runs
// anything of the workspace's.
async function mintSyncToken(snapshot) {
  if (!app.appId) throw new GithubAppError("invalid_config", "GitHub App ID is not configured on the VPS broker.");
  loadPrivateKeyFromFile();
  const response = await createInstallationToken({
    appId: app.appId, privateKeyPem: privateKey(), installationId: snapshot.installation_id,
    repositoryIds: [snapshot.github_repository_id], permissions: { contents: "read", metadata: "read" },
  });
  return response.token;
}

export async function processWorkspaceSync(sync, {
  worker = workerId,
  db = queryJson,
  mintToken = mintSyncToken,
  revokeToken = (token, secrets) => revokeInstallationToken({ installationToken: token, secrets }),
  supervisor = new RuntimeSupervisorClient({ socketPath: supervisorSocket }),
  remoteUrlFor = (item) => sanitizeCloneUrl(item.repository_url),
  runGit = (args, env) => execFileSync("/usr/bin/git", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: cloneTimeoutMs, maxBuffer: 2 * 1024 * 1024 }),
} = {}) {
  const secrets = [];
  let token = null;
  let helper = null;
  let snapshot = null;
  let connected = false;
  let prepared = false;
  let fetched = false;
  const said = (error) => redactSecrets(error instanceof Error ? error.message : String(error), secrets).slice(0, 400);
  const finishFailed = (outcome) => db(`SELECT finish_workspace_sync(:'id'::uuid,:'result'::jsonb)::text;`,
    { id: sync.sync_id, result: JSON.stringify({ status: "failed", outcome }) }).catch(() => undefined);
  try {
    const remoteUrl = remoteUrlFor(sync);
    if (!remoteUrl) { await finishFailed("the repository URL is outside the GitHub allowlist"); return { status: "failed" }; }
    snapshot = await db(`SELECT acquire_github_clone_authorization(:'project_id'::uuid,:'worker')::text;`,
      { project_id: sync.project_id, worker });
    if (!snapshot?.installation_id || !snapshot?.github_repository_id) {
      await finishFailed("the project has no GitHub connection to read from"); return { status: "failed" };
    }
    token = await mintToken(snapshot);
    secrets.push(token);
    const fence = await db(`SELECT validate_github_clone_authorization(:'auth_id'::uuid,:'worker')::text;`,
      { auth_id: snapshot.authorization_id, worker });
    if (fence?.status !== "active") { await finishFailed("the GitHub connection changed during the sync"); return { status: "failed" }; }
    await supervisor.connect();
    connected = true;
    const inbox = await supervisor.prepareWorkspaceSync({ syncId: sync.sync_id });
    prepared = true;
    helper = await createAskpassHelper(token);
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: helper.helperFile,
      GIT_CONFIG_NOSYSTEM: "1", HOME: helper.tempDir };
    const bare = path.join(helper.tempDir, "origin.git");
    try {
      runGit(["clone", "--bare", "--quiet", "--no-tags", "--single-branch", "--branch", sync.base_branch, remoteUrl, bare], env);
      runGit(["-C", bare, "bundle", "create", "--quiet", path.join(inbox.inbox, "origin.bundle"), `refs/heads/${sync.base_branch}`], env);
    } catch (error) {
      const detail = String(error?.stderr ?? error?.message ?? "");
      // An empty repository, or one whose base branch is not there yet.
      const outcome = /Remote branch .* not found|remote HEAD refers to nonexistent ref|empty repository/i.test(detail)
        ? `GitHub has no ${sync.base_branch} branch yet; nothing to sync`
        : `reading GitHub: ${normalizeCloneError(detail, secrets)}`;
      await db(`SELECT finish_workspace_sync(:'id'::uuid,:'result'::jsonb)::text;`,
        { id: sync.sync_id, result: JSON.stringify({ status: /no .* branch yet/.test(outcome) ? "kept" : "failed", outcome: outcome.slice(0, 400) }) })
        .catch(() => undefined);
      return { status: "failed" };
    }
    fetched = true;
    const applied = await supervisor.applyWorkspaceSync({ syncId: sync.sync_id });
    return { status: applied?.status ?? "unknown", outcome: applied?.outcome };
  } catch (error) {
    if (!fetched) await finishFailed(said(error));
    return { status: "failed", error: said(error) };
  } finally {
    if (prepared) await supervisor.releaseWorkspaceSync({ syncId: sync.sync_id }).catch(() => undefined);
    if (connected) supervisor.close();
    if (helper) await rm(helper.tempDir, { recursive: true, force: true }).catch(() => undefined);
    if (token) await revokeToken(token, secrets).catch(() => undefined);
    if (snapshot?.authorization_id) {
      await db(`SELECT finalize_github_clone_authorization(:'auth_id'::uuid,:'worker',:'success'::boolean)::text;`,
        { auth_id: snapshot.authorization_id, worker, success: String(fetched) }).catch(() => undefined);
    }
    token = null;
  }
}

export async function runOnce() {
  const results = [];
  try {
    const manifest = await processAppManifest();
    if (manifest) results.push({ kind: "manifest", result: manifest });
  } catch (error) {
    results.push({ kind: "manifest", error: redactSecrets(error?.message ?? "the App manifest could not be processed") });
  }
  await refreshAppConfig();
  try {
    const identity = await recordAppIdentity();
    if (identity) results.push({ kind: "identity", result: identity });
  } catch (error) {
    results.push({ kind: "identity", error: redactSecrets(error?.message ?? "the App's identity could not be read") });
  }
  const oauthWork = await queryJson(`SELECT claim_github_oauth_pending(:'worker',3,interval '90 seconds')::text;`, { worker: workerId });
  for (const item of Array.isArray(oauthWork) ? oauthWork : []) {
    try { results.push({ kind: "oauth", result: await processOAuthPending(item) }); }
    catch (error) { results.push({ kind: "oauth", error: redactSecrets(error?.message ?? "oauth work failed") }); }
  }
  const work = await queryJson(`SELECT claim_github_connection_work(:'worker',5,interval '90 seconds')::text;`, { worker: workerId });
  for (const item of Array.isArray(work) ? work : []) {
    try { results.push({ kind: "connection", result: await processConnectionWork(item) }); }
    catch (error) { results.push({ kind: "connection", error: redactSecrets(error?.message ?? "connection work failed") }); }
  }
  const intent = await queryJson(`SELECT claim_publish_intent(:'worker')::text;`, { worker: workerId });
  if (intent) {
    try { results.push({ kind: "publish", intent_id: intent.id, result: await processPublishIntent(intent) }); }
    catch (error) { results.push({ kind: "publish", intent_id: intent.id, error: redactSecrets(error?.message ?? "publish work failed") }); }
  }
  const polls = await queryJson(`SELECT claim_issue_intake_polls(:'worker',5)::text;`, { worker: workerId });
  for (const item of Array.isArray(polls) ? polls : []) {
    try { results.push({ kind: "issues", project_id: item.project_id, result: await processIssuePoll(item) }); }
    catch (error) { results.push({ kind: "issues", project_id: item.project_id, error: redactSecrets(error?.message ?? "issue poll failed") }); }
  }
  const comments = await queryJson(`SELECT claim_issue_comments(:'worker',5)::text;`, { worker: workerId });
  for (const item of Array.isArray(comments) ? comments : []) {
    try { results.push({ kind: "issue_comment", link_id: item.id, result: await processIssueComment(item) }); }
    catch (error) { results.push({ kind: "issue_comment", link_id: item.id, error: redactSecrets(error?.message ?? "issue comment failed") }); }
  }
  const sync = await queryJson(`SELECT claim_workspace_sync(:'worker')::text;`, { worker: workerId });
  if (sync) {
    try { results.push({ kind: "workspace_sync", project_id: sync.project_id, result: await processWorkspaceSync(sync) }); }
    catch (error) { results.push({ kind: "workspace_sync", project_id: sync.project_id, error: redactSecrets(error?.message ?? "workspace sync failed") }); }
  }
  const projects = await queryJson(`SELECT claim_github_app_clone_projects(:'worker',3)::text;`, { worker: workerId });
  for (const project of Array.isArray(projects) ? projects : []) {
    try { results.push({ kind: "clone", project_id: project.project_id, result: await processCloneProject(project) }); }
    catch (error) { results.push({ kind: "clone", project_id: project.project_id, error: redactSecrets(error?.message ?? "clone work failed") }); }
  }
  return results;
}

async function main() {
  if (process.argv[2] === "once") {
    process.stdout.write(`${JSON.stringify({ type: "github-app-broker.once", results: await runOnce() })}\n`);
    return;
  }
  await runPollLoop({
    name: "github-app-broker", pollMs, signal: shutdownSignal(),
    fallbackMessage: "The GitHub App broker cycle failed.",
    tick: async () => {
      const results = await runOnce();
      return results.length ? results : undefined;
    },
  });
}

if (isMain(import.meta.url)) {
  try { await main(); } finally { await closePool(); }
}
