// End-to-end tests for `deploy/install.sh`, run in the sandbox that
// `installer-harness.mjs` builds.
//
// They exist because 237 green tests did not stop two blockers from reaching a
// review: a group that was never created, and an undefined variable under
// `set -u`. Both are one clean run away from being caught, and neither was
// reachable by any suite that existed.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { createSandbox, harnessPrerequisites, RELEASE_VERSION, REPOSITORY_ROOT } from "./installer-harness.mjs";

const missing = harnessPrerequisites();
const skip = missing.length > 0 ? `harness needs: ${missing.join(", ")}` : false;

// Logs go to stdout in normal mode and to stderr in --json mode, where stdout is
// reserved for the receipt. Assertions about log lines look at both.
function log(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function assertClean(result, label) {
  assert.equal(
    result.status, 0,
    `${label} exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  );
}

test("a clean install completes and leaves the documented layout", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  const result = box.run(["--json"]);
  assertClean(result, "clean install");

  // The two P0s: a `codex-worker` user needs a `codex-worker` group, and every path
  // the directory block installs has to be a variable that exists.
  assert.match(log(result), /block 5/);
  assert.ok(box.exists("etc/infra-cod/github-app"), "GITHUB_APP_DIR was not created");

  assert.ok(box.exists("etc/infra-cod/web.env"));
  assert.ok(box.exists("etc/infra-cod/caddy.env"));
  assert.ok(box.exists("etc/infra-cod/opencode/broker-private.pem"));
  assert.ok(box.exists("etc/infra-cod/opencode/broker-public.pem"));
  assert.ok(box.exists("etc/infra-cod/initial-credentials"));
  assert.ok(box.exists("etc/systemd/system/infra-cod.target"));
  assert.ok(box.exists(`opt/infra-cod/releases/${RELEASE_VERSION}/manifest.json`));
  assert.ok(existsSync(box.currentLink), "current symlink missing");

  // Every runtime entrypoint is reached through this pair. The release itself
  // can be 0755 and still be unreachable when its parent was implicitly made
  // under the installer's umask 077.
  assert.equal(box.mode("opt/infra-cod"), 0o755);
  assert.equal(box.mode("opt/infra-cod/releases"), 0o755);

  assert.equal(box.mode("etc/infra-cod/web.env"), 0o640);
  assert.equal(box.mode("etc/infra-cod/caddy.env"), 0o640);
  assert.equal(box.mode("etc/infra-cod/backup.passphrase"), 0o600);
  assert.equal(box.mode("etc/infra-cod/opencode/broker-private.pem"), 0o640);
  assert.equal(box.mode("etc/infra-cod/opencode/broker-public.pem"), 0o644);
  assert.equal(box.mode("etc/infra-cod/initial-credentials"), 0o600);
  assert.equal(box.mode("etc/infra-cod/.install-state"), 0o600);

  // The panel reads the broker key through the path the installer wrote.
  const webEnv = box.read("etc/infra-cod/web.env");
  assert.match(webEnv, /^OPENCODE_BROKER_PUBLIC_KEY_PATH=.*broker-public\.pem$/m);
  assert.match(webEnv, /^INFRA_COD_SITE_URL=https:\/\/panel\.example\.test$/m);

  const state = box.readState();
  assert.equal(state.block, 12, "the last block did not record completion");
});

test("--json writes a receipt on stdout and nothing else", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  const result = box.run(["--json"]);
  assertClean(result, "json install");

  // The whole point of the mode: `install.sh --json | jq .` must work. Every log
  // line, including "Installation complete", belongs on stderr.
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.version, RELEASE_VERSION);
  assert.equal(receipt.domain, "panel.example.test");
  assert.doesNotMatch(result.stdout, /Installation complete/);
  assert.match(result.stderr, /Installation complete/);
});

test("a second run is a no-op that preserves generated secrets", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const firstSecrets = box.read("etc/infra-cod/.generated-secrets");
  const firstKey = box.read("etc/infra-cod/opencode/broker-private.pem");

  const second = box.run([]);
  assertClean(second, "second run");

  // Regenerating the pepper would invalidate every stored password hash, so the
  // secrets block must recognise that it has already run.
  assert.equal(box.read("etc/infra-cod/.generated-secrets"), firstSecrets);
  assert.equal(box.read("etc/infra-cod/opencode/broker-private.pem"), firstKey);
  assert.match(log(second), /installed, current and intact — no-op/);
});

test("--resume repairs an app root that runtime services cannot traverse", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  chmodSync(path.join(box.prefix, "opt/infra-cod"), 0o700);

  const resumed = box.run(["--resume"]);
  assertClean(resumed, "resume over an untraversable app root");
  assert.equal(box.mode("opt/infra-cod"), 0o755);
  assert.match(log(resumed), /block 6/);
  assert.doesNotMatch(log(resumed), /resume: block 6 already done, skipping/);
});

test("an installed release that no longer matches its FILESUMS is replaced", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const live = readlinkSync(box.currentLink);
  rmSync(path.join(live, "manifest.json"));

  const second = box.run([]);
  assertClean(second, "re-run over a damaged tree");
  assert.match(log(second), /does not match its own FILESUMS/);

  // Repaired, and `current` names the repaired tree — not the damaged one.
  const now = readlinkSync(box.currentLink);
  assert.ok(existsSync(path.join(now, "manifest.json")), "the damaged release was not replaced");
});

test("a re-run with a different --domain reconciles web.env and caddy.env", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const drifted = box.run(["--domain", "new.example.test", "--acme-email", "new@example.test"]);
  assertClean(drifted, "re-run with a new domain");

  // Configuration that is written once and never reconciled is how a panel ends
  // up serving the previous origin while the receipt names the new one.
  assert.match(box.read("etc/infra-cod/caddy.env"), /^INFRA_COD_DOMAIN=new\.example\.test$/m);
  assert.match(box.read("etc/infra-cod/caddy.env"), /^INFRA_COD_ACME_EMAIL=new@example\.test$/m);
  assert.match(box.read("etc/infra-cod/web.env"), /^INFRA_COD_SITE_URL=https:\/\/new\.example\.test$/m);
  assert.doesNotMatch(box.read("etc/infra-cod/caddy.env"), /panel\.example\.test/);

  // The pepper is configuration nobody may reconcile.
  assert.match(box.read("etc/infra-cod/web.env"), /^INFRA_COD_AUTH_PEPPER=.+$/m);
});

test("a re-run without --domain or --acme-email keeps what the host has", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  // The default for a new host is <ip>.sslip.io; a host that has a domain must
  // not be moved to it by a re-run that simply left the flag out.
  assertClean(box.run([], { site: false }), "re-run with neither flag");
  assert.match(box.read("etc/infra-cod/caddy.env"), /^INFRA_COD_DOMAIN=panel\.example\.test$/m);
  assert.match(box.read("etc/infra-cod/caddy.env"), /^INFRA_COD_ACME_EMAIL=ops@example\.test$/m);
  assert.match(box.read("etc/infra-cod/web.env"), /^INFRA_COD_SITE_URL=https:\/\/panel\.example\.test$/m);
});

test("--resume skips completed blocks", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const resumed = box.run(["--resume"]);

  // The bug this pins: with `skip_if_done` returning 1 to mean "skip", `set -e`
  // ended the whole installer at the first completed block.
  assertClean(resumed, "resume after a complete run");
  assert.match(log(resumed), /resume: block 5 already done, skipping/);
  assert.match(log(resumed), /Installation complete/);
});

// Every block, one at a time: delete what it produced, tell the state file the
// run got past it, and assert that --resume notices the evidence is gone and
// re-runs the block rather than trusting the marker.
const BLOCK_EVIDENCE = [
  { block: 5, label: "users", wipe: (box) => { rmSync(path.join(box.stateDir, "groups")); } },
  // Not the marker: block 6 deliberately no longer decides anything from it.
  // The public key is the one secret a re-run is allowed to rebuild.
  { block: 6, label: "keys", wipe: (box) => box.remove("etc/infra-cod/opencode/broker-public.pem") },
  { block: 7, label: "env files", wipe: (box) => box.remove("etc/infra-cod/caddy.env") },
  { block: 9, label: "systemd", wipe: (box) => box.remove("etc/systemd/system/infra-cod.target") },
  // Block 10's evidence is "an owner exists", not "the credentials file is still
  // there": that file is meant to be removed once the operator acknowledges it.
  { block: 10, label: "bootstrap", wipe: (box) => { box.remove("etc/infra-cod/initial-credentials"); box.setOwnerCount(0); } },
  { block: 11, label: "current symlink", wipe: (box) => box.remove("opt/infra-cod/current") },
];

for (const { block, label, wipe } of BLOCK_EVIDENCE) {
  test(`--resume re-runs block ${block} (${label}) when its result is missing`, { skip }, (t) => {
    const box = createSandbox();
    t.after(() => box.cleanup());

    assertClean(box.run([]), "first run");
    wipe(box);
    box.writeState({ block: 12 });

    const resumed = box.run(["--resume"]);
    assertClean(resumed, `resume with block ${block} evidence removed`);
    assert.match(log(resumed), new RegExp(`block ${block} is marked done but its result is missing`));
  });
}

test("--resume ignores state recorded for a different artifact", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  box.writeState({ block: 12, artifact: "0".repeat(64) });

  const resumed = box.run(["--resume"]);
  assertClean(resumed, "resume across artifacts");
  // Resuming across artifacts would skip the block that installs the new one.
  assert.match(log(resumed), /ignoring saved state/);
  assert.doesNotMatch(log(resumed), /already done, skipping/);
});

test("--resume ignores state recorded for different install parameters", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const resumed = box.run(["--resume", "--domain", "other.example.test"]);
  assertClean(resumed, "resume with a changed domain");
  assert.match(log(resumed), /install parameters changed/);
  assert.match(box.read("etc/infra-cod/caddy.env"), /^INFRA_COD_DOMAIN=other\.example\.test$/m);
});

test("a failure mid-run leaves resumable state and the re-run finishes", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  // Fault injection: the migration ledger disagrees with the manifest.
  box.setMigrationCount(3);
  const failed = box.run([]);
  assert.notEqual(failed.status, 0, "the installer accepted a short migration ledger");
  assert.match(log(failed), /expected 46 migrations \(per manifest\), got 3/);

  const state = box.readState();
  assert.equal(state.block, 8, "the state file does not point at the block that failed");

  box.setMigrationCount(46);
  const resumed = box.run(["--resume"]);
  assertClean(resumed, "resume after fixing the fault");
  assert.match(log(resumed), /resume: block 4 already done, skipping/);
  assert.match(log(resumed), /Installation complete/);
});

test("an unreachable database fails the install rather than skipping the ledger", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  // Secrets already exist, so block 6 has nothing to ask the database and the
  // run reaches the ledger — which is the check under test here.
  assertClean(box.run([]), "first run");
  box.setPsqlDown(true);
  const result = box.run([]);
  assert.notEqual(result.status, 0, "an unreadable ledger was accepted");
  assert.match(log(result), /expected 46 migrations/);
});

test("a web tier that never answers fails the install", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  box.setWebDown(true);
  const result = box.run([]);
  assert.notEqual(result.status, 0, "a dead panel was accepted");
  assert.match(log(result), /web not responding on 3100/);
}, );

test("a failing oneshot unit fails the install and says which", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  box.failUnit("infra-cod-backup.service");
  const result = box.run([]);
  assert.notEqual(result.status, 0, "a failed backup run was accepted");

  // "Job for X failed, see systemctl status" is a dead end on a headless VPS:
  // the installer has exited by the time anyone could run that command.
  assert.match(log(result), /infra-cod-backup\.service failed; its log follows/);
  assert.match(log(result), /infra-cod-backup\.service failed$/m);
});

test("doctor's critical findings abort the install", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  box.setDoctorReport({
    ok: false, critical: 1, warnings: 0, passed: 10,
    checks: [{ check: "secrets._etc_infra-cod_web.env", ok: false, severity: "critical", message: "mode=0644 (expected 0640)" }],
  });
  const result = box.run([]);
  assert.notEqual(result.status, 0, "the installer accepted a critical doctor finding");
  assert.match(log(result), /doctor reports 1 critical issue/);
});

test("doctor's warnings do not abort the install", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  box.setDoctorReport({ ok: true, critical: 0, warnings: 2, passed: 10, checks: [] });
  const result = box.run(["--json"]);
  assertClean(result, "install with doctor warnings");
  assert.match(log(result), /doctor reports warnings/);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test("every shipped systemd unit is verified, not a subset", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "clean install");

  // A hand-kept list of five units is how a shipped unit reaches a host having
  // never been parsed. The installer verifies what it installed.
  const verified = readFileSync(path.join(box.stateDir, "analyze.log"), "utf8")
    .split("\n").filter((line) => line.startsWith("systemd-analyze verify")).length;
  const installed = readdirSync(box.systemdDir)
    .filter((name) => /\.(service|timer|target)$/.test(name)).length;
  assert.ok(installed >= 20, `expected the full unit set, found ${installed}`);
  assert.equal(verified, installed, `verified ${verified} of ${installed} installed units`);
});

test("--resume re-runs block 8 when the migration ledger is empty", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  box.setMigrationCount(0);
  box.writeState({ block: 12 });

  const resumed = box.run(["--resume"]);
  // The block is re-entered because its evidence is gone, and then fails loudly
  // on the count rather than reporting a healthy install of an unmigrated database.
  assert.notEqual(resumed.status, 0);
  assert.match(log(resumed), /block 8 is marked done but its result is missing/);
  assert.match(log(resumed), /expected 46 migrations \(per manifest\), got 0/);
});

test("caddy validate is given the environment file the unit will load", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "clean install");

  // The Caddyfile is written in terms of {$INFRA_COD_DOMAIN} and
  // {$INFRA_COD_ACME_EMAIL}. Validating without them is what failed every real
  // install with "parsing caddyfile tokens for 'email': wrong argument count".
  const calls = readFileSync(path.join(box.stateDir, "caddy.log"), "utf8");
  const validate = calls.split("\n").find((line) => line.startsWith("caddy validate"));
  assert.ok(validate, `no validate call in:\n${calls}`);
  assert.match(validate, /--envfile \S*\/etc\/infra-cod\/caddy\.env/);
});

test("the Caddyfile does not validate without that environment file", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "clean install");
  const caddy = path.join(box.prefix, "usr/bin/caddy");
  const config = path.join(box.prefix, "etc/infra-cod/caddy/Caddyfile");
  const envFile = path.join(box.prefix, "etc/infra-cod/caddy.env");
  const bareEnv = { PATH: "/usr/bin:/bin" };

  // Proof that the flag is load-bearing and not decoration: the same config,
  // validated without the environment file, fails the way Caddy 2.9.1 fails.
  const without = spawnSync(caddy, ["validate", "--config", config], { encoding: "utf8", env: bareEnv });
  assert.notEqual(without.status, 0, "validation without the environment file passed");
  assert.match(without.stderr, /wrong argument count/);

  const withEnv = spawnSync(caddy, ["validate", "--envfile", envFile, "--config", config],
    { encoding: "utf8", env: bareEnv });
  assert.equal(withEnv.status, 0, withEnv.stderr);
});

test("a caddy on the host that is not the pinned version is refused", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  // The unit runs /usr/bin/caddy and nothing else, so that is the binary whose
  // version has to match — `command -v caddy` accepted any build anywhere.
  box.setCaddyVersion("v2.7.0 h1:stale");
  const result = box.run([]);
  assert.notEqual(result.status, 0, "a stale caddy was accepted");
  assert.match(log(result), /found v2\.7\.0/);
  assert.match(log(result), /expected v2\.9\.1/);
});

test("the infra-cod command is installed", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "clean install");

  // `infra-cod doctor` is the documented command. Without this shim it was a
  // ninety-character path to a .mjs file that only CI knew.
  assert.ok(box.exists("usr/local/bin/infra-cod"), "no /usr/local/bin/infra-cod");
  assert.equal(box.mode("usr/local/bin/infra-cod"), 0o755);
  const shim = box.read("usr/local/bin/infra-cod");
  assert.match(shim, /opt\/infra-cod\/current\/services\/cli\/infra-cod\.mjs/);
  assert.match(shim, /opt\/node\/bin\/node/);
});

test("a supplementary group that does not take stops the install", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  box.setUsermodFails(true);
  const result = box.run([]);
  // A silent `|| true` here produced an installation that starts and then cannot
  // reach its own sockets.
  assert.notEqual(result.status, 0, "a lost group membership was accepted");
  assert.match(log(result), /could not add infra-control to group opencode-worker/);
});

test("a missing broker private key stops the re-run instead of skipping it", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  box.remove("etc/infra-cod/opencode/broker-private.pem");

  // Only that key can decrypt the OpenCode envelopes already in PostgreSQL, so a
  // re-run may not quietly mint a new one — and it may not quietly do nothing
  // either, which is what the marker file used to cause.
  const result = box.run([]);
  assert.notEqual(result.status, 0, "a lost broker key was accepted");
  assert.match(log(result), /unrecoverable secret missing/);
  assert.match(log(result), /broker-private\.pem/);
});

test("a missing broker public key is rebuilt from the private half", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  box.remove("etc/infra-cod/opencode/broker-public.pem");

  assertClean(box.run([]), "re-run after losing the public key");

  // Final state, not a log line: the key is back, and it is the public half of
  // the private key that stayed.
  assert.ok(box.exists("etc/infra-cod/opencode/broker-public.pem"), "the public key was not rebuilt");
  const derived = spawnSync("openssl", ["rsa", "-pubout", "-in",
    path.join(box.prefix, "etc/infra-cod/opencode/broker-private.pem")], { encoding: "utf8" });
  assert.equal(derived.status, 0, derived.stderr);
  assert.equal(box.read("etc/infra-cod/opencode/broker-public.pem").trim(), derived.stdout.trim());
  assert.equal(box.mode("etc/infra-cod/opencode/broker-public.pem"), 0o644);
});

test("a truncated web.env is restored on the next run", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const pepper = /^INFRA_COD_AUTH_PEPPER=(.+)$/m.exec(box.read("etc/infra-cod/web.env"))[1];

  // What an interrupted `cat tmp > live` leaves behind. The next run has to put
  // the same pepper back — a different one would invalidate every stored hash.
  writeFileSync(path.join(box.prefix, "etc/infra-cod/web.env"), "");

  assertClean(box.run([]), "re-run over an empty web.env");
  const restored = box.read("etc/infra-cod/web.env");
  assert.match(restored, new RegExp(`^INFRA_COD_AUTH_PEPPER=${pepper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(restored, /^INFRA_COD_SITE_URL=https:\/\/panel\.example\.test$/m);
  assert.match(restored, /^OPENCODE_BROKER_PUBLIC_KEY_PATH=.*broker-public\.pem$/m);
});

test("env files keep keys the installer does not manage", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const file = path.join(box.prefix, "etc/infra-cod/github-app.env");
  writeFileSync(file, `${readFileSync(file, "utf8").replace(/^GITHUB_APP_CLIENT_SECRET=$/m, "GITHUB_APP_CLIENT_SECRET=operator-secret")}`);

  assertClean(box.run(["--domain", "other.example.test"]), "re-run after operator configuration");
  assert.match(box.read("etc/infra-cod/github-app.env"), /^GITHUB_APP_CLIENT_SECRET=operator-secret$/m);
});

test("--resume converges a current symlink that points at the wrong release", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");

  // The failure this pins: `current` pointing somewhere else while the installer
  // reported "Installation complete", because the evidence check only asked
  // whether `current` was a symlink at all.
  const wrong = path.join(box.releasesDir, "wrong");
  mkdirSync(wrong, { recursive: true });
  rmSync(box.currentLink, { force: true });
  symlinkSync(wrong, box.currentLink);
  box.writeState({ block: 12 });

  const resumed = box.run(["--resume"]);
  assertClean(resumed, "resume over a misdirected current");
  assert.equal(readlinkSync(box.currentLink), path.join(box.releasesDir, RELEASE_VERSION));
});

test("--resume re-runs block 8 when the ledger holds the wrong number of migrations", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  // Not zero: a count that belongs to a different release. Any non-zero ledger
  // used to satisfy the evidence check.
  box.setMigrationCount(45);
  box.writeState({ block: 12 });

  const resumed = box.run(["--resume"]);
  assert.notEqual(resumed.status, 0);
  assert.match(log(resumed), /block 8 is marked done but its result is missing/);
  assert.match(log(resumed), /expected 46 migrations \(per manifest\), got 45/);
});

test("an unsupported host is refused before anything is installed with apt", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  // In the sandbox the host checks are skipped, so what is pinned here is the
  // order: the immutable preflight is called before install_prerequisites, which
  // is the difference between refusing a machine and modifying it first.
  const installer = readFileSync(path.join(REPOSITORY_ROOT, "deploy/install.sh"), "utf8");
  const body = installer.slice(installer.lastIndexOf("main() {"));
  assert.ok(
    body.indexOf("preflight_immutable") < body.indexOf("install_prerequisites"),
    "install_prerequisites runs before the host is checked",
  );
  assert.ok(
    body.indexOf("install_prerequisites") < body.indexOf("preflight_tools"),
    "the tool preflight runs before the tools are installed",
  );
});

test("losing the marker file does not rotate the permanent secrets", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const before = {
    secrets: box.read("etc/infra-cod/.generated-secrets"),
    passphrase: box.read("etc/infra-cod/backup.passphrase"),
    brokerKey: box.read("etc/infra-cod/opencode/broker-private.pem"),
  };

  // `.secrets-generated` is a zero-byte file and the least durable artefact of
  // the set. While it was the gate, losing it meant the next run minted a new
  // pepper, a new backup passphrase and a new broker key over an installation
  // still using the old ones — in silence, from a command whose promise is that
  // re-running it is safe.
  box.remove("etc/infra-cod/.secrets-generated");

  assertClean(box.run([]), "re-run after losing the marker");
  assert.equal(box.read("etc/infra-cod/.generated-secrets"), before.secrets, "the pepper was rotated");
  assert.equal(box.read("etc/infra-cod/backup.passphrase"), before.passphrase, "the backup passphrase was rotated");
  assert.equal(box.read("etc/infra-cod/opencode/broker-private.pem"), before.brokerKey, "the broker key was rotated");
  assert.ok(box.exists("etc/infra-cod/.secrets-generated"), "the marker was not restored");
});

test("a marker with no secrets behind it stops rather than regenerating", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  box.remove("etc/infra-cod/.generated-secrets");

  const result = box.run([]);
  assert.notEqual(result.status, 0, "a lost pepper was regenerated instead of reported");
  assert.match(log(result), /unrecoverable secret missing/);
  assert.match(log(result), /generated-secrets/);
});

test("a broker public key that does not match the private half is replaced", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const privateKey = path.join(box.prefix, "etc/infra-cod/opencode/broker-private.pem");
  const publicKey = path.join(box.prefix, "etc/infra-cod/opencode/broker-public.pem");

  // A public key left over from another installation passes every existence and
  // permission check, and then nothing enrolled against it can ever be decrypted.
  const stranger = spawnSync("sh", ["-c",
    "openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | openssl rsa -pubout 2>/dev/null"],
    { encoding: "utf8" });
  assert.equal(stranger.status, 0, stranger.stderr);
  writeFileSync(publicKey, stranger.stdout);

  assertClean(box.run([]), "re-run over a foreign public key");

  const derived = spawnSync("openssl", ["rsa", "-pubout", "-in", privateKey], { encoding: "utf8" });
  assert.equal(readFileSync(publicKey, "utf8").trim(), derived.stdout.trim(),
    "the foreign public key survived the run");
});

test("--resume rejects a web.env carrying a foreign pepper", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const webEnv = path.join(box.prefix, "etc/infra-cod/web.env");
  const real = /^INFRA_COD_AUTH_PEPPER=(.+)$/m.exec(readFileSync(webEnv, "utf8"))[1];
  writeFileSync(webEnv, readFileSync(webEnv, "utf8")
    .replace(/^INFRA_COD_AUTH_PEPPER=.*$/m, "INFRA_COD_AUTH_PEPPER=somebody-elses-pepper"));
  box.writeState({ block: 12 });

  // "Present and non-empty" is exactly what a wrong pepper is. Every password
  // would be checked against the wrong key while the install reported success.
  const resumed = box.run(["--resume"]);
  assertClean(resumed, "resume over a foreign pepper");
  assert.match(log(resumed), /block 7 is marked done but its result is missing/);
  assert.match(readFileSync(webEnv, "utf8"), new RegExp(`^INFRA_COD_AUTH_PEPPER=${real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
});

test("--resume rejects a systemd unit that no longer matches the release", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const unit = path.join(box.systemdDir, "infra-cod-web.service");
  const shipped = readFileSync(path.join(box.releasesDir, RELEASE_VERSION, "deploy/systemd/infra-cod-web.service"), "utf8");
  writeFileSync(unit, `${shipped}\n# edited by hand\nEnvironment=INFRA_COD_TAMPERED=1\n`);
  box.writeState({ block: 12 });

  // A file with the right name is not the right file. An edited or stale unit is
  // precisely what block 9 exists to correct.
  const resumed = box.run(["--resume"]);
  assertClean(resumed, "resume over an edited unit");
  assert.match(log(resumed), /block 9 is marked done but its result is missing/);
  assert.equal(readFileSync(unit, "utf8"), shipped, "the edited unit was not restored");
});

test("--resume re-runs the bootstrap when the database has no owner", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  // The credentials file stays on disk, but the database no longer holds an
  // operator — a restored or rebuilt database. The file is a copy of a password
  // the operator is meant to delete; it proves nothing about who can sign in.
  box.setOwnerCount(0);
  box.writeState({ block: 12 });

  const resumed = box.run(["--resume"]);
  assertClean(resumed, "resume over an ownerless database");
  assert.match(log(resumed), /block 10 is marked done but its result is missing/);
  assert.match(log(resumed), /bootstrapping operator/);
});

test("an idle host is not mistaken for one with busy ports", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  // The first real Ubuntu run died on "port 80 in use: unknown" on a completely
  // idle host: `ss` prints a column header even when the filter matches nothing,
  // and the check treated that header as a listener. The stub reproduces the
  // header, so a clean run here is the regression test.
  assertClean(box.run([]), "clean install on an idle host");
  const calls = readFileSync(path.join(box.stateDir, "commands.log"), "utf8");
  assert.doesNotMatch(calls, /port 80/);
});

test("a foreign listener on a published port stops the install", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  box.setListener(80, "nginx");
  const result = box.run([]);
  assert.notEqual(result.status, 0, "another server on port 80 was accepted");
  assert.match(log(result), /port 80 in use by something that is not infra-cod-caddy\.service/);
});

test("our own listener on a published port is a re-run, not a conflict", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  // The panel's process is called `next-server`, which the old name-matching
  // check did not recognise: the second install refused the panel the first one
  // had just started. Identity, not a name, is what settles this.
  box.setListener(3100, "next-server (v16.2.10)", { unit: "infra-cod-web.service" });
  const result = box.run([]);
  assertClean(result, "re-run with the panel already listening");
  assert.match(log(result), /port 3100: infra-cod-web\.service \(re-run OK\)/);
});

test("a wiped /etc over a populated database is refused, not regenerated", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");

  // /etc is not the only witness. A wiped or unmounted /etc leaves nothing to
  // find, and minting a fresh pepper then looks like a clean install right up to
  // the moment nobody can sign in: the stored hashes are peppered with the key
  // that was just replaced.
  box.remove("etc/infra-cod");
  box.setUserCount(3);

  const result = box.run([]);
  assert.notEqual(result.status, 0, "a new pepper was minted over an existing control plane");
  assert.match(log(result), /control-plane database with data in it and no secrets to match/);
  assert.match(log(result), /3 user\(s\)/);
});

test("a wiped /etc with an empty database is a fresh install", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  box.remove("etc/infra-cod");
  box.setUserCount(0);
  box.setOwnerCount(0);

  // The legitimate case the refusal above must not swallow: nothing anywhere,
  // so there is nothing to orphan.
  assertClean(box.run([]), "fresh install over an empty database");
  assert.ok(box.exists("etc/infra-cod/.generated-secrets"), "no secrets were generated");
});

test("--resume replaces a CLI shim that is not the one this release installs", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const shim = path.join(box.prefix, "usr/local/bin/infra-cod");
  const expected = readFileSync(shim, "utf8");

  // A shim from an older release still executes, and then names a Node or a
  // release path that no longer exists — so `infra-cod doctor` fails in a way
  // that reads as a broken installation rather than a stale command.
  writeFileSync(shim, "#!/bin/sh\nexec /opt/node-old/bin/node /opt/infra-cod/releases/0.0.1/services/cli/infra-cod.mjs \"$@\"\n", { mode: 0o755 });
  box.writeState({ block: 12 });

  const resumed = box.run(["--resume"]);
  assertClean(resumed, "resume over a stale shim");
  assert.match(log(resumed), /block 9 is marked done but its result is missing/);
  assert.equal(readFileSync(shim, "utf8"), expected, "the stale shim survived");
});

test("the operator bootstrap is given the installation's own pepper", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  // Argon2id refuses to hash without INFRA_COD_AUTH_PEPPER, and a hash made with
  // a different pepper than the panel's could never be verified by a sign-in.
  // The first real Ubuntu run ended here, at "the command failed".
  assertClean(box.run([]), "clean install");
  assert.ok(box.exists("etc/infra-cod/initial-credentials"), "no operator was bootstrapped");

  const pepper = /^PEPPER=(.+)$/m.exec(box.read("etc/infra-cod/.generated-secrets"))[1];
  assert.equal(pepper, /^INFRA_COD_AUTH_PEPPER=(.+)$/m.exec(box.read("etc/infra-cod/web.env"))[1],
    "web.env and the generated secrets disagree about the pepper");
});

test("a web.env whose pepper drifted stops the bootstrap", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  // Force block 10 to run again against a web.env the installer did not write.
  box.setOwnerCount(0);
  box.remove("etc/infra-cod/initial-credentials");
  const webEnv = path.join(box.prefix, "etc/infra-cod/web.env");
  writeFileSync(webEnv, readFileSync(webEnv, "utf8")
    .replace(/^INFRA_COD_AUTH_PEPPER=.*$/m, "INFRA_COD_AUTH_PEPPER=drifted"));
  box.writeState({ block: 10 });

  const result = box.run(["--resume"]);
  // Block 7 repairs web.env, so the run succeeds — and the pepper the bootstrap
  // receives is the installation's, which is the property under test.
  assertClean(result, "resume with a drifted pepper");
  const pepper = /^PEPPER=(.+)$/m.exec(box.read("etc/infra-cod/.generated-secrets"))[1];
  assert.match(box.read("etc/infra-cod/web.env"), new RegExp(`^INFRA_COD_AUTH_PEPPER=${pepper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.ok(box.exists("etc/infra-cod/initial-credentials"), "the operator was not bootstrapped");
});

test("an unreachable database creates no secrets at all", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  box.remove("etc/infra-cod");

  // PostgreSQL is installed, so a control plane may well exist here — but the
  // cluster will not say. "I could not find out" must never license minting a
  // new pepper, and the proof is that no secret file exists afterwards.
  box.setPsqlDown(true);
  const result = box.run([]);
  assert.notEqual(result.status, 0, "secrets were generated against an unreachable database");
  assert.match(log(result), /the cluster did not answer/);

  for (const secret of [
    "etc/infra-cod/.generated-secrets",
    "etc/infra-cod/backup.passphrase",
    "etc/infra-cod/opencode/broker-private.pem",
    "etc/infra-cod/opencode/broker-public.pem",
    "etc/infra-cod/.secrets-generated",
  ]) {
    assert.equal(box.exists(secret), false, `${secret} was created despite the refusal`);
  }
});

test("an unmigrated database is not mistaken for a populated one", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  box.remove("etc/infra-cod");
  // The database exists but has no control_plane schema: a run that got as far
  // as createdb and no further holds nothing a new pepper could orphan.
  box.setSchemaExists(false);

  assertClean(box.run([]), "fresh install over an unmigrated database");
  assert.ok(box.exists("etc/infra-cod/.generated-secrets"));
});

test("current always resolves to a complete release, even mid-install", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const live = readlinkSync(box.currentLink);
  assert.ok(existsSync(path.join(live, "manifest.json")));

  // Force a repair install of the same version — the case that used to rename
  // the live tree aside — and make it die straight after block 4.
  rmSync(path.join(live, "manifest.json"));
  box.setMigrationCount(0);

  const result = box.run([]);
  assert.notEqual(result.status, 0, "the injected fault did not stop the run");

  // The state a crash would leave behind. `current` must still resolve to a
  // release that is all there: the new tree goes beside the live one, and only
  // the symlink ever moves.
  const afterwards = readlinkSync(box.currentLink);
  assert.ok(existsSync(afterwards), `current dangles at ${afterwards}`);
  assert.ok(existsSync(path.join(afterwards, "FILESUMS.sha256")),
    "current points at something that is not a release");
  assert.ok(existsSync(path.join(afterwards, "deploy/systemd/infra-cod-web.service")),
    "current points at an incomplete tree");
});

test("a repair install lands beside the live release and retires it after the flip", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const live = readlinkSync(box.currentLink);
  rmSync(path.join(live, "manifest.json"));

  assertClean(box.run([]), "repair install");
  const now = readlinkSync(box.currentLink);
  assert.notEqual(now, live, "the live tree was replaced in place");
  assert.ok(existsSync(path.join(now, "manifest.json")));
  // Once current has been flipped and the panel has answered, the old copy is
  // nobody's fallback any more.
  assert.equal(existsSync(live), false, `the superseded release was left at ${live}`);
});

test("a lost /etc with no psql but an old cluster on disk is refused", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  box.remove("etc/infra-cod");
  // Purging the packages removes the client and leaves the cluster where it is.
  box.removePsql();
  mkdirSync(path.join(box.prefix, "var/lib/postgresql/17/main"), { recursive: true });

  const result = box.run([]);
  assert.notEqual(result.status, 0, "secrets were generated with an old cluster still on disk");
  assert.match(log(result), /trace of a previous installation/);
  assert.equal(box.exists("etc/infra-cod/.generated-secrets"), false, "a pepper was generated anyway");
});

test("a truly bare host with no psql still generates its secrets", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  // The refusal above must not swallow the case it exists to allow: nothing
  // anywhere, no client, no cluster, no backups.
  //
  // The run does not finish, because block 8 installs PostgreSQL and the sandbox
  // cannot — so what is asserted is the boundary this test is about: block 6
  // generated the secrets and nothing was refused as a trace.
  box.removePsql();
  const result = box.run([]);
  assert.ok(box.exists("etc/infra-cod/.generated-secrets"), "a bare host was refused");
  assert.doesNotMatch(log(result), /trace of a previous installation/);
  assert.match(log(result), /expected 46 migrations/, "the run stopped somewhere other than block 8");
  assert.notEqual(result.status, 0);
});

test("old backups are a trace even when the cluster is gone", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  box.remove("etc/infra-cod");
  box.removePsql();
  writeFileSync(path.join(box.prefix, "var/lib/infra-cod-backups/2026-09-01.dump.age"), "encrypted\n");

  const result = box.run([]);
  assert.notEqual(result.status, 0, "a new backup passphrase was minted over existing backups");
  assert.match(log(result), /trace of a previous installation/);
});

test("all long-running services must be active before the oneshots run", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  // The health snapshot reports on the whole stack; running it while half of it
  // is still starting produces a failure that describes the timing.
  box.setInactiveUnit("infra-cod-catalog-gate-worker.service");
  const result = box.run([]);
  assert.notEqual(result.status, 0, "the install proceeded with a service down");
  assert.match(log(result), /infra-cod-catalog-gate-worker\.service is not active/);
  assert.doesNotMatch(log(result), /infra-cod-health\.service:/, "health ran before the stack was up");
});

test("the runtime agents' state directories are created", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "clean install");

  // systemd resolves these while building the runtime supervisor's mount
  // namespace, before ExecStart. A missing one is status=226/NAMESPACE, and the
  // supervisor never starts — which is what a clean install produced.
  for (const [relative, mode] of [
    ["home/codex-worker/.codex", 0o700],
    ["home/opencode-worker/.local", 0o700],
    ["home/opencode-worker/.config/opencode/tools", 0o755],
  ]) {
    assert.ok(box.exists(relative), `${relative} was not created`);
    assert.equal(box.mode(relative), mode, `${relative} has the wrong mode`);
  }
});

test("a re-run restores a runtime directory that was removed", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  box.remove("home/codex-worker/.codex");

  // A completed install used to skip block 5 — its evidence asked only about
  // accounts — and skip block 9 too, because the tmpfiles rules were still
  // installed. The run reported success and the supervisor could not start.
  assertClean(box.run([]), "re-run after the directory was removed");
  assert.ok(box.exists("home/codex-worker/.codex"), "the re-run did not restore it");
  assert.equal(box.mode("home/codex-worker/.codex"), 0o700);
});

test("--resume restores a runtime directory that was removed", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  box.remove("home/opencode-worker/.config/opencode/tools");
  box.writeState({ block: 12 });

  // The path a resume takes: every block marked done, so nothing that creates
  // these directories would run at all without the unconditional step.
  assertClean(box.run(["--resume"]), "resume after the directory was removed");
  assert.ok(box.exists("home/opencode-worker/.config/opencode/tools"), "the resume did not restore it");
  assert.equal(box.mode("home/opencode-worker/.config/opencode/tools"), 0o755);
});

test("a runtime path replaced by a symlink stops the install", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");

  // The runtime user owns its home and can write it. Replacing `.codex` with a
  // link to somewhere else is how that user would aim a privileged operation at
  // another account's files: `mkdir -p` accepts the link, and a following chmod
  // and chown act on its target.
  const victim = path.join(box.prefix, "etc/victim");
  mkdirSync(victim, { recursive: true });
  chmodSync(victim, 0o755);
  const codex = path.join(box.prefix, "home/codex-worker/.codex");
  rmSync(codex, { recursive: true, force: true });
  symlinkSync(victim, codex);

  const result = box.run([]);
  assert.notEqual(result.status, 0, "the installer proceeded through a planted symlink");
  assert.match(log(result), /is a symlink/);
  assert.match(log(result), /\.codex/);

  // And the target is untouched: not chmodded, not replaced, still a directory.
  assert.equal(statSync(victim).mode & 0o777, 0o755, "the symlink's target was chmodded");
  assert.ok(statSync(victim).isDirectory());
  // The link itself is left alone too — removing it is the operator's decision,
  // not something an installer should do quietly on their behalf.
  assert.ok(lstatSync(codex).isSymbolicLink());
});

test("a symlinked runtime path is never counted as present", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  assertClean(box.run([]), "first run");
  const target = path.join(box.prefix, "srv/elsewhere");
  mkdirSync(target, { recursive: true });
  const local = path.join(box.prefix, "home/opencode-worker/.local");
  rmSync(local, { recursive: true, force: true });
  symlinkSync(target, local);
  box.writeState({ block: 12 });

  // Including on the resume path, where every block is marked done.
  const resumed = box.run(["--resume"]);
  assert.notEqual(resumed.status, 0, "a resume followed a planted symlink");
  assert.match(log(resumed), /is a symlink/);
});


test("the app root is traversable even when the install stops mid-run", { skip }, (t) => {
  const box = createSandbox();
  t.after(() => box.cleanup());

  // Block 4 runs under `umask 077`, so the app root it creates on the way to
  // staging a release was 0700 until block 6 repaired it. A run that stopped in
  // between left every non-root service failing at WorkingDirectory with
  // status=200/CHDIR — which is exactly what a real host was found in.
  box.setUsermodFails(true);
  const result = box.run([]);
  assert.notEqual(result.status, 0, "the injected fault did not stop the run");

  assert.equal(box.mode("opt/infra-cod"), 0o755, "the app root is not traversable");
  assert.equal(box.mode("opt/infra-cod/releases"), 0o755);
});

test("the panel reads the broker key variable the installer writes", () => {
  // The two halves of this contract live in different languages and different
  // trees, which is exactly how they drifted: the installer wrote `_PATH` and
  // both web routes read only the inline spelling, so every OpenCode enrolment
  // answered 503 on a correctly installed system.
  const installer = readFileSync(path.join(REPOSITORY_ROOT, "deploy/install.sh"), "utf8");
  const webBlock = installer.slice(installer.indexOf('merge_env_file "${ETC_ROOT}/web.env"'));
  const written = [...webBlock.slice(0, webBlock.indexOf("\n\n")).matchAll(/"(\w+)=/g)].map((m) => m[1]);
  assert.ok(written.includes("OPENCODE_BROKER_PUBLIC_KEY_PATH"), `installer writes: ${written.join(", ")}`);

  const helper = readFileSync(path.join(REPOSITORY_ROOT, "apps/web/src/lib/opencode-broker-key.ts"), "utf8");
  for (const variable of written) {
    if (!variable.startsWith("OPENCODE_BROKER")) continue;
    assert.match(helper, new RegExp(`process\\.env\\.${variable}`), `the panel never reads ${variable}`);
  }

  for (const route of [
    "apps/web/src/app/opencode-enroll/route.ts",
    "apps/web/src/app/api/control-plane/opencode/broker-key/route.ts",
  ]) {
    const source = readFileSync(path.join(REPOSITORY_ROOT, route), "utf8");
    assert.match(source, /readBrokerPublicKey\(\)/, `${route} does not resolve the key through the shared helper`);
    assert.doesNotMatch(source, /process\.env\.OPENCODE_BROKER_PUBLIC_KEY/, `${route} still reads the environment directly`);
  }
});
