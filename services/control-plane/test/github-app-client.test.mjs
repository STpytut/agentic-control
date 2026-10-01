import { test } from "node:test";
import { strictEqual, ok, deepStrictEqual, rejects } from "node:assert";
import { createCipheriv, generateKeyPairSync } from "node:crypto";
import {
  createAppJwt, sanitizeCloneUrl, parseRepository, parseInstallation,
  redactSecrets, normalizeGithubError, generateLoginState, stateDigest,
  getAppIdentity, getInstallation, createInstallationToken, decryptOAuthCode, exchangeOAuthCode, listInstallationRepositories,
  revokeInstallationToken, revokeOAuthToken,
  GithubAppError,
} from "../github-app-client.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" });

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

test("createAppJwt produces an RS256 JWT with iss and a <=600s validity window", () => {
  const now = Date.parse("2026-07-22T10:00:00Z");
  const jwt = createAppJwt({ appId: "123456", privateKeyPem }, now);
  const segments = jwt.split(".");
  strictEqual(segments.length, 3, "JWT must have three segments");
  const [header, payload] = segments.slice(0, 2).map((segment) => JSON.parse(Buffer.from(segment, "base64url").toString()));
  strictEqual(header.alg, "RS256");
  strictEqual(payload.iss, "123456");
  strictEqual(payload.iat, Math.floor(now / 1000) - 60);
  ok(payload.exp - payload.iat <= 600, "JWT validity window must be <= 600s");
});

test("sanitizeCloneUrl canonicalizes safe URLs and rejects credential-embedded ones", () => {
  strictEqual(sanitizeCloneUrl("https://github.com/owner/repo.git"), "https://github.com/owner/repo.git");
  strictEqual(sanitizeCloneUrl("https://github.com/owner/repo"), "https://github.com/owner/repo.git");
  strictEqual(sanitizeCloneUrl("https://github.com/owner/repo/"), "https://github.com/owner/repo.git");
  strictEqual(sanitizeCloneUrl("https://ghs_FAKE_TOKEN@github.com/owner/repo.git"), "", "token-embedded URL must be rejected");
  strictEqual(sanitizeCloneUrl("ssh://git@github.com/owner/repo.git"), "", "non-https URL must be rejected");
  strictEqual(sanitizeCloneUrl(""), "");
});

test("parseRepository canonicalizes the clone url and maps safe fields", () => {
  const repo = parseRepository({
    id: 9991, full_name: "owner/private-repo", private: true, archived: false,
    default_branch: "main", clone_url: "https://github.com/owner/private-repo",
  }, "2026-07-22T10:00:00Z");
  deepStrictEqual(repo, {
    github_repository_id: "9991", full_name: "owner/private-repo", private: true, archived: false,
    default_branch: "main", clone_url: "https://github.com/owner/private-repo.git", verified_at: "2026-07-22T10:00:00Z",
  });
  strictEqual(parseRepository({ id: 1, full_name: "o/r", clone_url: "https://token@github.com/o/r.git" }, null), null, "repo with unsafe clone_url must be dropped");
});

test("parseInstallation builds safe account and installation labels", () => {
  const parsed = parseInstallation({
    id: 7, target_type: "User", repository_selection: "selected", permissions: { contents: "read", metadata: "read" },
    account: { login: "owner-login", name: "Owner Display", id: 1234, type: "User" },
  });
  strictEqual(parsed.installation_id, "7");
  strictEqual(parsed.account_label, "Owner Display (owner-login)");
  strictEqual(parsed.installation_label, "User / owner-login");
  strictEqual(parsed.repository_selection, "selected");
  deepStrictEqual(parsed.permissions, { contents: "read", metadata: "read" });
});

test("redactSecrets scrubs tokens, JWTs, authorization headers and embedded-credential URLs", () => {
  const token = "ghs_FAKE_TOKEN_VALUE_123";
  const jwt = "eyJhbGci.fake.jwt";
  const secrets = [token, jwt];
  ok(!redactSecrets(`got ${token} from github`, secrets).includes(token));
  ok(!redactSecrets(`Authorization: Bearer ${token}`, secrets).includes(token), "bearer header token must be redacted");
  strictEqual(redactSecrets(`Authorization: Bearer ${token}`, secrets), "Authorization: [REDACTED]");
  strictEqual(redactSecrets(`Authorization: Basic abcdef==`, secrets), "Authorization: [REDACTED]");
  ok(!redactSecrets(`https://${token}@github.com/owner/repo.git`, secrets).includes(token), "embedded-credential URL must be redacted");
  ok(!redactSecrets(`jwt=${jwt}`, secrets).includes(jwt));
});

test("normalizeGithubError maps status codes to actionable codes without leaking detail", () => {
  strictEqual(normalizeGithubError(401, "Bad credentials").code, "bad_credentials");
  strictEqual(normalizeGithubError(403, "Forbidden").code, "forbidden");
  strictEqual(normalizeGithubError(404, "Not Found").code, "installation_not_found");
  strictEqual(normalizeGithubError(422, "Validation Failed").code, "validation_failed");
  strictEqual(normalizeGithubError(429, "rate limited").code, "github_unavailable");
  strictEqual(normalizeGithubError(503, "down").code, "github_unavailable");
  strictEqual(normalizeGithubError(500, "boom").code, "github_unavailable");
  strictEqual(normalizeGithubError(200, "weird").code, "github_error");
  ok(!normalizeGithubError(200, `Bad credentials ghs_FAKE_TOKEN`, ["ghs_FAKE_TOKEN"]).detail?.includes("ghs_FAKE_TOKEN"), "detail must be redacted");
});

test("generateLoginState/stateDigest produce a 64-hex digest deterministically", () => {
  const state = generateLoginState();
  ok(/^[0-9a-f]{64}$/.test(state), "state must be 64 hex");
  strictEqual(stateDigest("abc"), stateDigest("abc"), "digest must be deterministic");
  ok(/^[0-9a-f]{64}$/.test(stateDigest("abc")), "digest must be 64 hex");
  ok(stateDigest("abc") !== stateDigest("abd"), "digest must differ for different inputs");
});

test("getInstallation returns parsed installation metadata on success", async () => {
  const fetchImpl = async (url, opts) => {
    ok(opts.headers["Authorization"].startsWith("Bearer "), "must authenticate with a JWT bearer");
    ok(url.endsWith("/app/installations/7"), "must call the installation endpoint");
    return response(200, { id: 7, target_type: "Organization", repository_selection: "selected", permissions: { contents: "read" }, account: { login: "org", name: "Org", id: 9, type: "Organization" } });
  };
  const parsed = await getInstallation({ appId: "1", privateKeyPem, installationId: "7", fetchImpl });
  strictEqual(parsed.installation_id, "7");
  strictEqual(parsed.account_label, "Org (org)");
});

test("getAppIdentity reads the slug with the App's JWT and the bot without any credential", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    if (url.endsWith("/app")) return response(200, { id: 101, slug: "infra-cod" });
    return response(200, { login: "infra-cod[bot]", id: 308131237, type: "Bot" });
  };
  deepStrictEqual(await getAppIdentity({ appId: "101", privateKeyPem, fetchImpl }), { appId: 101, slug: "infra-cod", botUserId: 308131237 });
  ok(calls[0].auth.startsWith("Bearer "), "GET /app must carry the App's JWT");
  ok(calls[1].url.endsWith("/users/infra-cod%5Bbot%5D"), "the bot user is <slug>[bot]");
  strictEqual(calls[1].auth, undefined, "the public bot user must not be asked with the App's JWT");
});

test("getAppIdentity refuses a user that is not the App's bot", async () => {
  const fetchImpl = async (url) => url.endsWith("/app")
    ? response(200, { id: 101, slug: "infra-cod" })
    : response(200, { login: "infra-cod[bot]", id: 5, type: "User" });
  await rejects(() => getAppIdentity({ appId: "101", privateKeyPem, fetchImpl }),
    (error) => error instanceof GithubAppError && error.code === "github_error");
});

test("getInstallation raises a normalized installation_not_found error on 404", async () => {
  const fetchImpl = async () => response(404, { message: "Not Found" });
  await rejects(
    () => getInstallation({ appId: "1", privateKeyPem, installationId: "7", fetchImpl }),
    (error) => error instanceof GithubAppError && error.code === "installation_not_found",
  );
});

test("createInstallationToken scopes the token to the repository and read-only permissions", async () => {
  let capturedBody = null;
  const fetchImpl = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    ok(url.endsWith("/app/installations/7/access_tokens"), "must call the access_tokens endpoint");
    return response(201, { token: "ghs_FAKE_TOKEN", expires_at: "2026-07-22T11:00:00Z" });
  };
  const result = await createInstallationToken({ appId: "1", privateKeyPem, installationId: "7", repositoryIds: ["9991"], fetchImpl });
  strictEqual(result.token, "ghs_FAKE_TOKEN");
  deepStrictEqual(capturedBody.repository_ids, [9991]);
  deepStrictEqual(capturedBody.permissions, { contents: "read", metadata: "read" });
});

test("revokeInstallationToken uses the credential only in the authorization header", async () => {
  const result = await revokeInstallationToken({
    installationToken: "ghs_REVOKE_ME",
    fetchImpl: async (url, init) => {
      strictEqual(url, "https://api.github.com/installation/token");
      strictEqual(init.method, "DELETE");
      strictEqual(init.headers.Authorization, "Bearer ghs_REVOKE_ME");
      return { ok: true, status: 204, async text() { return ""; } };
    },
  });
  deepStrictEqual(result, { revoked: true });
});

test("listInstallationRepositories paginates and canonicalizes repository rows", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url.includes("page=1")) {
      return response(200, { total_count: 3, repositories: [
        { id: 1, full_name: "o/r1", private: true, archived: false, default_branch: "main", clone_url: "https://github.com/o/r1.git" },
        { id: 2, full_name: "o/r2", private: false, archived: true, default_branch: "main", clone_url: "https://github.com/o/r2" },
      ]});
    }
    return response(200, { total_count: 3, repositories: [
      { id: 3, full_name: "o/r3", private: false, archived: false, default_branch: "dev", clone_url: "https://github.com/o/r3.git" },
    ]});
  };
  const repos = await listInstallationRepositories({ installationToken: "ghs_FAKE", perPage: 2, fetchImpl });
  strictEqual(repos.length, 3);
  strictEqual(repos[1].clone_url, "https://github.com/o/r2.git", "clone_url must be canonicalized");
  strictEqual(repos[1].archived, true);
  strictEqual(repos[2].default_branch, "dev");
  ok(calls >= 2, "must paginate until all repositories are fetched");
});

test("listInstallationRepositories never includes the installation token in the request URL", async () => {
  const fetchImpl = async (url) => {
    ok(!url.includes("ghs_FAKE"), "token must not appear in the query string");
    return response(200, { total_count: 0, repositories: [] });
  };
  const repos = await listInstallationRepositories({ installationToken: "ghs_FAKE", fetchImpl });
  strictEqual(repos.length, 0);
});

test("exchangeOAuthCode uses the global fetch when no fetchImpl is injected", async () => {
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    called = true;
    ok(String(url).endsWith("/login/oauth/access_token"), "must hit the OAuth access_token endpoint");
    ok(init.body.includes("client_id=Iv1_fake_client_id"), "must forward client_id");
    ok(!String(url).includes("shh_secret"), "client_secret must not appear in the URL");
    ok(init.body.includes("client_secret=shh_secret"), "OAuth exchange requires the client_secret in the POST body");
    ok(init.body.includes("code=short_code"), "must forward the code");
    return { ok: true, status: 200, async text() { return JSON.stringify({ access_token: "ghu_real_token", expires_at: "", refresh_token: "" }); } };
  };
  try {
    const result = await exchangeOAuthCode({ clientId: "Iv1_fake_client_id", clientSecret: "shh_secret", code: "short_code" });
    strictEqual(result.access_token, "ghu_real_token");
    ok(called, "global fetch must be invoked when no fetchImpl is passed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decryptOAuthCode opens an AES-256-GCM envelope and rejects a wrong key", () => {
  const key = Buffer.alloc(32, 7);
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update("github-one-time-code", "utf8"), cipher.final()]);
  const envelope = {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  strictEqual(decryptOAuthCode({ ...envelope, encryptionKey: key.toString("hex") }), "github-one-time-code");
  rejects(async () => decryptOAuthCode({ ...envelope, encryptionKey: Buffer.alloc(32, 8).toString("hex") }),
    (error) => error instanceof GithubAppError && error.code === "oauth_code_decryption_failed");
});

test("revokeOAuthToken keeps credentials out of the URL and sends Basic auth", async () => {
  const result = await revokeOAuthToken({
    clientId: "Iv1_client",
    clientSecret: "oauth-secret",
    accessToken: "ghu_user_token",
    fetchImpl: async (url, init) => {
      ok(!String(url).includes("oauth-secret") && !String(url).includes("ghu_user_token"));
      strictEqual(init.method, "DELETE");
      ok(init.headers.Authorization.startsWith("Basic "));
      deepStrictEqual(JSON.parse(init.body), { access_token: "ghu_user_token" });
      return { ok: true, status: 204, async text() { return ""; } };
    },
  });
  deepStrictEqual(result, { revoked: true });
});
