import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Do the queries the services ship actually name columns that exist?
//
// `validateOpenCodeLaunch` read `lm.model`, `lm.snapshot_authorized` and
// `lm.snapshot_mismatch` off `resolve_executor_launch_model(j.id)`, which returns
// jsonb — so those are keys, not columns, and the statement failed to parse.
// Every implementation run died on it: the job retried twice, dead-lettered, and
// the workspace lease then expired, so what reached the operator was
// `run.lost: workspace_lease_expired` with nothing about a column. No executor
// had ever launched through that path.
//
// Nothing caught it because nothing ran it. The unit suites have no database, and
// the integration suites exercise the functions rather than the workers' own SQL.
//
// The check is cheap because PostgreSQL resolves column references when it parses
// a statement, before it looks at a single row. A query with a condition that
// matches nothing still fails on a column that does not exist — so this needs no
// fixtures, no rows and no runtime state: it asks the server to plan each
// statement and reports the ones it will not.
//
// Parameters are replaced with typed NULLs. `EXPLAIN` then plans a statement that
// selects nothing, which is exactly the part being checked.

const databaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";
let hasPsql = false;
try {
  execFileSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" });
  hasPsql = true;
} catch {}

const servicesRoot = path.resolve(import.meta.dirname, "../..");

// Template literals handed to the query helpers. Only those: a string that is not
// given to the database is not a statement this test has an opinion about.
function extractQueries(source) {
  // Scanned by position rather than with one global regular expression. A global
  // match consumes as it goes, so a template literal elsewhere in the file moves
  // `lastIndex` past the next call — which is how the first version of this test
  // extracted 26 queries from `server.mjs` and silently skipped the one that was
  // broken. Verified by reintroducing the defect: this finds it, that did not.
  const found = [];
  const call = /\b(?:queryJson|queryJsonRows|executeJson|psql)\(/g;
  for (const match of source.matchAll(call)) {
    const open = source.indexOf("`", match.index + match[0].length);
    if (open === -1) continue;
    // Only whitespace may sit between the parenthesis and the literal; anything
    // else means this call was handed a variable, and there is nothing to read.
    if (/[^\s]/.test(source.slice(match.index + match[0].length, open))) continue;
    const close = source.indexOf("`", open + 1);
    if (close === -1) continue;
    found.push(source.slice(open + 1, close));
  }
  return found;
}

// `:'name'::type` becomes `NULL::type`; a bare `:'name'` becomes NULL. The types
// stay, because a cast is part of what the planner checks.
function withNullParameters(sql) {
  return sql
    .replace(/:'[a-z_0-9]+'\s*::\s*([a-z_]+(?:\s*\[\s*\])?)/gi, "NULL::$1")
    .replace(/:'[a-z_0-9]+'/g, "NULL");
}

function sourceFiles() {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "test" || entry.name === "node_modules") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mjs")) files.push(full);
    }
  };
  walk(servicesRoot);
  return files;
}

test("every shipped query plans against the real schema", { skip: !databaseUrl || !hasPsql ? "DATABASE_URL or psql unavailable" : false }, () => {
  const failures = [];
  let planned = 0;

  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const raw of extractQueries(source)) {
      const sql = withNullParameters(raw).trim();
      // Statements this cannot plan meaningfully: anything still carrying a
      // placeholder, and DDL or transaction control, which is not this test's
      // subject.
      if (/:'/.test(sql)) continue;
      if (!/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(sql)) continue;
      if (/\b(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) continue;

      const statements = sql.split(/;\s*(?=SELECT|WITH|INSERT|UPDATE|DELETE)/i);
      for (const statement of statements) {
        const text = statement.replace(/;\s*$/, "").trim();
        if (text.length === 0) continue;
        planned += 1;
        const result = spawnSync(psqlBin, [
          databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
          "-c", `SET search_path TO control_plane,public,extensions; EXPLAIN ${text}`,
        ], { encoding: "utf8", timeout: 20_000 });
        if (result.status !== 0) {
          const reason = (result.stderr ?? "").split("\n").find((line) => line.startsWith("ERROR:")) ?? "unknown";
          // A statement can fail to plan for reasons that are not defects — a
          // NULL where the planner wants a literal, for instance. Column and
          // relation resolution is what this test is about, and those say so by
          // name.
          if (/does not exist|has no column|missing FROM-clause/i.test(reason)) {
            failures.push(`${path.relative(servicesRoot, file)}: ${reason}`);
          }
        }
      }
    }
  }

  assert.ok(planned > 20, `expected to plan many shipped statements, planned ${planned}`);
  assert.deepEqual(
    [...new Set(failures)].sort(),
    [],
    "these shipped statements name something the schema does not have, and fail when the code path is first taken",
  );
});
