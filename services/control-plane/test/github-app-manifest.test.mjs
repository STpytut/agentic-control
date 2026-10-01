import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normaliseSlug, resolveAppConfig, writeAppSecrets } from "../github-app-config.mjs";
import { convertManifestCode, GithubAppError } from "../github-app-client.mjs";

// Stage 12 G1: the GitHub App from the settings page.

const KEY = Buffer.alloc(32, 5);
process.env.GITHUB_OAUTH_CODE_ENCRYPTION_KEY = KEY.toString("hex");
const { processAppManifest } = await import("../github-app-worker.mjs");

function seal(text) {
  const iv = Buffer.alloc(12, 9);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

test("a slug is read as GitHub spells it, from the App's URL too", () => {
  assert.equal(normaliseSlug("infra-cod"), "infra-cod");
  assert.equal(normaliseSlug("https://github.com/apps/infra-cod"), "infra-cod");
  assert.equal(normaliseSlug("https://github.com/apps/infra-cod/"), "infra-cod");
  assert.equal(normaliseSlug("Not A Slug"), "");
  assert.equal(normaliseSlug(undefined), "");
});

test("an App configured by hand wins; else the panel's; else there is none", async () => {
  const env = { GITHUB_APP_ID: "7", GITHUB_APP_SLUG: "https://github.com/apps/hand", GITHUB_APP_CLIENT_ID: "Iv1.hand",
    GITHUB_APP_CLIENT_SECRET: "s", GITHUB_APP_PRIVATE_KEY_PATH: "/etc/k.pem" };
  const registration = { app_id: 9, slug: "panel", client_id: "Iv1.panel" };
  assert.deepEqual(await resolveAppConfig({ env, registration }),
    { source: "env", appId: "7", slug: "hand", clientId: "Iv1.hand", clientSecret: "s", keyPath: "/etc/k.pem" });
  const panel = await resolveAppConfig({ env: {}, registration, stateDir: "/state", read: async (file) => `${file}-contents\n` });
  assert.deepEqual(panel, { source: "panel", appId: "9", slug: "panel", clientId: "Iv1.panel",
    clientSecret: "/state/client-secret-contents", keyPath: "/state/private-key.pem" });
  assert.equal((await resolveAppConfig({ env: {}, registration: null })).source, null);
});

test("the App's secrets are files only their owner reads", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "app-secrets-"));
  try {
    const stateDir = path.join(dir, "app");
    await writeAppSecrets({ stateDir, pem: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n", clientSecret: "secret" });
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(stateDir, "private-key.pem"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(stateDir, "client-secret"))).mode & 0o777, 0o600);
    assert.equal(await readFile(path.join(stateDir, "client-secret"), "utf8"), "secret\n");
    await assert.rejects(writeAppSecrets({ stateDir, pem: "", clientSecret: "s" }), /no private key/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the manifest code converts without a credential and must answer the whole App", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, auth: opts.headers.Authorization });
    return { ok: true, status: 201, async text() { return JSON.stringify({ id: 11, slug: "infra-cod-acp", client_id: "Iv1.abc",
      client_secret: "cs", pem: "-----BEGIN RSA PRIVATE KEY-----", owner: { login: "STpytut" }, html_url: "https://github.com/apps/infra-cod-acp" }); } };
  };
  const app = await convertManifestCode({ code: "abcdef123456", fetchImpl });
  assert.equal(calls[0].url, "https://api.github.com/app-manifests/abcdef123456/conversions");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].auth, undefined);
  assert.deepEqual({ ...app, pem: undefined }, { appId: 11, slug: "infra-cod-acp", clientId: "Iv1.abc", clientSecret: "cs",
    pem: undefined, ownerLogin: "STpytut", htmlUrl: "https://github.com/apps/infra-cod-acp" });
  const partial = async () => ({ ok: true, status: 201, async text() { return JSON.stringify({ id: 11, slug: "x" }); } });
  await assert.rejects(convertManifestCode({ code: "abcdef123456", fetchImpl: partial }), (error) => error instanceof GithubAppError);
  await assert.rejects(convertManifestCode({ code: "../x", fetchImpl }), (error) => error instanceof GithubAppError);
});

test("the broker turns a sealed code into the App: secrets to files, public fields to the database", async () => {
  const sql = [];
  const db = async (statement, params) => {
    sql.push({ statement, params });
    if (statement.includes("claim_github_app_manifest")) return { manifest_id: "m-1", ...seal("the-one-hour-code") };
    if (statement.includes("complete_github_app_manifest")) return { slug: params.slug };
    return null;
  };
  let converted = "";
  let written = null;
  const result = await processAppManifest({
    db,
    convert: async ({ code }) => { converted = code; return { appId: 11, slug: "infra-cod-acp", clientId: "Iv1.abc", clientSecret: "cs", pem: "PEM", ownerLogin: "o", htmlUrl: null }; },
    write: async (secrets) => { written = secrets; },
  });
  assert.equal(converted, "the-one-hour-code");
  assert.equal(written.pem, "PEM");
  assert.equal(written.clientSecret, "cs");
  assert.deepEqual(result, { manifest_id: "m-1", status: "registered", slug: "infra-cod-acp" });
  const completion = sql.find((call) => call.statement.includes("complete_github_app_manifest"));
  assert.ok(!Object.values(completion.params).includes("cs"), "the client secret must not reach the database");
  assert.ok(!JSON.stringify(completion.params).includes("PEM"), "the key must not reach the database");
});

test("a conversion GitHub refuses fails the manifest, with the code out of the message", async () => {
  const sql = [];
  const db = async (statement, params) => {
    sql.push({ statement, params });
    return statement.includes("claim_github_app_manifest") ? { manifest_id: "m-2", ...seal("secret-code-123") } : null;
  };
  const result = await processAppManifest({ db, convert: async () => { throw new GithubAppError("not_found", "code secret-code-123 is gone"); } });
  assert.equal(result.status, "failed");
  const failure = sql.find((call) => call.statement.includes("fail_github_app_manifest"));
  assert.equal(failure.params.code, "not_found");
  assert.ok(!failure.params.message.includes("secret-code-123"));
});
