// A sandboxed installed host that `infra-cod update` can actually update.
//
// The coordinator under test is the real one, running from a real release tree:
// `node <release>/services/cli/infra-cod.mjs update ...`, which is how the host
// runs it. What the sandbox supplies is a prefix (INFRA_COD_INSTALL_PREFIX), a
// PATH of stub system commands, a fake `/proc`, and signed-shaped artifacts.
//
// The one simulation that carries the weight of these tests is systemd's.
// `WorkingDirectory=/opt/infra-cod/current/...` is resolved *when the service
// execs*, so a running process holds the real release directory as its cwd. The
// stub reproduces exactly that: `restart` re-resolves `current` and re-points
// each unit's `/proc/<pid>/cwd`, `start` on an already active target does
// nothing at all, and the PID changes only on a restart. That is the difference
// between an update that replaced the running code and one that moved a symlink,
// and it is the difference these tests are for.
//
// What this harness does NOT prove: the signature and checksum chain. The
// verification gate is stubbed here, exactly as it is in the installer harness,
// because the trust chain has its own suites (`test:release`,
// `test:release:artifact`) that run the real minisign and the real verifier
// against a real artifact.

import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(HERE, "../../../");

export function harnessPrerequisites() {
  return ["bash", "tar", "shasum", "sed", "awk"].filter(
    (name) => spawnSync("sh", ["-c", `command -v ${name}`]).status !== 0,
  );
}

function writeExecutable(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function walk(root, base = root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// The units whose processes the coordinator inspects. The real list comes from
// the unit contract; the sandbox only has to behave like systemd for it.
import { LONG_RUNNING_SERVICES } from "../unit-contract.mjs";
import { declareInstall } from "../install-declaration.mjs";

// ---------------------------------------------------------------------------
// Stub system commands
// ---------------------------------------------------------------------------

function writeStubs(binDir, stateDir, prefix) {
  const preamble = `#!/bin/sh\nSTATE="${stateDir}"\nPREFIX="${prefix}"\n`;

  // systemd, as far as this coordinator can tell.
  //
  // `units` holds one line per unit: "<unit> <active|inactive> <pid>". A restart
  // allocates a new PID and re-points that PID's /proc/<pid>/cwd at whatever
  // `current` resolves to *now*; a start on an active unit changes nothing,
  // which is the no-op that let an old process serve a new symlink.
  writeExecutable(path.join(binDir, "systemctl"), `${preamble}
echo "systemctl $*" >> "$STATE/systemctl.log"
# A test refuses an action on a unit by listing "<action> <unit>" here.
if grep -qx "$1 $2" "$STATE/systemctl-fails" 2>/dev/null; then echo "Failed to $1 $2: harness refusal" >&2; exit 1; fi

resolve_current() {
  readlink "$PREFIX/opt/infra-cod/current" 2>/dev/null
}

# The unit's own WorkingDirectory, read from the unit file that is installed —
# not assumed. Two of the fourteen services run from /var/lib/infra-control and
# not from the release tree, and a harness that gave every process a cwd inside
# the release hid exactly that: the real verification marked those two
# "unidentifiable" and would have failed every update on a real host.
working_directory_of() {
  unit="$1"
  file="$PREFIX/etc/systemd/system/$unit.service"
  [ -f "$file" ] || file="$(resolve_current)/deploy/systemd/$unit.service"
  sed -n 's/^WorkingDirectory=//p' "$file" 2>/dev/null | head -1
}

set_running() {
  unit="$1"
  release=$(resolve_current)
  [ -n "$release" ] || return 0
  pid=$(cat "$STATE/next-pid" 2>/dev/null || echo 1000)
  pid=$((pid + 1))
  echo "$pid" > "$STATE/next-pid"
  # A monotonic start stamp, which is what proves a process re-exec'd rather than
  # survived a no-op start.
  stamp=$(cat "$STATE/next-stamp" 2>/dev/null || echo 100)
  stamp=$((stamp + 7))
  echo "$stamp" > "$STATE/next-stamp"
  grep -v "^$unit " "$STATE/units" > "$STATE/units.tmp" 2>/dev/null || true
  mv "$STATE/units.tmp" "$STATE/units" 2>/dev/null || true
  echo "$unit active $pid $stamp" >> "$STATE/units"

  wd=$(working_directory_of "$unit")
  case "$wd" in
    /opt/infra-cod/current*)
      # systemd resolves the symlink at exec, so the cwd is the real release.
      suffix=\${wd#/opt/infra-cod/current}
      cwd="$release$suffix" ;;
    "") cwd="$release" ;;
    *)
      cwd="$PREFIX$wd"
      mkdir -p "$cwd" ;;
  esac
  mkdir -p "$PREFIX/proc/$pid"
  rm -f "$PREFIX/proc/$pid/cwd"
  ln -s "$cwd" "$PREFIX/proc/$pid/cwd"
}

stop_unit() {
  unit="$1"
  pid=$(grep "^$unit " "$STATE/units" 2>/dev/null | awk '{print $3}')
  [ -n "$pid" ] && rm -rf "$PREFIX/proc/$pid"
  grep -v "^$unit " "$STATE/units" > "$STATE/units.tmp" 2>/dev/null || true
  mv "$STATE/units.tmp" "$STATE/units" 2>/dev/null || true
  echo "$unit inactive 0" >> "$STATE/units"
}

target_units() {
  cat "$STATE/target-units"
}

ACTION="$1"
UNIT="$2"

case "$ACTION" in
  daemon-reload|enable|disable|reset-failed) exit 0 ;;
  show)
    for a in "$@"; do last="$a"; done
    name=\${last%.service}
    case " $* " in
      *ActiveState*)
        case "$last" in
          unattended-upgrades.service)
            # Ubuntu's shutdown helper: active for the life of the machine.
            if [ -f "$STATE/apt-shutdown-helper-running" ]; then echo "active"; else echo "inactive"; fi
            exit 0 ;;
          apt-daily-upgrade.service|apt-daily.service)
            if [ -f "$STATE/apt-running" ]; then echo "active"; else echo "inactive"; fi
            exit 0 ;;
        esac
        echo "active"; exit 0 ;;
      *Result*)
        if grep -qx "$name" "$STATE/unknown-oneshots" 2>/dev/null; then exit 1; fi
        if grep -qx "$name" "$STATE/failed-oneshots" 2>/dev/null; then echo "exit-code"; else echo "success"; fi
        exit 0 ;;
    esac
    # MainPID / ExecMainStartTimestampMonotonic / ExecStart are asked for
    # together and printed as KEY=VALUE, which is how the coordinator reads them.
    line=$(grep "^$name " "$STATE/units" 2>/dev/null | tail -1)
    pid=$(echo "$line" | awk '{print $3}')
    stamp=$(echo "$line" | awk '{print $4}')
    [ -n "$pid" ] || pid=0
    [ -n "$stamp" ] || stamp=0
    exec_start=$(sed -n 's/^ExecStart=//p' "$PREFIX/etc/systemd/system/$name.service" 2>/dev/null | head -1)
    for a in "$@"; do
      case "$a" in
        MainPID) echo "MainPID=$pid" ;;
        ExecMainStartTimestampMonotonic) echo "ExecMainStartTimestampMonotonic=$stamp" ;;
        ExecStart) echo "ExecStart={ path=\${exec_start%% *} ; argv[]=$exec_start }" ;;
      esac
    done
    exit 0 ;;
  is-active)
    name=\${UNIT%.service}
    name=\${name%.timer}
    if [ "$UNIT" = "infra-cod.target" ]; then
      grep -q " active " "$STATE/units" 2>/dev/null && exit 0 || exit 3
    fi
    if grep -qx "$name" "$STATE/inactive-now" 2>/dev/null; then
      # One poll of not-yet-active, then it settles — as a real restart does.
      grep -v "^$name$" "$STATE/inactive-now" > "$STATE/inactive-now.tmp" 2>/dev/null || true
      mv "$STATE/inactive-now.tmp" "$STATE/inactive-now" 2>/dev/null || true
      pid=$(grep "^$name " "$STATE/units" | awk '{print $3}')
      release=$(resolve_current)
      wd=$(working_directory_of "$name")
      case "$wd" in
        /opt/infra-cod/current*) suffix=\${wd#/opt/infra-cod/current}; cwd="$release$suffix" ;;
        "") cwd="$release" ;;
        *) cwd="$PREFIX$wd"; mkdir -p "$cwd" ;;
      esac
      mkdir -p "$PREFIX/proc/$pid"; ln -sf "$cwd" "$PREFIX/proc/$pid/cwd"
      exit 3
    fi
    grep -q "^$name active " "$STATE/units" 2>/dev/null && exit 0
    case "$UNIT" in *.timer) exit 0 ;; esac
    exit 3 ;;
  stop)
    if [ "$UNIT" = "infra-cod.target" ]; then
      for u in $(target_units); do stop_unit "$u"; done
    else
      stop_unit "\${UNIT%.service}"
    fi
    exit 0 ;;
  start)
    case "$UNIT" in
      infra-cod-backup.service)
        grep -qx infra-cod-backup "$STATE/failing-units" 2>/dev/null && { echo "Job for $UNIT failed" >&2; exit 1; }
        sh "$STATE/backup.sh"; exit 0 ;;
      infra-cod-restore-drill.service)
        grep -qx infra-cod-restore-drill "$STATE/failing-units" 2>/dev/null && { echo "Job for $UNIT failed" >&2; exit 1; }
        sh "$STATE/restore-drill.sh"; exit 0 ;;
      infra-cod-health.service)
        grep -qx infra-cod-health "$STATE/failing-units" 2>/dev/null && { echo "Job for $UNIT failed" >&2; exit 1; }
        exit 0 ;;
      infra-cod.target)
        # A start on an already active target is a no-op. That is the whole
        # point: nothing re-execs, so nothing picks up the new symlink.
        grep -q " active " "$STATE/units" 2>/dev/null && exit 0
        for u in $(target_units); do set_running "$u"; done
        exit 0 ;;
      *)
        set_running "\${UNIT%.service}"; exit 0 ;;
    esac ;;
  restart)
    if [ "$UNIT" = "infra-cod.target" ]; then
      grep -qx infra-cod.target "$STATE/failing-units" 2>/dev/null && { echo "Job for $UNIT failed" >&2; exit 1; }
      for u in $(target_units); do
        # A unit listed in restart-immune keeps its process and its start stamp:
        # the failure where a service somehow survives the restart and goes on
        # serving the old code.
        if grep -qx "$u" "$STATE/restart-immune" 2>/dev/null; then continue; fi
        stop_unit "$u"; set_running "$u"
        # A unit listed in restart-slow is systemd mid-flight: the target job has
        # returned, the unit is not active yet, and its MainPID names a process
        # that no longer exists. This is what the first real host did, and what
        # made a correct update report itself as a failure.
        if grep -qx "$u" "$STATE/restart-slow" 2>/dev/null; then
          n=$(cat "$STATE/slow-$u" 2>/dev/null || echo 0)
          n=$((n + 1)); echo "$n" > "$STATE/slow-$u"
          if [ "$n" -le 2 ]; then
            pid=$(grep "^$u " "$STATE/units" | awk '{print $3}')
            rm -rf "$PREFIX/proc/$pid"
            echo "$u" >> "$STATE/inactive-now"
          fi
        fi
      done
    else
      stop_unit "\${UNIT%.service}"; set_running "\${UNIT%.service}"
    fi
    exit 0 ;;
esac
exit 0
`);

  writeExecutable(path.join(binDir, "systemd-tmpfiles"), "#!/bin/sh\nexit 0\n");
  // The runtime accounts a release declares (sysusers.d), made before its
  // tmpfiles rules: the harness has no users to make.
  writeExecutable(path.join(binDir, "systemd-sysusers"), "#!/bin/sh\nexit 0\n");

  // The panel, and which release's panel it is.
  //
  // `web-down` names the release whose panel does not answer — empty means all
  // of them. Scoping it matters: the interesting failure is "B is broken and A
  // is fine", and a probe that fails for every release would make the rollback
  // look unhealthy too, which is a different outcome entirely.
  writeExecutable(path.join(binDir, "curl"), `${preamble}
echo "curl $*" >> "$STATE/commands.log"
if [ -f "$STATE/web-down" ]; then
  WANT=$(cat "$STATE/web-down")
  CURRENT=$(basename "$(readlink "$PREFIX/opt/infra-cod/current" 2>/dev/null)" 2>/dev/null)
  if [ -z "$WANT" ] || [ "$WANT" = "$CURRENT" ]; then printf '000'; exit 0; fi
fi
if [ -f "$STATE/auth-open" ]; then printf '200'; exit 0; fi
case "$*" in
  */api/control-plane/selftest*)
    if [ -f "$STATE/selftest-fails" ]; then
      WANT=$(cat "$STATE/selftest-fails")
      CURRENT=$(basename "$(readlink "$PREFIX/opt/infra-cod/current" 2>/dev/null)" 2>/dev/null)
      if [ -z "$WANT" ] || [ "$WANT" = "$CURRENT" ]; then printf '500'; exit 0; fi
    fi
    printf '200'; exit 0 ;;
esac
case "$*" in
  */api/control-plane/snapshot*) printf '401'; exit 0 ;;
  */projects*) printf '307'; exit 0 ;;
esac
printf '200'
exit 0
`);

  // The database, as far as the coordinator asks it: the migration ledger and
  // the in-flight job count.
  writeExecutable(path.join(binDir, "psql"), `${preamble}
SQL=""
prev=""
for a in "$@"; do
  [ "$prev" = "-c" ] && SQL="$a"
  prev="$a"
done
echo "psql $SQL" >> "$STATE/psql.log"
[ -f "$STATE/psql-fails" ] && { echo "connection refused" >&2; exit 1; }
# INFRA_COD_HARNESS_PSQL_FAILS_AFTER names an update phase; once the coordinator
# has recorded that phase, the database stops answering. That is how a failure
# path meets an unreadable ledger.
if [ -n "\${INFRA_COD_HARNESS_PSQL_FAILS_AFTER:-}" ]; then
  if grep -q "phase.*$INFRA_COD_HARNESS_PSQL_FAILS_AFTER" "$PREFIX/etc/infra-cod/.update-state" 2>/dev/null; then
    echo "connection refused" >&2
    exit 1
  fi
fi
case "$SQL" in
  *schema_migrations*) cat "$STATE/ledger" ;;
  *runtime_jobs*) cat "$STATE/in-flight" ;;
  *) echo "" ;;
esac
exit 0
`);

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
for f in $FILES; do shasum -a 256 "$f" | awk '{print $1"  "$2}'; done
exit 0
`);

  // A real mutual exclusion, not a no-op: a directory create is atomic, so two
  // coordinators in the sandbox contend the way two do on a host.
  writeExecutable(path.join(binDir, "flock"), `#!/bin/sh
STATE_DIR="${stateDir}"
[ "$1" = "--version" ] && { echo "flock (harness)"; exit 0; }
while [ $# -gt 0 ]; do
  case "$1" in
    -n) shift ;;
    -w) shift 2 ;;
    *) break ;;
  esac
done
LOCK="$1"; shift
# Real flock takes either a command and its arguments, or -c with a shell string.
if [ "$1" = "-c" ]; then shift; set -- sh -c "$1"; fi
mkdir -p "$(dirname "$LOCK")"
if ! mkdir "$LOCK.d" 2>/dev/null; then echo "flock: failed to get lock" >&2; exit 1; fi
trap 'rmdir "$LOCK.d" 2>/dev/null' EXIT INT TERM HUP
"$@"
`);
}

// ---------------------------------------------------------------------------
// Release trees and artifacts
// ---------------------------------------------------------------------------

function manifestFor({ version, migrations, compatibility, install }) {
  const names = migrations.map((entry) => entry.name).sort();
  return {
    schema: "infra-cod/release-manifest/1",
    product: "infra-cod",
    version,
    channel: "rc",
    release: { signed: true },
    git: { sha: "a".repeat(40), dirty: false, sourceDateEpoch: 1 },
    target: { os: "linux", arch: "x64", libc: "glibc" },
    toolchain: { node: "24.20.0", pnpm: "11.9.0", next: "16.2.10", postgresqlMajor: 17 },
    database: {
      migrationCount: names.length,
      latestMigration: names[names.length - 1] ?? null,
      migrationSetSha256: "b".repeat(64),
      compatibility: compatibility ?? {
        contract: "infra-cod/schema-compatibility/1",
        unverifiedThrough: "0050",
        unverified: names.filter((name) => name.slice(0, 4) <= "0050").map((name) => name.slice(0, 4)),
        backwardIncompatible: [],
      },
    },
    entrypoints: {
      web: "web/apps/web/server.js",
      cli: "services/cli/infra-cod.mjs",
      migrate: "services/control-plane/migrate.mjs",
      runtimeSupervisor: "services/runtime-supervisor/server.mjs",
    },
    ...(install ? { install } : {}),
    payload: { fileCount: 1, bytes: 1, checksums: "FILESUMS.sha256", symlinks: [] },
  };
}

// One release tree: the repository's real services (so the coordinator under
// test is the real code), the real units, and stubs for exactly the two things
// a sandbox cannot run — the signature gate and the migration runner.
// `extra`: files one release ships and another does not — a unit and a tool
// definition — so a test can watch the second retire them. `install`: the
// manifest's install declaration; by default the one the tree implies, with a
// coordinator floor every harness release meets, and `null` for a release built
// before WP-A.
export function buildReleaseTree(destination, { version, migrations, compatibility, stateDir, extra = {}, install }) {
  mkdirSync(destination, { recursive: true });
  cpSync(path.join(REPOSITORY_ROOT, "services"), path.join(destination, "services"), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}test`) && !source.includes("node_modules"),
  });
  cpSync(path.join(REPOSITORY_ROOT, "deploy/systemd"), path.join(destination, "deploy/systemd"), { recursive: true });
  cpSync(path.join(REPOSITORY_ROOT, "deploy/tmpfiles.d"), path.join(destination, "deploy/tmpfiles.d"), { recursive: true });
  cpSync(path.join(REPOSITORY_ROOT, "deploy/caddy"), path.join(destination, "deploy/caddy"), { recursive: true });
  mkdirSync(path.join(destination, "web"), { recursive: true });
  for (const unit of extra.units ?? []) {
    writeFileSync(path.join(destination, "deploy/systemd", unit), `[Unit]\nDescription=${unit}\n[Service]\nExecStart=/bin/true\n`);
  }
  // A unit shipped under another name, as rc.43 renamed two workers: the same
  // file, so the renamed service runs from the release tree like the original.
  for (const [from, to] of Object.entries(extra.renameUnits ?? {})) {
    renameSync(path.join(destination, "deploy/systemd", from), path.join(destination, "deploy/systemd", to));
    const target = path.join(destination, "deploy/systemd/infra-cod.target");
    writeFileSync(target, readFileSync(target, "utf8").replaceAll(`Wants=${from}`, `Wants=${to}`));
  }
  for (const tool of extra.tools ?? []) {
    writeFileSync(path.join(destination, "services/runtime-supervisor/opencode-tools", tool), `// ${tool}\n`);
  }

  // `pg` and `hash-wasm` are resolved from the release root on a real host too.
  const modules = path.join(destination, "node_modules");
  if (!existsSync(modules)) symlinkSync(path.join(REPOSITORY_ROOT, "node_modules"), modules);

  mkdirSync(path.join(destination, "db/migrations"), { recursive: true });
  for (const migration of migrations) {
    writeFileSync(path.join(destination, "db/migrations", migration.name), migration.sql ?? "SELECT 1;\n");
  }

  // The verification gate: the real one needs minisign and a signed artifact.
  // This one keeps the contract the coordinator depends on — refuse unless the
  // artifact is listed in the checksum file, then extract into --extract — and
  // leaves the trust chain itself to the suites that run it for real.
  writeExecutable(path.join(destination, "deploy/verify-release.sh"), `#!/bin/sh
set -eu
ARTIFACT=""; CHECKSUMS=""; EXTRACT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --artifact) ARTIFACT=$2; shift 2 ;;
    --checksums) CHECKSUMS=$2; shift 2 ;;
    --signature|--public-key|--version) shift 2 ;;
    --require-signature) shift ;;
    --extract) EXTRACT=$2; shift 2 ;;
    *) echo "gate: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -f "$ARTIFACT" ] || { echo "gate: no artifact" >&2; exit 1; }
grep -q "$(basename "$ARTIFACT")" "$CHECKSUMS" || { echo "gate: the artifact is not listed in the checksums" >&2; exit 1; }
[ -f "$ARTIFACT.rejected" ] && { echo "gate: signature verification failed" >&2; exit 1; }
mkdir -p "$EXTRACT"
tar -xzf "$ARTIFACT" -C "$EXTRACT"
echo "gate: verified"
`);

  writeExecutable(path.join(destination, "scripts/verify-release.mjs"), `#!/usr/bin/env node
// Harness stand-in for the deep verifier; the real one is covered by test:release.
process.stdout.write("deep verification passed (harness)\\n");
`);

  // The migration runner. The real one grants and revokes a temporary role
  // around `migrate.mjs`; what matters to the coordinator is that it applies
  // exactly the pending migrations and fails loudly, so the stub appends them to
  // the ledger the psql stub reads.
  writeExecutable(path.join(destination, "deploy/run-production-migrations.sh"), `#!/bin/sh
set -eu
STATE="${stateDir}"
ROOT=\${1:-${destination}}
[ -f "$STATE/migrations-fail" ] && { echo "migration failed (harness)" >&2; exit 1; }
for f in "$ROOT"/db/migrations/*.sql; do
  v=$(basename "$f" | cut -c1-4)
  grep -qx "$v" "$STATE/ledger" || echo "$v" >> "$STATE/ledger"
done
sort -o "$STATE/ledger" "$STATE/ledger"
echo '{"ok":true}'
`);

  const declaration = install === undefined ? declareInstall(destination, { minCoordinatorVersion: "0.1.0" }) : install;
  const manifest = manifestFor({ version, migrations, compatibility, install: declaration ?? undefined });
  writeFileSync(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const files = walk(destination).filter((relative) => relative !== "FILESUMS.sha256").sort();
  writeFileSync(
    path.join(destination, "FILESUMS.sha256"),
    `${files.map((relative) => `${sha256File(path.join(destination, relative))}  ${relative}`).join("\n")}\n`,
  );
  return destination;
}

export function defaultMigrations(count = 50) {
  return Array.from({ length: count }, (_, index) => ({
    name: `${String(index + 1).padStart(4, "0")}_m${index + 1}.sql`,
  }));
}

// ---------------------------------------------------------------------------
// The sandboxed host
// ---------------------------------------------------------------------------

export function createHost({ version = "0.1.0", migrations = defaultMigrations(), extra = {} } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "infra-cod-update-"));
  const prefix = path.join(base, "root");
  const binDir = path.join(base, "bin");
  const stateDir = path.join(base, "state");
  const artifactDir = path.join(base, "artifacts");

  for (const directory of [prefix, binDir, stateDir, artifactDir]) mkdirSync(directory, { recursive: true });
  for (const directory of ["opt/infra-cod/releases", "etc/infra-cod", "etc/systemd/system", "etc/tmpfiles.d", "var/lib/infra-cod-backups", "var/run/postgresql", "usr/local/bin", "run/lock", "proc"]) {
    mkdirSync(path.join(prefix, directory), { recursive: true });
  }

  writeStubs(binDir, stateDir, prefix);
  writeFileSync(path.join(stateDir, "units"), "");
  writeFileSync(path.join(stateDir, "next-pid"), "1000\n");
  writeFileSync(path.join(stateDir, "next-stamp"), "100\n");
  writeFileSync(path.join(stateDir, "target-units"), `${LONG_RUNNING_SERVICES.join("\n")}\n`);
  writeFileSync(path.join(stateDir, "failing-units"), "");
  writeFileSync(path.join(stateDir, "failed-oneshots"), "");
  writeFileSync(path.join(stateDir, "unknown-oneshots"), "");
  writeFileSync(path.join(stateDir, "restart-immune"), "");
  writeFileSync(path.join(stateDir, "restart-slow"), "");
  writeFileSync(path.join(stateDir, "inactive-now"), "");
  writeFileSync(path.join(stateDir, "in-flight"), "0\n");
  writeFileSync(path.join(stateDir, "ledger"), `${migrations.map((entry) => entry.name.slice(0, 4)).join("\n")}\n`);
  writeFileSync(path.join(stateDir, "doctor.json"), `${JSON.stringify({ ok: true, critical: 0, warnings: 0, checks: [] })}\n`);

  const backupRoot = path.join(prefix, "var/lib/infra-cod-backups");
  writeExecutable(path.join(stateDir, "backup.sh"), `#!/bin/sh
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
NAME="infra-cod-$(date -u +%Y%m%dT%H%M%S).tar.gpg"
printf '{"created_at":"%s","backup_id":"harness","encrypted_file":"%s"}\\n' "$NOW" "$NAME" > "${backupRoot}/latest.json"
: > "${backupRoot}/$NAME"
`);
  writeExecutable(path.join(stateDir, "restore-drill.sh"), `#!/bin/sh
FILE=$(sed -n 's/.*"encrypted_file":"\\([^"]*\\)".*/\\1/p' "${backupRoot}/latest.json")
printf '{"type":"restore_drill.completed","backup":"%s"}\\n' "$FILE" > "${backupRoot}/$FILE.restore.json"
`);

  // The installed command. Kept a stub on purpose: `doctor` has its own suite,
  // and what these tests check is that the coordinator reads its verdict and the
  // version the release reports — not that doctor works.
  writeExecutable(path.join(prefix, "usr/local/bin/infra-cod"), `#!/bin/sh
STATE="${stateDir}"
case "$1" in
  doctor) cat "$STATE/doctor.json" ;;
  version)
    sed -n 's/.*"version": "\\([^"]*\\)".*/{"version":"\\1"}/p' "${prefix}/opt/infra-cod/current/manifest.json" | head -1 ;;
  *) echo "harness shim: unsupported command" >&2; exit 2 ;;
esac
`);

  // dpkg's lock files and the kernel's lock table, which is how the coordinator
  // asks whether a package operation is running. The lock itself is taken for
  // real, with fcntl, because that is the mechanism apt uses and the one a BSD
  // flock silently fails to exclude.
  mkdirSync(path.join(prefix, "var/lib/dpkg"), { recursive: true });
  mkdirSync(path.join(prefix, "var/cache/apt/archives"), { recursive: true });
  for (const lock of ["var/lib/dpkg/lock-frontend", "var/lib/dpkg/lock", "var/cache/apt/archives/lock"]) {
    writeFileSync(path.join(prefix, lock), "");
  }
  writeFileSync(path.join(prefix, "proc/locks"), "");

  const releaseDirectory = path.join(prefix, "opt/infra-cod/releases", version);
  buildReleaseTree(releaseDirectory, { version, migrations, stateDir, extra });
  symlinkSync(releaseDirectory, path.join(prefix, "opt/infra-cod/current"));

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    INFRA_COD_INSTALL_PREFIX: prefix,
    INFRA_COD_ACTOR: "harness",
    // A real host waits a minute for a booting panel; a suite that starts a
    // dozen of them does not have a minute to spare per probe.
    INFRA_COD_UPDATE_PROBE_ATTEMPTS: "3",
    INFRA_COD_UPDATE_PROBE_DELAY_MS: "100",
  };

  const host = {
    base, prefix, binDir, stateDir, artifactDir, env,
    currentRelease: () => releaseDirectory,

    // Runs the coordinator the way the host runs it: from the release that
    // `current` points at, which is the release it may be about to replace.
    cli(args, { extraEnv = {} } = {}) {
      const current = path.join(prefix, "opt/infra-cod/current");
      const result = spawnSync(process.execPath, [path.join(current, "services/cli/infra-cod.mjs"), ...args], {
        encoding: "utf8",
        env: { ...env, ...extraEnv },
        timeout: 180_000,
      });
      return {
        code: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        signal: result.signal ?? null,
      };
    },

    // A verified-shaped artifact: a tarball whose single top-level directory is a
    // complete release tree, plus the checksum and signature files the command
    // line requires.
    artifact({ version: artifactVersion, migrations: artifactMigrations = migrations, compatibility, extra: artifactExtra = {}, install } = {}) {
      const work = mkdtempSync(path.join(base, "build-"));
      const top = path.join(work, `infra-cod-${artifactVersion}`);
      buildReleaseTree(top, { version: artifactVersion, migrations: artifactMigrations, compatibility, stateDir, extra: artifactExtra, install });
      const tarball = path.join(artifactDir, `infra-cod-${artifactVersion}-linux-x64.tar.gz`);
      // Symlinks travel as symlinks. The one that matters is `node_modules`,
      // which points at the checkout's dependency closure: dereferencing it would
      // pack a few hundred megabytes into every artifact this suite builds, and
      // what the coordinator needs from it is only that `pg` resolves.
      const tar = spawnSync("tar", ["-czf", tarball, "-C", work, `infra-cod-${artifactVersion}`], { encoding: "utf8" });
      if (tar.status !== 0) throw new Error(`harness: tar failed: ${tar.stderr}`);
      const checksums = path.join(artifactDir, `SHA256SUMS-${artifactVersion}`);
      writeFileSync(checksums, `${sha256File(tarball)}  ${path.basename(tarball)}\n`);
      const signature = `${checksums}.minisig`;
      writeFileSync(signature, "untrusted comment: harness\n");
      const publicKey = path.join(artifactDir, "public.key");
      writeFileSync(publicKey, "untrusted comment: harness public key\n");
      rmSync(work, { recursive: true, force: true });
      return { artifact: tarball, checksums, signature, publicKey };
    },

    updateArgs(artifact, extra = []) {
      return [
        "update",
        "--artifact", artifact.artifact,
        "--checksums", artifact.checksums,
        "--signature", artifact.signature,
        "--public-key", artifact.publicKey,
        "--yes",
        ...extra,
      ];
    },

    // Installs the current release's declared files the way install.sh does, so
    // the host starts out with what that release put there.
    installCurrent() {
      const result = spawnSync(process.execPath, [
        path.join(releaseDirectory, "services/operations/install-reconcile.mjs"), "reconcile", "--release", releaseDirectory,
      ], { encoding: "utf8", env });
      if (result.status !== 0) throw new Error(`harness: install-reconcile failed: ${result.stderr}`);
      return host;
    },
    installed(relative) {
      return existsSync(path.join(prefix, relative));
    },
    readPrefixed(relative) {
      return readFileSync(path.join(prefix, relative), "utf8");
    },

    // Everything the tests assert on, read from the sandbox rather than from the
    // command's own output.
    state(name) {
      return readFileSync(path.join(stateDir, name), "utf8");
    },
    setState(name, value) {
      writeFileSync(path.join(stateDir, name), value);
    },
    units() {
      return Object.fromEntries(
        readFileSync(path.join(stateDir, "units"), "utf8")
          .split("\n").filter(Boolean)
          .map((line) => {
            const [unit, status, pid, stamp] = line.split(/\s+/);
            return [unit, { status, pid: Number(pid), startedMonotonic: Number(stamp ?? 0) }];
          }),
      );
    },
    // Which release each running process is executing, read the way the
    // coordinator reads it: from the process's own working directory.
    // Which release each running process is executing, read the way the
    // coordinator reads it. Only meaningful for the units that actually run from
    // the release tree; the two that do not are reported as `null`, because
    // their cwd genuinely does not answer the question.
    runningReleases() {
      const releasesRoot = path.join(prefix, "opt/infra-cod/releases");
      const result = {};
      for (const [unit, info] of Object.entries(host.units())) {
        if (info.status !== "active" || !info.pid) continue;
        const link = path.join(prefix, "proc", String(info.pid), "cwd");
        if (!existsSync(link)) continue;
        const cwd = path.resolve(readlinkSync(link));
        if (!cwd.startsWith(`${releasesRoot}${path.sep}`)) {
          result[unit] = null;
          continue;
        }
        result[unit] = path.relative(releasesRoot, cwd).split(path.sep)[0];
      }
      return result;
    },

    // The release-tree services only: the set the cwd evidence can speak for.
    releaseTreeUnits() {
      return Object.entries(host.runningReleases())
        .filter(([, release]) => release !== null)
        .map(([unit]) => unit);
    },
    currentTarget() {
      const link = path.join(prefix, "opt/infra-cod/current");
      return path.basename(spawnSync("readlink", [link], { encoding: "utf8" }).stdout.trim());
    },
    releaseNames() {
      return readdirSync(path.join(prefix, "opt/infra-cod/releases")).sort();
    },
    receipts() {
      const directory = path.join(prefix, "etc/infra-cod/release-receipts");
      if (!existsSync(directory)) return [];
      return readdirSync(directory).sort().map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")));
    },
    updateState() {
      const file = path.join(prefix, "etc/infra-cod/.update-state");
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    },
    // Start the stack, as an installed host has it: every unit active, every
    // process executing the current release.
    boot() {
      spawnSync(path.join(binDir, "systemctl"), ["start", "infra-cod.target"], { env });
      return host;
    },
    // Hold dpkg's frontend lock exactly as apt does — an fcntl write lock — and
    // publish it in the fake /proc/locks the way the kernel does. Returns a
    // function that lets go.
    holdPackageLock() {
      const file = path.join(prefix, "var/lib/dpkg/lock-frontend");
      const holder = spawn("python3", ["-c", [
        "import fcntl, sys",
        "f = open(sys.argv[1], 'a+')",
        "fcntl.lockf(f, fcntl.LOCK_EX | fcntl.LOCK_NB)",
        "sys.stdout.write('held\\n'); sys.stdout.flush()",
        "sys.stdin.read()",
      ].join("\n"), file], { stdio: ["pipe", "pipe", "pipe"] });

      const inode = statSync(file).ino;
      writeFileSync(
        path.join(prefix, "proc/locks"),
        `1: POSIX  ADVISORY  WRITE ${holder.pid} 00:01:${inode} 0 EOF\n`,
      );
      mkdirSync(path.join(prefix, "proc", String(holder.pid)), { recursive: true });
      writeFileSync(path.join(prefix, "proc", String(holder.pid), "comm"), "unattended-upgr\n");

      return () => {
        writeFileSync(path.join(prefix, "proc/locks"), "");
        try {
          holder.stdin.end();
          holder.kill("SIGKILL");
        } catch {
          // already gone
        }
      };
    },

    destroy() {
      rmSync(base, { recursive: true, force: true });
    },
  };

  return host;
}
