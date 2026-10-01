// Runtime provisioning, against a registry that behaves like npm's.
//
// The signature, the integrity and the archive checks are the production code
// running on bytes this suite produced, so a test that expects a refusal is
// watching the real check refuse — not a mock returning false.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildPackageTarball, createRuntimeHost, harnessPrerequisites } from "./runtime-harness.mjs";
import { adapterFor, assertExactVersion, runtimeNames } from "../runtime-adapters.mjs";
import { executableDigest } from "../runtime-inventory.mjs";
import {
  applyAutoUpdatePolicy,
  assertSafeArchiveMembers,
  requireAutoUpdatePolicy,
  authenticationOf,
  loginRuntime,
  runtimeEnvironment,
  rootTableHas,
  rootTomlWithSetting,
  verifyIntegrity,
  verifyRegistrySignature,
} from "../runtime.mjs";

const missing = harnessPrerequisites();
const options = missing.length > 0 ? { skip: `missing: ${missing.join(", ")}` } : {};

const CODEX = { name: "codex", version: "0.154.0", package: "@openai/codex", packageVersion: "0.154.0-linux-x64" };

function withHost(body) {
  return async () => {
    const host = await createRuntimeHost();
    try {
      await body(host);
    } finally {
      await host.destroy();
    }
  };
}

function publishCodex(host, { version = CODEX.version, prints = version, extraMembers = [], links = [], tarball = null, ...rest } = {}) {
  const adapter = adapterFor("codex");
  const built = tarball ?? buildPackageTarball(host.base, { executablePath: adapter.executablePath, prints, extraMembers, links });
  host.publish({ name: CODEX.package, version: `${version}-linux-x64`, tarball: built, ...rest });
  return built;
}

// ---------------------------------------------------------------------------
// The contract, without a host
// ---------------------------------------------------------------------------

test("only an exact version is accepted", () => {
  assert.equal(assertExactVersion("0.154.0"), "0.154.0");
  assert.equal(assertExactVersion("1.18.30"), "1.18.30");
  for (const refused of ["latest", "^1.2.3", "~1.2", "1.x", "next", ""]) {
    assert.throws(() => assertExactVersion(refused), /exact version/, `${JSON.stringify(refused)} must be refused`);
  }
});

test("the executable is taken from the package that contains it, not the one people install", () => {
  // `@openai/codex` and `opencode-ai` are platform selectors of a few kilobytes.
  // Installing them would mean installing something whose only job is to choose
  // what a release already knows — and, for opencode, running a postinstall
  // script to do it.
  assert.deepEqual(adapterFor("codex").packageFor("0.154.0"), { name: "@openai/codex", version: "0.154.0-linux-x64" });
  assert.deepEqual(adapterFor("opencode").packageFor("1.18.30"), { name: "opencode-linux-x64", version: "1.18.30" });
  // Claude Code's wrapper runs a postinstall to pick a platform; this is the
  // platform package, whose binary the host's install found at package/claude.
  assert.deepEqual(adapterFor("claude").packageFor("2.1.270"), { name: "@anthropic-ai/claude-code-linux-x64", version: "2.1.270" });
  assert.deepEqual(runtimeNames().sort(), ["claude", "codex", "opencode"]);
});

test("a runtime silenced by its environment carries the switches on every start, and signs in on the host", () => {
  // Claude Code checks two variables before anything else; with both set
  // `claude update` refused on the production host (probe 60). There is no
  // file to write, so the control is applied by passing them — to the driver's
  // runs and to every probe — and recorded as verified at the pinned version.
  const claude = adapterFor("claude");
  assert.equal(claude.autoUpdate.mechanism, "environment");
  assert.deepEqual(runtimeEnvironment(claude), ["DISABLE_AUTOUPDATER=1", "DISABLE_UPDATES=1"]);
  assert.deepEqual(applyAutoUpdatePolicy(claude), {
    disabled: true, verified: true, mechanism: "environment", setting: claude.autoUpdate.setting, source: claude.autoUpdate.verifiedAgainst,
  });
  assert.deepEqual(runtimeEnvironment(adapterFor("codex")), [], "a config-file control adds nothing to the environment");
  assert.equal(applyAutoUpdatePolicy({ autoUpdate: { mechanism: "environment", environment: [] } }).verified, false);
  // Its credential is the login file, tested and never read; its exit code is
  // not trusted.
  assert.deepEqual(claude.authEvidence.path, ".claude/.credentials.json");
  // `runtime login` is for a runtime that has its own login; the others sign
  // in from the panel and are refused by name.
  assert.deepEqual(claude.login, ["auth", "login"]);
  assert.throws(() => loginRuntime("codex"), /signed in from the panel/);
});

test("every adapter names the user, the home and the way to silence self-updates", () => {
  for (const name of runtimeNames()) {
    const adapter = adapterFor(name);
    assert.ok(adapter.user && adapter.home.startsWith("/home/"), `${name} must run as its own user`);
    assert.ok(adapter.credentialState.startsWith(adapter.home), `${name}'s credentials belong inside its home`);
    // A runtime either has a verified way to be told not to update itself, or
    // says it has none. What it may not do is name a control nobody confirmed:
    // `CODEX_DISABLE_UPDATE_CHECK` was invented here, appears nowhere in the
    // pinned release, and the test that asserted we passed it proved only that
    // we passed something.
    if (adapter.autoUpdate.mechanism) {
      assert.ok(adapter.autoUpdate.verifiedAgainst, `${name}'s auto-update control must name the source it was verified against`);
      assert.match(adapter.autoUpdate.verifiedAgainst, /\S+\/\S+/, "and that source must be a place somebody can go and look");
    } else {
      assert.ok(adapter.autoUpdate.reason, `${name} must say why it has no verified auto-update control`);
    }
    assert.ok(adapter.executablePath.startsWith("package/"), "npm tarballs put everything under package/");
  }
});

test("a root-table setting is placed in the root table, whatever the file looks like", () => {
  const place = (contents) => rootTomlWithSetting(contents, "check_for_update_on_startup", false);
  const effective = (contents) => rootTableHas(place(contents), "check_for_update_on_startup", false);

  assert.ok(effective(""), "an empty file");
  assert.ok(effective('model = "gpt-5"\n'), "root settings only");
  // The case that made appending wrong: the file ends inside a table, so a line
  // added at the end becomes that table's field — with the right name, in the
  // wrong scope, and grep-visible either way.
  assert.ok(effective('model = "gpt-5"\n\n[mcp_servers.foo]\ncommand = "x"\n'), "ends inside a table");
  assert.ok(effective('[mcp_servers.foo]\ncheck_for_update_on_startup = true\n'), "the same key inside a table");

  // A setting already at the root is replaced rather than duplicated, and one
  // inside a table is left exactly where it is: same name, different setting.
  const rewritten = place("check_for_update_on_startup = true\n[a]\ncheck_for_update_on_startup = true\n");
  assert.equal(rewritten.match(/check_for_update_on_startup/g).length, 2);
  assert.match(rewritten.split(/^\[a\]$/m)[1], /check_for_update_on_startup = true/);
});

test("an archive that reaches outside package/ is refused", () => {
  assert.equal(assertSafeArchiveMembers("package/\npackage/bin/codex"), 2);
  for (const [label, listing] of [
    ["an absolute member", "/etc/cron.d/evil"],
    ["a parent reference", "package/../../etc/passwd"],
    ["a second top level", "package/bin/codex\nelsewhere/x"],
  ]) {
    assert.throws(() => assertSafeArchiveMembers(listing), /archive contains/, `${label} must be refused`);
  }
});

test("integrity is checked against sha512, and nothing weaker is accepted", async () => {
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("a runtime");
  const correct = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(verifyIntegrity(bytes, correct).sha512, correct.slice("sha512-".length));
  assert.throws(() => verifyIntegrity(Buffer.from("another runtime"), correct), /does not match the integrity/);
  assert.throws(() => verifyIntegrity(bytes, "sha1-abc"), /unsupported integrity algorithm/);
});

// ---------------------------------------------------------------------------
// Installing, on a sandboxed host
// ---------------------------------------------------------------------------

test("install verifies, stages, smoke-tests as the runtime user, then switches", options, withHost(async (host) => {
  publishCodex(host);

  const result = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(result.code, 0, result.stderr);

  // The executable is on PATH, and it points into the version that was asked for.
  const target = host.activeTarget("codex");
  assert.ok(target.includes(`/runtimes/codex/${CODEX.version}/`), `expected the link to name the version, got ${target}`);
  assert.deepEqual(host.installedVersions("codex"), [CODEX.version]);

  // The smoke test ran as codex-worker, through env -i, with the update check off.
  const log = host.runuserLog();
  assert.match(log, /^codex-worker /m, "the smoke test must run as the runtime's own user");
  assert.match(log, /env -i/, "and with a scrubbed environment");
  assert.doesNotMatch(log, /CODEX_DISABLE_UPDATE_CHECK/, "no invented environment variable is passed");
  assert.match(log, /PATH=\/usr\/local\/bin:\/opt\/node\/bin:\/usr\/bin:\/bin/, "and with the runtime PATH the supervisor uses");

  // The record says where it came from and what was checked, and holds nothing
  // that could be a credential.
  const entry = host.runtimes().runtimes.codex;
  assert.equal(entry.active.version, CODEX.version);
  assert.equal(entry.user, "codex-worker");
  assert.equal(entry.installed[0].source.package, `${CODEX.package}@${CODEX.packageVersion}`);
  assert.match(entry.installed[0].digest.sha256, /^[0-9a-f]{64}$/);
  assert.equal(entry.installed[0].actor, "harness");
  assert.doesNotMatch(JSON.stringify(entry), /token|secret|password|api_?key/i);
}));

test("a package signed by the wrong key is refused before anything is unpacked", options, withHost(async (host) => {
  publishCodex(host, { signWith: host.wrongKey() });

  const result = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /signature .* does not verify against the pinned key/);
  assert.deepEqual(host.installedVersions("codex"), [], "nothing may be staged from an unverified package");
  assert.equal(host.activeTarget("codex"), null);
}));

test("a tarball that does not match its signed integrity is refused", options, withHost(async (host) => {
  // The metadata is signed correctly, over an integrity that belongs to
  // different bytes: the registry vouched for a package this is not.
  const adapter = adapterFor("codex");
  const other = buildPackageTarball(host.base, { executablePath: adapter.executablePath, prints: "9.9.9" });
  const { createHash } = await import("node:crypto");
  const foreign = `sha512-${createHash("sha512").update(readFileSync(other)).digest("base64")}`;
  publishCodex(host, { integrityOverride: foreign });

  const result = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /does not match the integrity/);
  assert.deepEqual(host.installedVersions("codex"), []);
}));

test("a binary the runtime user cannot execute fails the install, and changes nothing", options, withHost(async (host) => {
  publishCodex(host);
  // Stage 10 ended with a `doctor` that reported a binary as working which the
  // runtime user could not run, because the check ran as root. The smoke test
  // asks the question as the user who will actually run it.
  host.refuseUser("codex-worker");

  const result = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /did not pass its smoke test as codex-worker/);
  assert.deepEqual(host.installedVersions("codex"), [], "a failed smoke test leaves nothing behind");
  assert.equal(host.activeTarget("codex"), null);
}));

test("a binary that reports the wrong version fails the install", options, withHost(async (host) => {
  // The package claims one version and the executable another. Whatever that is,
  // it is not the version the operator asked for.
  publishCodex(host, { prints: "0.153.0" });

  const result = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /does not contain 0\.154\.0/);
  assert.deepEqual(host.installedVersions("codex"), []);
}));

test("a failed install leaves the previously active version serving", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  const before = host.activeTarget("codex");

  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });
  host.refuseUser("codex-worker");
  const failed = await host.cli(["runtime", "install", "codex", "--version", "0.155.0"]);
  assert.equal(failed.code, 1);

  assert.equal(host.activeTarget("codex"), before, "the active version must not move when a new one fails");
  assert.deepEqual(host.installedVersions("codex"), [CODEX.version]);
}));

test("list reports the four states separately, and does not pretend about the last two", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  const listed = await host.cli(["runtime", "list", "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  const report = JSON.parse(listed.stdout);
  const codex = report.find((entry) => entry.runtime === "codex");
  assert.equal(codex.installed, true);
  // The fixture answers `auth list` successfully, so it reads as authenticated.
  assert.equal(typeof codex.authenticated, "boolean");
  // Capability verification belongs to the gate, and has not run. Saying
  // otherwise would be a claim about a model nobody asked.
  assert.equal(codex.capabilityVerified, false);
  assert.equal(codex.ready, false);

  const opencode = report.find((entry) => entry.runtime === "opencode");
  assert.equal(opencode.installed, false, "a runtime nobody installed is not installed");
}));

test("the active version cannot be removed, and an inactive one can", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", "0.155.0"])).code, 0);
  assert.deepEqual(host.installedVersions("codex"), ["0.154.0", "0.155.0"]);

  const refused = await host.cli(["runtime", "remove", "codex", "--version", "0.155.0"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /is the active version/);

  const removed = await host.cli(["runtime", "remove", "codex", "--version", CODEX.version]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(host.installedVersions("codex"), ["0.155.0"]);
  assert.ok(host.activeTarget("codex").includes("0.155.0"), "the active version is untouched");
}));

test("installing twice is the same installation, not two", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  const first = host.runtimes().runtimes.codex.active;

  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  assert.deepEqual(host.installedVersions("codex"), [CODEX.version]);
  assert.deepEqual(host.runtimes().runtimes.codex.active, first);
}));

test("the pinned key is read from the release, not from the registry", options, withHost(async (host) => {
  // The registry serves the package; if it also supplied the key that vouches
  // for it, whoever replaced one would replace the other.
  const pinned = path.join(host.release, "release/keys/npm-registry.pub");
  assert.ok(existsSync(pinned), "the release carries the key");
  assert.match(readFileSync(pinned, "utf8"), /BEGIN PUBLIC KEY/);
}));

test("a signature under an unexpected key id is refused before the maths is attempted", async () => {
  const { createSign, generateKeyPairSync } = await import("node:crypto");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const key = publicKey.export({ type: "spki", format: "pem" });
  const message = "@openai/codex@0.154.0-linux-x64:sha512-abc";
  const sign = (keyid) => ({
    name: "@openai/codex",
    version: "0.154.0-linux-x64",
    integrity: "sha512-abc",
    signatures: [{ keyid, sig: createSign("SHA256").update(message).sign(privateKey).toString("base64") }],
  });

  const pinned = "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U";
  assert.equal(verifyRegistrySignature(sign(pinned), { key, keyId: pinned }).keyId, pinned);
  // Valid maths, wrong signer: a signature that verifies under a key nobody
  // pinned is a signature from somebody else.
  assert.throws(() => verifyRegistrySignature(sign("SHA256:somebody-else"), { key, keyId: pinned }), /no signature from the pinned registry key/);
});

test("readiness is a bounded answer: states and a version, never a path or a digest", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  // This is what the health snapshot puts in the database for the panel to read,
  // which is the whole reason the panel never opens /etc/infra-cod/runtimes.json.
  // It must carry what an operator needs to decide, and nothing that would make
  // the snapshot a second copy of the provisioning record.
  const listed = JSON.parse((await host.cli(["runtime", "list", "--json"])).stdout);
  const codex = listed.find((entry) => entry.runtime === "codex");
  for (const field of ["installed", "authenticated", "capabilityVerified", "ready"]) {
    assert.equal(typeof codex[field], "boolean", `${field} must be a plain state`);
  }
  assert.equal(codex.version, CODEX.version);

  const readiness = { ...codex };
  delete readiness.record;
  const serialised = JSON.stringify(readiness);
  assert.doesNotMatch(serialised, /\/opt\/infra-cod|sha256|sha512|integrity/, "no paths and no digests");
}));

// ---------------------------------------------------------------------------
// The findings from the review of this branch
// ---------------------------------------------------------------------------

test("a registry answer for a different package is refused, however well signed", options, withHost(async (host) => {
  // Verifying the signature over the name and version the *answer* chose proves
  // the registry signed something. It does not prove it signed what was asked
  // for: a request for Codex could be answered with a perfectly signed OpenCode,
  // and every later check would have been performed against the impostor's own
  // identity.
  const adapter = adapterFor("codex");
  const tarball = buildPackageTarball(host.base, { executablePath: adapter.executablePath, prints: "9.9.9" });
  host.publish({ name: CODEX.package, version: CODEX.packageVersion, tarball, impersonate: { name: "opencode-linux-x64", version: "9.9.9" } });

  const result = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /answered with opencode-linux-x64@9\.9\.9/);
  assert.deepEqual(host.installedVersions("codex"), []);
}));

test("an executable that is a symlink is refused, however contained it is", options, withHost(async (host) => {
  const adapter = adapterFor("codex");
  // A link at `package/bin/codex` aimed inside the package passes containment,
  // and everything after extraction follows it: chmod changes the target's mode,
  // and the smoke test runs the target. The executable is checked for being a
  // regular file, not merely for resolving somewhere acceptable.
  const linked = buildPackageTarball(host.base, {
    executablePath: "package/lib/real-codex",
    prints: CODEX.version,
    links: [{ path: adapter.executablePath, target: "../lib/real-codex" }],
  });
  host.publish({ name: CODEX.package, version: CODEX.packageVersion, tarball: linked });

  const result = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /regular file|symlink|link/i);
  assert.equal(host.activeTarget("codex"), null);
}));

test("re-installing the active version never leaves the command on PATH dangling", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  const target = host.activeTarget("codex");
  assert.ok(existsSync(target), "the active executable exists");

  // The same version again, and this time its smoke test fails. The first
  // version of this deleted the tree before the smoke test ran, so a failure
  // left /usr/local/bin/codex pointing at nothing at all.
  publishCodex(host);
  host.refuseUser("codex-worker");
  const failed = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(failed.code, 1);

  assert.equal(host.activeTarget("codex"), target, "the link must still name the same executable");
  assert.ok(existsSync(target), "and that executable must still be there");
}));

test("a runtime in use is never replaced, however the caller asks", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  host.setRunningProcesses("codex-worker", ["4242", "4243"]);
  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });

  // The earlier version offered `--interrupt-active`, which interrupted nothing:
  // it swapped the tree out from under processes that kept running against it.
  // There is no flag now. Either the runtime is idle or the install waits, and a
  // caller who will not wait is told to stop the sessions themselves.
  const refused = await host.cli(["runtime", "install", "codex", "--version", "0.155.0"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /2 codex process\(es\) are running/);
  assert.deepEqual(host.installedVersions("codex"), [CODEX.version]);

  const waited = await host.cli(["runtime", "install", "codex", "--version", "0.155.0", "--wait", "1"]);
  assert.equal(waited.code, 1, "waiting does not make a busy runtime idle");
  assert.deepEqual(host.installedVersions("codex"), [CODEX.version]);

  host.setRunningProcesses("codex-worker", []);
  const done = await host.cli(["runtime", "install", "codex", "--version", "0.155.0", "--wait", "1"]);
  assert.equal(done.code, 0, done.stderr);
}));

test("the same version installed again is a new immutable tree, or nothing at all", options, withHost(async (host) => {
  // The same tarball twice: `tar` stamps mtimes, so rebuilding the fixture would
  // produce different bytes and a different question.
  const tarball = publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  const first = host.activeTarget("codex");

  // Byte-identical: there is nothing to do, and doing nothing is the one
  // reinstall with no window in which the command on PATH names a tree being
  // written.
  publishCodex(host, { tarball });
  const again = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(host.installedVersions("codex"), [CODEX.version]);
  assert.equal(host.activeTarget("codex"), first);

  // A different payload under the same version number goes into its own
  // directory, and the link moves in one atomic step. The tree that was serving
  // is never the tree being written.
  publishCodex(host, { prints: CODEX.version, extraMembers: [{ path: "package/NOTICE", content: "different" }] });
  const rebuilt = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(rebuilt.code, 0, rebuilt.stderr);
  assert.notEqual(host.activeTarget("codex"), first, "a different payload must not reuse the live directory");
  assert.ok(existsSync(host.activeTarget("codex")), "and the link must name something that exists");
}));

test("the inventory remembers every version on disk, not only the newest", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", "0.155.0"])).code, 0);

  // Two trees on disk and a record that knows about one is a version nobody will
  // ever be asked to remove.
  assert.deepEqual(host.installedVersions("codex"), ["0.154.0", "0.155.0"]);
  const entry = host.runtimes().runtimes.codex;
  assert.deepEqual(entry.installed.map((installed) => installed.version), ["0.154.0", "0.155.0"]);
  assert.equal(entry.active.version, "0.155.0");
}));

test("the probe runs in the working directory it names", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  // `PWD` is a string in an environment; it does not move a process. The
  // supervisor passes a real cwd, so the probe must too — otherwise it measures
  // a runtime somewhere the runtime never runs.
  const log = host.runuserLog();
  assert.match(log, /PWD=\/home\/codex-worker/, "it still announces the directory");
  assert.match(host.probeWorkingDirectories(), /home\/codex-worker/, "and it is actually in it");
}));

test("an auto-update control is applied when verified, and reported when not", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  const record = host.runtimes().runtimes.codex.verification.autoUpdate;
  assert.equal(record.verified, true);
  assert.equal(record.setting, "check_for_update_on_startup");
  assert.match(record.source, /openai\/codex rust-v0\.154\.0/);
  assert.match(host.runtimeConfig("codex-worker", ".codex/config.toml"), /check_for_update_on_startup = false/);
}));

test("link targets are judged from the listing, before anything is written", options, withHost(async (host) => {
  const adapter = adapterFor("codex");
  const escaping = buildPackageTarball(host.base, {
    executablePath: adapter.executablePath,
    prints: CODEX.version,
    links: [{ path: "package/lib/outside", target: "/etc/passwd" }],
  });
  host.publish({ name: CODEX.package, version: CODEX.packageVersion, tarball: escaping });

  const result = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /link that leaves the package/);

  // The point of checking the listing rather than the tree: extraction is the
  // step that creates the link. If the refusal came afterwards, the link existed
  // on disk for as long as it took to notice.
  assert.deepEqual(host.installedVersions("codex"), [], "nothing may be left behind");
}));

test("a link to something the package does not ship is refused", options, withHost(async (host) => {
  const adapter = adapterFor("codex");
  const dangling = buildPackageTarball(host.base, {
    executablePath: adapter.executablePath,
    prints: CODEX.version,
    links: [{ path: "package/bin/helper", target: "../lib/helper.js" }],
  });
  host.publish({ name: CODEX.package, version: CODEX.packageVersion, tarball: dangling });

  // It stays inside the package, so containment says nothing. What it resolves
  // to is decided by whoever writes `package/lib/helper.js` first.
  const result = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /link to something it does not ship/);
  assert.deepEqual(host.installedVersions("codex"), []);
}));

test("the auto-update setting lands in the root table, not in whatever table the file ends with", options, withHost(async (host) => {
  publishCodex(host);
  // A config that ends inside a table is the ordinary case: anyone with an MCP
  // server configured has one. Appending the setting would make it a field of
  // that table — invisible to Codex, and visible to grep.
  host.writeRuntimeConfig("codex-worker", ".codex/config.toml", [
    'model = "gpt-5"',
    "",
    "[mcp_servers.local]",
    'command = "/usr/local/bin/thing"',
    "",
  ].join("\n"));

  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  const config = host.runtimeConfig("codex-worker", ".codex/config.toml");
  const beforeFirstTable = config.split(/^\s*\[/m)[0];
  assert.match(beforeFirstTable, /check_for_update_on_startup = false/, "the setting belongs to no table");
  assert.match(config, /\[mcp_servers\.local\]/, "and the existing configuration survives");
  assert.match(config, /command = "\/usr\/local\/bin\/thing"/);
}));

test("OpenCode's self-update is stopped by the variable its pinned source reads", options, withHost(async (host) => {
  const adapter = adapterFor("opencode");
  const tarball = buildPackageTarball(host.base, { executablePath: adapter.executablePath, prints: "0.4.0" });
  host.publish({ name: "opencode-linux-x64", version: "0.4.0", tarball });

  // Stage 12 W1: the control was read from anomalyco/opencode at v1.18.31, so
  // an install needs no --accept-unmanaged-updates any more, and the record
  // names where the control was shown.
  const installed = await host.cli(["runtime", "install", "opencode", "--version", "0.4.0"]);
  assert.equal(installed.code, 0, installed.stderr);
  const record = host.runtimes().runtimes.opencode.verification.autoUpdate;
  assert.deepEqual([record.verified, record.mechanism, record.setting], [true, "environment", "OPENCODE_DISABLE_AUTOUPDATE"]);
  assert.match(record.source, /anomalyco\/opencode v1\.18\.31: packages\/opencode\/src\/cli\/upgrade\.ts/);
  assert.deepEqual(runtimeEnvironment(adapter), ["OPENCODE_DISABLE_AUTOUPDATE=true"], "and every probe carries it");
}));

test("a runtime with no self-update control is refused unless the operator says so", () => {
  // No runtime in the registry lacks a control since W1; the rule stays, and is
  // held here against an adapter that has none.
  const bare = { name: "bare", autoUpdate: { mechanism: null, reason: "no control verified" } };
  const steps = [];
  const reporter = { step: (line) => steps.push(line) };
  let discarded = false;
  assert.throws(
    () => requireAutoUpdatePolicy(bare, { reporter, onRefuse: () => { discarded = true; } }),
    /self-update cannot be disabled: no control verified\..*--accept-unmanaged-updates/s,
  );
  assert.equal(discarded, true, "and the staged tree is discarded");
  const accepted = requireAutoUpdatePolicy(bare, { acceptUnmanaged: true, reporter });
  assert.deepEqual([accepted.verified, accepted.acceptedUnmanaged], [false, true]);
  assert.match(steps.at(-1), /WARNING: installing with self-update unmanaged/);
});

test("the executable's digest is recorded, and a reused tree must still be the package's", options, withHost(async (host) => {
  const adapter = adapterFor("codex");
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  const entry = host.runtimes().runtimes.codex;
  const executable = path.join(entry.active.directory, adapter.executablePath);
  const recorded = entry.installed.find((installed) => installed.directory === entry.active.directory).executableSha256;
  assert.match(recorded, /^[0-9a-f]{64}$/);
  assert.equal(recorded, executableDigest(executable));

  // The same version again reuses the tree — only if its bytes are still the
  // package's. A tree changed on disk is refused by name, and stays inactive.
  writeFileSync(executable, "#!/bin/sh\necho tampered\n");
  const refused = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /its executable is not the one the signed package carries/);
}));

test("a missing runtime home is a refusal, not a probe run from somewhere else", options, withHost(async (host) => {
  publishCodex(host);
  host.removeRuntimeHome("codex-worker");

  // Falling back to the caller's cwd hands the child root's working directory
  // while still announcing the runtime home in PWD: every relative path the
  // runtime touches lands somewhere production never puts it.
  const result = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /home\/codex-worker does not exist/);
  assert.doesNotMatch(host.probeWorkingDirectories(), /opt\/infra-cod/, "and no probe ran from the release tree");
}));

test("a runtime's configuration never passes through a command line", options, withHost(async (host) => {
  publishCodex(host);
  // /proc/<pid>/cmdline is world-readable on an ordinary Linux host. A config
  // that travels in argv is a config every local user can read out of the
  // process table — including the other runtime's user.
  host.writeRuntimeConfig("codex-worker", ".codex/config.toml", [
    'model = "gpt-5"',
    "",
    "[mcp_servers.private]",
    'command = "/opt/secrets/launch --token hunter2-not-ours-to-broadcast"',
    "",
  ].join("\n"));

  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  const argv = host.runuserLog();
  assert.doesNotMatch(argv, /hunter2-not-ours-to-broadcast/, "not in plain text");
  // base64 encodes three bytes at a time, so a substring's encoding depends on
  // where it starts. All three alignments are checked, with the partial
  // characters at either end trimmed — otherwise this assertion passes by
  // arithmetic rather than by the content being absent.
  const secret = "hunter2-not-ours-to-broadcast";
  for (let shift = 0; shift < 3; shift += 1) {
    const aligned = Buffer.concat([Buffer.alloc(shift, 0x41), Buffer.from(secret, "utf8")])
      .toString("base64")
      .slice(Math.ceil((shift * 4) / 3) + 1)
      .replace(/=+$/, "")
      .slice(0, -1);
    assert.doesNotMatch(argv, new RegExp(aligned.replace(/[+/]/g, "\\$&")), `and not base64'd at offset ${shift}`);
  }

  // The setting still arrived, and the rest of the file is intact.
  const config = host.runtimeConfig("codex-worker", ".codex/config.toml");
  assert.match(config.split(/^\s*\[/m)[0], /check_for_update_on_startup = false/);
  assert.match(config, /hunter2-not-ours-to-broadcast/, "the operator's own configuration is not rewritten away");
}));

test("a rebuilt package of the same version leaves no tree the record has forgotten", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  const first = host.runtimes().runtimes.codex.active.directory;

  // A different payload under the same version number: a new immutable
  // directory, because the old one must not be rewritten under the link.
  publishCodex(host, { extraMembers: [{ path: "package/NOTICE", content: "rebuilt" }] });
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  const second = host.runtimes().runtimes.codex.active.directory;
  assert.notEqual(second, first);

  // Both trees are on disk, so both must be in the record. Keying `installed` by
  // version dropped the first one, and a tree nothing knows about is a tree
  // nobody will ever be asked to remove.
  const directories = host.runtimes().runtimes.codex.installed.map((installed) => installed.directory);
  assert.deepEqual([...directories].sort(), [first, second].sort());

  // And the active version number must not shield its own superseded trees from
  // removal: they are inactive, and being inactive is a property of a directory.
  const removed = await host.cli(["runtime", "remove", "codex", "--version", CODEX.version]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.ok(!existsSync(first), "the superseded tree is gone");
  assert.ok(existsSync(host.activeTarget("codex")), "and the active one is still serving");
  assert.deepEqual(host.runtimes().runtimes.codex.installed.map((i) => i.directory), [second]);
}));

test("an install that cannot be recorded does not leave a different runtime on PATH", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  const serving = host.activeTarget("codex");

  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });

  // The switch happens before the record. A failure in between used to leave the
  // new binary active under the old inventory while the command reported
  // failure — every later reader describing a host that no longer existed.
  const failed = await host.cli(["runtime", "install", "codex", "--version", "0.155.0"], {
    extraEnv: { INFRA_COD_HARNESS_FAIL_INVENTORY_WRITE: "1" },
  });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /could not be written/);
  assert.equal(host.activeTarget("codex"), serving, "the link is back where it was");

  // The record was never touched — the write is what failed — so once the
  // inventory is reachable again it must still describe the running host.
  assert.equal(host.runtimes().runtimes.codex.active.version, CODEX.version, "and the record still matches it");
}));

test("an unanswerable process check stops the install rather than assuming idle", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });
  // exit 1 means "no matches"; anything else means the question was not
  // answered. Reading them all as "nothing is running" is fail-open exactly when
  // the host has stopped being able to tell us.
  host.breakProcessCheck(2);

  const result = await host.cli(["runtime", "install", "codex", "--version", "0.155.0"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /could not be determined/);
  assert.deepEqual(host.installedVersions("codex"), [CODEX.version]);
}));

test("the fence holds one runtime's launches and leaves the other alone", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  // The earlier version stopped infra-cod-runtime-supervisor.service. That unit
  // is shared, and its shutdown terminates every child channel — so installing
  // Codex would have killed a live OpenCode session, which is the exact harm the
  // rule exists to prevent.
  assert.doesNotMatch(host.systemctlLog(), /stop infra-cod-runtime-supervisor/, "the shared unit is never stopped");

  // Held during the switch, admitting again after it, and OpenCode never paused.
  assert.equal(host.admissionOf("codex").paused, false, "codex is admitting launches again");
  assert.equal(host.admissionOf("opencode").paused, false, "opencode was never fenced at all");
}));

test("an install waits for open launches instead of ending them", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });
  host.setInFlight("codex", 2);

  const refused = await host.cli(["runtime", "install", "codex", "--version", "0.155.0"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /2 codex launch\(es\) are still open/);
  assert.deepEqual(host.installedVersions("codex"), [CODEX.version], "nothing was replaced");

  // And the fence is released even though the install gave up: a runtime left
  // unable to launch is worse than the race being closed.
  assert.equal(host.admissionOf("codex").paused, false);
}));

test("a failed switch still leaves the runtime able to launch", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });
  const failed = await host.cli(["runtime", "install", "codex", "--version", "0.155.0"], {
    extraEnv: { INFRA_COD_HARNESS_FAIL_INVENTORY_WRITE: "1" },
  });
  assert.equal(failed.code, 1);
  assert.equal(host.admissionOf("codex").paused, false, "the fence is released however the install ended");
}));

test("a supervisor that refuses to resume does not leave the runtime fenced", options, withHost(async (host) => {
  publishCodex(host);
  host.refuseResume("codex");

  // The polite request fails, but the fence belongs to the connection, and the
  // connection is closed on the way out. What matters is that this is verified
  // over a fresh connection rather than assumed.
  const result = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(host.admissionOf("codex").paused, false, "the runtime can launch again");
}));

test("a fence lost mid-install stops the switch instead of proceeding without one", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });
  const serving = host.activeTarget("codex");

  // The supervisor restarts while the install is preparing. The old design kept
  // going: the pause was gone, this process did not know, and it moved the
  // symlink with no fence at all — the worse of the two failure directions.
  host.restartSupervisorDuring("codex");

  const result = await host.cli(["runtime", "install", "codex", "--version", "0.155.0"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /fence is gone|no longer fenced|connection to the supervisor closed/);
  assert.equal(host.activeTarget("codex"), serving, "nothing was switched");
  assert.deepEqual(host.installedVersions("codex"), [CODEX.version], "and nothing was left staged");
}));

test("an installer that dies does not leave the runtime fenced off forever", options, withHost(async (host) => {
  // The fence is held by a connection, so there is no state that outlives the
  // process holding it. A plain map, asked over short-lived connections, left a
  // runtime paused with nothing able to release it.
  const link = await host.holdFence("codex");
  assert.equal(host.admissionOf("codex").paused, true);

  link.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(host.admissionOf("codex").paused, false, "the fence went with the connection");
}));

test("an interrupted switch is visible to verify and repaired by reconcile", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });

  // The inventory write fails after the link has moved, and the rollback is
  // denied too — which is what a SIGKILL between the two looks like from
  // outside: a host running one tree and describing another.
  const interrupted = await host.cli(["runtime", "install", "codex", "--version", "0.155.0"], {
    extraEnv: { INFRA_COD_HARNESS_FAIL_INVENTORY_WRITE: "1", INFRA_COD_HARNESS_FAIL_ROLLBACK: "1" },
  });
  assert.equal(interrupted.code, 1);
  assert.match(interrupted.stderr, /reconcile/);

  // `verify` used to re-ask its questions about whatever the record named and
  // pass. It must see the divergence.
  const verified = await host.cli(["runtime", "verify", "codex"]);
  assert.equal(verified.code, 1, "verify does not pass a host that disagrees with its own record");
  assert.match(verified.stderr, /do not describe the same installation/);
  assert.match(verified.stdout, /"agrees": false/);

  // Reporting without --apply changes nothing.
  const reported = await host.cli(["runtime", "reconcile", "codex"]);
  assert.equal(reported.code, 1);
  assert.match(reported.stderr, /Nothing was changed/);

  const repaired = await host.cli(["runtime", "reconcile", "codex", "--apply"]);
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.equal((await host.cli(["runtime", "verify", "codex"])).code, 0, "and the host agrees with itself again");
  assert.equal(host.runtimes().runtimes.codex.active.version, "0.155.0", "the tree on PATH is what gets described");
}));

test("a config that cannot be read is never replaced with an empty one", options, withHost(async (host) => {
  publishCodex(host);
  const original = 'model = "gpt-5"\n[mcp_servers.a]\ncommand = "x"\n';
  const file = host.writeRuntimeConfig("codex-worker", ".codex/config.toml", original);
  // A regular file, present, that the runtime user cannot read — arranged in the
  // `runuser` boundary rather than with a mode, because the sandbox runs as one
  // user and in the container that user is root.
  host.makeUnreadable(file);

  // `test -e f && cat f || true` returns success and an empty stdout for exactly
  // this. The config was then rebuilt from "" and written back: the operator's
  // whole file replaced by one line.
  const result = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot read it/);

  host.makeReadable();
  assert.equal(host.runtimeConfig("codex-worker", ".codex/config.toml"), original, "the file is byte-for-byte untouched");
  assert.equal(host.activeTarget("codex"), null, "and nothing was activated on the strength of a config we could not read");
}));

test("a command on PATH that this host did not put there is not overwritten", options, withHost(async (host) => {
  publishCodex(host);
  // An operator's own build, a distribution package, a colleague's binary. The
  // earlier version could not tell it from "nothing is there": both read as
  // null, and rename replaces a regular file without comment.
  const foreign = host.writeForeignCommand("codex", "#!/bin/sh\necho somebody else's codex\n");

  const result = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not a symlink this host manages/);
  assert.match(readFileSync(foreign, "utf8"), /somebody else/, "and it is still there, untouched");
}));

test("reconcile --apply is fenced exactly as an install is", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });
  const interrupted = await host.cli(["runtime", "install", "codex", "--version", "0.155.0"], {
    extraEnv: { INFRA_COD_HARNESS_FAIL_INVENTORY_WRITE: "1", INFRA_COD_HARNESS_FAIL_ROLLBACK: "1" },
  });
  assert.equal(interrupted.code, 1);

  // A recovery path with weaker guarantees than the operation it recovers from
  // is a way of doing the unsafe thing by asking differently: it moves the same
  // symlink.
  host.setInFlight("codex", 1);
  const refused = await host.cli(["runtime", "reconcile", "codex", "--apply"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /1 codex launch\(es\) are still open/);
  assert.equal(host.admissionOf("codex").paused, false, "and the fence is released again");

  host.setInFlight("codex", 0);
  assert.equal((await host.cli(["runtime", "reconcile", "codex", "--apply"])).code, 0);
}));

test("an intent that does not describe what is on PATH is not used as a record", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", "0.155.0"], {
    extraEnv: { INFRA_COD_HARNESS_FAIL_INVENTORY_WRITE: "1", INFRA_COD_HARNESS_FAIL_ROLLBACK: "1" },
  })).code, 1);

  // The file is read from disk and used to write the inventory. "It has an
  // entry field" is not a reason to believe it: here it claims a version its
  // own record does not carry.
  host.rewriteIntent("codex", (intent) => ({ ...intent, version: "9.9.9" }));

  const result = await host.cli(["runtime", "reconcile", "codex", "--apply"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not a tree .* knows about|cannot describe/);
  assert.notEqual(host.runtimes().runtimes.codex.active.version, "9.9.9");
}));

test("an install refuses to run on top of an interrupted switch", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", "0.155.0"], {
    extraEnv: { INFRA_COD_HARNESS_FAIL_INVENTORY_WRITE: "1", INFRA_COD_HARNESS_FAIL_ROLLBACK: "1" },
  })).code, 1);

  const onPath = host.activeTarget("codex");
  publishCodex(host, { version: "0.156.0", prints: "0.156.0" });

  // Installing again would overwrite the only account of what happened, and
  // orphan the tree the interrupted switch made live — which the inventory never
  // learned about, so nothing could ever be asked to remove it.
  const refused = await host.cli(["runtime", "install", "codex", "--version", "0.156.0"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /cannot describe/);
  assert.match(refused.stderr, /reconcile codex/);
  assert.equal(host.activeTarget("codex"), onPath, "and it changed nothing");

  // `remove` is held to the same rule, for the same reason.
  const removal = await host.cli(["runtime", "remove", "codex", "--version", CODEX.version]);
  assert.equal(removal.code, 1);
  assert.match(removal.stderr, /cannot describe/);

  // reconcile is the one command that may act, and afterwards the rest may too.
  assert.equal((await host.cli(["runtime", "reconcile", "codex", "--apply"])).code, 0);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", "0.156.0"])).code, 0);
}));

test("reconcile refuses while the runtime is running outside the supervisor", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", "0.155.0"], {
    extraEnv: { INFRA_COD_HARNESS_FAIL_INVENTORY_WRITE: "1", INFRA_COD_HARNESS_FAIL_ROLLBACK: "1" },
  })).code, 1);

  // The fence covers admissions. A process an operator started by hand is not an
  // admission, and repair moves the same symlink an install moves.
  host.setRunningProcesses("codex-worker", ["9001"]);
  const refused = await host.cli(["runtime", "reconcile", "codex", "--apply"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /1 codex process\(es\) are running/);

  host.setRunningProcesses("codex-worker", []);
  assert.equal((await host.cli(["runtime", "reconcile", "codex", "--apply"])).code, 0);
}));

test("a supervisor that restarts mid-switch cannot launch, so the switch stands", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });
  // The supervisor answers the checks and then dies — the boundary a restart
  // during `pause` cannot reach. Before the fence was a kernel lock this had to
  // abort and undo, and even then the undo was incomplete: a session admitted by
  // the new supervisor went on running a version the rollback had just made
  // inactive.
  //
  // The lock removes the problem rather than handling it. A supervisor started a
  // second ago knows nothing of any pause, but it cannot take a shared lock on a
  // file held exclusively, so it cannot launch.
  host.restartSupervisorAfterChecks("codex", 2);

  const result = await host.cli(["runtime", "install", "codex", "--version", "0.155.0"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(host.runtimes().runtimes.codex.active.version, "0.155.0");
}));

test("no launch is admitted while an installation holds the fence", options, withHost(async (host) => {
  // The guarantee, asked of the kernel rather than of a process. This is the
  // case every in-process version missed: the asking party did not exist when
  // the fence was taken.
  const held = await host.holdInstallFence("codex");
  await assert.rejects(host.attemptLaunch("codex"), /being installed/);

  held.release();
  const launch = await host.attemptLaunch("codex");
  launch.release();
}));

test("an installation cannot begin while a launch is open", options, withHost(async (host) => {
  const launch = await host.attemptLaunch("codex");
  // The other direction, and the one that protects running work.
  await assert.rejects(host.holdInstallFence("codex"), /launches in flight/);

  launch.release();
  const held = await host.holdInstallFence("codex");
  held.release();
}));

test("a staged tree is not left behind when the fence cannot be taken", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  publishCodex(host, { version: "0.155.0", prints: "0.155.0" });
  // A launch is open, so the exclusive lock cannot be taken. By then the install
  // has staged its tree, and leaving it would be a directory on disk that
  // nothing in the record names.
  const launch = await host.attemptLaunch("codex");
  try {
    const result = await host.cli(["runtime", "install", "codex", "--version", "0.155.0"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /launches in flight|cannot be installed/);
    assert.deepEqual(host.installedVersions("codex"), [CODEX.version], "no tree is left that nothing can name");
  } finally {
    launch.release();
  }
}));

test("a runtime whose auth probe always succeeds is not called authenticated on that alone", () => {
  // Found on the production host, not here: `opencode auth list` prints
  // "0 credentials" and exits 0. Believing the exit code reported a runtime with
  // an empty credential store as authenticated — green in the panel, admitted by
  // dispatch, and broken at the first provider call, which is the exact collapse
  // the four separate states exist to prevent.
  const adapter = adapterFor("opencode");
  assert.ok(adapter.authEvidence, "opencode must not rely on its exit code alone");

  let probed = false;
  const alwaysFine = () => { probed = true; return { ok: true, code: 0, stdout: "0 credentials", stderr: "" }; };

  const empty = authenticationOf(adapter, { probe: alwaysFine, evidence: () => ({ ok: false }) });
  assert.equal(empty.ok, false, "an empty credential store is not authentication");
  assert.match(empty.detail, /either way/, "the reason names why the probe was not believed");

  const stocked = authenticationOf(adapter, { probe: alwaysFine, evidence: () => ({ ok: true }) });
  assert.equal(stocked.ok, true);

  // And the probe is not run at all where evidence decides. Not tidiness: the
  // health snapshot asks this every minute from a unit whose `/home` is
  // read-only, and OpenCode opens a log file in its home on startup — so
  // launching it for an answer it does not give would have cost the unit a
  // writable home.
  assert.equal(probed, false, "an adapter with evidence must not launch its runtime to answer");

  // Codex answers with its exit code — measured on the host, `login status`
  // exits 1 with no account — so it declares no evidence and none is demanded.
  const codex = adapterFor("codex");
  assert.equal(codex.authEvidence, null);
  assert.equal(authenticationOf(codex, { probe: alwaysFine, evidence: () => ({ ok: false }) }).ok, true);
});

test("a package that does not carry the executable leaves nothing on disk", options, withHost(async (host) => {
  // This is the failure the production host produced, and the one path after the
  // rename that had no `discard()` on it. The adapter named
  // `package/bin/codex`; the real package keeps its binary under a vendor tree,
  // so the check fired — correctly — and 324 MB stayed in
  // `/opt/infra-cod/runtimes/codex/0.154.0`, which the inventory never learned
  // about and no command could then remove.
  const elsewhere = buildPackageTarball(host.base, {
    executablePath: "package/somewhere-else/codex",
    prints: CODEX.version,
  });
  host.publish({ name: CODEX.package, version: CODEX.packageVersion, tarball: elsewhere });

  const result = await host.cli(["runtime", "install", "codex", "--version", CODEX.version]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /does not contain/);
  assert.deepEqual(
    host.installedVersions("codex"), [],
    "a failed install must take its tree with it; the record never learned about it",
  );
}));

test("a tree the record does not name can still be seen and removed", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);

  // A tree from an install that died before it could be recorded. Made here
  // rather than by crashing an installer, because what is under test is whether
  // the product can see and remove one — not how it came to exist.
  const stray = path.join(host.prefix, "opt/infra-cod/runtimes/codex", `${CODEX.version}+7`);
  mkdirSync(path.join(stray, "package/bin"), { recursive: true });
  writeFileSync(path.join(stray, "package/bin/codex"), "#!/bin/sh\nexit 0\n");

  const verified = await host.cli(["runtime", "verify", "codex"]);
  assert.match(verified.stderr, /not in/, "verify must say a tree is unrecorded");
  assert.match(verified.stderr, new RegExp(`${CODEX.version}\\+7`), "and name it");
  assert.match(verified.stdout, /unrecorded_directories/);

  const removed = await host.cli(["runtime", "remove", "codex", "--version", CODEX.version]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(
    host.installedVersions("codex"), [CODEX.version],
    "the stray goes and the active installation stays",
  );

  // The active one is still active, and still the thing on PATH.
  const after = await host.cli(["runtime", "verify", "codex"]);
  assert.equal(after.code, 0, after.stderr);
  assert.match(after.stdout, /"agrees": true/);
}));

test("host requirements are declared by version", async () => {
  const { hostRequirementsOf, versionInRange, compareVersions } = await import("../runtime-adapters.mjs");
  const names = (runtime, version) => hostRequirementsOf(adapterFor(runtime), version).map((entry) => entry.requirement);
  // Codex's Landlock fallback up to 0.154.0; bubblewrap after (0.158.0 on the host).
  assert.deepEqual(names("codex", "0.154.0"), ["landlock"]);
  assert.deepEqual(names("codex", "0.158.0"), ["bwrap.userns"]);
  assert.deepEqual(names("opencode", "1.18.31"), ["landlock"]);
  assert.deepEqual(names("claude", "2.1.270"), ["landlock"]);
  assert.equal(versionInRange("0.155.0", ">=0.155.0"), true);
  assert.equal(versionInRange("0.154.9", ">=0.155.0"), false);
  assert.equal(compareVersions("0.154.0", "0.154.0"), 0);
  assert.equal(compareVersions("1.9.0", "1.18.31"), -1, "numeric, not lexical");
  assert.throws(() => versionInRange("1.0.0", "^1.0.0"), /unsupported version range/);
});

// Stage 12 W2: the watch reads metadata and nothing else.
test("the watch finds newer platform builds and offers them once published (0127: no wait)", async () => {
  const { platformVersions, newerVersions, isOffered, watchRuntime } = await import("../runtime.mjs");
  const hoursAgo = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
  // Codex publishes one version per platform plus the wrapper; only the
  // linux-x64 build of an exact release is ours.
  const codexDocument = {
    name: "@openai/codex",
    versions: {
      "0.154.0": {}, "0.154.0-linux-x64": {}, "0.154.0-darwin-arm64": {},
      "0.158.0-linux-x64": {}, "0.157.1-linux-x64": {}, "0.157.0-linux-x64": { deprecated: "broken" },
      "0.159.0-alpha.1-linux-x64": {}, "0.120.0-linux-x64": {},
    },
    time: {
      "0.154.0-linux-x64": hoursAgo(700), "0.158.0-linux-x64": hoursAgo(5),
      "0.157.1-linux-x64": hoursAgo(72), "0.157.0-linux-x64": hoursAgo(90), "0.120.0-linux-x64": hoursAgo(5000),
    },
  };
  const found = platformVersions(adapterFor("codex"), codexDocument);
  assert.deepEqual(found.map((entry) => entry.version).sort(), ["0.120.0", "0.154.0", "0.157.0", "0.157.1", "0.158.0"]);

  const newer = newerVersions(found, "0.154.0");
  assert.deepEqual(newer.map((entry) => entry.version), ["0.158.0", "0.157.1", "0.157.0"], "newer only, newest first");
  assert.deepEqual(newer.map((entry) => isOffered(entry)), [true, true, false], "five hours old, offered, deprecated");

  // One document per package, asked by name; an answer about another package is refused.
  const asked = [];
  const watched = await watchRuntime("codex", {
    activeVersion: "0.154.0",
    fetchJson: async (url, options) => { asked.push({ url, options }); return codexDocument; },
  });
  assert.equal(watched.error, "");
  assert.equal(asked[0].url, "https://registry.npmjs.org/%40openai%2Fcodex");
  assert.ok(asked[0].options.maxBytes >= 32 * 1024 * 1024, "a whole package history is allowed to be large");
  const wrong = await watchRuntime("codex", { fetchJson: async () => ({ ...codexDocument, name: "@openai/other" }) });
  assert.match(wrong.error, /answered with "@openai\/other"/);
  const down = await watchRuntime("opencode", { fetchJson: async () => { throw new Error("ETIMEDOUT"); } });
  assert.deepEqual([down.error, down.versions], ["ETIMEDOUT", []]);

  // OpenCode and Claude publish plain versions of their platform package.
  assert.deepEqual(platformVersions(adapterFor("opencode"), { versions: { "1.18.31": {}, "1.18.33": {}, "1.19.0-beta.1": {} } })
    .map((entry) => entry.version), ["1.18.31", "1.18.33"]);
});

// Stage 12 W3: a candidate is installed beside the active version, never instead.
test("qualify installs a candidate beside the active version and switches nothing", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  const serving = host.activeTarget("codex");
  publishCodex(host, { version: "0.154.1", prints: "0.154.1" });

  const result = await host.cli(["runtime", "qualify", "codex", "--version", "0.154.1", "--no-record", "--no-turns"]);
  // Incomplete: the checks that run turns are not built yet, so it cannot pass.
  assert.equal(result.code, 3, result.stderr + result.stdout);
  assert.match(result.stdout, /✓ package\.signature/);
  assert.match(result.stdout, /✓ version\.reports — .*0\.154\.1/);
  assert.match(result.stdout, /· read_only\.shell — turn checks not run/);
  assert.match(result.stdout, /codex 0\.154\.1: INCOMPLETE/);

  assert.equal(host.activeTarget("codex"), serving, "the active link did not move");
  const entry = host.runtimes().runtimes.codex;
  assert.equal(entry.active.version, CODEX.version);
  const candidate = entry.installed.find((installed) => installed.version === "0.154.1");
  assert.ok(candidate?.candidate, "the candidate is recorded, and marked as one");
  assert.match(candidate.executableSha256, /^[0-9a-f]{64}$/);

  // And it is removable like any inactive tree.
  const removed = await host.cli(["runtime", "remove", "codex", "--version", "0.154.1"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.ok(!host.runtimes().runtimes.codex.installed.some((installed) => installed.version === "0.154.1"));
}));

// Stage 12 W4: a promotion is earned by a passed qualification of that exact
// tree, keeps the version it replaces, and rollback is one command.
test("promote needs a passed qualification, keeps the previous version, and rollback returns to it", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  publishCodex(host, { version: "0.154.1", prints: "0.154.1" });
  assert.equal((await host.cli(["runtime", "qualify", "codex", "--version", "0.154.1", "--no-record", "--no-turns"])).code, 3);
  const serving = host.activeTarget("codex");

  // Not qualified: refused, and saying how to get there.
  const refused = await host.cli(["runtime", "promote", "codex", "--version", "0.154.1", "--no-record"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /not promoted: no qualification of it has passed on this host/);
  assert.match(refused.stderr, /infra-cod runtime qualify codex --version 0\.154\.1/);
  const noReason = await host.cli(["runtime", "promote", "codex", "--version", "0.154.1", "--no-record", "--accept-unqualified"]);
  assert.equal(noReason.code, 1);
  assert.match(noReason.stderr, /--accept-unqualified needs --reason/);
  assert.equal(host.activeTarget("codex"), serving, "nothing moved");

  // A qualification under another adapter version does not count.
  const file = path.join(host.prefix, "etc/infra-cod/runtimes.json");
  const qualify = (adapterVersion) => {
    const document = JSON.parse(readFileSync(file, "utf8"));
    const candidate = document.runtimes.codex.installed.find((installed) => installed.version === "0.154.1");
    candidate.qualification = { id: "00000000-0000-4000-8000-000000000009", result: "passed", adapterVersion, version: "0.154.1" };
    writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  };
  qualify("0.9.0");
  const stale = await host.cli(["runtime", "promote", "codex", "--version", "0.154.1", "--no-record"]);
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /qualified under adapter 0\.9\.0, and this release ships 1\.0\.0/);

  qualify("1.0.0");
  const promoted = await host.cli(["runtime", "promote", "codex", "--version", "0.154.1", "--no-record"]);
  assert.equal(promoted.code, 0, promoted.stderr + promoted.stdout);
  assert.match(promoted.stdout, /codex 0\.154\.0 -> 0\.154\.1: promoted/);
  assert.ok(host.activeTarget("codex").includes("/0.154.1"), host.activeTarget("codex"));
  let entry = host.runtimes().runtimes.codex;
  assert.equal(entry.active.version, "0.154.1");
  assert.equal(entry.rollbackTo.version, CODEX.version, "the replaced version is named for rollback");
  assert.equal(entry.verification.promotion.qualification, "00000000-0000-4000-8000-000000000009");
  // The qualification stays with the tree it was made on.
  assert.equal(entry.installed.find((installed) => installed.version === "0.154.1").qualification?.result, "passed");

  // The version a rollback needs is kept.
  const kept = await host.cli(["runtime", "remove", "codex", "--version", CODEX.version]);
  assert.equal(kept.code, 1);
  assert.match(kept.stderr, /kept for `infra-cod runtime rollback codex`/);

  const back = await host.cli(["runtime", "rollback", "codex", "--no-record", "--reason", "harness"]);
  assert.equal(back.code, 0, back.stderr + back.stdout);
  assert.match(back.stdout, /codex 0\.154\.1 -> 0\.154\.0: rolled back/);
  assert.equal(host.activeTarget("codex"), serving);
  entry = host.runtimes().runtimes.codex;
  assert.equal(entry.active.version, CODEX.version);
  assert.equal(entry.rollbackTo, undefined, "a rollback does not point back at what it left");
  assert.equal(entry.verification.rollback.from, "0.154.1");

  const nothing = await host.cli(["runtime", "rollback", "codex", "--no-record"]);
  assert.equal(nothing.code, 1);
  assert.match(nothing.stderr, /no previous version to roll back to/);
}));

test("an unqualified promotion is possible only with a reason, and says so", options, withHost(async (host) => {
  publishCodex(host);
  assert.equal((await host.cli(["runtime", "install", "codex", "--version", CODEX.version])).code, 0);
  publishCodex(host, { version: "0.154.1", prints: "0.154.1" });
  assert.equal((await host.cli(["runtime", "qualify", "codex", "--version", "0.154.1", "--no-record", "--no-turns"])).code, 3);
  const promoted = await host.cli(["runtime", "promote", "codex", "--version", "0.154.1", "--no-record",
    "--accept-unqualified", "--reason", "the new model is needed before a qualification can run"]);
  assert.equal(promoted.code, 0, promoted.stderr + promoted.stdout);
  assert.match(promoted.stdout, /WARNING: promoting codex 0\.154\.1 unqualified/);
  const entry = host.runtimes().runtimes.codex;
  assert.equal(entry.verification.promotion.acceptedUnqualified.reason, "the new model is needed before a qualification can run");
}));

// Stage 12 W4b: the probation timer's decisions, without a database.
test("probation closes a passed one, rolls back a failing one, and leaves a running one alone", async () => {
  const { applyProbationVerdicts } = await import("../runtime.mjs");
  const out = [];
  const err = [];
  const ended = [];
  const recorded = [];
  const rolled = [];
  const verdicts = [
    { runtime: "claude", state: "none" },
    { runtime: "opencode", state: "passed", activation_id: "a1", version: "1.18.32", from: "1.18.31", runs_seen: 4, runs_required: 3, until: "t" },
    { runtime: "codex", state: "failing", activation_id: "a2", version: "0.158.0", from: "0.154.0", runs_seen: 1, runs_required: 3, until: "t",
      failures: [{ attempt_id: 77, status: "failed", error: "thread panicked at linux-sandbox" }] },
  ];
  const io = { stdout: { write: (line) => out.push(line) }, stderr: { write: (line) => err.push(line) } };
  const reportOnly = await applyProbationVerdicts(verdicts, { ...io, apply: false, end: () => assert.fail("ended"), record: () => assert.fail("recorded"), rollback: () => assert.fail("rolled back") });
  assert.deepEqual(reportOnly, { failed: 0, rolledBack: 0 });
  assert.equal(out.length, 2, "a runtime with no probation says nothing");

  const applied = await applyProbationVerdicts(verdicts, {
    ...io, apply: true,
    end: async (id, detail) => { ended.push([id, detail]); },
    record: async (row) => { recorded.push(row); },
    rollback: async (name, reason) => { rolled.push([name, reason]); return { name, version: "0.154.0", from: "0.158.0" }; },
  });
  assert.deepEqual(applied, { failed: 0, rolledBack: 1 });
  assert.deepEqual(ended, [["a1", "three runs and a day without a runtime failure"]]);
  assert.equal(rolled[0][0], "codex");
  assert.match(rolled[0][1], /^probation: failed — thread panicked at linux-sandbox \(attempt 77\)$/);
  assert.equal(recorded[0].kind, "rollback");
  assert.equal(recorded[0].actor, "probation");
  assert.equal(recorded[0].version, "0.154.0");

  // A rollback that cannot happen is a failure of the timer, not a silence.
  const stuck = await applyProbationVerdicts([verdicts[2]], {
    ...io, apply: true, end: async () => {}, record: async () => assert.fail("recorded"),
    rollback: async () => { throw new Error("codex has no previous version to roll back to"); },
  });
  assert.deepEqual(stuck, { failed: 1, rolledBack: 0 });
  assert.match(err.at(-1), /failed its probation and could not be rolled back: codex has no previous version/);
});
