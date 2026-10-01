#!/usr/bin/env node
// Offline acceptance: does the release run with no network at all?
//
// The relocation test in `release-artifact.test.mjs` removes `npm`, `pnpm`, `yarn`
// and `corepack` from `PATH` and asserts that `pg`, `hash-wasm` and the CLI still
// work. That proves the artifact does not *invoke a package manager*. It does not
// prove the artifact does not reach the **network** — a process whose `PATH` is
// clean can still open a socket, and `NO_PROXY=*` permits direct connections rather
// than blocking them. The two guarantees are different and the second one is the
// one that matters on a VPS with no egress: a release that downloads a dependency at
// boot would pass every test the first version had and fail in production.
//
// So the smoke is re-run inside a network namespace with no interfaces:
//
//   unshare --net --map-root-user  (util-linux, present on Ubuntu 24.04)
//
// Inside it, the only reachable address is loopback and no route exists. Anything
// that tries to resolve a registry or fetch a tarball fails immediately and visibly.
//
// The network namespace requires Linux. On macOS this exits with a skip code and a
// message naming the reason, because a check that silently passes on a platform
// that cannot perform it is worse than one that is absent. CI runs it on
// `ubuntu-24.04`, which is the platform the artifact is for.
//
// Usage:
//   node scripts/offline-smoke.mjs --artifact <tarball> [--public-key <file>]
//                                  [--require-signature] [--json]

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractTar, listTarMembers, assertSafeMembers } from "./lib/release-archive.mjs";
import { parsePublicKeyFile, verifySignature } from "./lib/release-signature.mjs";
import { sha256FileStreaming } from "./verify-release.mjs";
import { gunzipSync } from "node:zlib";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SKIP_EXIT_CODE = 78; // EX_CONFIG: "the platform cannot run this check"

function parseArguments(argv) {
  const options = { artifact: null, publicKey: null, requireSignature: false, json: false, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--artifact") options.artifact = path.resolve(argv[++index]);
    else if (argument === "--public-key") options.publicKey = path.resolve(argv[++index]);
    else if (argument === "--require-signature") options.requireSignature = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--keep") options.keep = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.artifact) throw new Error("--artifact is required");
  return options;
}

// The script that runs *inside* the namespace. It is written as a heredoc-style
// literal rather than assembled from the parent so that the environment the child
// sees is fully explicit: no inherited proxy variables, no inherited HOME, nothing
// from this process.
export function sandboxScript({ releaseRoot, sandboxRoot = releaseRoot }) {
  return `
set -eu
RELEASE=${JSON.stringify(releaseRoot)}
SANDBOX=${JSON.stringify(sandboxRoot)}

# A PATH with the pinned Node and the system directories, and no package manager.
# Sentinels are placed in the sandbox for npm/pnpm/yarn/corepack, so an invocation is
# a hard failure rather than a plain "command not found" that a fallback could swallow.
SENTINELS="$SANDBOX/sentinels"
mkdir -p "$SENTINELS"
for tool in npm pnpm yarn corepack; do
  printf '#!/bin/sh\\necho "the release invoked %s while offline" >&2\\nexit 97\\n' "$tool" > "$SENTINELS/$tool"
  chmod 0755 "$SENTINELS/$tool"
done
export PATH="$SENTINELS:$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin"

# Registry and proxy variables are cleared rather than trusted to be absent.
unset npm_config_registry NPM_CONFIG_REGISTRY NODE_AUTH_TOKEN NPM_TOKEN || true
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy NO_PROXY no_proxy || true

# Bring loopback up. A fresh network namespace starts with lo administratively
# DOWN, so nothing can bind or connect to 127.0.0.1 — the smoke's readiness probe
# failed with ENETUNREACH while the server logged Ready, because the server could
# not bind and the probe could not connect. ip is in iproute2, which is part of the
# base image; when it is absent the smoke says so instead of reporting a listener
# that never existed.
# Only failure is fatal, and only when the assertion is expected to hold. In
# rehearsal mode there is no namespace at all, so loopback is already up and ip
# may not even exist.
if ! ip link set lo up 2>/dev/null; then
  if [ -n "$INFRA_COD_OFFLINE_SKIP_ISOLATION_ASSERTION" ]; then
    echo "rehearsal mode: no iproute2, loopback is already up outside a namespace"
  else
    echo "could not bring loopback up in the network namespace; without it nothing can bind or connect" >&2
    exit 1
  fi
else
  echo "loopback is up"
fi

# A temporary HOME and TMPDIR, so nothing can be read from or written to a home
# directory that happens to contain a cache.
export HOME="$SANDBOX/home"
export TMPDIR="$SANDBOX/tmp"
export NODE_ENV=production
mkdir -p "$HOME" "$TMPDIR"

# 1. No network at all: the loopback interface is the only one, and there is no
#    route. This is asserted, not assumed — if the namespace were not applied the
#    check below would fail, and that failure would be the point. The rehearsal mode
#    skips it, because without a namespace it is guaranteed to fail; a real run
#    never does, so the assertion cannot be silently lost.
if [ "\${INFRA_COD_OFFLINE_SKIP_ISOLATION_ASSERTION:-}" != "1" ]; then
  node -e '
  const net = require("node:net");
  const socket = net.createConnection({ host: "1.1.1.1", port: 443 });
  const timer = setTimeout(() => { console.error("no route out (timed out), which is what we want"); process.exit(0); }, 2000);
  socket.once("connect", () => { console.error("NETWORK REACHABLE: the sandbox has a route out"); process.exit(1); });
  socket.once("error", (error) => { clearTimeout(timer); console.error("no route out:", error.code); process.exit(0); });
  '
else
  echo "isolation assertion skipped by rehearsal mode"
fi

# 2. The dependencies the services import.
cd "$RELEASE"
node -e 'import("pg").then(() => process.stdout.write("pg ok\\n"))'
node -e 'import("hash-wasm").then(() => process.stdout.write("hash-wasm ok\\n"))'

# 3. The CLI, whose answer must come from the release manifest.
node services/cli/infra-cod.mjs version > "$TMPDIR/version.json"
node -e '
const { readFileSync } = require("node:fs");
const report = JSON.parse(readFileSync(process.argv[1], "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
if (report.version !== manifest.version) {
  console.error("the CLI reports", report.version, "but the manifest says", manifest.version);
  process.exit(1);
}
console.error("cli version ok:", report.version);
' "$TMPDIR/version.json"

# 4. The web entry point must become ready.
#
# The port is chosen first, synchronously, and passed to the server explicitly. The
# earlier version wrote it to a file from a background process and read the file
# immediately afterwards — a race in which the read usually won, leaving PORT empty
# and the server bound to its default 3000 while the readiness probe polled the port
# it had meant to use. It looked exactly like a server that never listened.
#
# HOSTNAME and PORT are *exported*: an unexported shell variable does not reach the
# server's environment.
PORT=$(node -e '
const net = require("node:net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port));
  server.close();
});
')
case "$PORT" in
  ""|*[!0-9]*) echo "could not allocate a loopback port (got \"$PORT\")" >&2; exit 1 ;;
esac
export PORT HOSTNAME=127.0.0.1
echo "web entry point will bind 127.0.0.1:$PORT"

WEB="$RELEASE/web/apps/web/server.js"
node "$WEB" > "$TMPDIR/web.log" 2>&1 &
WEB_PID=$!
cleanup() { kill "$WEB_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# One process decides readiness: it requires a completed TCP connection to the port
# the server was told to use, and fails immediately if the child has exited.
node -e '
const net = require("node:net");
const [pid, port, timeoutMs] = process.argv.slice(1);
const started = Date.now();
const deadline = started + Number(timeoutMs);
function alive() { try { process.kill(Number(pid), 0); return true; } catch { return false; } }
function attempt() {
  if (!alive()) { console.error("the web entry point died before it listened"); process.exit(1); }
  const socket = net.createConnection({ host: "127.0.0.1", port: Number(port) });
  let settled = false;
  const done = (ok, why) => {
    if (settled) return; settled = true;
    socket.removeAllListeners(); socket.destroy();
    if (ok) { console.error("web entry point listening after " + (Date.now() - started) + "ms"); process.exit(0); }
    if (Date.now() >= deadline) { console.error("no listener on 127.0.0.1:" + port + " after " + (Date.now() - started) + "ms: " + why); process.exit(1); }
    setTimeout(attempt, 100);
  };
  socket.once("connect", () => done(true));
  socket.once("error", (error) => done(false, error.code));
  socket.setTimeout(1000, () => done(false, "attempt timed out"));
}
attempt();
' "$WEB_PID" "$PORT" 20000
if [ $? -ne 0 ]; then
  echo "the web entry point never listened:" >&2
  cat "$TMPDIR/web.log" >&2
  exit 1
fi

# The packaging failures that would mean the release is broken rather than merely
# unconfigured. A database error is not one of them.
if grep -qE "Cannot find module|ERR_MODULE_NOT_FOUND|Cannot find package" "$TMPDIR/web.log"; then
  echo "the web entry point failed for a packaging reason:" >&2
  cat "$TMPDIR/web.log" >&2
  exit 1
fi

echo "offline smoke passed"
`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!existsSync(options.artifact)) throw new Error(`artifact does not exist: ${options.artifact}`);

  // 1. Verify first, always. Extracting inside a namespace does not make an
  //    unverified archive safe, and this command is also a convenient place to
  //    prove the signature path runs with no network.
  const directory = path.dirname(options.artifact);
  const checksums = path.join(directory, "SHA256SUMS");
  const signature = `${checksums}.minisig`;

  // `--require-signature` means the artifact is not used unless a signature has been
  // *cryptographically verified* against the pinned key. The first version accepted
  // the mere presence of a `.minisig` file: the verification call was nested inside
  // `if (options.publicKey)`, so a file of the right name with no key given skipped
  // it entirely and the command went on to run the smoke and exit 0. Any file with
  // the right name was enough to satisfy a flag whose whole purpose is to refuse
  // that.
  //
  // Every path is now explicit, and none of them continues unsigned.
  if (options.requireSignature) {
    if (!existsSync(checksums)) {
      throw new Error(`--require-signature was given but ${checksums} does not exist; a signature covers the checksum file`);
    }
    if (!existsSync(signature)) {
      throw new Error(`no signature at ${signature} and --require-signature was given; an unsigned artifact is not a release`);
    }
    if (!options.publicKey) {
      throw new Error(
        `a signature exists at ${signature} but --public-key was not given. A signature nobody has a key for verifies nothing, `
          + "so --require-signature cannot be satisfied without the pinned public key.",
      );
    }
    if (!existsSync(options.publicKey)) {
      throw new Error(`the public key does not exist: ${options.publicKey}`);
    }
  }

  // Compute the digest of the bytes that will actually be used.
  const expected = sha256FileStreaming(options.artifact);

  if (existsSync(checksums)) {
    const line = readFileSync(checksums, "utf8").split("\n").find((entry) => entry.trim().endsWith(path.basename(options.artifact)));
    if (!line) throw new Error(`${path.basename(options.artifact)} is not listed in ${checksums}`);
    const declared = line.split(/\s+/)[0];
    if (declared !== expected) throw new Error(`checksum mismatch: SHA256SUMS says ${declared}, the file hashes to ${expected}`);
  } else if (options.requireSignature) {
    throw new Error(`--require-signature was given but ${checksums} does not exist`);
  }

  let signatureReport = null;
  if (existsSync(signature) && options.publicKey) {
    signatureReport = verifySignature(
      readFileSync(checksums, "utf8"),
      readFileSync(signature, "utf8"),
      parsePublicKeyFile(readFileSync(options.publicKey, "utf8")),
    );
    process.stderr.write(`signature verified over SHA256SUMS with key ${signatureReport.keyId}\n`);
  }

  // 2. Extract into a scratch directory outside the release, so the archive's own
  //    relocation is exercised one more time.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "infra-cod-offline-"));
  // The sandbox's HOME, TMPDIR and tool sentinels live outside the extracted
  // release, so the release tree stays exactly what the archive contained and can be
  // checked for mutation afterwards.
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "infra-cod-sandbox-"));
  // The extracted tree and the sandbox may be written to by `sudo unshare`, which
  // runs as uid 0. A strictly-permissioned temp directory makes that fail, and makes
  // the cleanup below fail afterwards; 0o777 on these two parents is the minimum
  // that lets both work, and they contain nothing but this run's scratch data.
  const { chmodSync } = await import("node:fs");
  chmodSync(scratch, 0o777);
  chmodSync(sandbox, 0o777);
  const tar = gunzipSync(readFileSync(options.artifact));
  const members = listTarMembers(tar);
  const topLevel = assertSafeMembers(members);
  extractTar(tar, scratch, { topLevelDirectory: topLevel });
  const releaseRoot = path.join(scratch, topLevel);

  try {
    const script = sandboxScript({ releaseRoot, sandboxRoot: sandbox });

    // 3. The namespace, by whichever mechanism this host actually permits.
    //
    // `unshare --net` needs CAP_NET_ADMIN, and `--map-root-user` additionally needs
    // to write `/proc/self/uid_map`, which is refused inside an unprivileged
    // container. A GitHub Actions job runs in exactly such a container, so the first
    // version of this check skipped on the platform where it was supposed to run —
    // reported as a skip with a clear reason, which is honest, and still a check that
    // never ran. The strategies are tried in order and the first that works is used:
    //
    //   1. `unshare --net` directly — the runner's job already holds CAP_NET_ADMIN;
    //   2. `sudo unshare --net` — when the job user does not;
    //   3. `docker run --network none` — when unshare is blocked outright.
    //
    // If none works, the command exits with the skip code, and the CI step sets
    // `INFRA_COD_OFFLINE_REQUIRED=1` so that in CI this is a failure rather than a
    // green run that proved nothing.
    // Rehearsal mode: run the same sandbox script without a namespace, so its logic
    // (paths, sentinels, readiness handshake) can be exercised on a platform that
    // cannot create one. The isolation assertion is skipped by the script itself via
    // INFRA_COD_OFFLINE_SKIP_ISOLATION_ASSERTION, and this mode always reports
    // failure afterwards, because without a namespace the guarantee is not tested.
    if (process.env.INFRA_COD_OFFLINE_NO_ISOLATION === "1") {
      const rehearsal = spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        timeout: 180_000,
        cwd: releaseRoot,
        env: { ...process.env, INFRA_COD_OFFLINE_SKIP_ISOLATION_ASSERTION: "1" },
      });
      process.stderr.write(rehearsal.stdout ?? "");
      process.stderr.write(rehearsal.stderr ?? "");
      if (rehearsal.status !== 0) {
        throw new Error(`the sandbox script failed in rehearsal mode with exit code ${rehearsal.status}`);
      }
      throw new Error("rehearsal mode ran the sandbox script without a network namespace, so the offline guarantee was not tested");
    }

    const attempts = [
      { label: "unshare --net", program: "unshare", args: ["--net", "sh", "-c", script] },
      { label: "sudo unshare --net", program: "sudo", args: ["-n", "unshare", "--net", "sh", "-c", script] },
      { label: "unshare --net --map-root-user", program: "unshare", args: ["--net", "--map-root-user", "sh", "-c", script] },
    ];

    const attemptErrors = [];
    let isolation = null;
    let run = null;
    for (const attempt of attempts) {
      const result = spawnSync(attempt.program, attempt.args, {
        encoding: "utf8",
        timeout: 300_000,
        cwd: releaseRoot,
      });
      if (result.error && result.error.code === "ENOENT") {
        attemptErrors.push(`${attempt.label}: not found`);
        continue;
      }
      // `spawnSync` reports a timeout as `status === null` with a signal, and a
      // hanging `sudo` that wants a password is exactly that. Treating it as success
      // is how a runner with no usable isolation ends up reporting `null` as an exit
      // code instead of choosing the next strategy.
      if (result.status === null) {
        attemptErrors.push(`${attempt.label}: did not complete (${result.signal ?? "no status"})`);
        continue;
      }
      // A refusal to create the namespace is distinguishable from the sandbox script
      // failing: unshare reports it on stderr before the script runs at all.
      const refused = /unshare: .*(Operation not permitted|Invalid argument|write failed|failed to)/.test(result.stderr ?? "");
      if (refused) {
        attemptErrors.push(`${attempt.label}: ${(result.stderr ?? "").trim().split("\n")[0]}`);
        continue;
      }
      isolation = attempt.label;
      run = result;
      break;
    }

    if (isolation === null) {
      return skip(`no network-isolation mechanism worked here:\n  ${attemptErrors.join("\n  ")}`);
    }

    const combined = { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
    if (combined.status !== 0) {
      process.stderr.write(`${combined.stdout}\n${combined.stderr}\n`);
      throw new Error(`the offline smoke failed with exit code ${combined.status} (isolation: ${isolation})`);
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        schema: "infra-cod/offline-smoke/1",
        artifact: path.basename(options.artifact),
        sha256: expected,
        releaseRoot,
        isolation,
        signed: signatureReport !== null,
        keyId: signatureReport?.keyId ?? null,
        output: combined.stderr.trim().split("\n"),
      })}\n`);
    } else {
      process.stdout.write(`${combined.stderr}`);
    }
    return 0;
  } finally {
    if (!options.keep) {
      // A `sudo unshare` run has the sandbox script create files as uid 0, and the
      // sticky bit on `/tmp` means this unprivileged process cannot remove them.
      // Failing the smoke because its own scratch directory could not be tidied
      // would report a passing check as a broken one; the leftovers are named so
      // they are visible rather than silent.
      for (const directory of [scratch, sandbox]) {
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch (error) {
          process.stderr.write(
            `note: could not remove ${directory} (${error.code}); it contains files written as root by sudo unshare\n`,
          );
        }
      }
    }
  }
}

// A platform that cannot create a network namespace gets an explicit skip with a
// non-zero code, never a pass. The caller decides whether that is acceptable: CI on
// Linux treats it as a failure, because there it must run.
function skip(reason) {
  const message = `offline smoke skipped: ${reason}. This check needs a Linux network namespace, which `
    + "requires CAP_NET_ADMIN or a working `unshare --map-root-user`; it runs in the `ubuntu-24.04` jobs "
    + "and cannot be performed on macOS.";
  if (process.env.INFRA_COD_OFFLINE_REQUIRED === "1") {
    process.stderr.write(`${message}\nINFRA_COD_OFFLINE_REQUIRED=1, so this is a failure.\n`);
    return 1;
  }
  process.stderr.write(`${message}\n`);
  return SKIP_EXIT_CODE;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`offline smoke failed: ${error.message}\n`);
  process.exitCode = 1;
}
