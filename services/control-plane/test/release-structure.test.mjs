// Structural tests for the release contract: versions, tags, the payload
// allowlist, the tar format, and the signature.
//
// These are fast — no build, no network, no database — so `npm run check` can run
// them on every commit. They exist because several of the defects this stage was
// built against were *format* defects that a round-trip test through this
// project's own reader could not see:
//
//   * the tar `linkname` field was written at byte 340 instead of 157, which this
//     module's reader tolerated (it looked in both places) while `tar` on Ubuntu
//     turned every symlink into a regular file whose name began with its target;
//   * the pax record length did not count its own digits, which GNU tar rejects;
//   * a pax `linkpath` record for a long symlink target is read differently by
//     libarchive than by GNU tar.
//
// Each of those now has an assertion on the *bytes*, or on an independent
// implementation, rather than on a round trip through the same code that produced
// them.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertSafeMembers, extractTar, listTarMembers, readTarMembers, writeTar } from "../../../scripts/lib/release-archive.mjs";
import { PayloadError, SERVICE_RUNTIME_ASSETS, assertNoForbiddenEntries, checkSymlinkClosure, isForbiddenName, selectServicePayload, walkTree, serviceImportClosure } from "../../../scripts/lib/release-payload.mjs";
import { assertPublishable, assertTreeIsClean, buildIdFor, resolveBuildTarget, resolveVersion, sentinelValues } from "../../../scripts/lib/release-preconditions.mjs";
import { createSignatureFile, generateKeyPair, keyPairFromSeed, parsePublicKeyFile, parseSecretKeyFile, releasedTrustedComment, renderPublicKeyFile, renderSecretKeyFile, verifySignature } from "../../../scripts/lib/release-signature.mjs";
import { blake2b256, Blake2b } from "../../../scripts/lib/blake2b.mjs";
import { assertRunningNode, artifactName, channelFor, developmentVersion, loadVersionSource, parseVersion, releaseRootName, versionFromTag } from "../../../scripts/lib/release-version.mjs";
import { migrationSetDigest, validateManifest, assertManifestIsHostFree } from "../../../scripts/lib/release-manifest.mjs";
import { TRUSTED_KEYS, VERIFIER_SCRIPTS, assembleTrustedKeysRelease } from "../../../scripts/lib/release-assemble.mjs";
import { REGISTRY_KEY_ID, REGISTRY_PUBLIC_KEY } from "../../operations/runtime-adapters.mjs";
import { verifyRegistrySignature } from "../../operations/runtime.mjs";
import { declareInstall } from "../../operations/install-declaration.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const versionSource = loadVersionSource(root);

function temporaryDirectory(label) {
  return mkdtempSync(path.join(os.tmpdir(), `infra-cod-${label}-`));
}

// ---------------------------------------------------------------------------
// Version and tag contract
// ---------------------------------------------------------------------------

test("SemVer versions are accepted, and the channel follows from the version", () => {
  assert.equal(parseVersion("0.1.0").version, "0.1.0");
  assert.equal(parseVersion("0.1.0-rc.1").prerelease, "rc.1");
  assert.equal(parseVersion("1.2.3+build.5").build, "build.5");
  assert.equal(channelFor("0.1.0"), "stable");
  assert.equal(channelFor("0.1.0-rc.1"), "rc");
  assert.equal(channelFor("0.0.0-dev+abc123"), "dev");
  assert.equal(channelFor("0.0.0"), "dev");
});

test("a version that could escape a filename or a shell is refused, with the offending character named", () => {
  const hostile = [
    ["../../etc/passwd", ".."],
    ["0.1.0/../../x", ".."],
    ["0.1.0; rm -rf /", ";"],
    ["$(id)", "$"],
    ["0.1.0`whoami`", "`"],
    ["0.1.0 && echo", "&"],
    ["0.1.0 | tee", "|"],
    // `JSON.stringify` is what the validator uses to quote the value, so the
    // assertion names the escaped form.
    ["0.1.0\n0.2.0", "\\n"],
    ["not-a-version", "not SemVer"],
    ["0.1", "not SemVer"],
    ["01.2.3", "not SemVer"],
  ];
  for (const [value, expected] of hostile) {
    assert.throws(
      () => parseVersion(value),
      (error) => error.message.includes(expected),
      `${JSON.stringify(value)} should be refused mentioning ${JSON.stringify(expected)}`,
    );
  }
});

test("a tag must be v-prefixed and must name a version", () => {
  assert.equal(versionFromTag("v0.1.0-rc.1"), "0.1.0-rc.1");
  assert.throws(() => versionFromTag("0.1.0"), /must start with "v"/);
  assert.throws(() => versionFromTag("vnext"), /not SemVer/);
});

test("the artifact name is derived from the version and the target is fixed", () => {
  assert.equal(artifactName("0.1.0-rc.1"), "infra-cod-0.1.0-rc.1-linux-x64.tar.gz");
  assert.equal(releaseRootName("0.1.0-rc.1"), "infra-cod-0.1.0-rc.1");
  assert.throws(() => artifactName("../evil"));
});

test("the development version carries the commit and can never be published", () => {
  const sha = "a".repeat(40);
  const version = developmentVersion(sha);
  assert.equal(version, `0.0.0-dev+${"a".repeat(12)}`);
  assert.equal(channelFor(version), "dev");
  assert.throws(() => assertPublishable({ publish: true, channel: "dev", fromTag: true }), /development version/);
  assert.throws(() => assertPublishable({ publish: true, channel: "rc", fromTag: false }), /must come from a tag/);
  assert.doesNotThrow(() => assertPublishable({ publish: true, channel: "rc", fromTag: true }));
  assert.doesNotThrow(() => assertPublishable({ publish: false, channel: "dev", fromTag: false }));
  assert.throws(() => developmentVersion("abc"), /40 lowercase hex/);
});

test("resolveVersion ties a tagged HEAD to its tag and refuses a mismatch", () => {
  const sha = "b".repeat(40);
  assert.equal(
    resolveVersion({ requested: "0.1.0-rc.1", publish: true, headSha: sha, tagsAtHead: ["v0.1.0-rc.1"] }).version,
    "0.1.0-rc.1",
  );
  assert.throws(
    () => resolveVersion({ requested: "0.1.0", publish: true, headSha: sha, tagsAtHead: ["v0.1.0-rc.1"] }),
    /does not match any tag/,
  );
  assert.throws(
    () => resolveVersion({ requested: "0.1.0", publish: true, headSha: sha, tagsAtHead: [] }),
    /requires a v\* tag/,
  );
  assert.throws(
    () => resolveVersion({ requested: "0.1.0", publish: false, headSha: sha, tagsAtHead: ["v0.2.0"] }),
    /does not match the tag/,
  );
  // An untagged local build is a development version whether or not one was asked for.
  assert.equal(resolveVersion({ requested: null, publish: false, headSha: sha, tagsAtHead: [] }).version, developmentVersion(sha));
  assert.equal(resolveVersion({ requested: null, publish: false, headSha: sha, tagsAtHead: ["v0.2.0"] }).version, "0.2.0");
});

test("an artifact is only built for the platform that produced it", () => {
  const source = { target: { os: "linux", arch: "x64", libc: "glibc" } };

  // On the target, nothing changes.
  const onTarget = resolveBuildTarget({ publish: true, source, platform: "linux", arch: "x64" });
  assert.equal(onTarget.offTarget, false);
  assert.deepEqual(onTarget.target, source.target);

  // Off the target, the build is refused — for *every* mode, not only publish. The
  // first version of this check ran only for `--publish`, which is how a
  // Darwin/arm64 payload came to be named `…-linux-x64.tar.gz` with a manifest that
  // said `linux/x64/glibc` and claimed nothing was wrong.
  assert.throws(
    () => resolveBuildTarget({ publish: false, source, platform: "darwin", arch: "arm64" }),
    /this build host is darwin\/arm64 but the release target is linux\/x64/,
  );
  assert.throws(
    () => resolveBuildTarget({ publish: true, source, platform: "darwin", arch: "arm64" }),
    /a publishable release must be built on linux\/x64/,
  );

  // The diagnostic escape hatch exists, and it changes the declared identity so the
  // result cannot be mistaken for a target build.
  const diagnostic = resolveBuildTarget({ publish: false, source, allowOffTarget: true, platform: "darwin", arch: "arm64" });
  assert.equal(diagnostic.offTarget, true);
  assert.deepEqual(diagnostic.target, { os: "darwin", arch: "arm64", libc: "glibc" });
});

test("the artifact name carries whatever platform the build declared", () => {
  // The filename is part of the published contract, so it is not derived from
  // `process.platform`; but it must not claim a platform the build did not run on
  // either, or a consumer looking for `linux-x64` picks up the wrong file.
  assert.equal(artifactName("0.1.0-rc.1"), "infra-cod-0.1.0-rc.1-linux-x64.tar.gz");
  assert.equal(artifactName("0.1.0-rc.1", { os: "linux", arch: "x64" }), "infra-cod-0.1.0-rc.1-linux-x64.tar.gz");
  assert.equal(artifactName("0.1.0-rc.1", { os: "darwin", arch: "arm64" }), "infra-cod-0.1.0-rc.1-darwin-arm64.tar.gz");
});

test("publish mode refuses a dirty tree, and `dirty` counts untracked files too", () => {
  assert.throws(() => assertTreeIsClean({ publish: true, dirty: true }), /dirty working tree/);
  assert.throws(
    () => assertTreeIsClean({ publish: true, dirty: false, untracked: ["secret.pem"] }),
    /untracked files present/,
  );
  assert.doesNotThrow(() => assertTreeIsClean({ publish: false, dirty: true, untracked: ["x"] }));
});

test("the build id is a function of version and commit, so two builds agree", () => {
  const first = buildIdFor({ version: "0.1.0-rc.1", sha: "c".repeat(40) });
  assert.equal(first, buildIdFor({ version: "0.1.0-rc.1", sha: "c".repeat(40) }));
  assert.notEqual(first, buildIdFor({ version: "0.1.0-rc.1", sha: "d".repeat(40) }));
  // A `+` in a version would otherwise appear in a directory name Next writes.
  assert.ok(!/\+/.test(buildIdFor({ version: "0.0.0-dev+a1b2c3", sha: "e".repeat(40) })));
});

test("the running Node must be the pinned patch version", () => {
  assert.equal(assertRunningNode(versionSource, `v${versionSource.node}`), versionSource.node);
  assert.throws(() => assertRunningNode(versionSource, "v26.4.0"), /requires Node \d+\.\d+\.\d+ exactly/);
});

test("the pinned version source names a toolchain and a target", () => {
  assert.match(versionSource.node, /^\d+\.\d+\.\d+$/);
  assert.equal(versionSource.pnpm, "11.9.0");
  assert.equal(versionSource.next, "16.2.10");
  assert.equal(versionSource.postgresqlMajor, 17);
  assert.deepEqual(versionSource.target, { os: "linux", arch: "x64", libc: "glibc" });
});

test("sentinel values are unique per call and contain no regex metacharacters", () => {
  const first = sentinelValues(["A", "B"]);
  const second = sentinelValues(["A", "B"]);
  assert.equal(first.length, 2);
  assert.notEqual(first[0].value, second[0].value);
  for (const entry of first) assert.match(entry.value, /^[A-Z0-9]+$/);
});

// ---------------------------------------------------------------------------
// Payload allowlist
// ---------------------------------------------------------------------------

test("a non-normalised or absolute payload path is refused before the name rules are even consulted", () => {
  // `.` and `..` are not "forbidden names" — they are path shapes that cannot be
  // represented in a portable archive and that a traversal would use.
  for (const relativePath of ["../secret", "a/../b", "a/./b", "/etc/passwd", "a//b", "C:/windows"]) {
    assert.throws(
      () => assertNoForbiddenEntries([{ relativePath, type: "file", size: 0 }]),
      /absolute path|non-normalised path/,
      `${relativePath} must be refused`,
    );
  }
  assert.doesNotThrow(() => assertNoForbiddenEntries([{ relativePath: "services/cli/infra-cod.mjs", type: "file", size: 1 }]));
  assert.throws(
    () => assertNoForbiddenEntries([{ relativePath: "services/cli/.env.local", type: "file", size: 1 }]),
    /forbidden basename/,
  );
});

test("forbidden names are refused as a component, a basename and a suffix", () => {
  for (const relative of [
    "services/control-plane/test/x.mjs",
    "db/tests/0001.sql",
    "pocs/codex-runtime/run.mjs",
    ".env",
    ".env.local",
    "infra-cod.private-key.pem",
    "release/keys/x.key",
    "SHA256SUMS.minisig",
    "build.log",
    "web/.next/cache/x",
    "node_modules/.pnpm/foo/initial-credentials",
  ]) {
    assert.ok(isForbiddenName(relative), `${relative} should be forbidden`);
  }
  for (const relative of [
    "services/cli/infra-cod.mjs",
    "web/apps/web/.next/static/chunk.js",
    "db/migrations/0050_audit_action_namespace.sql",
    "deploy/systemd/infra-cod-web.service",
    "node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js",
  ]) {
    assert.equal(isForbiddenName(relative), null, `${relative} should be allowed`);
  }
});

test("the service payload is the import closure of the real entry points, in both directions", () => {
  const selection = selectServicePayload({ repositoryRoot: root });
  const relative = selection.files.map((file) => path.relative(root, file).split(path.sep).join("/"));

  for (const entry of ["services/cli/infra-cod.mjs", "services/control-plane/migrate.mjs", "services/runtime-supervisor/server.mjs"]) {
    assert.ok(relative.includes(entry), `${entry} must be in the payload`);
  }
  for (const worker of ["dispatcher.mjs", "implementation-worker.mjs", "catalog-gate-worker.mjs", "github-app-worker.mjs", "project-provisioner.mjs"]) {
    assert.ok(
      relative.includes(`services/control-plane/${worker}`),
      `every worker a unit starts must be in the payload; ${worker} is missing`,
    );
  }
  // Test directories and developer-only scripts are not reachable and are absent.
  assert.ok(!relative.some((file) => file.includes("/test/")), "no test file may be shipped");
  assert.ok(!relative.includes("services/control-plane/run-db-tests.mjs"));
  assert.ok(!relative.includes("services/runtime-supervisor/policy-smoke.mjs"), "an unreachable developer script must be omitted, and recorded");
  assert.deepEqual(selection.packages, ["hash-wasm", "pg"], "the services import exactly pg and hash-wasm");
  assert.ok(selection.omitted.length > 0, "the omissions must be recorded so a reviewer can ask about them");
  for (const omission of selection.omitted) assert.ok(omission.reason.length > 10, `${omission.path} needs a reason`);
});

// A minimal checkout that satisfies the layout the selector requires, so a test can
// put exactly one service file in it and see what the selector says.
function serviceFixture(files) {
  const fixture = temporaryDirectory("services");
  for (const directory of ["cli", "control-plane", "operations", "runtime-supervisor"]) {
    const absolute = path.join(fixture, "services", directory);
    mkdirSync(absolute, { recursive: true });
    // Each directory needs at least one root script, or the selector has no entry
    // point for it.
    writeFileSync(path.join(absolute, "entry.mjs"), "export const entry = 1;\n");
  }
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(fixture, "services", relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return fixture;
}

test("a service that imports a missing file stops the build instead of shipping", () => {
  const fixture = serviceFixture({ "cli/infra-cod.mjs": 'import "./absent.mjs";\n' });
  try {
    assert.throws(() => selectServicePayload({ repositoryRoot: fixture }), /imports .*absent\.mjs, which does not resolve/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a service file nothing reaches stops the build, so nothing ships unreviewed", () => {
  // A root-level script is an entry point by definition — it is what a unit would
  // start. The reachability rule is what governs the *support* files, and that is
  // where an unreviewed file can hide.
  const fixture = serviceFixture({ "cli/support/orphan.mjs": "export const orphan = 1;\n" });
  try {
    assert.throws(
      () => selectServicePayload({ repositoryRoot: fixture }),
      (error) => error instanceof PayloadError && /unreachable/.test(error.message) && /orphan\.mjs/.test(error.message),
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a support file that an entry point does reach is shipped", () => {
  const fixture = serviceFixture({
    "cli/infra-cod.mjs": 'import "./support/helper.mjs";\n',
    "cli/support/helper.mjs": "export const helper = 1;\n",
  });
  try {
    const selection = selectServicePayload({ repositoryRoot: fixture });
    const relative = selection.files.map((file) => path.relative(fixture, file).split(path.sep).join("/"));
    assert.ok(relative.includes("services/cli/support/helper.mjs"), "a reached support file must be shipped");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a service directory that is missing from the layout stops the build", () => {
  const fixture = serviceFixture({});
  rmSync(path.join(fixture, "services/operations"), { recursive: true, force: true });
  try {
    assert.throws(() => selectServicePayload({ repositoryRoot: fixture }), /services\/operations does not exist/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("walkTree normalises separators and refuses anything that is not a file, a directory or a link", () => {
  const fixture = temporaryDirectory("walk");
  mkdirSync(path.join(fixture, "a/b"), { recursive: true });
  writeFileSync(path.join(fixture, "a/b/c.txt"), "hello");
  const entries = walkTree(fixture);
  assert.deepEqual(entries.map((entry) => entry.relativePath), ["a/b/c.txt"]);
  assert.equal(entries[0].type, "file");
  assert.equal(entries[0].size, 5);
  rmSync(fixture, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Symlink closure
// ---------------------------------------------------------------------------

test("symlink closure accepts internal links and refuses escapes and dangling links", () => {
  const fixture = temporaryDirectory("links");
  mkdirSync(path.join(fixture, "a/b"), { recursive: true });
  writeFileSync(path.join(fixture, "a/b/t.txt"), "x");
  symlinkSync("b/t.txt", path.join(fixture, "a/internal"));
  let result = checkSymlinkClosure(fixture, walkTree(fixture));
  assert.equal(result.escaping.length, 0);
  assert.equal(result.dangling.length, 0);
  assert.equal(result.links.length, 1);

  symlinkSync("../../../etc/passwd", path.join(fixture, "a/escape"));
  result = checkSymlinkClosure(fixture, walkTree(fixture));
  assert.equal(result.escaping.length, 1);
  assert.match(result.escaping[0].reason, /outside the release tree/);

  rmSync(path.join(fixture, "a/escape"));
  symlinkSync("nowhere/t.txt", path.join(fixture, "a/dangling"));
  result = checkSymlinkClosure(fixture, walkTree(fixture));
  assert.equal(result.dangling.length, 1, "a link to a file that is not there must be reported, not resolved away");
  rmSync(fixture, { recursive: true, force: true });
});

test("symlink closure is not confused by a symlinked ancestor of the tree itself", () => {
  // macOS `/var/folders/...` is a symlink to `/private/var/...`, and this is the
  // case that made every internal link look like an escape until the comparison was
  // canonicalised on both sides.
  const real = temporaryDirectory("canonical");
  mkdirSync(path.join(real, "a/b"), { recursive: true });
  writeFileSync(path.join(real, "a/b/t.txt"), "x");
  symlinkSync("b/t.txt", path.join(real, "a/internal"));
  const alias = path.join(os.tmpdir(), `infra-cod-alias-${process.pid}-${Date.now()}`);
  symlinkSync(real, alias);
  try {
    const result = checkSymlinkClosure(path.join(alias, ""), walkTree(path.join(alias, "")));
    assert.equal(result.escaping.length, 0);
    assert.equal(result.dangling.length, 0);
  } finally {
    rmSync(alias, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tar format
// ---------------------------------------------------------------------------

function buildFixtureTree() {
  const fixture = temporaryDirectory("tar");
  const stage = path.join(fixture, "stage");
  const longDirectory = "node_modules/.pnpm/next@16.2.10_@babel+core@7.29.7_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/next";
  mkdirSync(path.join(stage, longDirectory, "deep"), { recursive: true });
  writeFileSync(path.join(stage, longDirectory, "deep/file.txt"), "content\n");
  writeFileSync(path.join(stage, "plain.txt"), "plain\n");
  writeFileSync(path.join(stage, "run.sh"), "#!/bin/sh\n");
  symlinkSync("plain.txt", path.join(stage, "link"));
  // A symlink target that fits the tar field, pointing at a directory whose *name*
  // is long. Both directions are exercised: the target is short, the name is long.
  symlinkSync("deep", path.join(stage, longDirectory, "peer"));
  return { fixture, stage };
}

function buildTar(stage, { epoch = 1700000000, prefix = "pkg" } = {}) {
  const chunks = [];
  const members = writeTar(stage, { prefix, sourceDateEpoch: epoch, write: (chunk) => chunks.push(Buffer.from(chunk)) });
  return { tar: Buffer.concat(chunks), members };
}

test("the tar header puts every field where the format puts it", () => {
  const { fixture, stage } = buildFixtureTree();
  try {
    const { tar } = buildTar(stage);
    // Walk the headers by hand. The point of the test is that it does not use the
    // reader: a field written at the wrong offset is invisible to a reader that
    // knows where to look for it anyway.
    let offset = 0;
    let seenSymlink = false;
    const names = [];
    while (offset + 512 <= tar.length) {
      const block = tar.subarray(offset, offset + 512);
      if (block.every((byte) => byte === 0)) break;
      const type = String.fromCharCode(block[156]);
      const name = block.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
      const sizeText = block.subarray(124, 136).toString("latin1").replace(/\0.*$/, "").trim();
      const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
      const link = block.subarray(157, 257).toString("utf8").replace(/\0.*$/, "");
      const magic = block.subarray(257, 263).toString("latin1");
      names.push(name);

      assert.equal(magic, "ustar\0", `member ${name} must use the ustar magic at byte 257`);

      // The checksum is recomputed from the header with the checksum field read as
      // spaces, which is the definition. A header whose declared checksum does not
      // match is a header no reader may trust.
      const declared = parseInt(block.subarray(148, 156).toString("latin1").replace(/\0.*$/, "").trim(), 8);
      let computed = 0;
      for (let index = 0; index < 512; index += 1) {
        computed += index >= 148 && index < 156 ? 0x20 : block[index];
      }
      assert.equal(computed, declared, `member ${name} has a wrong header checksum`);

      if (type === "2") {
        seenSymlink = true;
        assert.notEqual(link, "", `the symlink ${name} has an empty linkname field at byte 157`);
        assert.ok(!name.startsWith(link), `the linkname must not be a prefix of the name on ${name}`);
      }
      if (type === "0") {
        const data = tar.subarray(offset + 512, offset + 512 + size);
        assert.ok(data.length === size, `member ${name} declares ${size} bytes but the archive ends early`);
      }
      offset += 512 + size + ((512 - (size % 512)) % 512);
    }
    assert.ok(seenSymlink, "the fixture must exercise a symlink");
    assert.ok(names.some((name) => name.endsWith("plain.txt")));
    assert.ok(names.some((name) => name.endsWith(".sh")), "a long name must still be listed");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("an archive this project writes is readable by the system tar, not just by its own reader", () => {
  // The strongest available check on the format, and the one that caught the
  // linkname defect: hand the bytes to an implementation that shares no code with
  // the writer and ask it to list and extract them.
  const { fixture, stage } = buildFixtureTree();
  try {
    const { tar } = buildTar(stage);
    const tarball = path.join(fixture, "release.tar");
    writeFileSync(tarball, tar);
    const out = path.join(fixture, "out");
    mkdirSync(out, { recursive: true });

    let listing;
    try {
      listing = execFileSync("tar", ["-tf", tarball], { encoding: "utf8" });
    } catch (error) {
      assert.fail(`the system tar could not list the archive: ${error.stderr ?? error.message}`);
    }
    assert.match(listing, /pkg\/plain\.txt/);
    assert.match(listing, /deep\/file\.txt/);

    try {
      execFileSync("tar", ["-xf", tarball, "-C", out], { encoding: "utf8" });
    } catch (error) {
      assert.fail(`the system tar could not extract the archive: ${error.stderr ?? error.message}`);
    }
    const extracted = path.join(out, "pkg");
    assert.equal(readFileSync(path.join(extracted, "plain.txt"), "utf8"), "plain\n");
    assert.equal(readFileSync(path.join(extracted, "link"), "utf8"), "plain\n", "the symlink must resolve to its target");
    assert.ok(
      readFileSync(path.join(extracted, "node_modules", ".pnpm", "next@16.2.10_@babel+core@7.29.7_react-dom@19.2.4_react@19.2.4__react@19.2.4", "node_modules", "next", "peer", "file.txt"), "utf8").includes("content"),
      "a symlink with a long member name must still resolve after extraction",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the tar writer is byte-for-byte deterministic and independent of the build clock", () => {
  const { fixture, stage } = buildFixtureTree();
  try {
    const first = buildTar(stage).tar;
    const second = buildTar(stage).tar;
    assert.ok(first.equals(second), "two writes of one input must produce identical bytes");
    const other = buildTar(stage, { epoch: 1700000001 }).tar;
    assert.ok(!first.equals(other), "a different SOURCE_DATE_EPOCH must change the archive, or the epoch is not being applied");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the writer refuses a symlink target the tar field cannot hold, instead of producing an archive that cannot be read", () => {
  // This is the guard that makes the assembler's materialisation step load-bearing:
  // a long target inside the pax `linkpath` record is read differently by libarchive
  // and by GNU tar, so this project does not write one.
  const fixture = temporaryDirectory("longlink");
  const stage = path.join(fixture, "stage");
  mkdirSync(stage, { recursive: true });
  const longTarget = `${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
  symlinkSync(longTarget, path.join(stage, "link"));
  try {
    assert.throws(() => buildTar(stage), /target, which the ustar field cannot hold/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a tar member with a traversal path is refused before anything is extracted", () => {
  const { fixture, stage } = buildFixtureTree();
  try {
    const { tar } = buildTar(stage);
    const members = listTarMembers(tar);
    const evil = members.map((member, index) => (index === 1 ? { ...member, name: "../../etc/passwd" } : member));
    assert.throws(() => assertSafeMembers(evil), /not a normalised relative path/);

    const absolute = members.map((member, index) => (index === 1 ? { ...member, name: "/etc/passwd" } : member));
    assert.throws(() => assertSafeMembers(absolute), /absolute path/);

    const twoRoots = members.map((member, index) => (index === 1 ? { ...member, name: "elsewhere/x" } : member));
    assert.throws(() => assertSafeMembers(twoRoots), /exactly one top-level directory/);

    const hardlink = members.map((member, index) => (index === 1 ? { ...member, type: "1" } : member));
    assert.throws(() => assertSafeMembers(hardlink), /hard link/);

    const device = members.map((member, index) => (index === 1 ? { ...member, type: "3" } : member));
    assert.throws(() => assertSafeMembers(device), /character device/);

    const escapingLink = members.map((member) => (member.type === "2" ? { ...member, linkname: "../../../etc/passwd" } : member));
    assert.throws(() => assertSafeMembers(escapingLink), /escapes the archive/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the reader refuses a truncated archive and a corrupted header", () => {
  const { fixture, stage } = buildFixtureTree();
  try {
    const { tar } = buildTar(stage);
    assert.throws(() => listTarMembers(tar.subarray(0, tar.length - 1024)), /end-of-archive marker/);

    // The declared checksum is changed to a different *valid octal* value, so the
    // checksum check is what fails rather than the field parser. A corrupt field and
    // a wrong checksum are different failures and the test should name the one it
    // means.
    const corrupted = Buffer.from(tar);
    assert.equal(corrupted[148], "0".charCodeAt(0), "the fixture checksum must start with 0 for this test to be meaningful");
    corrupted[148] = "1".charCodeAt(0);
    assert.throws(() => listTarMembers(corrupted), /bad header checksum/);

    // A pax header whose declared length does not count its own digits is what GNU
    // tar rejects; this writer must not produce one.
    const file = readTarMembers(tar).find((member) => member.type === "0");
    assert.ok(file, "the fixture must contain a file member");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a long member name is carried in a pax record whose length counts its own digits", () => {
  const { fixture, stage } = buildFixtureTree();
  try {
    const { tar } = buildTar(stage);
    let offset = 0;
    let checked = 0;
    while (offset + 512 <= tar.length) {
      const block = tar.subarray(offset, offset + 512);
      if (block.every((byte) => byte === 0)) break;
      const type = String.fromCharCode(block[156]);
      const sizeText = block.subarray(124, 136).toString("latin1").replace(/\0.*$/, "").trim();
      const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
      if (type === "x") {
        const body = tar.subarray(offset + 512, offset + 512 + size).toString("utf8");
        const space = body.indexOf(" ");
        const declared = Number(body.slice(0, space));
        assert.equal(declared, body.length, `the pax record length ${declared} must equal its actual length ${body.length}`);
        assert.match(body.slice(space + 1), /^path=.+\n$/);
        checked += 1;
      }
      offset += 512 + size + ((512 - (size % 512)) % 512);
    }
    assert.ok(checked > 0, "the fixture's long names must have produced at least one pax header");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("extraction refuses to write outside its destination even when the member list looks safe", () => {
  const { fixture, stage } = buildFixtureTree();
  try {
    const { tar } = buildTar(stage);
    const out = path.join(fixture, "extract");
    extractTar(tar, out, { topLevelDirectory: "pkg" });
    assert.ok(readFileSync(path.join(out, "pkg/plain.txt"), "utf8").includes("plain"));

    assert.throws(() => extractTar(tar, path.join(fixture, "extract2"), { topLevelDirectory: "other" }), /top-level directory is "pkg", expected "other"/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

test("BLAKE2b-256 matches the published vectors and OpenSSL's BLAKE2b-512", () => {
  // The published vectors.
  assert.equal(
    blake2b256(Buffer.alloc(0)).toString("hex"),
    "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8",
  );
  assert.equal(
    blake2b256(Buffer.from("abc")).toString("hex"),
    "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319",
  );
  assert.equal(
    blake2b256(Buffer.from("The quick brown fox jumps over the lazy dog")).toString("hex"),
    "01718cec35cd3d796dd00020e0bfecb473ad23457d063b75eff29c0ffa2e58a9",
  );

  // A differential test against OpenSSL over several lengths, including the block
  // boundary and beyond, which exercises the counter and the multi-block path. This
  // is what makes "we implemented a hash" a checkable claim.
  const openssl = (buffer) => createHash("blake2b512").update(buffer).digest("hex");
  for (const length of [0, 1, 63, 64, 127, 128, 129, 255, 256, 1000, 4096]) {
    const buffer = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) buffer[index] = (index * 31 + 7) & 0xff;
    assert.equal(new Blake2b(64).update(buffer).digest().toString("hex"), openssl(buffer), `length ${length}`);
  }

  // Incremental updates must equal a single update.
  const buffer = Buffer.alloc(333);
  for (let index = 0; index < 333; index += 1) buffer[index] = index & 0xff;
  const incremental = new Blake2b(32);
  for (let offset = 0; offset < 333; offset += 17) incremental.update(buffer.subarray(offset, offset + 17));
  assert.ok(incremental.digest().equals(blake2b256(buffer)));
});

test("a minisign key pair, signature file and secret key file round-trip", () => {
  const pair = keyPairFromSeed(Buffer.alloc(32, 7));
  assert.equal(pair.keyId.length, 16);
  assert.equal(pair.publicKeyStruct.length, 42);
  assert.equal(pair.secretKeyStruct.length, 158);
  assert.match(renderPublicKeyFile(pair), /^untrusted comment: minisign public key [0-9A-F]{16}\n[A-Za-z0-9+/]+=*\n$/);

  const publicKey = parsePublicKeyFile(renderPublicKeyFile(pair));
  assert.equal(publicKey.keyId, pair.keyId);
  const secret = parseSecretKeyFile(renderSecretKeyFile(pair));
  assert.equal(secret.keyId, pair.keyId);

  const data = Buffer.from("SHA256SUMS contents\n");
  const signature = createSignatureFile(data, secret, { trustedComment: "infra-cod release 0.1.0", publicKey: pair.publicKeyStruct });
  const result = verifySignature(data, signature, renderPublicKeyFile(pair));
  assert.equal(result.trustedComment, "infra-cod release 0.1.0");
  assert.equal(result.keyId, pair.keyId);
});

test("every tampering path a verifier must catch is caught, with the reason named", () => {
  const pair = keyPairFromSeed(Buffer.alloc(32, 9));
  const secret = { keyId: pair.keyId, keynum: pair.publicKeyStruct.subarray(2, 10), privateKey: pair.privateKey };
  const data = Buffer.from("SHA256SUMS contents\n");
  const signature = createSignatureFile(data, secret, { trustedComment: "infra-cod release 0.1.0" });
  const publicKeyFile = renderPublicKeyFile(pair);
  const lines = signature.split("\n");

  // One byte of the signed payload.
  assert.throws(
    () => verifySignature(Buffer.from("SHA256SUMS contents!\n"), signature, publicKeyFile),
    /does not verify against the pinned public key/,
  );

  // A different key: the key id check fires first, which is the informative error.
  const other = generateKeyPair();
  assert.throws(() => verifySignature(data, signature, renderPublicKeyFile(other)), /signature key id is .* but the pinned public key id is/);

  // The trusted comment, edited to say something more reassuring.
  const commentTampered = [...lines];
  commentTampered[2] = "trusted comment: infra-cod release 9.9.9";
  assert.throws(() => verifySignature(data, commentTampered.join("\n"), publicKeyFile), /trusted comment signature does not verify/);

  // A byte of the signature itself.
  const signatureTampered = [...lines];
  const struct = Buffer.from(signatureTampered[1], "base64");
  struct[30] ^= 1;
  signatureTampered[1] = struct.toString("base64");
  assert.throws(() => verifySignature(data, signatureTampered.join("\n"), publicKeyFile), /does not verify/);

  // The legacy, non-prehashed algorithm, which minisign itself refuses by default.
  const legacy = [...lines];
  const legacyStruct = Buffer.from(legacy[1], "base64");
  legacyStruct[0] = 0x45;
  legacyStruct[1] = 0x64;
  legacy[1] = legacyStruct.toString("base64");
  assert.throws(() => verifySignature(data, legacy.join("\n"), publicKeyFile), /legacy non-prehashed format/);

  // A truncated signature file.
  assert.throws(() => verifySignature(data, lines.slice(0, 2).join("\n"), publicKeyFile), /must have four lines/);
});

test("an encrypted secret key is refused, and an unencrypted key's zero checksum is accepted", () => {
  const pair = keyPairFromSeed(Buffer.alloc(32, 11));
  const text = renderSecretKeyFile(pair);

  // This module writes and expects unencrypted keys, which is what release signing
  // uses. An encrypted key cannot be read without scrypt from libsodium, so it is
  // refused with a message that says what to do instead of half-working.
  const encrypted = Buffer.from(text.split("\n")[1], "base64");
  encrypted[2] = 0x53;
  encrypted[3] = 0x63;
  assert.throws(
    () => parseSecretKeyFile(`untrusted comment: x\n${encrypted.toString("base64")}\n`),
    /is encrypted/,
  );

  const wrongAlgorithm = Buffer.from(text.split("\n")[1], "base64");
  wrongAlgorithm[0] = 0x58;
  wrongAlgorithm[1] = 0x58;
  assert.throws(
    () => parseSecretKeyFile(`untrusted comment: x\n${wrongAlgorithm.toString("base64")}\n`),
    /does not use the Ed algorithm/,
  );

  // The checksum field of an *unencrypted* minisign key is 32 zero bytes and
  // minisign never reads it, so this module must not either. This is the property
  // that made a real `minisign -G -W` key usable; `release-interop.test.mjs` checks
  // it against the binary, and this checks the layout assumption it rests on.
  const struct = Buffer.from(text.split("\n")[1], "base64");
  assert.equal(struct.length, 158);
  assert.deepEqual(struct.subarray(2, 4), Buffer.from([0, 0]));
  assert.deepEqual(struct.subarray(126, 158), Buffer.alloc(32));
  assert.doesNotThrow(() => parseSecretKeyFile(text));
});

test("the trusted comment names the version and nothing else", () => {
  // The defect this guards against: the builder recovered the version from the
  // artifact filename with a greedy regex, so the signed comment for
  // `infra-cod-0.1.0-linux-x64.tar.gz` read `infra-cod release 0.1.0-linux-x64`.
  assert.equal(releasedTrustedComment("0.1.0"), "infra-cod release 0.1.0");
  assert.equal(releasedTrustedComment("0.1.0-rc.1"), "infra-cod release 0.1.0-rc.1");
  assert.equal(releasedTrustedComment("0.0.0-dev+abc123"), "infra-cod release 0.0.0-dev+abc123");

  // A version that merely *looks* like it has a platform appended is a legitimate
  // SemVer prerelease and must be signed verbatim. An earlier version rejected these,
  // which would have refused to sign a real release: the guard was aimed at the
  // filename-parsing bug but hit valid versions instead. The fix is that the value is
  // passed in, not recovered — so the property to test is that any valid SemVer is
  // accepted and signed exactly, and that an invalid one is refused.
  for (const version of ["0.1.0-linux-x64", "0.1.0-darwin-arm64", "1.2.3-linux-x64.rc.1", "0.1.0+build.7"]) {
    assert.equal(
      releasedTrustedComment(version),
      `infra-cod release ${version}`,
      `${version} is valid SemVer and must be signed verbatim`,
    );
  }

  // The refusal that remains is the version contract itself, which every other part of
  // the release path applies too.
  assert.throws(() => releasedTrustedComment(""), /needs a version/);
  assert.throws(() => releasedTrustedComment("not-a-version"), /not SemVer/);
  assert.throws(() => releasedTrustedComment("0.1.0/../../etc"), /not allowed in a version/);

  // And the comment survives signing and verification byte for byte.
  const pair = keyPairFromSeed(Buffer.alloc(32, 23));
  const secret = { keyId: pair.keyId, keynum: pair.publicKeyStruct.subarray(2, 10), privateKey: pair.privateKey };
  const data = Buffer.from("SHA256SUMS contents\n");
  const signature = createSignatureFile(data, secret, { trustedComment: releasedTrustedComment("0.1.0-rc.1") });
  assert.equal(verifySignature(data, signature, renderPublicKeyFile(pair)).trustedComment, "infra-cod release 0.1.0-rc.1");
});

test("signing refuses a public key that does not match the secret key", () => {
  const pair = keyPairFromSeed(Buffer.alloc(32, 13));
  const secret = { keyId: pair.keyId, keynum: pair.publicKeyStruct.subarray(2, 10), privateKey: pair.privateKey };
  const other = generateKeyPair();
  assert.throws(
    () => createSignatureFile(Buffer.from("x"), secret, { trustedComment: "t", publicKey: other.publicKeyStruct }),
    /does not match the public key/,
  );
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

test("the migration digest is computed from the files and changes when one does", () => {
  const fixture = temporaryDirectory("migrations");
  const directory = path.join(fixture, "migrations");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "0001_first.sql"), "select 1;\n");
  writeFileSync(path.join(directory, "0002_second.sql"), "select 2;\n");
  const before = migrationSetDigest(directory);
  assert.equal(before.migrationCount, 2);
  assert.equal(before.latestMigration, "0002_second.sql");

  // A boundary move that leaves the concatenated SQL identical must still change
  // the digest: the digest is over names and per-file hashes, not over the bodies.
  writeFileSync(path.join(directory, "0001_first.sql"), "select 1;\nselect ");
  writeFileSync(path.join(directory, "0002_second.sql"), "2;\n");
  const after = migrationSetDigest(directory);
  assert.notEqual(after.migrationSetSha256, before.migrationSetSha256);

  // A rename with identical contents must also change it.
  writeFileSync(path.join(directory, "0001_first.sql"), "select 1;\n");
  writeFileSync(path.join(directory, "0002_second.sql"), "select 2;\n");
  writeFileSync(path.join(directory, "0002_renamed.sql"), "select 2;\n");
  rmSync(path.join(directory, "0002_second.sql"));
  const renamed = migrationSetDigest(directory);
  assert.notEqual(renamed.migrationSetSha256, before.migrationSetSha256);
  assert.equal(renamed.latestMigration, "0002_renamed.sql");

  rmSync(fixture, { recursive: true, force: true });
});

test("the repository's migration set is described, not hard-coded", () => {
  const digest = migrationSetDigest(path.join(root, "db/migrations"));
  assert.ok(digest.migrationCount > 0);
  assert.match(digest.latestMigration, /^\d{4}_.+\.sql$/);
  assert.match(digest.migrationSetSha256, /^[0-9a-f]{64}$/);
  // The count is whatever is on disk. Nothing in this repository may carry a second
  // copy of it: a constant in a test is how a release ends up claiming a migration
  // count that the payload does not have.
  const onDisk = readFileSync(path.join(root, "db/migrations", digest.latestMigration), "utf8");
  assert.ok(onDisk.length > 0, "the latest migration must not be empty");
  assert.equal(
    digest.migrationCount,
    readdirSync(path.join(root, "db/migrations")).filter((name) => name.endsWith(".sql")).length,
  );
});

test("a manifest with a host path, a secret or a branch name is refused", () => {
  const base = {
    schema: "infra-cod/release-manifest/1",
    product: "infra-cod",
    version: "0.1.0-rc.1",
    channel: "rc",
    release: { signed: false },
    git: { sha: "a".repeat(40), dirty: false, sourceDateEpoch: 1 },
    target: { os: "linux", arch: "x64", libc: "glibc" },
    toolchain: { node: "24.20.0", pnpm: "11.9.0", next: "16.2.10", postgresqlMajor: 17 },
    database: {
      migrationCount: 1,
      latestMigration: "0001_a.sql",
      migrationSetSha256: "b".repeat(64),
      compatibility: {
        contract: "infra-cod/schema-compatibility/1",
        unverifiedThrough: "0050",
        unverified: ["0001"],
        backwardIncompatible: [],
      },
    },
    entrypoints: { web: "web/apps/web/server.js", cli: "a", migrate: "b", runtimeSupervisor: "c" },
    payload: { fileCount: 1, bytes: 1, checksums: "FILESUMS.sha256", symlinks: [] },
  };
  assert.doesNotThrow(() => assertManifestIsHostFree(base));
  assert.doesNotThrow(() => validateManifest(base));
  // A URL that merely contains `/home/` is not a host path, and refusing it would
  // make the check unusable.
  assert.doesNotThrow(() => assertManifestIsHostFree({ ...base, homepage: "https://github.com/home/example" }));

  for (const [label, mutate] of [
    ["an absolute build path", (m) => ({ ...m, build: { root: "/Users/stepan/Project/infra_cod" } })],
    ["a home directory", (m) => ({ ...m, build: { root: "/home/operator/infra-cod" } })],
    ["a private key", (m) => ({ ...m, note: "-----BEGIN OPENSSH PRIVATE KEY-----" })],
    ["a registry token", (m) => ({ ...m, note: "//registry.npmjs.org/:_authToken=abc" })],
    ["a branch name", (m) => ({ ...m, git: { ...m.git, branch: "feat/self-hosted-foundation" } })],
  ]) {
    assert.throws(() => assertManifestIsHostFree(mutate(base)), /manifest contains/, `${label} must be refused`);
  }

  assert.throws(
    () => validateManifest({ ...base, version: "0.1.0" }, { version: "0.1.0-rc.1" }),
    /manifest version is "0.1.0", requested "0.1.0-rc.1"/,
    "a requested version must be enforced",
  );
  assert.throws(
    () => validateManifest({ ...base, target: { os: "darwin", arch: "arm64", libc: "glibc" } }, { target: { os: "linux", arch: "x64", libc: "glibc" } }),
    /manifest target.os is "darwin"/,
  );
  assert.throws(() => validateManifest({ ...base, payload: { ...base.payload, checksums: "SHA256SUMS" } }), /payload.checksums/);
  assert.throws(() => validateManifest({ ...base, channel: "nightly" }), /channel "nightly" is not one of/);
});

test("every module the deep verifier imports travels inside the artifact", () => {
  // The verifier runs from inside the extracted release, where the repository
  // does not exist. A module it imports and the artifact does not carry is not a
  // degraded verification — it is ERR_MODULE_NOT_FOUND, and the artifact cannot
  // be installed or updated to at all. That is what shipped: the compatibility
  // contract was imported by the verifier and left out of the payload, and no
  // structural test compared the two.
  const closure = serviceImportClosure({
    servicesRoot: root,
    entrypoints: ["scripts/verify-release.mjs"],
  });
  assert.deepEqual(closure.missing, []);
  const reachable = closure.files
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .filter((relative) => relative.startsWith("scripts/"))
    .sort();

  assert.deepEqual(
    reachable,
    [...VERIFIER_SCRIPTS].sort(),
    "VERIFIER_SCRIPTS must be exactly the import closure of the deep verifier",
  );
});

test("the key the runtime installer verifies against travels inside the artifact", () => {
  // The same class of defect as the one above, one directory over.
  //
  // `infra-cod runtime install` verifies the npm registry's signature against a
  // key pinned in the tree, and it resolves that key relative to the release it
  // is running from. The key was in the repository and in no release: the command
  // that Stage 11.1 exists for would have failed on the only host it is for, with
  // the file plainly present in every checkout anybody would have looked at.
  //
  // `runtime.test.mjs` could not see it. Its harness builds a synthetic release
  // and writes the key into it, so it tests the reader against a tree the packer
  // never made. This tests the packer, and against the path the reader computes.
  const staged = temporaryDirectory("trusted-keys");
  try {
    const counters = assembleTrustedKeysRelease({ repositoryRoot: root, releaseRoot: staged, hardlink: false });
    assert.equal(counters.files, TRUSTED_KEYS.length);

    assert.ok(
      TRUSTED_KEYS.includes(REGISTRY_PUBLIC_KEY),
      "the registry key the installer reads must be one the packer places",
    );

    for (const relative of TRUSTED_KEYS) {
      // The path the release is assembled at is the path `pinnedKey()` resolves:
      // it reads `<release>/<REGISTRY_PUBLIC_KEY>` from `services/operations/../..`.
      assert.deepEqual(
        readFileSync(path.join(staged, relative)),
        readFileSync(path.join(root, relative)),
        `${relative} must reach the release byte for byte`,
      );
      // A trust anchor whose name trips the payload guard is a release that
      // cannot be built at all — `.pem` and `.key` are both refused. Better to
      // fail here, where the reason is named, than in the packer's final walk.
      assert.equal(isForbiddenName(relative), null, `${relative} would be refused by the payload guard`);
    }

    // Bytes that parse as a key are not yet the right key. This is a real
    // `dist.signatures` entry from `registry.npmjs.org` for the version ADR-0012
    // pins, verified against the copy that ships — so a truncated, re-encoded or
    // quietly rotated key fails here rather than on the host.
    const placed = readFileSync(path.join(staged, REGISTRY_PUBLIC_KEY), "utf8");
    const verified = verifyRegistrySignature({
      name: "@openai/codex",
      version: "0.154.0-linux-x64",
      integrity: "sha512-a4FI3A8sGtwGrOqltrPbrS2hajrHQG591EwmRfiRoLMb10VxdBtUGW4gu6IJVYENiYGA7k3P4jlRHEoCZU/s9Q==",
      signatures: [{
        keyid: REGISTRY_KEY_ID,
        sig: "MEUCIBFWxn7pj29BIGp6PqEc5fup6VUS1wr53PnBNTIB5iaMAiEA7ctnSmbpmNNTF64TNHKELO+uItnkSvmvTT+CvLc+Jes=",
      }],
    }, { key: placed });
    assert.equal(verified.keyId, REGISTRY_KEY_ID);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
});

test("every control-plane tool the executor is asked to call is shipped and installed", () => {
  // The prompt named three tools, the supervisor implemented all three, and the
  // release shipped none of them: their definitions were listed as PoC leftovers
  // because no module imports them. Nothing connected the three places, so the
  // executor was told to call tools it could not see — it worked for sixteen
  // minutes and failed with "did not submit a terminal report", which is true
  // and explains nothing.
  //
  // This is the connection. The prompt is the source: whatever it names must
  // exist as a definition, ship in the payload, and be installed by both the
  // installer and the update.
  const prompt = readFileSync(path.join(root, "services/control-plane/implementation-worker.mjs"), "utf8");
  const named = [...prompt.matchAll(/\b(complete_task|report_blocker|request_user_input)\b/g)]
    .map((match) => match[1]);
  const tools = [...new Set(named)].sort();
  assert.deepEqual(
    tools, ["complete_task", "report_blocker", "request_user_input"],
    "the prompt should name the three terminal tools; update this test if the set changes",
  );

  const assets = [...SERVICE_RUNTIME_ASSETS.keys()];
  for (const tool of tools) {
    const relative = `runtime-supervisor/opencode-tools/${tool}.ts`;
    assert.ok(
      existsSync(path.join(root, "services", relative)),
      `${tool} is named in the prompt but has no definition at services/${relative}`,
    );
    assert.ok(
      assets.includes(relative),
      `${tool} has a definition that the release payload does not ship; `
      + "add it to SERVICE_RUNTIME_ASSETS or the executor cannot call it",
    );
  }

  // And both paths that put a release on a host must install them, because a
  // host reaches its current release through one or the other. Since WP-A both
  // install the release's declaration through the same reconciler, so the
  // question is whether the declaration carries each tool, and whether each path
  // runs the reconciler.
  const declared = declareInstall(root).files
    .filter((entry) => entry.root === "runtime-tools" && entry.runtime === "opencode")
    .map((entry) => entry.name);
  for (const tool of tools) {
    assert.ok(declared.includes(`${tool}.ts`), `${tool}.ts is not in the release's install declaration`);
  }
  const installer = readFileSync(path.join(root, "deploy/install.sh"), "utf8");
  const update = readFileSync(path.join(root, "services/operations/update.mjs"), "utf8");
  assert.match(installer, /services\/operations\/install-reconcile\.mjs" "\$1"/,
    "install.sh does not run the release's reconciler; a host installed through it has no tool definitions");
  assert.match(update, /reconcileInstall\(/,
    "update.mjs does not reconcile to the release's declaration; a host updated through it has no tool definitions");
});
