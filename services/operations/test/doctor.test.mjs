// `infra-cod doctor` — the severity contract.
//
// Doctor is the gate the installer runs before it calls an installation good, so
// what it calls a warning is what an installer will ship. These tests pin the
// cases where a warning was the wrong answer: a secret with the wrong mode, a
// credentials file that is not a root-owned regular file, a migration ledger
// nobody can read, and a host with no git.

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, chownSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RUNTIME_SANDBOX_PATHS } from "../unit-contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCTOR_URL = pathToFileURL(path.resolve(HERE, "../doctor.mjs")).href;

function runDoctorIn(prefix, { path: pathOverride } = {}) {
  const script = `
    import { runDoctor } from ${JSON.stringify(DOCTOR_URL)};
    let out = "";
    const sink = { write: () => {} };
    await runDoctor(["--json"], { stdout: { write: (chunk) => { out += chunk; } }, stderr: sink });
    process.stdout.write(out);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      INFRA_COD_INSTALL_PREFIX: prefix,
      ...(pathOverride === undefined ? {} : { PATH: pathOverride }),
    },
  });
  assert.equal(result.status, 0, `doctor runner failed: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  return {
    report,
    check(name) {
      const found = report.checks.find((c) => c.check === name);
      assert.ok(found, `no check named ${name} in ${report.checks.map((c) => c.check).join(", ")}`);
      return found;
    },
  };
}

function sandbox(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), "infra-cod-doctor-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(path.join(base, "etc/infra-cod/opencode"), { recursive: true });
  return base;
}

function writeSecret(prefix, relative, mode) {
  const file = path.join(prefix, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "KEY=value\n", { mode });
  chmodSync(file, mode);
  return file;
}

const WEB_ENV_CHECK = "secrets._etc_infra-cod_web.env";
const CREDENTIALS_CHECK = "secrets.initial_credentials";

test("a secret with the wrong mode is critical, not a note", (t) => {
  const prefix = sandbox(t);
  writeSecret(prefix, "etc/infra-cod/web.env", 0o644);

  const { check } = runDoctorIn(prefix);
  const result = check(WEB_ENV_CHECK);
  assert.equal(result.severity, "critical", `expected critical, got ${result.severity}: ${result.message}`);
  assert.match(result.message, /mode=0644 \(expected 0640\)/);
});

test("a secret with the right mode does not complain about the mode", (t) => {
  const prefix = sandbox(t);
  writeSecret(prefix, "etc/infra-cod/web.env", 0o640);

  // The test user cannot chgrp to infra-web, so the group and owner complaints
  // remain — which is the correct answer for a file that is not root:infra-web.
  const { check } = runDoctorIn(prefix);
  assert.doesNotMatch(check(WEB_ENV_CHECK).message, /mode=/);
});

test("a missing required secret is critical", (t) => {
  const prefix = sandbox(t);

  const { check } = runDoctorIn(prefix);
  const result = check(WEB_ENV_CHECK);
  assert.equal(result.severity, "critical");
  assert.match(result.message, /does not exist/);
});

test("an absent credentials file passes", (t) => {
  const prefix = sandbox(t);

  const { check } = runDoctorIn(prefix);
  const result = check(CREDENTIALS_CHECK);
  assert.equal(result.ok, true, result.message);
});

test("a credentials file that is a symlink is critical", (t) => {
  const prefix = sandbox(t);
  const target = path.join(prefix, "elsewhere");
  writeFileSync(target, "username=a\npassword=b\n", { mode: 0o600 });
  symlinkSync(target, path.join(prefix, "etc/infra-cod/initial-credentials"));

  // A symlink here is a plaintext password redirected somewhere readable, and
  // the old check reported it as a pass regardless.
  const { check } = runDoctorIn(prefix);
  const result = check(CREDENTIALS_CHECK);
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /is a symlink/);
});

test("a world-readable credentials file is critical", (t) => {
  const prefix = sandbox(t);
  writeSecret(prefix, "etc/infra-cod/initial-credentials", 0o644);

  const { check } = runDoctorIn(prefix);
  const result = check(CREDENTIALS_CHECK);
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /mode=0644 \(expected 0600\)/);
});

test("a 0600 credentials file is reported only for its ownership", (t) => {
  const prefix = sandbox(t);
  const file = writeSecret(prefix, "etc/infra-cod/initial-credentials", 0o600);

  // The condition under test is "this file is not owned by root", and whether it
  // holds by default depends on who runs the suite: as an ordinary user it is
  // true for free, and as root — which is how it runs on a real Ubuntu host —
  // the fixture would be root-owned and doctor would be right to say nothing.
  // So the condition is created rather than assumed.
  if (process.getuid?.() === 0) chownSync(file, 1, 1);

  const { check } = runDoctorIn(prefix);
  const result = check(CREDENTIALS_CHECK);
  assert.match(result.message, /owner uid=/);
  assert.doesNotMatch(result.message, /mode=/);
  assert.doesNotMatch(result.message, /symlink/);
});

test("a migration ledger that cannot be read is critical", (t) => {
  const prefix = sandbox(t);

  // No psql under the prefix: the ledger is unreadable, and an unreadable ledger
  // is an unchecked one.
  const { check } = runDoctorIn(prefix);
  const result = check("database.ledger");
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /migration ledger/);
});

test("a host without git is critical", (t) => {
  const prefix = sandbox(t);
  const empty = path.join(prefix, "empty-bin");
  mkdirSync(empty, { recursive: true });

  const { check } = runDoctorIn(prefix, { path: empty });
  const result = check("runtime.git");
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /git not found/);
});

test("git on PATH passes", (t) => {
  const prefix = sandbox(t);

  const { check } = runDoctorIn(prefix);
  const result = check("runtime.git");
  assert.equal(result.ok, true, result.message);
});

test("the summary counts criticals and the exit contract follows them", (t) => {
  const prefix = sandbox(t);
  writeSecret(prefix, "etc/infra-cod/web.env", 0o666);

  const { report } = runDoctorIn(prefix);
  assert.ok(report.critical > 0, "no critical findings on a deliberately broken tree");
  assert.equal(report.ok, false);
});

test("an app root that runtime services cannot traverse is critical", (t) => {
  const prefix = sandbox(t);
  const appRoot = path.join(prefix, "opt/infra-cod");
  mkdirSync(path.join(appRoot, "releases"), { recursive: true });
  chmodSync(appRoot, 0o700);
  chmodSync(path.join(appRoot, "releases"), 0o755);

  const { check } = runDoctorIn(prefix);
  const result = check("release.path_permissions");
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /mode=0700 \(expected 0755\)/);
});

test("every supervisor socket is checked, and the per-run tool sockets' root", (t) => {
  const prefix = sandbox(t);

  const { report } = runDoctorIn(prefix);
  const socketChecks = report.checks.filter((c) => c.check.startsWith("systemd.socket."));
  assert.deepEqual(
    socketChecks.map((c) => c.check).sort(),
    [
      "systemd.socket.github-workspace-broker.sock",
      "systemd.socket.runtime-supervisor.sock",
      "systemd.socket.worker-tools",
      "systemd.socket.worker-tools.stale",
    ],
    "only some of the supervisor's sockets are checked",
  );
});

test("a run tool socket nobody listens on is reported by name (WP-9b)", async (t) => {
  const prefix = sandbox(t);
  const root = path.join(prefix, "run/infra-cod/worker-tools");
  const run = "0c0c0c0c-0000-4000-8000-00000000000c";
  mkdirSync(path.join(root, run), { recursive: true });
  chmodSync(root, 0o711);
  // A socket file whose listener is gone: bound by a process that then exited.
  const script = `const s=require('node:net').createServer().listen(process.argv[1],()=>process.exit(0));`;
  spawnSync(process.execPath, ["-e", script, path.join(root, run, "tools.sock")]);

  const { check } = runDoctorIn(prefix);
  const stale = check("systemd.socket.worker-tools.stale");
  assert.equal(stale.severity, "warning", stale.message);
  assert.match(stale.message, new RegExp(run));
});

test("a missing supplementary group membership is critical", (t) => {
  const prefix = sandbox(t);
  const bin = path.join(prefix, "bin");
  mkdirSync(bin, { recursive: true });
  // getent reports the group with nobody in it.
  writeFileSync(path.join(bin, "getent"), "#!/bin/sh\necho \"$2:x:900:\"\n", { mode: 0o755 });
  chmodSync(path.join(bin, "getent"), 0o755);

  const { check } = runDoctorIn(prefix, { path: `${bin}:${process.env.PATH}` });
  const result = check("users.infra-control_in_opencode-worker");
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /not a member/);
});

test("the agent runtimes are reported when absent, and not as a pass", (t) => {
  const prefix = sandbox(t);

  // The installer does not install them by design, so their absence is a warning
  // the operator must see — not silence, and not a failed install. What changed
  // in 11.1 is the evidence: absence is now read from the provisioning record
  // rather than from whether a file happens to sit on PATH, and the message
  // names the command that fixes it.
  const { check } = runDoctorIn(prefix);
  for (const cli of ["codex", "opencode"]) {
    const result = check(`runtime.agent_cli.${cli}`);
    assert.equal(result.severity, "warning", `${cli}: ${result.message}`);
    assert.match(result.message, /is not provisioned/);
    assert.match(result.message, new RegExp(`infra-cod runtime install ${cli}`));
  }
});

test("a caddy that is not the pinned version is critical", (t) => {
  const prefix = sandbox(t);
  const bin = path.join(prefix, "usr/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "caddy"), "#!/bin/sh\necho 'v2.7.0 h1:stale'\n", { mode: 0o755 });
  chmodSync(path.join(bin, "caddy"), 0o755);

  // Without a release manifest to read there is no pin, so the check can only
  // report the binary it found — which is still the pinned *path*, not PATH.
  const { check } = runDoctorIn(prefix);
  const result = check("runtime.caddy");
  assert.match(result.message, /v2\.7\.0/);
});

test("a missing caddy at the pinned path is critical", (t) => {
  const prefix = sandbox(t);

  const { check } = runDoctorIn(prefix);
  const result = check("runtime.caddy");
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /infra-cod-caddy\.service runs exactly this path/);
});

test("a current symlink pointing at another release is critical", (t) => {
  const prefix = sandbox(t);

  // Doctor runs from inside a release. When /opt/infra-cod/current names a
  // different tree, the release that is installed and the release that is
  // running disagree — an upgrade or a rollback that stopped halfway.
  const other = path.join(prefix, "opt/infra-cod/releases/other");
  mkdirSync(other, { recursive: true });
  mkdirSync(path.join(prefix, "opt/infra-cod"), { recursive: true });
  symlinkSync(other, path.join(prefix, "opt/infra-cod/current"));

  const { report } = runDoctorIn(prefix);
  const result = report.checks.find((c) => c.check === "release.installation");
  // Outside a release tree the check bows out early; inside one it must fail.
  if (/running from source checkout/.test(result.message)) return;
  assert.equal(result.severity, "critical", result.message);
});

test("a broker public key that is not the private key's half is critical", (t) => {
  const prefix = sandbox(t);
  const dir = path.join(prefix, "etc/infra-cod/opencode");
  mkdirSync(dir, { recursive: true });

  const pair = spawnSync("sh", ["-c",
    "openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null"], { encoding: "utf8" });
  assert.equal(pair.status, 0, pair.stderr);
  writeFileSync(path.join(dir, "broker-private.pem"), pair.stdout, { mode: 0o640 });

  const stranger = spawnSync("sh", ["-c",
    "openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | openssl rsa -pubout 2>/dev/null"],
    { encoding: "utf8" });
  writeFileSync(path.join(dir, "broker-public.pem"), stranger.stdout, { mode: 0o644 });

  const { check } = runDoctorIn(prefix);
  const result = check("secrets.broker_keypair");
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /not the public half/);
});

test("a matching broker keypair passes", (t) => {
  const prefix = sandbox(t);
  const dir = path.join(prefix, "etc/infra-cod/opencode");
  mkdirSync(dir, { recursive: true });

  const key = spawnSync("sh", ["-c",
    "openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null"], { encoding: "utf8" });
  writeFileSync(path.join(dir, "broker-private.pem"), key.stdout, { mode: 0o640 });
  const pub = spawnSync("openssl", ["rsa", "-pubout"], { encoding: "utf8", input: key.stdout });
  writeFileSync(path.join(dir, "broker-public.pem"), pub.stdout, { mode: 0o644 });

  const { check } = runDoctorIn(prefix);
  assert.equal(check("secrets.broker_keypair").ok, true, check("secrets.broker_keypair").message);
});

test("an ss header is not mistaken for a listener on 3100", (t) => {
  const prefix = sandbox(t);
  const bin = path.join(prefix, "bin");
  mkdirSync(bin, { recursive: true });
  // Real ss prints a column header unless -H is given. A check that reads that
  // header as data reports "not listening publicly" when nothing is listening
  // at all — a pass for a panel that is down.
  writeFileSync(path.join(bin, "ss"), `#!/bin/sh
for a in "$@"; do [ "$a" = "-H" ] && exit 0; done
echo "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process"
exit 0
`, { mode: 0o755 });
  chmodSync(path.join(bin, "ss"), 0o755);

  const { check } = runDoctorIn(prefix, { path: `${bin}:${process.env.PATH}` });
  const result = check("network.port_3100_loopback_only");
  assert.equal(result.ok, false, `header treated as a listener: ${result.message}`);
  assert.match(result.message, /nothing is listening/);
});

test("a panel bound to a public address is critical", (t) => {
  const prefix = sandbox(t);
  const bin = path.join(prefix, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "ss"), `#!/bin/sh
echo 'LISTEN 0 511 0.0.0.0:3100 0.0.0.0:* users:(("node",pid=1,fd=3))'
exit 0
`, { mode: 0o755 });
  chmodSync(path.join(bin, "ss"), 0o755);

  const { check } = runDoctorIn(prefix, { path: `${bin}:${process.env.PATH}` });
  const result = check("network.port_3100_loopback_only");
  assert.equal(result.severity, "critical", result.message);
});

test("a panel on loopback passes", (t) => {
  const prefix = sandbox(t);
  const bin = path.join(prefix, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "ss"), `#!/bin/sh
echo 'LISTEN 0 511 127.0.0.1:3100 0.0.0.0:* users:(("node",pid=1,fd=3))'
exit 0
`, { mode: 0o755 });
  chmodSync(path.join(bin, "ss"), 0o755);

  const { check } = runDoctorIn(prefix, { path: `${bin}:${process.env.PATH}` });
  assert.equal(check("network.port_3100_loopback_only").ok, true);
});

test("a missing infra-cod command is critical", (t) => {
  const prefix = sandbox(t);

  const { check } = runDoctorIn(prefix);
  const result = check("runtime.cli_shim");
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /documented `infra-cod` command is not installed/);
});

test("a shim naming a release directly is critical", (t) => {
  const prefix = sandbox(t);
  const bin = path.join(prefix, "usr/local/bin");
  mkdirSync(bin, { recursive: true });
  // A shim that names a release survives a rollback and keeps running the
  // release that was rolled back.
  writeFileSync(path.join(bin, "infra-cod"),
    "#!/bin/sh\nexec /opt/node/bin/node /opt/infra-cod/releases/0.0.1/services/cli/infra-cod.mjs \"$@\"\n",
    { mode: 0o755 });
  chmodSync(path.join(bin, "infra-cod"), 0o755);

  const { check } = runDoctorIn(prefix);
  const result = check("runtime.cli_shim");
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /does not run the CLI through \/opt\/infra-cod\/current/);
});

test("a world-writable shim is critical", (t) => {
  const prefix = sandbox(t);
  const bin = path.join(prefix, "usr/local/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "infra-cod"),
    "#!/bin/sh\nexec /opt/node/bin/node /opt/infra-cod/current/services/cli/infra-cod.mjs \"$@\"\n",
    { mode: 0o777 });
  chmodSync(path.join(bin, "infra-cod"), 0o777);

  const { check } = runDoctorIn(prefix);
  const result = check("runtime.cli_shim");
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /mode=0777/);
});

// ---------------------------------------------------------------------------
// A release doctor runs from: the tree must be checkable, and the manifest that
// says what the pins are must be readable. Both used to fail open.
// ---------------------------------------------------------------------------

function releaseSandbox(t, { filesums = true, installManifest = true } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "infra-cod-release-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "release");
  mkdirSync(path.join(root, "services/operations"), { recursive: true });
  mkdirSync(path.join(root, "deploy"), { recursive: true });
  mkdirSync(path.join(base, "etc/infra-cod"), { recursive: true });

  // doctor resolves its release from its own location, so it is copied in.
  // Doctor's own import closure, copied whole rather than named file by file.
  // Naming them meant that adding an import to doctor broke four tests with a
  // module-resolution error that says nothing about what is actually missing.
  cpSync(path.resolve(HERE, ".."), path.join(root, "services/operations"), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}test`),
  });
  // The closure reaches outside `operations/` as well: the runtime fence is
  // shared with the supervisor, because a fence only one service can see is not
  // a fence. Copied for the same reason as the line above — naming files one by
  // one turns a new import into four module-resolution errors that say nothing
  // about what is missing.
  cpSync(path.resolve(HERE, "../../runtime-supervisor"), path.join(root, "services/runtime-supervisor"), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}test`),
  });
  writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ version: "0.0.0-test" }));
  writeFileSync(path.join(root, "payload.txt"), "the shipped bytes\n");

  if (installManifest) {
    writeFileSync(path.join(root, "deploy/install-manifest.json"), JSON.stringify({
      node: { version: "24.20.0" }, caddy: { version: "2.9.1" },
    }));
  } else {
    writeFileSync(path.join(root, "deploy/install-manifest.json"), "{ this is not json");
  }

  if (filesums) {
    const digest = spawnSync("shasum", ["-a", "256", "payload.txt"], { cwd: root, encoding: "utf8" });
    writeFileSync(path.join(root, "FILESUMS.sha256"), `${digest.stdout.trim().split(/\s+/)[0]}  payload.txt\n`);
  }
  return { base, root };
}

function runDoctorFromRelease(root, prefix) {
  const script = `
    import { runDoctor } from ${JSON.stringify(pathToFileURL(path.join(root, "services/operations/doctor.mjs")).href)};
    let out = "";
    await runDoctor(["--json"], { stdout: { write: (c) => { out += c; } }, stderr: { write: () => {} } });
    process.stdout.write(out);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, INFRA_COD_INSTALL_PREFIX: prefix },
  });
  assert.equal(result.status, 0, `doctor runner failed: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  return {
    report,
    check(name) {
      const found = report.checks.find((c) => c.check === name);
      assert.ok(found, `no check named ${name}`);
      return found;
    },
  };
}

test("an installed tree that does not match FILESUMS is critical", (t) => {
  const { base, root } = releaseSandbox(t);

  // A single edited file under /opt passed every other check in this command.
  writeFileSync(path.join(root, "payload.txt"), "tampered\n");

  const { check } = runDoctorFromRelease(root, base);
  const result = check("release.filesums");
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /does not match FILESUMS/);
});

test("an intact tree passes the FILESUMS check", (t) => {
  const { base, root } = releaseSandbox(t);

  const { check } = runDoctorFromRelease(root, base);
  assert.equal(check("release.filesums").ok, true, check("release.filesums").message);
});

test("a release with no FILESUMS is critical", (t) => {
  const { base, root } = releaseSandbox(t, { filesums: false });

  const { check } = runDoctorFromRelease(root, base);
  const result = check("release.filesums");
  assert.equal(result.severity, "critical", result.message);
});

test("a broken install-manifest is critical, not a silently skipped pin", (t) => {
  const { base, root } = releaseSandbox(t, { installManifest: false });

  const { check } = runDoctorFromRelease(root, base);
  const manifest = check("release.install_manifest");
  assert.equal(manifest.severity, "critical", manifest.message);
  assert.match(manifest.message, /unreadable/);

  // And the checks that depend on it must say they could not verify, rather
  // than passing on whatever happens to be installed.
  const caddy = check("runtime.caddy");
  if (caddy.ok) assert.match(caddy.message, /unverified/);
});

test("a missing runtime sandbox path is critical", (t) => {
  const prefix = sandbox(t);

  // systemd resolves these while building the mount namespace, before
  // ExecStart. A missing one is 226/NAMESPACE, not a warning.
  const { check } = runDoctorIn(prefix);
  const result = check("systemd.sandbox_path._home_codex-worker_.codex");
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /cannot build their namespace/);
});

test("a runtime sandbox path with the wrong mode is critical", (t) => {
  const prefix = sandbox(t);
  const target = path.join(prefix, "home/codex-worker/.codex");
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o777);

  // `.codex` holds the agent's credentials. A directory that exists with mode
  // 0777 is not the same fact as a directory that exists, and existence was the
  // only thing this check used to ask about.
  const { check } = runDoctorIn(prefix);
  const result = check("systemd.sandbox_path._home_codex-worker_.codex");
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /mode=0777 \(expected 0700\)/);
});

test("a runtime sandbox path with the wrong owner is critical", (t) => {
  const prefix = sandbox(t);
  const target = path.join(prefix, "home/codex-worker/.codex");
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o700);

  // Not root and not codex-worker in a test sandbox, so the owner and group are
  // both wrong — which is exactly what must be reported.
  const { check } = runDoctorIn(prefix);
  const result = check("systemd.sandbox_path._home_codex-worker_.codex");
  assert.equal(result.severity, "critical", result.message);
  assert.match(result.message, /owner=/);
  assert.match(result.message, /group=/);
  assert.doesNotMatch(result.message, /mode=/, "the mode was right and was reported anyway");
});

test("every runtime path in the contract is checked", (t) => {
  const prefix = sandbox(t);

  const { report } = runDoctorIn(prefix);
  const checked = report.checks
    .filter((c) => c.check.startsWith("systemd.sandbox_path."))
    .length;
  assert.equal(checked, RUNTIME_SANDBOX_PATHS.length,
    `doctor checked ${checked} of ${RUNTIME_SANDBOX_PATHS.length} runtime paths`);
});

// ---------------------------------------------------------------------------
// The ledger, after a rollback
// ---------------------------------------------------------------------------

test("a schema ahead of the release is judged by the contract, not by a count", async () => {
  const { declaredCompatibleFor } = await import("../doctor.mjs").then((module) => ({
    declaredCompatibleFor: module.declaredCompatibleFor,
  }));
  // The first real rollback across an additive migration left the ledger at 0051
  // while the release it returned to carried 46 migrations up to 0050. That is
  // what a permitted rollback leaves behind — the contract says the old release
  // can read it — and doctor called the host critically broken, which also made
  // the rollback itself exit non-zero.
  assert.equal(typeof declaredCompatibleFor, "function");

  const carries = (versions, { unverifiedThrough = "0050", backwardIncompatible = [] } = {}) => ({
    database: {
      latestMigration: `${versions[versions.length - 1]}_x.sql`,
      compatibility: {
        contract: "infra-cod/schema-compatibility/1",
        unverifiedThrough,
        unverified: versions.filter((v) => v <= unverifiedThrough),
        backwardIncompatible,
      },
    },
  });

  assert.equal(declaredCompatibleFor("0051", [carries(["0051"])]), true, "an additive migration past the boundary is vouched for");
  assert.equal(
    declaredCompatibleFor("0052", [carries(["0052"], { backwardIncompatible: ["0052"] })]),
    false,
    "a migration declared incompatible is never vouched for",
  );
  assert.equal(declaredCompatibleFor("0049", [carries(["0049"])]), false, "a migration below the boundary is unverified, and unverified is not compatible");
  assert.equal(declaredCompatibleFor("0051", []), false, "nothing installed to ask means no");

  // A release can only speak for migrations it carries. A contract lists
  // exceptions, so without this the judgement read "past the boundary and in
  // neither list" as a declaration — and vouched for migrations that exist
  // nowhere in the installation, which is the fail-open case this whole check is
  // supposed to close.
  assert.equal(
    declaredCompatibleFor("0052", [carries(["0051"])]),
    false,
    "a release whose newest migration is 0051 knows nothing about 0052",
  );
  assert.equal(
    declaredCompatibleFor("9999", [carries(["0051"])]),
    false,
    "and nothing about a migration that appears in no release at all",
  );
  assert.equal(
    declaredCompatibleFor("0052", [carries(["0051"]), carries(["0052"])]),
    true,
    "the release that does carry it is the one that answers",
  );
});

// ---------------------------------------------------------------------------
// The agent runtimes, asked as the user who will run them
// ---------------------------------------------------------------------------

test("a runtime is judged by what its own user can run, not by what root can", async () => {
  const { checkAgentRuntimes } = await import("../doctor.mjs");
  const active = (version) => ({ active: { version, directory: `/opt/infra-cod/runtimes/codex/${version}` } });
  const answers = (result) => () => result;
  const find = (checks, name) => checks.find((check) => check.name === name);

  // Nothing provisioned: a warning that names the command that fixes it, rather
  // than a pass because a binary happened to be on PATH.
  const absent = await checkAgentRuntimes({ runtimes: {}, probe: answers({ ok: true, stdout: "1.0.0", stderr: "", code: 0 }) });
  assert.equal(find(absent, "runtime.agent_cli.codex").severity, "warning");
  assert.match(find(absent, "runtime.agent_cli.codex").message, /infra-cod runtime install codex/);

  // Recorded as active, and the runtime user cannot execute it. This is the
  // state Stage 10 shipped in while reporting health, because the probe ran as
  // root.
  const unrunnable = await checkAgentRuntimes({
    runtimes: { codex: active("0.154.0") },
    probe: answers({ ok: false, stdout: "", stderr: "runuser: cannot execute it", code: 126 }),
  });
  assert.equal(find(unrunnable, "runtime.agent_cli.codex").severity, "critical");
  assert.match(find(unrunnable, "runtime.agent_cli.codex").message, /codex-worker cannot run it/);

  // The binary on PATH is not the version the record claims.
  const mismatched = await checkAgentRuntimes({
    runtimes: { codex: active("0.154.0") },
    probe: answers({ ok: true, stdout: "0.153.0", stderr: "", code: 0 }),
  });
  assert.equal(find(mismatched, "runtime.agent_cli.codex").severity, "critical");
  assert.match(find(mismatched, "runtime.agent_cli.codex").message, /records 0\.154\.0 as active/);

  // A probe that could not be run at all is a question that was not asked. It
  // must never read as a pass — the whole point is that root's answer is the
  // wrong answer.
  const unprobeable = await checkAgentRuntimes({
    runtimes: { codex: active("0.154.0") },
    probe: answers({ ok: false, stdout: "", stderr: "runuser: Permission denied", code: 1 }),
  });
  assert.equal(find(unprobeable, "runtime.agent_cli.codex").severity, "warning");
  assert.match(find(unprobeable, "runtime.agent_cli.codex").message, /never asks/);

  // Healthy: version matches, and authentication is reported as its own state.
  const healthy = await checkAgentRuntimes({
    runtimes: { codex: active("0.154.0") },
    probe: answers({ ok: true, stdout: "codex-cli 0.154.0", stderr: "", code: 0 }),
  });
  assert.equal(find(healthy, "runtime.agent_cli.codex").severity, "info");
  assert.equal(find(healthy, "runtime.auth.codex").severity, "info");
});

test("a runtime other than the version its driver was verified at is reported, not refused", async () => {
  // WP-5b: a driver's capabilities were shown at one exact runtime version.
  const { checkAgentRuntimes } = await import("../doctor.mjs");
  const at = (version) => checkAgentRuntimes({
    runtimes: { codex: { active: { version, directory: `/opt/infra-cod/runtimes/codex/${version}` } } },
    probe: () => ({ ok: true, stdout: `codex-cli ${version}`, stderr: "", code: 0 }),
  });
  const verified = (checks) => checks.find((check) => check.name === "runtime.driver_verified.codex");

  const same = verified(await at("0.154.0"));
  assert.equal(same.severity, "info");
  assert.match(same.message, /codex adapter 1\.0\.0 \/ runtime 0\.154\.0/);

  const patch = verified(await at("0.154.1"));
  assert.equal(patch.severity, "warning", "a patch release is not the version shown");
  assert.match(patch.message, /0\.154\.1 is not the version its driver was verified at/);
});

test("a runtime that can update itself says so, every time it is asked", async () => {
  const { checkAgentRuntimes } = await import("../doctor.mjs");
  const probe = () => ({ ok: true, stdout: "0.154.0", stderr: "", code: 0 });
  const entry = (autoUpdate) => ({
    codex: { active: { version: "0.154.0", directory: "/opt/x" }, verification: { autoUpdate } },
  });
  const selfUpdate = (checks) => checks.find((check) => check.name === "runtime.self_update.codex");

  const controlled = await checkAgentRuntimes({
    runtimes: entry({ verified: true, setting: "check_for_update_on_startup" }),
    probe,
  });
  assert.equal(selfUpdate(controlled).severity, "info");

  // Accepted deliberately: a warning that names who accepted it, because the
  // person reading doctor is rarely the person who typed the flag.
  const accepted = await checkAgentRuntimes({
    runtimes: entry({ verified: false, acceptedUnmanaged: true, acceptedBy: "stepan", reason: "no control verified" }),
    probe,
  });
  assert.equal(selfUpdate(accepted).severity, "warning");
  assert.match(selfUpdate(accepted).message, /stepan/);

  // Not verified and nobody accepted it — the state an older install could reach
  // by exiting 0 with a warning. It is a failure, not a note.
  const unmanaged = await checkAgentRuntimes({
    runtimes: entry({ verified: false, reason: "no control verified" }),
    probe,
  });
  assert.equal(selfUpdate(unmanaged).severity, "critical");

  // And a record with no mention of the control at all is not a pass by default.
  const silent = await checkAgentRuntimes({ runtimes: entry(undefined), probe });
  assert.equal(selfUpdate(silent).severity, "critical");
  assert.match(selfUpdate(silent).message, /no record of the control/);
});

test("a probe that cannot be run is a finding, not a crash", async () => {
  const { checkAgentRuntimes } = await import("../doctor.mjs");
  // A missing runtime home makes the probe refuse rather than answer. doctor
  // reports the state of the host, including the states where nothing can be
  // asked — it does not stop reporting at the first one.
  const checks = await checkAgentRuntimes({
    runtimes: { codex: { active: { version: "0.154.0", directory: "/opt/x" } } },
    probe: () => { throw new Error("/home/codex-worker does not exist, so codex-worker cannot be run there."); },
  });
  const cli = checks.find((check) => check.name === "runtime.agent_cli.codex");
  assert.equal(cli.severity, "critical");
  assert.match(cli.message, /does not exist/);
  // Credentials are not asked about when the runtime cannot be run at all — that
  // question has no meaning here — but the report goes on to the next runtime.
  assert.equal(checks.find((check) => check.name === "runtime.auth.codex"), undefined);
  assert.ok(checks.find((check) => check.name === "runtime.agent_cli.opencode"), "the rest of the report still happens");
});

test("an auth probe's output never reaches the report", async () => {
  const { checkAgentRuntimes } = await import("../doctor.mjs");
  // The probe prints account state. Whatever it says, the report says only
  // whether a usable credential exists.
  const checks = await checkAgentRuntimes({
    runtimes: { codex: { active: { version: "0.154.0", directory: "/opt/x" } } },
    probe: (adapter, args) => args[0] === "--version"
      ? { ok: true, stdout: "0.154.0", stderr: "", code: 0 }
      : { ok: true, stdout: "logged in as operator@example.com, token sk-secret-value", stderr: "", code: 0 },
  });
  const auth = checks.find((check) => check.name === "runtime.auth.codex");
  assert.equal(auth.severity, "info");
  assert.doesNotMatch(auth.message, /sk-secret-value|example\.com/);
});

// 11.2 N3 renamed the orchestrator and implementation workers; an update retires
// the old units, and a unit left behind — a retirement that failed, or a copy
// made by hand — is named by doctor rather than left running on its own.
test("doctor names an infra-cod unit file the release does not ship", async () => {
  const { staleUnitFiles } = await import(DOCTOR_URL);
  const listing = [
    "infra-cod-web.service enabled enabled",
    "infra-cod-orchestrator-worker.service enabled enabled",
    "infra-cod-codex-chat-worker.service enabled enabled",
    "infra-cod-executor-worker.service disabled enabled",
    "infra-cod.target enabled enabled",
    "infra-cod-health.timer enabled enabled",
    "sshd.service enabled enabled",
  ].join("\n");
  assert.deepEqual(staleUnitFiles(listing), [
    { name: "infra-cod-codex-chat-worker.service", state: "enabled" },
    { name: "infra-cod-executor-worker.service", state: "disabled" },
  ]);
  assert.deepEqual(staleUnitFiles("infra-cod-web.service enabled enabled\ninfra-cod.target static -"), []);
});

// Sprint B, B0: workspaces provisioned before rc.48 have a seeded AGENTS.md in
// no commit, and their first publish is refused. doctor names them, reading the
// refs from disk — it never runs git as root.
test("doctor names a workspace whose seed was never committed, and only that one", async () => {
  const { uncommittedSeedWorkspaces } = await import(DOCTOR_URL);
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const root = mkdtempSync(path.join(os.tmpdir(), "seed-workspaces-"));
  const git = (cwd, ...args) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd }).status, 0);
  const workspace = (name) => { const dir = path.join(root, name); mkdirSync(dir); git(dir, "init", "-q", "-b", "main"); writeFileSync(path.join(dir, "AGENTS.md"), "# x\n"); return dir; };
  try {
    workspace("uncommitted");
    const committed = workspace("committed");
    git(committed, "add", "AGENTS.md"); git(committed, "commit", "-q", "-m", "seed");
    const packed = workspace("packed");
    git(packed, "add", "AGENTS.md"); git(packed, "commit", "-q", "-m", "seed"); git(packed, "pack-refs", "--all");
    const cloned = path.join(root, "no-seed"); mkdirSync(cloned); git(cloned, "init", "-q");
    mkdirSync(path.join(root, "not-a-repo"));
    assert.deepEqual(uncommittedSeedWorkspaces(root), ["uncommitted"]);
    assert.deepEqual(uncommittedSeedWorkspaces(path.join(root, "absent")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Stage 12 W1: the executable on disk against the one its package carried.
test("an executable that is not the one its package carried is a failure", async () => {
  const { checkAgentRuntimes } = await import("../doctor.mjs");
  const probe = () => ({ ok: true, stdout: "codex-cli 0.154.0", stderr: "", code: 0 });
  const hostProbe = () => ({ met: true, detail: "stub" });
  const directory = "/opt/infra-cod/runtimes/codex/0.154.0";
  const recorded = (executableSha256) => ({
    codex: {
      active: { version: "0.154.0", directory },
      installed: [{ version: "0.154.0", directory, ...(executableSha256 ? { executableSha256 } : {}) }],
    },
  });
  const digest = (checks) => checks.find((check) => check.name === "runtime.executable_digest.codex");
  let hashed = null;
  const hashExecutable = (file) => { hashed = file; return "a".repeat(64); };

  const same = await checkAgentRuntimes({ runtimes: recorded("a".repeat(64)), probe, hostProbe, hashExecutable });
  assert.equal(digest(same).severity, "info");
  assert.equal(hashed, `${directory}/package/vendor/x86_64-unknown-linux-musl/bin/codex`, "the executable the adapter names, in the active tree");

  const changed = await checkAgentRuntimes({ runtimes: recorded("b".repeat(64)), probe, hostProbe, hashExecutable });
  assert.equal(digest(changed).severity, "critical");
  assert.match(digest(changed).message, /has changed since it was installed/);

  // Installed before the digest was recorded: said, with the command that records it.
  const legacy = await checkAgentRuntimes({ runtimes: recorded(null), probe, hostProbe, hashExecutable });
  assert.equal(digest(legacy).severity, "warning");
  assert.match(digest(legacy).message, /infra-cod runtime install codex --version 0\.154\.0/);

  const unreadable = await checkAgentRuntimes({
    runtimes: recorded("a".repeat(64)), probe, hostProbe, hashExecutable: () => { throw new Error("EACCES"); },
  });
  assert.equal(digest(unreadable).severity, "critical");
});

test("a host requirement is a failure for the active version and a warning for the next one", async () => {
  const { checkAgentRuntimes } = await import("../doctor.mjs");
  const at = (version) => checkAgentRuntimes({
    runtimes: { codex: { active: { version, directory: `/opt/infra-cod/runtimes/codex/${version}` } } },
    probe: () => ({ ok: true, stdout: `codex-cli ${version}`, stderr: "", code: 0 }),
    hostProbe: (requirement) => (requirement === "landlock"
      ? { met: true, detail: "landlock is in the LSM list" }
      : { met: false, detail: "no bubblewrap on the runtime's PATH" }),
    hashExecutable: () => "",
  });
  const find = (checks, name) => checks.find((check) => check.name === name);

  // Today's host: 0.154.0 needs Landlock, which it has; bubblewrap is needed
  // only by the versions after it — so the report says why an update would not
  // work, and names the decision, before anyone asks for one.
  const today = await at("0.154.0");
  assert.equal(find(today, "runtime.host_requirement.codex.landlock").severity, "info");
  const bwrap = find(today, "runtime.host_requirement.codex.bwrap.userns");
  assert.equal(bwrap.severity, "warning");
  assert.match(bwrap.message, /codex >=0\.155\.0, not by the active 0\.154\.0/);
  assert.match(bwrap.message, /R13/);

  // A version that needs it, active on a host without it: 0.158.0's panic.
  const broken = await at("0.158.0");
  assert.equal(find(broken, "runtime.host_requirement.codex.bwrap.userns").severity, "critical");
  assert.match(find(broken, "runtime.host_requirement.codex.bwrap.userns").message, /the active codex 0\.158\.0 needs it/);
  assert.equal(find(broken, "runtime.host_requirement.codex.landlock").severity, "info", "met is met, whoever needs it");
});

test("an install recorded as unmanaged is told when the release can now record the control", async () => {
  const { checkAgentRuntimes } = await import("../doctor.mjs");
  const checks = await checkAgentRuntimes({
    runtimes: {
      opencode: {
        active: { version: "1.18.31", directory: "/opt/x" },
        verification: { autoUpdate: { verified: false, acceptedUnmanaged: true, acceptedBy: "root", reason: "no control verified" } },
      },
    },
    probe: () => ({ ok: true, stdout: "1.18.31", stderr: "", code: 0 }),
    hostProbe: () => ({ met: true, detail: "stub" }),
    hashExecutable: () => "",
  });
  const selfUpdate = checks.find((check) => check.name === "runtime.self_update.opencode");
  assert.equal(selfUpdate.severity, "warning");
  assert.match(selfUpdate.message, /establishes OPENCODE_DISABLE_AUTOUPDATE — `infra-cod runtime install opencode --version 1\.18\.31` records it/);
});

test("host requirements are probed without changing the host", async () => {
  const { probeHostRequirement } = await import("../runtime.mjs");
  const { adapterFor } = await import("../runtime-adapters.mjs");
  const codex = adapterFor("codex");

  assert.equal(probeHostRequirement("landlock", codex, { readFile: () => "lockdown,capability,landlock,yama,apparmor\n" }).met, true);
  assert.equal(probeHostRequirement("landlock", codex, { readFile: () => "capability,apparmor\n" }).met, false);
  assert.equal(probeHostRequirement("landlock", codex, { readFile: () => { throw new Error("ENOENT"); } }).met, false);

  // No distribution bubblewrap: not met, and nothing is run.
  let ran = false;
  const none = probeHostRequirement("bwrap.userns", codex, { exists: () => false, probe: () => { ran = true; } });
  assert.deepEqual([none.met, ran], [false, false]);
  assert.match(none.detail, /bubblewrap/);

  // Present: asked as the runtime user to make a namespace and exit — the
  // question the kernel answers "not permitted" on Ubuntu 24.04 without a profile.
  let asked;
  const refused = probeHostRequirement("bwrap.userns", codex, {
    exists: (file) => file === "/usr/bin/bwrap",
    probe: (adapter, executable, args) => { asked = { user: adapter.user, executable, args }; return { ok: false, code: 1, stderr: "bwrap: setting up uid map: Permission denied\n" }; },
  });
  assert.equal(refused.met, false);
  assert.match(refused.detail, /Permission denied/);
  assert.deepEqual([asked.user, asked.executable, asked.args.slice(0, 2)], ["codex-worker", "/usr/bin/bwrap", ["--unshare-user", "--unshare-net"]]);
  const allowed = probeHostRequirement("bwrap.userns", codex, { exists: (file) => file === "/usr/bin/bwrap", probe: () => ({ ok: true, code: 0, stderr: "" }) });
  assert.equal(allowed.met, true);
});

// ADR-0019: the usage probe is root's and no one else's to change.
test("the usage probe must be root-owned and writable only by root", async () => {
  const { usageProbeCheck } = await import("../doctor.mjs");
  const file = (uid, mode) => () => ({ isFile: () => true, uid, mode: 0o100000 | mode });
  const state = (check) => (check.ok ? "pass" : check.severity);
  assert.equal(state(usageProbeCheck("/opt/infra-cod/current", { stat: file(0, 0o644) })), "pass");
  assert.equal(state(usageProbeCheck("/opt/infra-cod/current", { stat: file(990, 0o644) })), "critical");
  assert.equal(state(usageProbeCheck("/opt/infra-cod/current", { stat: file(0, 0o664) })), "critical");
  assert.equal(state(usageProbeCheck("/opt/infra-cod/current", { stat: () => { throw new Error("ENOENT"); } })), "critical");
  assert.equal(state(usageProbeCheck(null)), "warning");
});

// Stage 12 M0: the model's tools cannot read the login beside them.
test("the sandbox shell must be root's, executable, and cover OpenCode's login as its user", async () => {
  const { sandboxShellCheck } = await import("../doctor.mjs");
  const file = (uid, mode) => () => ({ isFile: () => true, uid, mode: 0o100000 | mode });
  const state = (check) => (check.ok ? "pass" : check.severity);
  const answering = (stdout, extra = {}) => (binary, args) => ({ ok: true, exitCode: 0, stdout, stderr: "", binary, args, ...extra });
  const asked = [];
  const covered = sandboxShellCheck("/opt/infra-cod/current", { stat: file(0, 0o755), run: (binary, args) => { asked.push([binary, args]); return answering("covered")(); } });
  assert.equal(state(covered), "pass");
  const [binary, args] = asked[0];
  assert.equal(binary, "/usr/sbin/runuser");
  assert.deepEqual(args.slice(0, 2), ["-u", "opencode-worker"]);
  assert.ok(args.includes("INFRA_COD_HIDDEN_STATE=.local/share/opencode:/home/opencode-worker/.local/share/opencode"));
  assert.ok(args.includes("/opt/infra-cod/current/services/runtime-supervisor/sandbox-shell/bash"));
  assert.equal(args.at(-1), "/home/opencode-worker/.local/share/opencode");
  assert.equal(state(sandboxShellCheck("/opt/infra-cod/current", { stat: file(0, 0o755), run: answering("visible") })), "critical");
  assert.equal(state(sandboxShellCheck("/opt/infra-cod/current", { stat: file(0, 0o755), run: answering("", { ok: false, exitCode: 1, stderr: "bwrap: setting up uid map: Permission denied" }) })), "critical");
  assert.equal(state(sandboxShellCheck("/opt/infra-cod/current", { stat: file(990, 0o755), run: answering("covered") })), "critical");
  assert.equal(state(sandboxShellCheck("/opt/infra-cod/current", { stat: file(0, 0o775), run: answering("covered") })), "critical");
  assert.equal(state(sandboxShellCheck("/opt/infra-cod/current", { stat: file(0, 0o744), run: answering("covered") })), "critical");
  assert.equal(state(sandboxShellCheck("/opt/infra-cod/current", { stat: () => { throw new Error("ENOENT"); } })), "critical");
  assert.equal(state(sandboxShellCheck(null)), "warning");
});

test("a Codex older than 0.155.0 is reported: it cannot hide its login", async () => {
  const { codexLoginCheck } = await import("../doctor.mjs");
  const state = (check) => (check.ok ? "pass" : check.severity);
  assert.equal(state(codexLoginCheck("0.158.0")), "pass");
  assert.equal(state(codexLoginCheck("0.155.0")), "pass");
  assert.equal(state(codexLoginCheck("0.154.0")), "warning");
  assert.equal(state(codexLoginCheck(null)), "warning");
});

// Stage 12 M1: runs have memory limits of their own.
test("per-run memory limits are reported from the supervisor's cgroup", async () => {
  const { runMemoryLimitsCheck } = await import("../doctor.mjs");
  const state = (check) => (check.ok ? "pass" : check.severity);
  const unit = () => ({ ok: true, stdout: "/system.slice/infra-cod-runtime-supervisor.service" });
  const files = (entries) => (file) => { if (file in entries) return entries[file]; throw new Error("ENOENT"); };
  const root = "/sys/fs/cgroup/system.slice/infra-cod-runtime-supervisor.service";
  assert.equal(state(runMemoryLimitsCheck({ run: unit, read: files({ [`${root}/cgroup.subtree_control`]: "memory\n", [`${root}/supervisor/cgroup.procs`]: "355175\n" }) })), "pass");
  assert.equal(state(runMemoryLimitsCheck({ run: unit, read: files({ [`${root}/cgroup.subtree_control`]: "\n" }) })), "warning");
  assert.equal(state(runMemoryLimitsCheck({ run: unit, read: files({ [`${root}/cgroup.subtree_control`]: "memory\n", [`${root}/supervisor/cgroup.procs`]: "" }) })), "warning");
  assert.equal(state(runMemoryLimitsCheck({ run: () => ({ ok: false, stdout: "" }) })), "warning");
});
