import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { transactionControlStatement } from "./sql-scan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = path.join(root, "db/migrations");
const files = readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

// Migrations 0001-0038 open and close their own transaction, so the runner
// cannot wrap them: their COMMIT would end any outer transaction early. Their
// checksums are recorded in deployed ledgers, so rewriting them is not an
// option either. From 0039 the convention inverts — a migration contains no
// BEGIN/COMMIT and the runner owns the transaction, which is what makes
// apply + verify + stamp atomic. LEGACY_SELF_MANAGED_THROUGH is the boundary.
const LEGACY_SELF_MANAGED_THROUGH = 38;

function psql(sql, { file, singleTransaction = false } = {}) {
  const args = ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
  if (singleTransaction) args.push("--single-transaction");
  if (process.env.DATABASE_URL) args.push(process.env.DATABASE_URL);
  if (file) args.push("-f", file);
  const result = spawnSync("psql", args, { encoding: "utf8", input: file ? undefined : sql });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `psql exited ${result.status}`);
  return result.stdout.trim();
}

function migration(name) {
  const file = path.join(directory, name);
  const contents = readFileSync(file);
  const text = contents.toString("utf8");
  return {
    version: name.slice(0, 4), name, file,
    checksum: createHash("sha256").update(contents).digest("hex"),
    // Any transaction-control statement, not just BEGIN: a bare COMMIT, END,
    // ROLLBACK or SAVEPOINT would also break the runner's wrapper.
    transactionControl: transactionControlStatement(text),
    text,
  };
}

const migrations = files.map(migration);

for (const item of migrations) {
  const legacy = Number(item.version) <= LEGACY_SELF_MANAGED_THROUGH;
  if (!legacy && item.transactionControl) {
    throw new Error(
      `${item.name} runs ${item.transactionControl}. Migrations after ` +
      `${String(LEGACY_SELF_MANAGED_THROUGH).padStart(4, "0")} must contain no transaction-control ` +
      "statements so the runner can apply, verify and record them in one transaction.",
    );
  }
}

function ledgerExists() {
  return psql("SELECT to_regclass('control_plane.schema_migrations') IS NOT NULL;") === "t";
}

function ledgerRows() {
  const rows = psql("SELECT version||'|'||checksum FROM control_plane.schema_migrations ORDER BY version;");
  return new Map(rows.split("\n").filter(Boolean).map((line) => line.split("|")));
}

function stampStatement(item) {
  return "INSERT INTO control_plane.schema_migrations(version,name,checksum) VALUES ("
    + `'${item.version}','${item.name}','${item.checksum}');`;
}

// PostgreSQL grants EXECUTE on every new function to PUBLIC. 0038 removes that
// default globally; this catches what the default cannot — a migration that
// grants PUBLIC explicitly. The function only exists from 0038 onwards, so
// earlier files are checked as soon as it does.
const ASSERT_SQL = "SELECT control_plane.assert_no_public_function_execute();";

function assertionAvailable() {
  return psql("SELECT to_regprocedure('control_plane.assert_no_public_function_execute()') IS NOT NULL;") === "t";
}

function assertNoPublicExecute(label) {
  if (!assertionAvailable()) return;
  try {
    psql(ASSERT_SQL);
  } catch (error) {
    throw new Error(`${label} leaves functions executable by PUBLIC: ${error.message}`);
  }
}

// Every function the web role can execute must run as its owner: infra_web has no
// DML, so a web-facing function running as its caller fails on its first write.
// CREATE OR REPLACE FUNCTION resets SECURITY DEFINER unless the statement repeats
// it, and that is how 0058 broke "Request changes" and 0061 broke answering an
// implementation's question — silently, because a test listed five functions by
// name and neither was among them. Checked after every migration from 0062, where
// the assertion is created, in the same transaction as the migration.
const DEFINER_SQL = "SELECT control_plane.assert_web_functions_run_as_definer();";

function definerAssertionAvailable() {
  return psql("SELECT to_regprocedure('control_plane.assert_web_functions_run_as_definer()') IS NOT NULL;") === "t";
}

function assertWebDefiners(label) {
  if (!definerAssertionAvailable()) return;
  try {
    psql(DEFINER_SQL);
  } catch (error) {
    throw new Error(`${label} leaves a web-facing function running as its caller: ${error.message}`);
  }
}

const ledgerPresent = ledgerExists();
const foundationExists = psql("SELECT to_regclass('control_plane.users') IS NOT NULL;") === "t";
const applied = ledgerPresent ? ledgerRows() : new Map();

// A schema with no ledger is not a database this runner built. It used to be
// reachable through `supabase db reset`, which applied the SQL files directly
// and wrote nothing to `control_plane.schema_migrations`; the runner imported
// the baseline from Supabase's own ledger. Supabase is gone (0044), so there is
// no longer any ledger to trust, and guessing would mean either reapplying 0001
// against tables that already exist or recording a migration that never ran.
// Both are worse than stopping.
if (applied.size === 0 && foundationExists) {
  throw new Error(
    "control_plane.users exists but control_plane.schema_migrations has no rows. "
    + "This database was not built by this migrator — its ledger is missing or empty. "
    + "Restore from a backup rather than migrating forward.",
  );
}

// Files applied before the ledger table exists (0001-0004) cannot be recorded
// yet; they are stamped as soon as 0005 creates it.
const awaitingStamp = [];

function flushStamps() {
  if (!awaitingStamp.length || !ledgerExists()) return;
  for (const item of awaitingStamp) psql(stampStatement(item));
  awaitingStamp.length = 0;
}

for (const item of migrations) {
  const recorded = applied.get(item.version);
  if (recorded && recorded !== item.checksum) {
    throw new Error(`migration checksum mismatch: ${item.name}`);
  }
  if (recorded) continue;

  if (item.transactionControl) {
    // Legacy path. The file commits itself, so a failed assertion cannot undo
    // it; the guarantee here is only that the ledger does not record it and the
    // run stops. Every one of these files is asserted clean today.
    psql(null, { file: item.file });
    assertNoPublicExecute(item.name);
    awaitingStamp.push(item);
    flushStamps();
  } else {
    // Runner-owned transaction: the DDL, the assertion and the ledger row
    // either all land or none do.
    const guards = [assertionAvailable() ? ASSERT_SQL : "", definerAssertionAvailable() ? DEFINER_SQL : ""]
      .filter(Boolean).join("\n");
    const body = `${item.text}\n${guards}\n`;
    try {
      psql(`${body}${stampStatement(item)}`, { singleTransaction: true });
    } catch (error) {
      throw new Error(`${item.name} was rolled back: ${error.message}`);
    }
  }

  applied.set(item.version, item.checksum);
}

flushStamps();
if (awaitingStamp.length) {
  throw new Error("the migration ledger was never created; 0005 did not apply");
}

// Also covers a database whose migrations were all applied by an earlier run.
assertNoPublicExecute("the applied schema");
assertWebDefiners("the applied schema");

process.stdout.write(`${JSON.stringify({ status: "current", migrations: migrations.length })}\n`);
