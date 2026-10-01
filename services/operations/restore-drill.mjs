import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROGRAM, RESTORE_ROLE, clientArgs } from "./restore-accounts.mjs";

if (process.getuid?.() !== 0) throw new Error("restore drill must run as root");
const backupRoot = await realpath(process.env.INFRA_BACKUP_ROOT ?? "/var/lib/infra-cod-backups");
const keyPath = process.env.INFRA_BACKUP_KEY ?? "/etc/infra-cod/backup.passphrase";
const requested = process.argv[2] ?? JSON.parse(await readFile(path.join(backupRoot, "latest.json"), "utf8")).encrypted_file;
const backup = await realpath(path.resolve(backupRoot, requested));
if (!backup.startsWith(`${backupRoot}${path.sep}`)) throw new Error("backup path escapes backup root");
const staging = await mkdtemp(path.join(backupRoot, ".restore-"));
const drillDatabase = `infra_cod_restore_${randomBytes(6).toString("hex")}`;

const postgresBin = process.env.INFRA_POSTGRES_BIN ?? "";
const restoreHost = process.env.INFRA_RESTORE_PGHOST ?? "";
const restorePort = process.env.INFRA_RESTORE_PGPORT ?? "";
// `packages.postgresql-17` installs the clients outside the default PATH, so the
// unit points here. The command name still comes from the client map; only the
// directory is applied, locally, so the executable is named in one place.
const clientOptions = { binDirectory: postgresBin };
const connectionArgs = () => [
  ...(restoreHost ? ["-h", restoreHost] : []),
  ...(restorePort ? ["-p", restorePort] : []),
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}
function runWithInputFile(command, args, file) {
  const fd = openSync(file, "r");
  try {
    const result = spawnSync(command, args, { encoding: "utf8", stdio: [fd, "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout.trim();
  } finally {
    closeSync(fd);
  }
}
async function sha256(file) { return createHash("sha256").update(await readFile(file)).digest("hex"); }

let databaseCreated = false;
try {
  const gpgHome = path.join(staging, "gnupg");
  await mkdir(gpgHome, { mode: 0o700 });
  const bundle = path.join(staging, "bundle.tar");
  run("gpg", ["--homedir", gpgHome, "--batch", "--yes", "--pinentry-mode", "loopback",
    "--passphrase-file", keyPath, "--decrypt", "--output", bundle, backup]);
  run("tar", ["-C", staging, "-xf", bundle]);
  const manifest = JSON.parse(await readFile(path.join(staging, "manifest.json"), "utf8"));
  if (![1, 2].includes(manifest.format)) throw new Error("unsupported backup manifest format");
  for (const [name, expected] of Object.entries(manifest.components)) {
    const file = path.join(staging, name);
    if (await sha256(file) !== expected.sha256 || (await stat(file)).size !== expected.bytes) {
      throw new Error(`backup component integrity failed: ${name}`);
    }
  }
  const extracted = path.join(staging, "filesystem");
  await mkdir(extracted, { mode: 0o700 });
  run("tar", ["--no-same-owner", "-C", extracted, "-xzf", path.join(staging, "files.tar.gz")]);
  for (const source of manifest.sources) await stat(path.join(extracted, source));

  const targetVersion = Number(run("runuser", clientArgs("versionQuery", [
    PROGRAM, ...connectionArgs(), "-X", "-qAt", "-d", "postgres", "-c", "SHOW server_version_num;",
  ], clientOptions)));
  const sourceVersion = Number(manifest.database_state.server_version_num ?? 0);
  if (sourceVersion && Math.trunc(targetVersion / 10_000) < Math.trunc(sourceVersion / 10_000)) {
    throw new Error(`restore target PostgreSQL ${targetVersion} is older than backup source ${sourceVersion}`);
  }
  run("runuser", clientArgs("createDatabase", [
    PROGRAM, ...connectionArgs(), "-O", RESTORE_ROLE, drillDatabase,
  ], clientOptions));
  databaseCreated = true;
  run("runuser", clientArgs("createExtensions", [
    PROGRAM, ...connectionArgs(), "-X", "-v", "ON_ERROR_STOP=1", "-d", drillDatabase, "-c",
    `CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION ${RESTORE_ROLE};
     CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;`,
  ], clientOptions));
  runWithInputFile("runuser", clientArgs("restoreDump", [
    PROGRAM, ...connectionArgs(), "--exit-on-error", "--no-owner", "--no-privileges",
    "-d", drillDatabase,
  ], clientOptions), path.join(staging, "control-plane.dump"));
  const restored = JSON.parse(run("runuser", clientArgs("verificationRead", [
    PROGRAM, ...connectionArgs(), "-X", "-qAt", "-d", drillDatabase, "-c",
    `SELECT jsonb_build_object(
      'server_version_num',current_setting('server_version_num')::integer,
      'schema_migrations',(SELECT count(*) FROM control_plane.schema_migrations),
      'projects',(SELECT count(*) FROM control_plane.projects),
      'tasks',(SELECT count(*) FROM control_plane.tasks),
      'events',(SELECT count(*) FROM control_plane.domain_events),
      'runs',(SELECT count(*) FROM control_plane.task_runs),
      'duplicate_event_versions',(SELECT count(*) FROM (
        SELECT 1 FROM control_plane.domain_events
        GROUP BY aggregate_type,aggregate_id,aggregate_version HAVING count(*)>1) d),
      'concurrent_held_locks',(SELECT count(*) FROM (
        SELECT project_id FROM control_plane.workspace_locks
        WHERE status='held' GROUP BY project_id HAVING count(*)>1) l)
    )::text;`,
  ], clientOptions)));
  for (const field of ["schema_migrations", "projects", "tasks", "events", "runs"]) {
    if (restored[field] !== manifest.database_state[field]) throw new Error(`restored ${field} count differs from backup manifest`);
  }
  if (restored.duplicate_event_versions !== 0 || restored.concurrent_held_locks !== 0) throw new Error("restored database invariants failed");
  const receipt = { type: "restore_drill.completed", backup: path.basename(backup), backup_id: manifest.backup_id,
    tested_at: new Date().toISOString(), restored, filesystem_sources: manifest.sources.length };
  await writeFile(`${backup}.restore.json`, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await chmod(`${backup}.restore.json`, 0o600);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  if (databaseCreated) run("runuser", clientArgs("dropDatabase", [
    PROGRAM, ...connectionArgs(), "--if-exists", drillDatabase,
  ], clientOptions));
  await rm(staging, { recursive: true, force: true });
}
