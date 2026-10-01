// A sandbox in which `infra-cod runtime install` can be run against a registry
// that behaves like npm's and a key we control.
//
// Three things are real here, and they are the three that matter: the signature
// check, the integrity check and the archive member check all run the production
// code path against bytes this harness produced. What is stubbed is the part a
// laptop cannot have — `runuser`, and a registry on the public internet.
//
// The signing key is generated per sandbox and written into the fake release's
// `release/keys/npm-registry.pub`, which is where the coordinator reads its
// pinned key from. That means a test can produce a package signed by the wrong
// key and watch the real verification refuse it, rather than watching a mock
// return false.

import { createSign, generateKeyPairSync, createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import readline from "node:readline";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(HERE, "../../../");

// The keyid the coordinator pins. The label is part of the contract — a
// signature under an unexpected key id is refused before the maths is even
// attempted — so fixtures use the same label and a different key when they want
// to be refused.
export const PINNED_KEY_ID = "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U";

export function harnessPrerequisites() {
  return ["tar", "gzip"].filter((name) => spawnSync("sh", ["-c", `command -v ${name}`]).status !== 0);
}

function writeExecutable(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
}

// An npm-shaped tarball: everything under `package/`, with an executable at the
// path the adapter expects.
export function buildPackageTarball(directory, { executablePath, prints, extraMembers = [], links = [] }) {
  const tree = mkdtempSync(path.join(directory, "pkg-"));
  const full = path.join(tree, executablePath);
  writeExecutable(full, `#!/bin/sh\n# fixture runtime\ncase "$1" in\n  --version) echo "${prints}" ;;\n  *) echo "fixture: $*" ;;\nesac\n`);
  writeFileSync(path.join(tree, "package/package.json"), JSON.stringify({ name: "fixture", version: prints }, null, 2));
  for (const member of extraMembers) {
    const target = path.join(tree, member.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, member.content ?? "");
  }
  for (const link of links) {
    const target = path.join(tree, link.path);
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(link.target, target);
  }
  const tarball = path.join(directory, `fixture-${path.basename(tree)}.tgz`);
  const result = spawnSync("tar", ["-czf", tarball, "-C", tree, "package"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`harness: tar failed: ${result.stderr}`);
  rmSync(tree, { recursive: true, force: true });
  return tarball;
}

// ---------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------

export async function createRuntimeHost({ runAsUser = true } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "infra-cod-runtime-"));
  const prefix = path.join(base, "root");
  const binDir = path.join(base, "bin");
  const stateDir = path.join(base, "state");
  const registryDir = path.join(base, "registry");

  for (const directory of [prefix, binDir, stateDir, registryDir]) mkdirSync(directory, { recursive: true });
  for (const directory of ["etc/infra-cod", "opt/infra-cod/runtimes", "usr/local/bin", "usr/sbin", "usr/bin", "run/lock", "home/codex-worker", "home/opencode-worker"]) {
    mkdirSync(path.join(prefix, directory), { recursive: true });
  }

  // The signing key this sandbox vouches with, and the release tree that pins it.
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const release = path.join(prefix, "opt/infra-cod/releases/fixture");
  cpSync(path.join(REPOSITORY_ROOT, "services"), path.join(release, "services"), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}test`) && !source.includes("node_modules"),
  });
  mkdirSync(path.join(release, "release/keys"), { recursive: true });
  writeFileSync(path.join(release, "release/keys/npm-registry.pub"), publicKey.export({ type: "spki", format: "pem" }));
  // Linked, never copied. `pg` and `hash-wasm` resolve from the release root on
  // a real host too, and copying the closure into every sandbox costs hundreds
  // of megabytes per test for no added realism.
  const modules = path.join(release, "node_modules");
  if (!existsSync(modules)) symlinkSync(path.join(REPOSITORY_ROOT, "node_modules"), modules);

  // `runuser`, as far as the coordinator uses it: `-u <user> -- /usr/bin/env -i
  // KEY=VALUE... <command> <args>`. The sandbox cannot switch user, so it records
  // which user was asked for and runs the command with exactly the environment
  // that was named — which is the part the production code is asserting about.
  writeExecutable(path.join(prefix, "usr/sbin/runuser"), `#!/bin/sh
STATE="${stateDir}"
[ "$1" = "-u" ] || { echo "runuser: expected -u" >&2; exit 2; }
USER_NAME="$2"; shift 3   # -u <user> --
echo "$USER_NAME $*" >> "$STATE/runuser.log"
pwd >> "$STATE/runuser-cwd.log"
if grep -qx "$USER_NAME" "$STATE/refused-users" 2>/dev/null; then
  echo "runuser: user $USER_NAME cannot execute it" >&2
  exit 126
fi
# Fault injection at the boundary this sandbox exists to model.
#
# The sandbox cannot really drop privileges, so "this user cannot read that
# file" cannot be arranged with permissions: the suite runs as one user, and in
# the container that user is root, who walks through any mode. A cat shim
# ahead of the real one on the PATH the command is given refuses exactly the
# paths a test names, for exactly the reason a real refusal would — and it
# refuses on a *regular file*, which is the case the production bug was about.
if [ -s "$STATE/unreadable" ]; then
  SHIM="$STATE/shim"
  mkdir -p "$SHIM"
  cat > "$SHIM/cat" <<'SHIMEOF'
#!/bin/sh
for target in "$@"; do
  if grep -qxF "$target" "$STATE_DIR/unreadable" 2>/dev/null; then
    echo "cat: $target: Permission denied" >&2
    exit 1
  fi
done
exec /bin/cat "$@"
SHIMEOF
  chmod 755 "$SHIM/cat"
  # The command is /usr/bin/env -i KEY=VALUE... prog args; the PATH it names is
  # the one the shell inside will use, so the shim goes in front of it there.
  #
  # Rebuilt positionally rather than through eval: the last argument is a
  # multi-line shell script full of quotes, and re-quoting it by hand produced a
  # command that ran and did something subtly different.
  count=$#
  i=0
  while [ $i -lt $count ]; do
    arg="$1"; shift
    case "$arg" in
      PATH=*) set -- "$@" "PATH=$SHIM:\${arg#PATH=}" "STATE_DIR=$STATE" ;;
      *) set -- "$@" "$arg" ;;
    esac
    i=$((i+1))
  done
  exec "$@"
fi
${runAsUser ? 'exec "$@"' : 'echo "runuser: not executing in this sandbox"; exit 0'}
`);
  writeFileSync(path.join(stateDir, "refused-users"), "");
  writeFileSync(path.join(stateDir, "runuser.log"), "");
  writeFileSync(path.join(stateDir, "runuser-cwd.log"), "");
  writeFileSync(path.join(stateDir, "running-processes"), "");

  // `pgrep -u <user> -f <pattern>`, as far as the drain asks it.
  writeExecutable(path.join(binDir, "pgrep"), `#!/bin/sh
STATE="${stateDir}"
USER_NAME=""
prev=""
for a in "$@"; do
  [ "$prev" = "-u" ] && USER_NAME="$a"
  prev="$a"
done
# A host that cannot answer the question: exit 1 is "no matches", and every
# other code is something else entirely.
if [ -f "$STATE/pgrep-exit" ]; then
  echo "pgrep: harness failure" >&2
  exit "$(cat "$STATE/pgrep-exit")"
fi
MATCHES=$(grep "^$USER_NAME " "$STATE/running-processes" 2>/dev/null | cut -d" " -f2-)
[ -n "$MATCHES" ] || exit 1
echo "$MATCHES" | tr " " "\\n"
`);

  // A supervisor that answers the maintenance handshake, and counts launches
  // per runtime — which is the whole point of the fence being per runtime.
  const admission = {
    codex: { paused: false, inFlight: 0, owner: null },
    opencode: { paused: false, inFlight: 0, owner: null },
  };
  // Short on purpose: a Unix socket path is capped near 104 bytes, and the
  // sandbox prefix alone is longer than that.
  const supervisorSocket = path.join(mkdtempSync(path.join(os.tmpdir(), "ics")), "s");
  // Each sandbox gets its own fence directory, so two tests running at once do
  // not fence each other.
  const fenceDir = path.join(prefix, "run/infra-cod");
  mkdirSync(fenceDir, { recursive: true });
  process.env.INFRA_COD_RUNTIME_FENCE_DIR = fenceDir;
  let supervisorId = "supervisor-1";
  const connections = new Set();
  const supervisor = net.createServer((socket) => {
    connections.add(socket);
    // The fence belongs to the connection that took it. Whatever became of the
    // installer — finished, crashed, killed — this is what releases it.
    socket.on("close", () => {
      connections.delete(socket);
      for (const state of Object.values(admission)) {
        if (state.owner === socket) {
          state.paused = false;
          state.owner = null;
        }
      }
    });
    socket.on("error", () => {});
    readline.createInterface({ input: socket }).on("line", (line) => {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        return;
      }
      const state = admission[request.runtime];
      if (state && request.action === "status" && typeof state.dieAfterChecks === "number") {
        if (state.dieAfterChecks <= 0) {
          // Fires once. A restarted supervisor answers normally afterwards;
          // one that died on every request for the rest of the run would be a
          // different fault, and would make this test prove something else.
          state.dieAfterChecks = null;
          state.paused = false;
          state.owner = null;
          supervisorId = `supervisor-${Number(supervisorId.split("-")[1]) + 1}`;
          for (const open of [...connections]) open.destroy();
          return;
        }
        state.dieAfterChecks -= 1;
      }
      if (!state) return socket.write(`${JSON.stringify({ request_id: request.request_id, ok: false, error: "unknown runtime" })}\n`);
      if (request.action === "pause" && state.restartOnPause) {
        state.restartOnPause = false;
        state.paused = false;
        state.owner = null;
        supervisorId = `supervisor-${Number(supervisorId.split("-")[1]) + 1}`;
        for (const open of [...connections]) open.destroy();
        return;
      }
      if (request.action === "pause") {
        if (state.paused && state.owner !== socket) {
          return socket.write(`${JSON.stringify({ request_id: request.request_id, ok: false, error: "already held by another installation" })}\n`);
        }
        state.paused = true;
        state.owner = socket;
      }
      if (request.action === "resume") {
        if (state.refuseResume) {
          return socket.write(`${JSON.stringify({ request_id: request.request_id, ok: false, error: "harness: resume refused" })}\n`);
        }
        if (state.paused && state.owner !== socket) {
          return socket.write(`${JSON.stringify({ request_id: request.request_id, ok: false, error: "held by another installation" })}\n`);
        }
        state.paused = false;
        state.owner = null;
      }
      socket.write(`${JSON.stringify({
        request_id: request.request_id,
        ok: true,
        result: {
          runtime: request.runtime,
          paused: state.paused,
          in_flight: state.inFlight,
          supervisor_id: supervisorId,
        },
      })}\n`);
    });
  });
  await new Promise((resolve) => supervisor.listen(supervisorSocket, resolve));

  // The launch surface, as a unit whose state can be asked and changed.
  //
  // `launch-attempt` is the part that makes the fence testable rather than
  // merely present: a test can try to start a session and find out whether the
  // door was shut at that moment, which is the whole claim.
  writeFileSync(path.join(stateDir, "units"), "infra-cod-runtime-supervisor.service active\n");
  writeExecutable(path.join(binDir, "systemctl"), `#!/bin/sh
STATE="${stateDir}"
ACTION="$1"; shift
[ "$1" = "--quiet" ] && shift
UNIT="$1"
echo "$ACTION $UNIT" >> "$STATE/systemctl.log"
case "$ACTION" in
  is-active)
    grep -q "^$UNIT active$" "$STATE/units" && exit 0
    exit 3 ;;
  stop)
    sed -i.bak "s|^$UNIT active$|$UNIT inactive|" "$STATE/units"; exit 0 ;;
  start)
    sed -i.bak "s|^$UNIT inactive$|$UNIT active|" "$STATE/units"; exit 0 ;;
  *) exit 1 ;;
esac
`);

  // /usr/bin/env is real; the stub runuser execs it. Nothing else is stubbed.
  writeExecutable(path.join(binDir, "flock"), `#!/bin/sh
[ "$1" = "--version" ] && { echo "flock (harness)"; exit 0; }
while [ $# -gt 0 ]; do case "$1" in -n) shift ;; -w) shift 2 ;; *) break ;; esac; done
LOCK="$1"; shift
if [ "$1" = "-c" ]; then shift; set -- sh -c "$1"; fi
mkdir -p "$(dirname "$LOCK")"
mkdir "$LOCK.d" 2>/dev/null || { echo "flock: failed to get lock" >&2; exit 1; }
trap 'rmdir "$LOCK.d" 2>/dev/null' EXIT INT TERM HUP
"$@"
`);

  // A registry that answers the two questions the coordinator asks: metadata for
  // one exact version, and the tarball it names.
  const packages = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const entry = packages.get(decodeURIComponent(url.pathname));
    if (!entry) {
      response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
      return;
    }
    if (entry.kind === "json") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(entry.body));
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(entry.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const registry = `http://127.0.0.1:${server.address().port}`;

  const host = {
    base, prefix, binDir, stateDir, registry, release,

    // Publishes a version: metadata signed by this sandbox's key (or a wrong
    // one, on request) and the tarball it points at.
    publish({ name, version, tarball, signWith = privateKey, keyId = PINNED_KEY_ID, integrityOverride = null, impersonate = null }) {
      const bytes = readFileSync(tarball);
      const integrity = integrityOverride ?? `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      const tarballPath = `/${name}/-/${path.basename(tarball)}`;
      // `impersonate` answers a request for one package with another package's
      // identity — correctly signed under that identity, which is the point.
      const claimed = impersonate ?? { name, version };
      const message = `${claimed.name}@${claimed.version}:${integrity}`;
      const signature = createSign("SHA256").update(message).sign(signWith).toString("base64");

      packages.set(`/${name}/${version}`, {
        kind: "json",
        body: {
          name: claimed.name, version: claimed.version,
          dist: {
            tarball: `${registry}${tarballPath}`,
            integrity,
            signatures: [{ keyid: keyId, sig: signature }],
          },
        },
      });
      packages.set(tarballPath, { kind: "buffer", body: bytes });
      return { integrity };
    },

    // Runs the CLI the way the host runs it: from the installed release tree.
    //
    // Asynchronously, and that is not a preference. `spawnSync` blocks this
    // process's event loop, and the registry the child is about to call lives in
    // this process — so a synchronous spawn is a deadlock with a timeout on the
    // end of it, which is exactly how this harness first behaved.
    async cli(args, { extraEnv = {} } = {}) {
      const child = spawn(process.execPath, [path.join(release, "services/cli/infra-cod.mjs"), ...args], {
        env: {
          ...process.env,
          PATH: `${binDir}:${path.join(prefix, "usr/sbin")}:${process.env.PATH}`,
          INFRA_COD_INSTALL_PREFIX: prefix,
          INFRA_COD_RUNTIME_FENCE_DIR: fenceDir,
          INFRA_COD_NPM_REGISTRY: registry,
          INFRA_COD_ACTOR: "harness",
          RUNTIME_SUPERVISOR_SOCKET: supervisorSocket,
          ...extraEnv,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      const code = await new Promise((resolve) => child.on("close", resolve));
      clearTimeout(timer);
      return { code, stdout, stderr };
    },

    runtimes() {
      const file = path.join(prefix, "etc/infra-cod/runtimes.json");
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    },
    installedVersions(name) {
      const directory = path.join(prefix, "opt/infra-cod/runtimes", name);
      return existsSync(directory) ? readdirSync(directory).sort() : [];
    },
    activeTarget(executable) {
      const link = path.join(prefix, "usr/local/bin", executable);
      if (!existsSync(link)) return null;
      return spawnSync("readlink", [link], { encoding: "utf8" }).stdout.trim();
    },
    runuserLog() {
      return readFileSync(path.join(stateDir, "runuser.log"), "utf8");
    },
    // Where the probes actually ran, as reported by `pwd` inside the stub —
    // which is a different fact from the PWD they announced.
    probeWorkingDirectories() {
      return readFileSync(path.join(stateDir, "runuser-cwd.log"), "utf8");
    },
    setRunningProcesses(user, pids) {
      writeFileSync(path.join(stateDir, "running-processes"), `${user} ${pids.join(" ")}\n`);
    },
    runtimeConfig(user, relative) {
      const file = path.join(prefix, "home", user, relative);
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    },
    writeRuntimeConfig(user, relative, contents) {
      const file = path.join(prefix, "home", user, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
      return file;
    },
    removeRuntimeHome(user) {
      rmSync(path.join(prefix, "home", user), { recursive: true, force: true });
    },
    // Whether the launch surface is up. A session can only be admitted while it
    // is: every worker reaches a runtime through the supervisor's socket.
    launchSurfaceUp() {
      return readFileSync(path.join(stateDir, "units"), "utf8").includes("infra-cod-runtime-supervisor.service active");
    },
    systemctlLog() {
      const file = path.join(stateDir, "systemctl.log");
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    },
    stopLaunchSurface() {
      writeFileSync(path.join(stateDir, "units"), "infra-cod-runtime-supervisor.service inactive\n");
    },
    // A regular file that is there and cannot be read — the case the production
    // bug was about.
    //
    // Not `chmod 000` (root ignores it, and the gate runs as root) and not a
    // directory (the old defective code would have failed on that anyway, at the
    // `mv` or the read-back, so a test using one passes against the bug it is
    // meant to catch). The fake `runuser` refuses this exact path, which is what
    // a real permission refusal looks like from the reader's side.
    makeUnreadable(file) {
      writeFileSync(path.join(stateDir, "unreadable"), `${file}\n`);
    },
    makeReadable() {
      writeFileSync(path.join(stateDir, "unreadable"), "");
    },
    writeForeignCommand(executable, body) {
      const file = path.join(prefix, "usr/local/bin", executable);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body, { mode: 0o755 });
      return file;
    },
    // What the supervisor reports, and what a test can arrange.
    admissionOf(runtime) {
      return { ...admission[runtime] };
    },
    setInFlight(runtime, count) {
      admission[runtime].inFlight = count;
    },
    refuseResume(runtime) {
      admission[runtime].refuseResume = true;
    },
    // Drops every connection the next time one pauses this runtime — a
    // supervisor restart landing squarely inside an install.
    restartSupervisorDuring(runtime) {
      admission[runtime].restartOnPause = true;
    },
    // Dies after answering N status requests: the boundary a `pause`-time
    // restart cannot reach. The install has already been told the fence is held
    // and is on its way to the rename.
    restartSupervisorAfterChecks(runtime, checks) {
      admission[runtime].dieAfterChecks = checks;
    },
    // A connection that takes the fence and then dies, which is what a killed
    // installer looks like from the supervisor's side.
    async holdFence(runtime) {
      const socket = net.createConnection(supervisorSocket);
      await new Promise((resolve) => socket.once("connect", resolve));
      socket.write(`${JSON.stringify({ request_id: "hold", type: "runtime_maintenance", action: "pause", runtime })}\n`);
      await new Promise((resolve) => socket.once("data", resolve));
      return socket;
    },
    restartSupervisor() {
      supervisorId = `supervisor-${Number(supervisorId.split("-")[1]) + 1}`;
      for (const socket of [...connections]) socket.destroy();
      for (const state of Object.values(admission)) {
        state.paused = false;
        state.owner = null;
      }
    },
    rewriteIntent(runtime, change) {
      const file = path.join(prefix, "etc/infra-cod", `runtime-switch.${runtime}.json`);
      writeFileSync(file, `${JSON.stringify(change(JSON.parse(readFileSync(file, "utf8"))), null, 2)}\n`);
    },
    // The fence as every other process on the machine sees it.
    async holdInstallFence(runtime) {
      process.env.INFRA_COD_RUNTIME_FENCE_DIR = fenceDir;
      const { holdRuntimeFence } = await import("../../runtime-supervisor/runtime-fence.mjs");
      return holdRuntimeFence(runtime, { mode: "exclusive", fenceDir });
    },
    async attemptLaunch(runtime) {
      process.env.INFRA_COD_RUNTIME_FENCE_DIR = fenceDir;
      const { holdRuntimeFence } = await import("../../runtime-supervisor/runtime-fence.mjs");
      return holdRuntimeFence(runtime, { mode: "shared", fenceDir });
    },
    breakProcessCheck(code) {
      writeFileSync(path.join(stateDir, "pgrep-exit"), String(code));
    },
    // Makes the inventory impossible to write, which is what a full disk, a
    // read-only remount or a failed rename looks like from inside the install.
    //
    // Not `chmod 0555`: root ignores directory modes, and the suite runs as root
    // in the container gate — the test passed on macOS and proved nothing on
    // Linux. A regular file where the directory should be is refused by
    // `mkdir` for every user there is.
    refuseInventoryWrites() {
      const directory = path.join(prefix, "etc/infra-cod");
      renameSync(directory, `${directory}.saved`);
      writeFileSync(directory, "");
    },
    restoreInventoryWrites() {
      const directory = path.join(prefix, "etc/infra-cod");
      rmSync(directory, { force: true });
      renameSync(`${directory}.saved`, directory);
    },
    refuseUser(user) {
      writeFileSync(path.join(stateDir, "refused-users"), `${user}\n`);
    },
    wrongKey() {
      return generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    },
    async destroy() {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => supervisor.close(resolve));
      // A test may have made a directory read-only on purpose; teardown is not
      // the place to be defeated by it.
      spawnSync("chmod", ["-R", "u+rwX", base]);
      rmSync(base, { recursive: true, force: true });
    },
  };

  return host;
}
