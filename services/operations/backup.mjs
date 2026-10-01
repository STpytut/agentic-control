import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { INSTALLATION_LAYOUT } from "./installation-layout.mjs";
import { allAdapters } from "./runtime-adapters.mjs";
import { archiveOutcome } from "./backup-tar.mjs";
import { backupsToPrune } from "./retention.mjs";

if (process.getuid?.() !== 0) throw new Error("backup must run as root");

const backupRoot = process.env.INFRA_BACKUP_ROOT ?? "/var/lib/infra-cod-backups";
const keyPath = process.env.INFRA_BACKUP_KEY ?? "/etc/infra-cod/backup.passphrase";
const database = process.env.DATABASE_URL ?? process.env.CONTROL_PLANE_DB ?? "infra_cod";
const retentionDays = Number(process.env.INFRA_BACKUP_RETENTION_DAYS ?? 14);
// Besides the age limit, a count: every update takes a backup, and on rc.120 a
// fortnight of updates had filled the disk with them (retention.mjs).
const keepBackups = Number(process.env.INFRA_BACKUP_KEEP ?? 20);
const postgresBin = process.env.INFRA_POSTGRES_BIN ?? "";
// Every workspace, and each runtime's credentials and native session state —
// from the layout and the registry, so a moved home is a moved backup.
const sources = (process.env.INFRA_BACKUP_PATHS ?? [
  INSTALLATION_LAYOUT.workspaceRoot.path,
  ...allAdapters().flatMap((adapter) => adapter.backup),
].join(":" )).split(":").filter(Boolean);

function connection(value) {
  if (!/^postgres(ql)?:\/\//.test(value)) return { target: value, environment: process.env };
  const url = new URL(value);
  const password = decodeURIComponent(url.password);
  url.password = "";
  return { target: url.toString(), environment: { ...process.env, PGPASSWORD: password, HOME: "/var/lib/infra-control" } };
}
const databaseConnection = connection(database);
const postgresCommand = (name) => postgresBin ? path.join(postgresBin, name) : name;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: databaseConnection.environment, ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function runToFile(command, args, file) {
  const fd = openSync(file, "w", 0o600);
  try {
    const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", fd, "pipe"], env: databaseConnection.environment });
    if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.trim()}`);
  } finally {
    closeSync(fd);
  }
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

const key = await stat(keyPath);
if (!key.isFile() || (key.mode & 0o077) !== 0) throw new Error("backup key must be a regular 0600 file");
if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error("backup retention is invalid");
if (!Number.isInteger(keepBackups) || keepBackups < 1) throw new Error("backup count limit is invalid");
await mkdir(backupRoot, { recursive: true, mode: 0o700 });
await chmod(backupRoot, 0o700);
const staging = await mkdtemp(path.join(backupRoot, ".staging-"));
// root:root 0700. Every step of the backup runs in this process now, so no
// second account needs to read the staging area; the group-sharing variant only
// existed for the `runuser -u infra-control` database client.
await chown(staging, 0, 0);
await chmod(staging, 0o700);
const stamp = new Date().toISOString().replaceAll(":", "-");
const finalName = `infra-cod-${stamp}.tar.gpg`;
const finalPath = path.join(backupRoot, finalName);

try {
  const dump = path.join(staging, "control-plane.dump");
  // The database client runs as this process, which is root, and reaches
  // PostgreSQL as `infra_backup` through the peer map. It deliberately does NOT
  // drop to `infra-control`: the peer map is 1:1 per OS user, so mapping that
  // account to a second role would hand an unprivileged worker the backup role
  // and make the separation decorative.
  //
  // Read-only filesystem access is unaffected. Root can read the workspace and
  // runtime directories it must archive, and with `ProtectSystem=strict` it can
  // write only inside the backup root.
  runToFile(postgresCommand("pg_dump"), [
    "-Fc", "--schema=control_plane", "-d", databaseConnection.target,
  ], dump);

  const archive = path.join(staging, "files.tar.gz");
  const existingSources = [];
  for (const source of sources) {
    if ((await lstat(source).catch(() => null))?.isDirectory()) existingSources.push(source.replace(/^\/+/, ""));
  }
  if (existingSources.length === 0) throw new Error("no backup filesystem sources exist");
  // Live directories: a file a runtime writes while it is read is a warning,
  // not a failed backup (backup-tar.mjs); the manifest names each one.
  const archived = archiveOutcome(spawnSync("tar", ["-C", "/", "-czf", archive, ...existingSources],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));

  const databaseState = JSON.parse(run(postgresCommand("psql"), [
    "-X", "-qAt", "-d", databaseConnection.target, "-c",
    `SELECT jsonb_build_object(
      'server_version_num',current_setting('server_version_num')::integer,
      'schema_migrations',(SELECT count(*) FROM control_plane.schema_migrations),
      'projects',(SELECT count(*) FROM control_plane.projects),
      'tasks',(SELECT count(*) FROM control_plane.tasks),
      'events',(SELECT count(*) FROM control_plane.domain_events),
      'runs',(SELECT count(*) FROM control_plane.task_runs)
    )::text;`,
  ]));
  const manifest = {
    format: 2, backup_id: randomUUID(), created_at: new Date().toISOString(), database: databaseConnection.target,
    postgres_client: run(postgresCommand("pg_dump"), ["--version"]),
    sources: existingSources, database_state: databaseState,
    ...(archived.warned.length ? { changed_while_read: archived.warned } : {}),
    components: {
      "control-plane.dump": { sha256: await sha256(dump), bytes: (await stat(dump)).size },
      "files.tar.gz": { sha256: await sha256(archive), bytes: (await stat(archive)).size },
    },
  };
  await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const bundle = path.join(staging, "bundle.tar");
  run("tar", ["-C", staging, "-cf", bundle, "control-plane.dump", "files.tar.gz", "manifest.json"]);
  const gpgHome = path.join(staging, "gnupg");
  await mkdir(gpgHome, { mode: 0o700 });
  const encryptedTemp = path.join(backupRoot, `.${finalName}.tmp`);
  run("gpg", ["--homedir", gpgHome, "--batch", "--yes", "--pinentry-mode", "loopback",
    "--passphrase-file", keyPath, "--symmetric", "--cipher-algo", "AES256", "--output", encryptedTemp, bundle]);
  await chmod(encryptedTemp, 0o600);
  await rename(encryptedTemp, finalPath);
  const receipt = { ...manifest, encrypted_file: finalName, encrypted_sha256: await sha256(finalPath), encrypted_bytes: (await stat(finalPath)).size };
  const receiptPath = `${finalPath}.json`;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rm(path.join(backupRoot, "latest.json"), { force: true });
  await copyFile(receiptPath, path.join(backupRoot, "latest.json"));
  await chmod(path.join(backupRoot, "latest.json"), 0o600);

  const prune = backupsToPrune(await readdir(backupRoot), { now: Date.now(), retentionDays, keep: keepBackups });
  for (const name of prune) {
    for (const file of [name, `${name}.json`, `${name}.restore.json`]) await rm(path.join(backupRoot, file), { force: true });
  }
  process.stdout.write(`${JSON.stringify({ type: "backup.completed", ...receipt })}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
