// Runs the SQL test files against DATABASE_URL.
//
// Exists so the whole database suite is one command that works on a fresh
// checkout: it loads .env.local itself, refuses to run without a database
// instead of silently passing, and stops at the first failing file rather than
// reporting a count that hides which one broke.
//
// `node --env-file` would do the loading for a Node program, and this is one, so
// the flag is not needed — but the psql scripts in package.json are not, which is
// why they all route through here too.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testDirectory = path.join(root, "db/tests");
const psqlBin = process.env.PSQL_BIN ?? "psql";

// Same precedence as `node --env-file`: a value that is already in the
// environment wins, so CI and systemd are never overridden by a local file.
for (const name of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.join(root, name));
  } catch {
    // Optional. A missing file is the normal case in production and CI.
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write(
    "DATABASE_URL is not set. Point it at a disposable database (the SQL tests\n"
    + "run inside BEGIN/ROLLBACK, but the integration tests do not) or create\n"
    + ".env.local from .env.example.\n",
  );
  process.exit(2);
}

const requested = process.argv.slice(2);
const files = requested.length
  ? requested.map((name) => path.resolve(root, name))
  : readdirSync(testDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name) => path.join(testDirectory, name));

let passed = 0;
for (const file of files) {
  const label = path.relative(root, file);
  const result = spawnSync(
    psqlBin,
    ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", databaseUrl, "-f", file],
    { encoding: "utf8" },
  );
  process.stdout.write(result.stdout ?? "");
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.stderr.write(`\n${label} FAILED (${passed} file(s) passed before it)\n`);
    process.exit(1);
  }
  // psql writes NOTICEs to stderr even on success; they are the assertions'
  // own "passed" lines, so they belong in the output.
  process.stderr.write(result.stderr ?? "");
  passed += 1;
}

process.stdout.write(`${JSON.stringify({ status: "ok", files: passed })}\n`);
