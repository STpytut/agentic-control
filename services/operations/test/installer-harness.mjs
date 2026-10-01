// A sandbox in which `deploy/install.sh` can be run end to end.
//
// The script under test is the real one, unmodified: the harness only supplies a
// prefix (INFRA_COD_INSTALL_PREFIX), a PATH of stub system commands, and a fake
// signed release. What is stubbed is deliberately limited to things a developer
// machine cannot provide — systemd, apt, useradd, a PostgreSQL cluster — so that
// every line of ordering, idempotence, state and permission logic in the
// installer is the code that actually runs.
//
// What this harness does NOT prove: the signature and checksum chain. `minisign`
// and `sha256sum -c` inside the gate are stubbed, because the trust chain has its
// own suites (`test:release`, `test:release:artifact`) that run the real thing
// against a real artifact. This harness proves the installer.

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(HERE, "../../../");
export const INSTALLER = path.join(REPOSITORY_ROOT, "deploy/install.sh");
export const RELEASE_VERSION = "0.0.0-harness";

// The installer needs a bash with arrays and `${var}` redirections; macOS ships
// bash 3.2 as /bin/bash, which is enough, but `env bash` may find something
// older still on an exotic host. Everything the script uses is bash 3.2-safe.
function requireCommands(names) {
  const missing = names.filter((name) => spawnSync("sh", ["-c", `command -v ${name}`]).status !== 0);
  return missing;
}

export function harnessPrerequisites() {
  return requireCommands(["bash", "tar", "openssl", "jq", "sed", "awk", "shasum"]);
}

function writeExecutable(file, body) {
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function walk(root, base = root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stub system commands
// ---------------------------------------------------------------------------

function writeStubs(binDir, stateDir, prefix) {
  const preamble = `#!/bin/sh\nSTATE="${stateDir}"\n`;

  // getent reports real membership, because the installer now refuses to
  // continue when a required supplementary group did not take.
  writeExecutable(path.join(binDir, "getent"), `${preamble}
case "$1" in
  group)
    grep -qx "$2" "$STATE/groups" 2>/dev/null || exit 2
    MEMBERS=$(grep "^$2:" "$STATE/memberships" 2>/dev/null | cut -d: -f2 | paste -sd, - 2>/dev/null || true)
    echo "$2:x:900:$MEMBERS"
    exit 0 ;;
  passwd)
    grep -qx "$2" "$STATE/users" 2>/dev/null && { echo "$2:x:900:900::/nonexistent:/usr/sbin/nologin"; exit 0; }
    exit 2 ;;
esac
exit 2
`);

  writeExecutable(path.join(binDir, "groupadd"), `${preamble}
for a in "$@"; do last="$a"; done
echo "$last" >> "$STATE/groups"
echo "groupadd $*" >> "$STATE/commands.log"
`);

  writeExecutable(path.join(binDir, "useradd"), `${preamble}
for a in "$@"; do last="$a"; done
# A real useradd refuses --gid for a group that does not exist. Reproducing that
# is the whole point: it is the failure a clean install hit.
gid=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--gid" ]; then gid="$a"; fi
  prev="$a"
done
if [ -n "$gid" ] && ! grep -qx "$gid" "$STATE/groups" 2>/dev/null; then
  echo "useradd: group '$gid' does not exist" >&2
  exit 6
fi
echo "$last" >> "$STATE/users"
echo "useradd $*" >> "$STATE/commands.log"
`);

  writeExecutable(path.join(binDir, "usermod"), `${preamble}
echo "usermod $*" >> "$STATE/commands.log"
[ -f "$STATE/usermod-fails" ] && exit 1
# usermod -aG <group> <user>
group=""
user=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-aG" ]; then group="$a"; fi
  user="$a"
  prev="$a"
done
[ -n "$group" ] && echo "$group:$user" >> "$STATE/memberships"
exit 0
`);

  writeExecutable(path.join(binDir, "systemctl"), `${preamble}
echo "systemctl $*" >> "$STATE/systemctl.log"
for u in $(cat "$STATE/failing-units" 2>/dev/null); do
  [ "$2" = "$u" ] && { echo "Job for $u failed" >&2; exit 1; }
done
if [ "$1" = "show" ]; then
  # systemctl show -p MainPID --value <unit>: the installer asks this to tell
  # its own listener from somebody else s.
  for a in "$@"; do last="$a"; done
  case " $* " in
    *MainPID*) grep "^$last " "$STATE/unit-pids" 2>/dev/null | awk '{print $2}' | head -1 | grep . || echo 0; exit 0 ;;
  esac
fi
if [ "$1" = "is-active" ]; then
  for u in $(cat "$STATE/inactive-units" 2>/dev/null); do
    for a in "$@"; do [ "$a" = "$u" ] && { echo inactive; exit 3; }; done
  done
  echo active
fi
exit 0
`);

  writeExecutable(path.join(binDir, "systemd-analyze"), `${preamble}
echo "systemd-analyze $*" >> "$STATE/analyze.log"
exit 0
`);

  // The installer makes the accounts with useradd; the declared sysusers file
  // is applied too, and finds them there.
  writeExecutable(path.join(binDir, "systemd-sysusers"), "#!/bin/sh\nexit 0\n");

  // A real enough systemd-tmpfiles: it creates the `d` entries of the installed
  // configuration, and it refuses a path that is already a symlink instead of
  // following it. The refusal is the property the installer depends on — root
  // must never chmod through a link a runtime user planted — so a stub that
  // always succeeded would have hidden exactly the defect this guards.
  writeExecutable(path.join(binDir, "systemd-tmpfiles"), `${preamble}
PREFIX="${prefix}"
status=0
for conf in "$PREFIX"/etc/tmpfiles.d/*.conf; do
  [ -f "$conf" ] || continue
  while read -r type target mode rest; do
    case "$type" in d|D) : ;; *) continue ;; esac
    [ -n "$target" ] || continue
    full="$PREFIX$target"
    if [ -L "$full" ]; then
      echo "Failed to create directory or subvolume \"$full\": it is a symbolic link" >&2
      status=1
      continue
    fi
    if [ -e "$full" ] && [ ! -d "$full" ]; then
      echo "\"$full\" already exists and is not a directory" >&2
      status=1
      continue
    fi
    mkdir -p "$full" 2>/dev/null || { status=1; continue; }
    [ -n "$mode" ] && chmod "$mode" "$full" 2>/dev/null || true
  done < "$conf"
done
exit $status
`);

  writeExecutable(path.join(binDir, "apt-get"), `${preamble}
echo "apt-get $*" >> "$STATE/commands.log"
exit 0
`);

  // Present so the installer never takes the PGDG bootstrap path, which reaches
  // into the real /etc and /usr/share and has no business running on a laptop.
  writeExecutable(path.join(binDir, "pg_lsclusters"), `#!/bin/sh
echo "17 main 5432 online postgres /var/lib/postgresql/17/main"
`);

  writeExecutable(path.join(binDir, "minisign"), `${preamble}
echo "minisign $*" >> "$STATE/commands.log"
exit 0
`);

  writeExecutable(path.join(binDir, "host"), `#!/bin/sh
exit 1
`);

  // Faithful about the one behaviour that mattered: real `ss` prints a column
  // header even when the filter matches nothing, and only -H suppresses it. The
  // first Ubuntu run died on "port 80 in use: unknown" on an idle host because
  // the caller treated that header as a listener.
  writeExecutable(path.join(binDir, "ss"), `${preamble}
HEADER=1
PORT=""
for a in "$@"; do
  case "$a" in
    -H|--no-header) HEADER=0 ;;
    -H*) HEADER=0 ;;
    *sport*) PORT=$(echo "$a" | tr -dc '0-9') ;;
  esac
done
[ "$HEADER" -eq 1 ] && echo "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process"
[ -n "$PORT" ] || exit 0
grep "^$PORT|" "$STATE/listeners" 2>/dev/null | while IFS="|" read -r p name pid; do
  [ -n "$pid" ] || pid=1
  echo "LISTEN 0      511          0.0.0.0:$p        0.0.0.0:*    users:((\"$name\",pid=$pid,fd=3))"
done
exit 0
`);

  writeExecutable(path.join(binDir, "curl"), `${preamble}
echo "curl $*" >> "$STATE/commands.log"
if [ -f "$STATE/web-down" ]; then printf '000'; exit 0; fi
printf '200'
exit 0
`);

  // GNU sha256sum on top of shasum, including the `-c` mode the installer uses
  // to re-verify an installed tree against its FILESUMS.
  writeExecutable(path.join(binDir, "sha256sum"), `#!/bin/sh
CHECK=0
FILES=""
for a in "$@"; do
  case "$a" in
    -c|--check) CHECK=1 ;;
    --quiet|--status) : ;;
    *) FILES="$FILES $a" ;;
  esac
done
if [ "$CHECK" -eq 1 ]; then
  for f in $FILES; do shasum -a 256 -c "$f" >/dev/null 2>&1 || exit 1; done
  exit 0
fi
if [ -z "$FILES" ]; then shasum -a 256 - | awk '{print $1"  -"}'; exit 0; fi
for f in $FILES; do shasum -a 256 "$f" | awk '{print $1"  "$2}'; done
`);

  writeExecutable(path.join(binDir, "flock"), `#!/bin/sh
exit 0
`);

  // Faithful about the one behaviour that mattered: real `ss` prints a column
  // header even when the filter matches nothing, and only -H suppresses it. The
  // first Ubuntu run died on "port 80 in use: unknown" on an idle host because
  // the caller treated that header as a listener.
  writeExecutable(path.join(binDir, "ss"), `${preamble}
HEADER=1
PORT=""
for a in "$@"; do
  case "$a" in
    -H|--no-header) HEADER=0 ;;
    -H*) HEADER=0 ;;
    *sport*) PORT=$(echo "$a" | tr -dc '0-9') ;;
  esac
done
[ "$HEADER" -eq 1 ] && echo "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process"
[ -n "$PORT" ] || exit 0
grep "^$PORT|" "$STATE/listeners" 2>/dev/null | while IFS="|" read -r p name pid; do
  [ -n "$pid" ] || pid=1
  echo "LISTEN 0      511          0.0.0.0:$p        0.0.0.0:*    users:((\"$name\",pid=$pid,fd=3))"
done
exit 0
`);

  writeExecutable(path.join(binDir, "curl"), `${preamble}
echo "curl $*" >> "$STATE/commands.log"
if [ -f "$STATE/web-down" ]; then printf '000'; exit 0; fi
printf '200'
exit 0
`);

  // GNU sha256sum on top of shasum, including the `-c` mode the installer uses
  // to re-verify an installed tree against its FILESUMS.
  writeExecutable(path.join(binDir, "sha256sum"), `#!/bin/sh
CHECK=0
FILES=""
for a in "$@"; do
  case "$a" in
    -c|--check) CHECK=1 ;;
    --quiet|--status) : ;;
    *) FILES="$FILES $a" ;;
  esac
done
if [ "$CHECK" -eq 1 ]; then
  for f in $FILES; do shasum -a 256 -c "$f" >/dev/null 2>&1 || exit 1; done
  exit 0
fi
if [ -z "$FILES" ]; then shasum -a 256 - | awk '{print $1"  -"}'; exit 0; fi
for f in $FILES; do shasum -a 256 "$f" | awk '{print $1"  "$2}'; done
`);

  writeExecutable(path.join(binDir, "flock"), `#!/bin/sh
exit 0
`);

}

// ---------------------------------------------------------------------------
// The fake release
// ---------------------------------------------------------------------------

function buildReleaseTree(root, { migrationCount }) {
  const top = path.join(root, `infra-cod-${RELEASE_VERSION}`);
  mkdirSync(path.join(top, "scripts"), { recursive: true });
  mkdirSync(path.join(top, "services/cli"), { recursive: true });
  mkdirSync(path.join(top, "deploy"), { recursive: true });

  // Real units, real tmpfiles, real Caddyfile: the installer's "verify every
  // unit that was installed" loop must see the number of units this project
  // actually ships, not a convenient two.
  cpSync(path.join(REPOSITORY_ROOT, "deploy/systemd"), path.join(top, "deploy/systemd"), { recursive: true });

  // The tool definitions too, and from the repository rather than invented: the
  // installer refuses a release without them, because a host that has them
  // missing is a host whose executor cannot finish a task. A fixture that made
  // its own copies would pass while the real ones stopped shipping.
  cpSync(
    path.join(REPOSITORY_ROOT, "services/runtime-supervisor/opencode-tools"),
    path.join(top, "services/runtime-supervisor/opencode-tools"),
    { recursive: true },
  );
  cpSync(path.join(REPOSITORY_ROOT, "deploy/tmpfiles.d"), path.join(top, "deploy/tmpfiles.d"), { recursive: true });
  cpSync(path.join(REPOSITORY_ROOT, "deploy/caddy"), path.join(top, "deploy/caddy"), { recursive: true });

  // The real reconciler and what it imports: install.sh installs the release's
  // declared files by running the release's own install-reconcile.mjs (WP-A), so
  // a stand-in here would test a stand-in.
  cpSync(path.join(REPOSITORY_ROOT, "services/operations"), path.join(top, "services/operations"), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}test`),
  });

  writeFileSync(path.join(top, "manifest.json"), `${JSON.stringify({
    schema: "infra-cod/release-manifest/1",
    product: "infra-cod",
    version: RELEASE_VERSION,
    database: { migrationCount },
    payload: { checksums: "FILESUMS.sha256", symlinks: [] },
  }, null, 2)}\n`);

  writeExecutable(path.join(top, "deploy/setup-postgresql-production.sh"), `#!/bin/sh
echo "pg production setup (harness)"
`);
  writeExecutable(path.join(top, "deploy/run-production-migrations.sh"), `#!/bin/sh
echo "migrations applied (harness)"
`);

  writeFileSync(path.join(top, "scripts/verify-release.mjs"), `#!/usr/bin/env node
// Harness stand-in for the deep verifier. The real one is covered by test:release.
process.stdout.write("deep verification passed (harness)\\n");
`);

  writeFileSync(path.join(top, "services/cli/infra-cod.mjs"), `#!/usr/bin/env node
import { writeFileSync, chmodSync, readFileSync } from "node:fs";
import path from "node:path";

const state = process.env.INFRA_COD_HARNESS_STATE;
const [command, subcommand] = process.argv.slice(2);

if (command === "admin" && subcommand === "bootstrap") {
  // The real CLI cannot hash a password without the pepper, and it must be the
  // same pepper the panel runs with. Leaving it out is how the first Ubuntu run
  // died at "the command failed", so the stub refuses exactly as Argon2id does.
  const pepper = process.env.INFRA_COD_AUTH_PEPPER;
  if (!pepper) {
    process.stderr.write(JSON.stringify({ status: "error", error: "the command failed", error_code: null, error_name: "Error" }) + "\\n");
    process.exit(1);
  }
  const expected = readFileSync(path.join(state, "expected-pepper"), "utf8").trim();
  if (expected && pepper !== expected) {
    process.stderr.write(JSON.stringify({ status: "error", error: "pepper does not match the installation" }) + "\\n");
    process.exit(1);
  }
  const dir = process.env.INFRA_COD_CREDENTIALS_DIR;
  const file = path.join(dir, "initial-credentials");
  writeFileSync(file, "username=operator\\npassword=harness-password\\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  writeFileSync(path.join(state, "owner-count"), "1\\n");
  process.stdout.write("operator bootstrapped\\n");
} else if (command === "doctor") {
  process.stdout.write(readFileSync(path.join(state, "doctor.json"), "utf8"));
  const report = JSON.parse(readFileSync(path.join(state, "doctor.json"), "utf8"));
  process.exitCode = report.critical > 0 ? 2 : (report.warnings > 0 ? 1 : 0);
} else {
  process.stderr.write("harness CLI: unsupported command\\n");
  process.exitCode = 2;
}
`);

  // FILESUMS over every file in the tree, so the installer's intactness re-check
  // has something real to check.
  const entries = walk(top).sort();
  const lines = entries.map((relative) => `${sha256File(path.join(top, relative))}  ${relative}`);
  writeFileSync(path.join(top, "FILESUMS.sha256"), `${lines.join("\n")}\n`);
  return top;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export function createSandbox({ migrationCount = 46 } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "infra-cod-install-"));
  const prefix = path.join(base, "root");
  const binDir = path.join(base, "bin");
  const stateDir = path.join(base, "state");
  const artifactDir = path.join(base, "artifact");
  const releaseSource = path.join(base, "release-src");

  for (const dir of [prefix, binDir, stateDir, artifactDir, releaseSource]) mkdirSync(dir, { recursive: true });
  for (const dir of ["opt", "etc", "var/lib", "var/run", "usr/bin", "run/lock", "srv"]) {
    mkdirSync(path.join(prefix, dir), { recursive: true });
  }

  writeStubs(binDir, stateDir, prefix);
  writeFileSync(path.join(stateDir, "groups"), "");
  writeFileSync(path.join(stateDir, "memberships"), "");
  writeFileSync(path.join(stateDir, "listeners"), "");
  writeFileSync(path.join(stateDir, "inactive-units"), "");
  writeFileSync(path.join(stateDir, "unit-pids"), "");
  writeFileSync(path.join(stateDir, "caddy-version"), "v2.9.1 h1:harness\n");
  writeFileSync(path.join(stateDir, "users"), "");
  writeFileSync(path.join(stateDir, "owner-count"), "0\n");
  writeFileSync(path.join(stateDir, "user-count"), "0\n");
  writeFileSync(path.join(stateDir, "expected-pepper"), "");
  writeFileSync(path.join(stateDir, "database-exists"), "1\n");
  writeFileSync(path.join(stateDir, "schema-exists"), "t\n");
  writeFileSync(path.join(stateDir, "migration-count"), `${migrationCount}\n`);
  writeFileSync(path.join(stateDir, "doctor.json"), `${JSON.stringify({ ok: true, critical: 0, warnings: 0, passed: 20, checks: [] })}\n`);

  // The pinned Node the installer expects to find already unpacked.
  const nodeBin = path.join(prefix, "opt/node/bin");
  mkdirSync(nodeBin, { recursive: true });
  writeExecutable(path.join(nodeBin, "node"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "v24.20.0"; exit 0; fi
exec "${process.execPath}" "$@"
`);

  // Caddy at the pinned path, not somewhere on PATH — that is the contract the
  // installer now enforces. The stub adapts the Caddyfile the way the real one
  // does in the single respect that matters here: a {$VAR} placeholder with no
  // value is a parse error, so validating without the environment file fails
  // exactly as Caddy 2.9.1 fails.
  const caddyBin = path.join(prefix, "usr/bin/caddy");
  mkdirSync(path.dirname(caddyBin), { recursive: true });
  writeExecutable(caddyBin, `#!/bin/sh
STATE="${stateDir}"
echo "caddy $*" >> "$STATE/caddy.log"
[ "$1" = "version" ] && { cat "$STATE/caddy-version"; exit 0; }
[ "$1" = "fmt" ] && exit 0
[ "$1" = "validate" ] || exit 0

CONFIG=""
ENVFILE=""
prev=""
for a in "$@"; do
  [ "$prev" = "--config" ] && CONFIG="$a"
  [ "$prev" = "--envfile" ] && ENVFILE="$a"
  prev="$a"
done
[ -n "$CONFIG" ] || { echo "Error: no config" >&2; exit 1; }

# A {$NAME} placeholder with no default must resolve, from --envfile or from the
# inherited environment. {$NAME:default} is fine without one, exactly as in Caddy.
for name in $(grep -o '{\\$[A-Z_][A-Z0-9_]*}' "$CONFIG" | sed 's/{\\$//; s/}//' | sort -u); do
  value=""
  if [ -n "$ENVFILE" ] && [ -f "$ENVFILE" ]; then
    value=$(sed -n "s/^$name=//p" "$ENVFILE" | tail -1)
  fi
  if [ -z "$value" ]; then
    value=$(printenv "$name" 2>/dev/null || true)
  fi
  if [ -z "$value" ]; then
    echo "Error: adapting config using caddyfile: parsing caddyfile tokens for 'email': wrong argument count ($name is empty)" >&2
    exit 1
  fi
done
exit 0
`);

  // The psql the installer reads its two counters from.
  const pgBin = path.join(prefix, "usr/lib/postgresql/17/bin");
  mkdirSync(pgBin, { recursive: true });
  writeExecutable(path.join(pgBin, "psql"), `#!/bin/sh
STATE="${stateDir}"
[ -f "$STATE/psql-down" ] && { echo "psql: could not connect" >&2; exit 2; }
query=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-c" ]; then query="$a"; fi
  prev="$a"
done
case "$query" in
  *schema_migrations*) cat "$STATE/migration-count" ;;
  *owner*) cat "$STATE/owner-count" ;;
  *pg_database*) cat "$STATE/database-exists" ;;
  *to_regclass*) cat "$STATE/schema-exists" ;;
  *password_hash*) cat "$STATE/user-count" ;;
  *control_plane.users*) cat "$STATE/user-count" ;;
  "SELECT 1") echo 1 ;;
  *) echo "" ;;
esac
`);

  const releaseTop = buildReleaseTree(releaseSource, { migrationCount });
  const tarball = path.join(artifactDir, `infra-cod-${RELEASE_VERSION}-linux-x64.tar.gz`);
  const tarResult = spawnSync("tar", ["-czf", tarball, "-C", releaseSource, path.basename(releaseTop)], { encoding: "utf8" });
  if (tarResult.status !== 0) throw new Error(`harness: tar failed: ${tarResult.stderr}`);

  const checksums = path.join(artifactDir, "SHA256SUMS");
  writeFileSync(checksums, `${sha256File(tarball)}  ${path.basename(tarball)}\n`);
  const signature = `${checksums}.minisig`;
  writeFileSync(signature, "untrusted comment: harness signature\n");
  const publicKey = path.join(artifactDir, "infra-cod-release.pub");
  writeFileSync(publicKey, "untrusted comment: harness public key\n");

  return {
    base, prefix, binDir, stateDir, artifactDir,
    tarball, checksums, signature, publicKey,
    version: RELEASE_VERSION,
    etc: path.join(prefix, "etc/infra-cod"),
    systemdDir: path.join(prefix, "etc/systemd/system"),
    releasesDir: path.join(prefix, "opt/infra-cod/releases"),
    currentLink: path.join(prefix, "opt/infra-cod/current"),
    stateFile: path.join(prefix, "etc/infra-cod/.install-state"),

    setDoctorReport(report) {
      writeFileSync(path.join(stateDir, "doctor.json"), `${JSON.stringify(report)}\n`);
    },
    setCaddyVersion(version) {
      writeFileSync(path.join(stateDir, "caddy-version"), `${version}\n`);
    },
    // `unit` makes the listener the installation's own: the stub then answers
    // `systemctl show -p MainPID` with the same pid, which is how the installer
    // tells its own panel from another server on the same port.
    setListener(port, processName, { unit, pid = 4242 } = {}) {
      // Pipe-delimited: a process name contains spaces (`next-server (v16.2.10)`).
      writeFileSync(path.join(stateDir, "listeners"), `${port}|${processName}|${pid}\n`);
      writeFileSync(path.join(stateDir, "unit-pids"), unit ? `${unit} ${pid}\n` : "");
    },
    // A unit that never reports active, for the readiness wait.
    setInactiveUnit(unit) {
      writeFileSync(path.join(stateDir, "inactive-units"), `${unit}\n`);
    },
    // Purging the PostgreSQL packages removes the client and leaves the data.
    removePsql() {
      rmSync(path.join(prefix, "usr/lib/postgresql/17/bin/psql"), { force: true });
    },
    setUsermodFails(fails) {
      const marker = path.join(stateDir, "usermod-fails");
      if (fails) writeFileSync(marker, ""); else rmSync(marker, { force: true });
    },
    // The pepper the CLI stub will insist on, so a test can prove the installer
    // passes the installation's own value and not merely some value.
    expectPepper(value) {
      writeFileSync(path.join(stateDir, "expected-pepper"), `${value}\n`);
    },
    setDatabaseExists(exists) {
      writeFileSync(path.join(stateDir, "database-exists"), `${exists ? 1 : 0}\n`);
    },
    setSchemaExists(exists) {
      writeFileSync(path.join(stateDir, "schema-exists"), `${exists ? "t" : "f"}\n`);
    },
    setUserCount(count) {
      writeFileSync(path.join(stateDir, "user-count"), `${count}\n`);
    },
    setDatabaseExists(exists) {
      writeFileSync(path.join(stateDir, "database-exists"), `${exists ? 1 : 0}\n`);
    },
    setSchemaExists(exists) {
      writeFileSync(path.join(stateDir, "schema-exists"), `${exists ? "t" : "f"}\n`);
    },
    setUserCount(count) {
      writeFileSync(path.join(stateDir, "user-count"), `${count}\n`);
    },
    setOwnerCount(count) {
      writeFileSync(path.join(stateDir, "owner-count"), `${count}\n`);
    },
    setMigrationCount(count) {
      writeFileSync(path.join(stateDir, "migration-count"), `${count}\n`);
    },
    setPsqlDown(down) {
      const marker = path.join(stateDir, "psql-down");
      if (down) writeFileSync(marker, ""); else rmSync(marker, { force: true });
    },
    setWebDown(down) {
      const marker = path.join(stateDir, "web-down");
      if (down) writeFileSync(marker, ""); else rmSync(marker, { force: true });
    },
    failUnit(unit) {
      writeFileSync(path.join(stateDir, "failing-units"), `${unit}\n`);
    },
    clearFailingUnits() {
      rmSync(path.join(stateDir, "failing-units"), { force: true });
    },
    readState() {
      if (!existsSync(this.stateFile)) return null;
      const [block, step, version, artifact, config] = readFileSync(this.stateFile, "utf8").trim().split(/\s+/);
      return { block: Number(block), step: Number(step), version, artifact, config };
    },
    writeState({ block, step = 0, version = RELEASE_VERSION, artifact, config }) {
      const current = this.readState();
      writeFileSync(this.stateFile, `${block} ${step} ${version} ${artifact ?? current?.artifact ?? ""} ${config ?? current?.config ?? ""}\n`, { mode: 0o600 });
    },
    mode(relative) {
      return statSync(path.join(prefix, relative)).mode & 0o777;
    },
    read(relative) {
      return readFileSync(path.join(prefix, relative), "utf8");
    },
    exists(relative) {
      return existsSync(path.join(prefix, relative));
    },
    remove(relative) {
      rmSync(path.join(prefix, relative), { recursive: true, force: true });
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },

    run(extraArgs = [], { env = {} } = {}) {
      const args = [
        INSTALLER,
        "--artifact", tarball,
        "--checksums", checksums,
        "--signature", signature,
        "--public-key", publicKey,
        "--domain", "panel.example.test",
        "--acme-email", "ops@example.test",
        ...extraArgs,
      ];
      return spawnSync("bash", args, {
        encoding: "utf8",
        env: {
          PATH: `${binDir}:${process.env.PATH}`,
          HOME: base,
          INFRA_COD_INSTALL_PREFIX: prefix,
          INFRA_COD_HARNESS_STATE: stateDir,
          TMPDIR: process.env.TMPDIR ?? "/tmp",
          ...env,
        },
      });
    },
  };
}
