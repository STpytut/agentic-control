import { test } from "node:test";
import { strictEqual, ok, rejects, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAskpassHelper, verifyNoTokenInWorkspace, normalizeCloneError, resolveAuthorizedInstallationId,
} from "../github-app-worker.mjs";

const FAKE_TOKEN = "ghs_FAKE_SECURITY_SCAN_TOKEN_2026";

test("GitHub App clone uses the narrow supervisor staging boundary", () => {
  const source = readFileSync(new URL("../github-app-worker.mjs", import.meta.url), "utf8");
  ok(/prepareGithubAppWorkspace/.test(source));
  ok(/finalizeGithubAppWorkspace/.test(source));
  ok(/abortGithubAppWorkspace/.test(source));
  ok(!/\/usr\/bin\/chown/.test(source),
    "the credential broker must not perform privileged ownership changes");
  ok(!/await rm\(workspace/.test(source),
    "the broker must not create or replace entries in the root-owned workspace root");
});

test("standalone OAuth resolves the sole authorized installation", () => {
  strictEqual(resolveAuthorizedInstallationId([{ installation_id: "42" }]), "42");
  strictEqual(resolveAuthorizedInstallationId(
    [{ installation_id: "41" }, { installation_id: "42" }], "42"), "42");
});

test("standalone OAuth refuses zero or ambiguous installations", () => {
  throws(() => resolveAuthorizedInstallationId([]), (error) => error.code === "app_not_installed");
  throws(() => resolveAuthorizedInstallationId(
    [{ installation_id: "41" }, { installation_id: "42" }]),
  (error) => error.code === "multiple_installations");
});

function git(workspace, args) {
  return execFileSync("/usr/bin/git", ["-c", `safe.directory=${workspace}`, "-C", workspace, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function freshWorkspace() {
  const workspace = await mkdtemp(path.join(tmpdir(), "gh-clone-test-"));
  execFileSync("/usr/bin/git", ["init", "-q", "-b", "main", workspace], { stdio: "ignore" });
  return workspace;
}

test("createAskpassHelper never writes the token into the helper script and uses 0600/0700 modes", async () => {
  const helper = await createAskpassHelper(FAKE_TOKEN);
  const helperScript = await readFile(helper.helperFile, "utf8");
  ok(!helperScript.includes(FAKE_TOKEN), "askpass helper script must not embed the token");
  ok(helperScript.includes("cat "), "helper must read the token from a sibling file");
  const tokenMode = (await stat(helper.tokenFile)).mode & 0o777;
  const helperMode = (await stat(helper.helperFile)).mode & 0o777;
  strictEqual(tokenMode, 0o600, "token file must be broker-only 0600");
  strictEqual(helperMode, 0o700, "helper script must be broker-only 0700");
  await rm(helper.tempDir, { recursive: true, force: true });
  await rejects(stat(helper.tempDir), "temp dir must be removed after cleanup");
});

test("verifyNoTokenInWorkspace accepts a canonical sanitized origin", async () => {
  const workspace = await freshWorkspace();
  try {
    git(workspace, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
    verifyNoTokenInWorkspace(workspace, FAKE_TOKEN, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("verifyNoTokenInWorkspace rejects an origin url that embeds credentials", async () => {
  const workspace = await freshWorkspace();
  try {
    git(workspace, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
    git(workspace, ["remote", "set-url", "origin", `https://${FAKE_TOKEN}@github.com/owner/repo.git`]);
    throws(() => verifyNoTokenInWorkspace(workspace, FAKE_TOKEN, []), /embed credentials/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("verifyNoTokenInWorkspace detects a token leaked into git config", async () => {
  const workspace = await freshWorkspace();
  try {
    git(workspace, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
    git(workspace, ["config", "--local", "remote.origin.ghToken", FAKE_TOKEN]);
    throws(() => verifyNoTokenInWorkspace(workspace, FAKE_TOKEN, []), /leaked into git config/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("normalizeCloneError returns a safe message without the fake token", () => {
  const detail = `fatal: could not read Username for 'https://github.com': terminal prompts disabled ${FAKE_TOKEN}`;
  const message = normalizeCloneError(detail, [FAKE_TOKEN]);
  strictEqual(message, "This repository is no longer available to the GitHub App.");
  ok(!message.includes(FAKE_TOKEN), "normalized error must not contain the token");
});

test("normalizeCloneError maps a forbidden response to the access-denied message", () => {
  const message = normalizeCloneError("remote: Permission to owner/repo.git denied. 403", []);
  strictEqual(message, "The selected installation does not have read access to this repository.");
});
