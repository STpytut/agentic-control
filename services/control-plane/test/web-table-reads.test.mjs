// Every table the panel's SQL reads is readable by infra_web.
//
// The web tier runs its queries as infra_web, which reads each table by an
// explicit grant. rc.56 shipped a card reading publish_preparations and
// publish_intents without one, and every project page with an active task
// failed on the host with "permission denied" — nothing in the gate ran the
// panel's SQL as that role. This reads the SQL out of the web tier's sources,
// takes every relation it names after FROM or JOIN that exists in the schema,
// and asks the database whether infra_web can read it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const adminDatabaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";
let hasPsql = false;
try { hasPsql = spawnSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" }).status === 0; } catch {}
const skip = !adminDatabaseUrl ? "DATABASE_URL is not set" : !hasPsql ? "psql is not available" : false;
const root = path.resolve(import.meta.dirname, "../../..");

function adminUrl(database) {
  const parsed = new URL(adminDatabaseUrl);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function psql(sql, target) {
  const result = spawnSync(psqlBin, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", target], { encoding: "utf8", input: sql });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `psql exited ${result.status}`);
  return result.stdout.trim();
}

function webSources(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...webSources(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

export function relationsNamed(source) {
  const names = new Set();
  for (const match of source.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\b(?!\s*\()/g)) names.add(match[1]);
  return names;
}

test("the panel's SQL reads only tables infra_web can read", { skip }, () => {
  const named = new Map();
  for (const file of webSources(path.join(root, "apps/web/src"))) {
    for (const name of relationsNamed(readFileSync(file, "utf8"))) {
      if (!named.has(name)) named.set(name, path.relative(root, file));
    }
  }
  const scratch = `infra_cod_webreads_${randomUUID().slice(0, 8)}`;
  psql(`CREATE DATABASE ${scratch};`, adminUrl("postgres"));
  try {
    const url = adminUrl(scratch);
    const migrate = spawnSync(process.execPath, [path.join(root, "services/control-plane/migrate.mjs")], {
      encoding: "utf8", env: { ...process.env, DATABASE_URL: url },
    });
    if (migrate.status !== 0) throw new Error(`migrate failed: ${migrate.stderr}`);
    const list = [...named.keys()].map((name) => `('${name}')`).join(",");
    const unreadable = psql(`SELECT string_agg(n.name, ',' ORDER BY n.name) FROM (VALUES ${list}) n(name)
      JOIN pg_class c ON c.relname=n.name AND c.relnamespace='control_plane'::regnamespace AND c.relkind IN ('r','v','m','p')
      WHERE NOT has_any_column_privilege('infra_web', c.oid, 'SELECT');`, url);
    const missing = unreadable ? unreadable.split(",").map((name) => `${name} (${named.get(name)})`) : [];
    assert.deepEqual(missing, [], `the panel reads tables infra_web cannot: ${missing.join(", ")}`);
  } finally {
    spawnSync(psqlBin, ["-X", "-qAt", adminUrl("postgres")], { encoding: "utf8", input: `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE);` });
  }
});
