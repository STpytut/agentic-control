// Which runtime work blocks a workspace operation is decided twice: when the
// panel requests it (request_workspace_operation) and when the supervisor
// performs it (manageWorkspace). rc.28 changed the first and not the second, so
// a recovery the request admitted failed as "workspace operation authorization
// failed". This keeps the two predicates the same text.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");

// The blocking condition, from `(j.status='in_flight'` to its closing parenthesis.
function predicate(text, operand) {
  const start = text.indexOf("(j.status='in_flight'");
  assert.ok(start >= 0, "no blocking predicate found");
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    if (text[i] === ")") depth -= 1;
    if (depth === 0) {
      return text.slice(start, i + 1).replace(/\s+/g, " ").replace(operand, "OPERATION");
    }
  }
  throw new Error("unbalanced predicate");
}

test("the supervisor refuses a workspace operation on exactly the work the request refuses it on", () => {
  const migrations = readdirSync(path.join(ROOT, "db/migrations")).sort();
  const latest = migrations.filter((name) => readFileSync(path.join(ROOT, "db/migrations", name), "utf8")
    .includes("CREATE OR REPLACE FUNCTION request_workspace_operation(")).pop();
  // From the function's own definition: a migration that redefines several
  // functions (0073) has other blocking predicates before this one.
  const migration = readFileSync(path.join(ROOT, "db/migrations", latest), "utf8");
  const request = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION request_workspace_operation("));
  const server = readFileSync(path.join(ROOT, "services/runtime-supervisor/server.mjs"), "utf8");
  const body = server.slice(server.indexOf("async function manageWorkspace("));
  assert.equal(
    predicate(body, "op.operation_type"),
    predicate(request, "p_operation_type"),
    `server.mjs manageWorkspace and ${latest} disagree on what blocks a workspace operation`,
  );
});
