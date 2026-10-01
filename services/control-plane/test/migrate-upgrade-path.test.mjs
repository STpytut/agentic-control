import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";

// The install and upgrade paths of the migration runner.
//
// Supabase used to be one of them: `supabase db reset` wrote the schema with an
// empty application ledger, and the runner imported a baseline from Supabase's
// own ledger to avoid reapplying 0001. Supabase is gone (0044) and so is that
// import — there is no longer any ledger to trust. What is pinned here instead
// is that a clean database is migrated exactly once and that a schema the runner
// did not build is refused rather than guessed at.
//
// Skipped only when psql or a superuser connection is genuinely unavailable.

const databaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";
let hasPsql = false;
try {
  execFileSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" });
  hasPsql = true;
} catch {}

const skip = !databaseUrl ? "DATABASE_URL is not set" : !hasPsql ? "psql is not available" : false;

const root = path.resolve(import.meta.dirname, "../../..");
const migrationsDir = path.join(root, "db/migrations");
const migrations = readdirSync(migrationsDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function adminUrl(database) {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function run(url, sql, { file } = {}) {
  const args = ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", url];
  if (file) args.push("-f", file);
  const result = spawnSync(psqlBin, args, { encoding: "utf8", input: file ? undefined : sql });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `psql exited ${result.status}`);
  return result.stdout.trim();
}

function migrate(url) {
  const result = spawnSync(process.execPath, [path.join(root, "services/control-plane/migrate.mjs")], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url },
  });
  return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}

function scratchUrl(prefix) {
  const database = `infra_cod_${prefix}_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  run(adminUrl("postgres"), `CREATE DATABASE ${database};`);
  return { database, url: adminUrl(database) };
}

function drop(database) {
  run(adminUrl("postgres"), `DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
}

test("a fresh database installs every migration exactly once", { skip }, async () => {
  const { database, url } = scratchUrl("install");
  try {
    const first = migrate(url);
    assert.equal(first.code, 0, `migrate failed: ${first.err}`);
    assert.match(first.out, /"status":"current"/);
    // No Supabase baseline step survives anywhere in the runner.
    assert.doesNotMatch(first.out, /baseline_imported/);

    assert.equal(
      run(url, "SELECT count(*) FROM control_plane.schema_migrations;"),
      String(migrations.length),
      "the ledger does not cover every migration",
    );
    // The last migration is the one that removes the Supabase identity column.
    assert.equal(
      run(url, `SELECT count(*) FROM information_schema.columns
                WHERE table_schema='control_plane' AND table_name='users'
                  AND column_name='auth_user_id';`),
      "0",
      "users.auth_user_id survived a fresh install",
    );

    const again = migrate(url);
    assert.equal(again.code, 0, `re-running migrate failed: ${again.err}`);
    assert.equal(
      run(url, "SELECT count(*) FROM control_plane.schema_migrations;"),
      String(migrations.length),
      "a second run changed the ledger",
    );
  } finally {
    drop(database);
  }
});

test("a pre-existing schema without a ledger is refused", { skip }, async () => {
  // Both branches of the old baseline logic ended here. Without a trustworthy
  // ledger the runner must stop: reapplying 0001 would fail against the existing
  // schema, and stamping it would record a migration that never ran.
  const { database, url } = scratchUrl("nobase");
  try {
    run(url, `CREATE SCHEMA control_plane; CREATE TABLE control_plane.users(id uuid PRIMARY KEY);`);

    const result = migrate(url);
    assert.notEqual(result.code, 0, "migrate should refuse a schema it did not build");
    assert.match(result.err, /not built by this migrator/);

    // Nothing was written on the way out.
    assert.equal(
      run(url, `SELECT count(*) FROM information_schema.tables
                WHERE table_schema='control_plane' AND table_name='schema_migrations';`),
      "0",
      "the refused run created a ledger",
    );
  } finally {
    drop(database);
  }
});

test("an empty ledger beside an existing schema is refused too", { skip }, async () => {
  const { database, url } = scratchUrl("emptyledger");
  try {
    run(url, `CREATE SCHEMA control_plane;
      CREATE TABLE control_plane.users(id uuid PRIMARY KEY);
      CREATE TABLE control_plane.schema_migrations(
        version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now());`);

    const result = migrate(url);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /not built by this migrator/);
    assert.equal(run(url, "SELECT count(*) FROM control_plane.schema_migrations;"), "0");
  } finally {
    drop(database);
  }
});
