// No SQL a service embeds decides on `assignment_role` (ADR-0017, amendment R4;
// sprint C, C0).
//
// `db/tests/0051` proves it for the functions in the database: nothing but the
// trigger that keeps the projection names the word. The database cannot see the
// SQL the services write into their own queries, and that is where the last
// decision lived — the supervisor's validateExecutorLaunch joined the executor
// assignment on `assignment_role='executor'` after every function had moved to
// `role_holds(pa.role_definition_id,'implementation.execute')`. A custom
// definition that holds the permission would have been launched by the
// database and refused by the supervisor.
//
// The rule this test keeps:
//
//   * services/**/*.mjs outside a test directory: the word does not appear.
//     Product code asks permissions (`role_holds`, `agent_holds`); there is no
//     display there to read the projection for.
//   * test fixtures may write the word, as an older writer would — the trigger
//     of 0079 maps it to the built-in, and 0051 relies on the same path.
//   * apps/web/src: the panel decides nothing (every decision is a database
//     function, and the interface is not a security boundary), and the
//     projection exists for the roster it displays. The word may appear only in
//     the read model, product-data.ts, and in no action, route or component —
//     so a read can never become a check.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const WORD = /(^|[^_a-z])assignment_role/;

function walk(directory, keep) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, keep));
    else if (keep(entry.name)) files.push(full);
  }
  return files;
}

function linesNaming(file) {
  return readFileSync(file, "utf8").split("\n")
    .map((line, index) => (WORD.test(line) ? `${path.relative(root, file)}:${index + 1}` : null))
    .filter(Boolean);
}

test("no service's embedded SQL names assignment_role", () => {
  const sources = walk(path.join(root, "services"), (name) => name.endsWith(".mjs"))
    .filter((file) => !file.split(path.sep).includes("test"));
  assert.ok(sources.length > 20, `expected the services' sources, found ${sources.length}`);
  const offenders = sources.flatMap(linesNaming);
  assert.deepEqual(offenders, [],
    "these decide on the definition's projection; ask role_holds(pa.role_definition_id, <permission>) instead");
});

test("the panel reads the projection only in its read model", () => {
  const sources = walk(path.join(root, "apps/web/src"), (name) => /\.(ts|tsx)$/.test(name));
  assert.ok(sources.length > 10, `expected the panel's sources, found ${sources.length}`);
  const offenders = sources
    .filter((file) => path.relative(root, file) !== path.join("apps/web/src/lib/product-data.ts"))
    .flatMap(linesNaming);
  assert.deepEqual(offenders, [],
    "the word belongs to the roster's read model; an action or route that names it is deciding on a projection");
});

test("the supervisor launches an executor by the permission its definition holds", () => {
  // The defect this file exists for, pinned by name: the launch validation asks
  // for implementation.execute, and the two-word vocabulary is gone from it.
  const source = readFileSync(path.join(root, "services/runtime-supervisor/server.mjs"), "utf8");
  const start = source.indexOf("async function validateExecutorLaunch(");
  assert.ok(start >= 0, "validateExecutorLaunch is not in server.mjs");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(body, /role_holds\(pa\.role_definition_id,'implementation\.execute'\)/);
  assert.doesNotMatch(body, /'executor'/);
});
