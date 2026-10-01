#!/usr/bin/env node
// Verifies a release artifact, and — with `--extract` — unpacks it.
//
// This is the contract Stage 10 installs against. Its order is the security
// property, not a convenience:
//
//   pinned public key -> detached signature over SHA256SUMS -> checksum of the
//   tarball -> safe member list -> extraction -> manifest identity -> FILESUMS
//   -> symlink closure -> required paths -> (optional) runtime smoke
//
// Nothing is extracted, and no filename is believed, before the signature over the
// checksums has been verified against a public key that came from the reviewed
// repository rather than from the artifact. `infra-cod-9.9.9-linux-x64.tar.gz`
// whose manifest says `0.1.0-rc.1` is refused, and so is a `linux/arm64` build
// requested as `linux/x64`.
//
// The verifier never rebuilds anything: it only ever reads the file it was given.
// That is the difference between verifying a release and producing a new one.
//
// Usage:
//   node scripts/verify-release.mjs --artifact <tarball> [--checksums <file>]
//        [--signature <file>] [--public-key <file>] [--require-signature]
//        [--version <semver>] [--channel <dev|rc|stable>] [--target linux-x64]
//        [--extract <dir>] [--smoke] [--json]

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

import { ArchiveError, extractTar, listTarMembers, assertSafeMembers } from "./lib/release-archive.mjs";
import { ManifestError } from "./lib/release-manifest.mjs";
import { PayloadError } from "./lib/release-payload.mjs";
import { SignatureError, parsePublicKeyFile, verifySignature } from "./lib/release-signature.mjs";
import { VerificationError, verifyExtractedRelease } from "./lib/release-verify.mjs";
import { VersionContractError, artifactName, channelFor, loadVersionSource } from "./lib/release-version.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class ReleaseVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseVerificationError";
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export function parseArguments(argv) {
  const options = {
    artifact: null,
    checksums: null,
    signature: null,
    publicKey: null,
    requireSignature: false,
    version: null,
    channel: null,
    target: null,
    extract: null,
    smoke: false,
    json: false,
    quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new VersionContractError(`${argument} needs a value`);
      index += 1;
      return value;
    };
    if (argument === "--artifact") options.artifact = next();
    else if (argument === "--checksums") options.checksums = next();
    else if (argument === "--signature") options.signature = next();
    else if (argument === "--public-key") options.publicKey = next();
    else if (argument === "--require-signature") options.requireSignature = true;
    else if (argument === "--version") options.version = next();
    else if (argument === "--channel") options.channel = next();
    else if (argument === "--target" || argument === "--expect-target") options.target = next();
    else if (argument === "--extract") options.extract = path.resolve(next());
    else if (argument === "--smoke") options.smoke = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "usage: node scripts/verify-release.mjs --artifact <tarball> [options]\n"
          + "\n"
          + "  --checksums <file>       SHA256SUMS (default: beside the artifact)\n"
          + "  --signature <file>       SHA256SUMS.minisig (default: beside the checksums)\n"
          + "  --public-key <file>      pinned minisign public key (default: release-version.json)\n"
          + "  --require-signature      fail unless a signature is present and valid\n"
          + "  --version <semver>       require this version in the manifest\n"
          + "  --channel <c>            require this channel (dev, rc, stable)\n"
          + "  --target <os-arch>       require this target in the manifest (--expect-target is an alias)\n"
          + "  --extract <dir>          extract into <dir>/<release-root> after verifying\n"
          + "  --smoke                  import pg/hash-wasm and run `infra-cod version`\n"
          + "  --json                   print a machine-readable report\n",
      );
      process.exit(0);
    } else throw new VersionContractError(`unknown argument: ${argument}`);
  }
  if (!options.artifact) throw new VersionContractError("--artifact is required");
  return options;
}

// ---------------------------------------------------------------------------
// Signature and checksum, in that order
// ---------------------------------------------------------------------------

// Parses a `SHA256SUMS` line list. `sha256sum -c` format: two spaces between the
// digest and the name.
export function parseChecksumFile(text, { artifactName: expectedName } = {}) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new ReleaseVerificationError(`SHASUMS line is not in sha256sum format: ${JSON.stringify(line)}`);
    const [, sha256, name] = match;
    if (name.startsWith("/") || name.includes("..")) {
      throw new ReleaseVerificationError(`SHASUMS names an unsafe path: ${JSON.stringify(name)}`);
    }
    entries.push({ sha256, name });
  }
  if (entries.length === 0) throw new ReleaseVerificationError("the checksum file is empty");

  // A directory full of artifacts may hold more than one tarball. Picking "the
  // only one" or "the newest one" would make the verified bytes depend on what
  // happens to be lying around, so the artifact must be named by the checksum file
  // it is being checked against.
  if (expectedName !== undefined) {
    const match = entries.find((entry) => entry.name === expectedName);
    if (!match) {
      throw new ReleaseVerificationError(
        `${expectedName} is not listed in the checksum file (it lists ${entries.map((entry) => entry.name).join(", ")}). `
          + "Refusing to guess which entry describes this artifact.",
      );
    }
    return { entry: match, entries };
  }
  if (entries.length !== 1) {
    throw new ReleaseVerificationError(
      `the checksum file lists ${entries.length} artifacts; pass --artifact with a name that is in it`,
    );
  }
  return { entry: entries[0], entries };
}

// Reads the artifact in chunks. The whole point of hashing is that it works on a
// file too large to hold, and a release is exactly that file.
export function sha256FileStreaming(file) {
  const hash = createHash("sha256");
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// The verification pipeline
// ---------------------------------------------------------------------------

// Everything up to and including extraction, in the required order. Returns the
// paths the caller needs for the deep checks.
export function verifyArtifact({
  artifact,
  checksums,
  signature,
  publicKey,
  requireSignature,
  version,
  channel,
  target,
  extract,
  log,
}) {
  if (!existsSync(artifact)) throw new ReleaseVerificationError(`artifact does not exist: ${artifact}`);
  const artifactPath = path.resolve(artifact);
  const baseName = path.basename(artifactPath);
  const checksumsPath = checksums ?? path.join(path.dirname(artifactPath), "SHA256SUMS");
  const signaturePath = signature ?? `${checksumsPath}.minisig`;

  if (!existsSync(checksumsPath)) {
    throw new ReleaseVerificationError(`checksum file does not exist: ${checksumsPath}`);
  }
  const checksumText = readFileSync(checksumsPath, "utf8");
  const { entry } = parseChecksumFile(checksumText, { artifactName: baseName });

  // 1. The signature, over the checksum file, against the pinned key.
  let signatureReport = { verified: false, keyId: null, trustedComment: null };
  if (existsSync(signaturePath)) {
    if (!publicKey) {
      throw new ReleaseVerificationError(
        `a signature exists at ${signaturePath} but no public key was given; `
          + "a signature nobody has a key for verifies nothing",
      );
    }
    if (!existsSync(publicKey)) throw new ReleaseVerificationError(`public key does not exist: ${publicKey}`);
    const key = parsePublicKeyFile(readFileSync(publicKey, "utf8"));
    const result = verifySignature(Buffer.from(checksumText, "utf8"), readFileSync(signaturePath, "utf8"), key);
    signatureReport = { verified: true, keyId: result.keyId, trustedComment: result.trustedComment, keyFile: publicKey };
    log(`signature verified against ${path.basename(publicKey)} (key ${result.keyId})`);
  } else if (requireSignature) {
    throw new ReleaseVerificationError(
      `no signature at ${signaturePath} and --require-signature was given. An unsigned artifact is not a release.`,
    );
  } else {
    log(`no signature at ${signaturePath}; continuing unsigned (pass --require-signature to make this fatal)`);
  }

  // 2. The checksum of the artifact, against the *signed* checksum file.
  const actual = sha256FileStreaming(artifactPath);
  if (actual !== entry.sha256) {
    throw new ReleaseVerificationError(
      `the artifact does not match its checksum: SHA256SUMS says ${entry.sha256}, the file hashes to ${actual}`,
    );
  }
  log(`checksum verified: ${actual}`);

  // 3. The member list, before anything is written anywhere.
  const compressed = readFileSync(artifactPath);
  const tar = gunzip(compressed);
  const members = listTarMembers(tar);
  const topLevel = assertSafeMembers(members);
  log(`archive members are safe: ${members.length} entries under ${topLevel}/`);

  // 4. Extraction, into a location the caller chose, or into a temporary one only
  //    for the deep checks. `--extract` is the only way anything is left behind.
  const extractionRoot = extract ?? path.join(os.tmpdir(), `infra-cod-verify-${process.pid}`);
  const created = extract === null || extract === undefined;
  mkdirSync(extractionRoot, { recursive: true });
  const result = extractTar(tar, extractionRoot, { topLevelDirectory: topLevel });
  const releaseRoot = path.join(extractionRoot, result.root);
  log(`extracted to ${releaseRoot}`);

  const deep = verifyExtractedRelease(releaseRoot, {
    version,
    target,
    channel,
  });

  return {
    artifactPath,
    baseName,
    checksumsPath,
    signaturePath,
    signature: signatureReport,
    sha256: actual,
    topLevel,
    memberCount: members.length,
    releaseRoot,
    extractionRoot,
    createdExtractionRoot: created,
    manifest: deep.manifest,
    verification: deep,
  };
}

// gzip is decoded here rather than by a child process so the verifier has no
// dependency beyond Node itself, which is what lets it run before anything else is
// installed.
function gunzip(buffer) {
  try {
    return gunzipSync(buffer);
  } catch (error) {
    throw new ReleaseVerificationError(`the artifact is not a readable gzip stream: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Runtime smoke
// ---------------------------------------------------------------------------

// Imports the two production dependencies the non-web services need, runs the CLI,
// and starts the web entry point long enough to observe that it is alive.
//
// The web half used to be a synchronous spawn whose output was pattern-matched for
// known packaging failures. That accepts a server which dies immediately: an empty
// output, a `SyntaxError`, or a `throw` this module had not thought of were all
// "no packaging failure detected". A pattern list can only reject what somebody
// anticipated, and the failure that matters — the panel does not start — has no
// fixed text.
//
// So the process is started asynchronously and its *state* is observed instead:
//
//   * the child must still be running after a short settling period; an early exit
//     is a failure whatever it printed, and its output is reported with it;
//   * a TCP connection to the port it was told to bind must be accepted, which is
//     the observable readiness signal — not a sleep, and not a log line;
//   * only then is it stopped, and only a clean stop counts.
//
// `PORT=0` would let the kernel choose, but then nothing can be probed without
// parsing a log line, so the smoke picks a free port first and proves it is free.
export async function runtimeSmoke({ releaseRoot, nodePath = process.execPath, timeoutMs = 30_000 }) {
  const manifest = JSON.parse(readFileSync(path.join(releaseRoot, "manifest.json"), "utf8"));
  const results = [];

  for (const packageName of ["pg", "hash-wasm"]) {
    const script = `import(${JSON.stringify(packageName)}).then(() => process.stdout.write("ok")).catch((error) => { process.stderr.write(String(error && error.message)); process.exit(1); })`;
    const result = spawnSync(nodePath, ["-e", script], {
      cwd: releaseRoot,
      encoding: "utf8",
      timeout: timeoutMs,
      env: { PATH: path.dirname(nodePath), HOME: releaseRoot, NODE_ENV: "production" },
    });
    if (result.status !== 0) {
      throw new ReleaseVerificationError(
        `import(${JSON.stringify(packageName)}) failed inside the release: ${(result.stderr || result.stdout || "").trim()}`,
      );
    }
    results.push({ name: `import:${packageName}`, ok: true });
  }

  const cli = spawnSync(nodePath, [path.join(releaseRoot, manifest.entrypoints.cli), "version"], {
    cwd: releaseRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { PATH: path.dirname(nodePath), HOME: releaseRoot },
  });
  if (cli.status !== 0) {
    throw new ReleaseVerificationError(`infra-cod version failed inside the release: ${(cli.stderr || "").trim()}`);
  }
  const report = JSON.parse(cli.stdout);
  if (report.version !== manifest.version) {
    throw new ReleaseVerificationError(
      `infra-cod version reports ${JSON.stringify(report.version)} but the manifest says ${JSON.stringify(manifest.version)}`,
    );
  }
  results.push({ name: "cli:version", ok: true, version: report.version });

  const web = await smokeWebEntrypoint({ releaseRoot, nodePath, manifest, timeoutMs });
  results.push({ name: "web:entrypoint", ok: true, ...web });

  return { results, version: report.version, node: nodePath };
}

// Starts the web entry point, proves it is listening, and stops it.
//
// The observable signal is a TCP connection that succeeds. That requires no
// knowledge of what the server logs, works for any framework, and cannot be
// satisfied by a process that has already exited.
async function smokeWebEntrypoint({ releaseRoot, nodePath, manifest, timeoutMs }) {
  const port = await freePort();
  const entrypoint = path.join(releaseRoot, manifest.entrypoints.web);

  const environment = {
    PATH: path.dirname(nodePath),
    HOME: releaseRoot,
    TMPDIR: os.tmpdir(),
    NODE_ENV: "production",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    INFRA_COD_SITE_URL: `http://127.0.0.1:${port}`,
    // A port nothing listens on. Without a database the server is expected to start
    // and then fail on the first query; that is the state this smoke runs in, and it
    // is the state an install is in before Stage 2 and Stage 10 have run. The point
    // here is that it *starts*.
    DATABASE_URL: "postgresql://127.0.0.1:1/infra_cod_absent_for_smoke",
    NEXT_TELEMETRY_DISABLED: "1",
  };

  const child = spawn(nodePath, [entrypoint], {
    // `WorkingDirectory=/opt/infra-cod/current/web` in the unit, so that is the
    // working directory here: whatever the server resolves relative to the process
    // must resolve the same way in the smoke test as on the host.
    cwd: path.join(releaseRoot, "web"),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let exited = null;
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => { exited = { code, signal }; resolve(exited); });
  });

  try {
    // 1. The process must survive long enough to bind. `settle` is not a readiness
    //    wait — it is the window in which an immediate crash shows up as an exit
    //    rather than as silence.
    const settle = await Promise.race([
      exit.then((result) => ({ kind: "exit", result })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: "alive" }), 750)),
    ]);
    if (settle.kind === "exit") {
      throw new ReleaseVerificationError(
        `the web entry point exited immediately (${describeExit(settle.result)}) instead of starting:\n${tail(output)}`,
      );
    }

    // 2. Readiness: a connection to the port it was told to bind.
    const ready = await waitForListener(port, timeoutMs);
    if (!ready.ok) {
      throw new ReleaseVerificationError(
        `the web entry point did not accept a connection on 127.0.0.1:${port} within ${timeoutMs}ms `
          + `(last state: ${ready.reason}):\n${tail(output)}`,
      );
    }

    // 3. It must still be running once it is listening. A server that binds and then
    //    dies is not a working server.
    if (exited !== null) {
      throw new ReleaseVerificationError(
        `the web entry point accepted a connection and then exited (${describeExit(exited)}):\n${tail(output)}`,
      );
    }

    // 4. A packaging failure in the output is still reported, because it is
    //    evidence about *why* something else went wrong, but it is no longer the
    //    only thing that can fail this step.
    const packagingFailure = classifyWebStartFailure(output);
    const cancelled = cancelledPackagingFailure(output);
    if (packagingFailure && !cancelled) {
      throw new ReleaseVerificationError(
        `the web entry point is listening but reported a packaging problem (${packagingFailure}):\n${tail(output)}`,
      );
    }

    return { port, readyAfterMs: ready.elapsedMs, packagingWarning: cancelled };
  } finally {
    // Stop it the way systemd does, and never leave an orphan behind.
    //
    // `exit` is the only promise awaited here that is guaranteed to settle: it is
    // resolved by the `exit` event, which follows any kill. The first version of
    // this block also awaited a promise that resolved on the child's `error` event,
    // which never fires for a process that spawned successfully — so the smoke hung
    // forever on the happy path. A promise that only settles on failure must never be
    // awaited unconditionally.
    if (exited === null) child.kill("SIGTERM");
    const stopped = await Promise.race([
      exit.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    if (!stopped) {
      child.kill("SIGKILL");
      await exit;
    }
  }
}

function describeExit(result) {
  if (result.error) return `spawn error: ${result.error.message}`;
  if (result.signal) return `killed by ${result.signal}`;
  return `exit code ${result.code}`;
}

function tail(output, limit = 2000) {
  const text = output.trim();
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Repeatedly attempts a TCP connection until one is accepted or the budget runs
// out. The budget is a diagnostic timeout, not a readiness wait: success is a
// completed connection, and the elapsed time is reported so a slow start is
// visible rather than hidden behind a fixed sleep.
async function waitForListener(port, timeoutMs) {
  const { createConnection } = await import("node:net");
  return new Promise((resolve) => {
    const started = Date.now();
    let lastReason = "no attempt made";
    const attempt = () => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const finish = (ok, reason) => {
        socket.removeAllListeners();
        socket.destroy();
        if (ok) resolve({ ok: true, elapsedMs: Date.now() - started });
        else if (Date.now() - started >= timeoutMs) resolve({ ok: false, reason, elapsedMs: Date.now() - started });
        else setTimeout(attempt, 100);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", (error) => { lastReason = error.code ?? error.message; finish(false, lastReason); });
      socket.setTimeout(2_000, () => finish(false, "connection attempt timed out"));
    };
    attempt();
  });
}

// Distinguishes "the release is broken" from "the environment is not configured".
// Only the first is this stage's business: a run without a database is supposed to
// fail, and reporting that as a release defect would make the smoke test useless.
const PACKAGING_FAILURE_PATTERNS = [
  [/Cannot find module/i, "missing module"],
  [/ERR_MODULE_NOT_FOUND/i, "missing module"],
  [/MODULE_NOT_FOUND/i, "missing module"],
  [/Cannot find package/i, "missing package"],
  [/ENOENT.*\.next/i, "missing build output"],
  [/ENOENT.*server\.js/i, "missing entry point"],
  [/spawn (npm|pnpm|yarn|corepack)/i, "package manager invoked"],
  [/\bnpm ERR!/, "package manager invoked"],
];

export function classifyWebStartFailure(output) {
  for (const [pattern, label] of PACKAGING_FAILURE_PATTERNS) {
    if (pattern.test(output)) return label;
  }
  return null;
}

// Next prints "Ready" and then, on a deployment that is not configured, a database
// error. Some of those messages contain text the packaging patterns match — a
// Postgres error can mention `Cannot find module` for an optional driver, for
// example — so a match in an output that also proves the server to be listening is
// reported as a warning. The state check is what decides; this only explains.
function cancelledPackagingFailure(output) {
  return /ECONNREFUSED|ENOTFOUND|password authentication|role .* does not exist|database .* does not exist|connect ECONNREFUSED/i.test(output)
    ? classifyWebStartFailure(output)
    : null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const log = options.quiet ? () => {} : (message) => process.stdout.write(`${message}\n`);

  const source = loadVersionSource(repositoryRoot);
  // The target is checked only when the caller names one.
  //
  // Defaulting it to `release-version.json` looks stricter and is worse: the
  // pinned target is `linux-x64`, so every diagnostic build — the ones
  // `--allow-off-target` names after the host — would be refused by the verifier
  // that is supposed to read them, and the failure would read as a broken artifact
  // rather than as "you asked for the wrong platform". An installer must pass the
  // target it intends to install on, which is a decision it has to make anyway, and
  // the CI and documentation examples both do.
  if (options.target !== null) parseTarget(options.target);

  // The pinned public key. When the caller names one that does not exist, failing
  // immediately is the honest response: every path after this one either verifies
  // against a key or silently treats the artifact as unsigned.
  if (options.publicKey !== null && !existsSync(options.publicKey)) {
    throw new ReleaseVerificationError(`--public-key names a file that does not exist: ${options.publicKey}`);
  }
  const defaultKey = path.resolve(repositoryRoot, source.signing.publicKey);
  const publicKey = options.publicKey ?? defaultKey;
  const target = options.target ? parseTarget(options.target) : null;

  const report = verifyArtifact({
    artifact: options.artifact,
    checksums: options.checksums,
    signature: options.signature,
    publicKey,
    requireSignature: options.requireSignature,
    version: options.version,
    channel: options.channel,
    target,
    extract: options.extract,
    log,
  });

  let smoke = null;
  if (options.smoke) {
    smoke = await runtimeSmoke({ releaseRoot: report.releaseRoot });
    log(`runtime smoke passed: ${smoke.results.map((entry) => entry.name).join(", ")}`);
  }

  const summary = {
    schema: "infra-cod/release-verification/1",
    artifact: report.baseName,
    sha256: report.sha256,
    signed: report.signature.verified,
    keyId: report.signature.keyId,
    trustedComment: report.signature.trustedComment,
    topLevel: report.topLevel,
    members: report.memberCount,
    version: report.manifest.version,
    channel: report.manifest.channel,
    target: report.manifest.target,
    gitSha: report.manifest.git.sha,
    migrations: report.manifest.database.migrationCount,
    payload: report.manifest.payload,
    releaseRoot: report.releaseRoot,
    smoke,
  };

  if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else log(`verified ${report.baseName} (${report.manifest.version}, ${report.manifest.channel})`);

  // A temporary extraction is removed; an explicit one is the caller's to keep.
  if (report.createdExtractionRoot) rmSync(report.extractionRoot, { recursive: true, force: true });
  return summary;
}

function parseTarget(value) {
  const match = /^([a-z0-9]+)-([a-z0-9_]+)$/.exec(value);
  if (!match) throw new VersionContractError(`--target must look like linux-x64, got ${JSON.stringify(value)}`);
  return { os: match[1], arch: match[2], libc: "glibc" };
}

// Only run when invoked as a program. Unlike the CLI, this file is also imported
// by the test suite, and importing it must not start a verification of whatever
// arguments the test runner happens to have.
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    const expected = [ReleaseVerificationError, VersionContractError, SignatureError, ArchiveError, VerificationError, ManifestError, PayloadError];
    const label = expected.some((type) => error instanceof type) ? error.name : "error";
    process.stderr.write(`release verification failed (${label}): ${error.message}\n`);
    process.exitCode = 1;
  }
}

export { main as runVerifyRelease };
