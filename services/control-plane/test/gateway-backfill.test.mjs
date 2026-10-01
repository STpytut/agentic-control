// The vendor, the gateway and the billing, apart (0083, Stage 11.4 A3).
//
// db/tests run on a schema past 0083, where the old boundary words cannot be
// written; what 0083 does to a host's connections, catalog and enrollments is
// shown on a database stopped at 0082 with rows in the old vocabulary — the
// shapes the host had: a Codex connection, OpenCode Free, a Go connection in
// action_required, OpenRouter, their catalog entries and a pending enrollment.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";


const adminDatabaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";
let hasPsql = false;
try { hasPsql = spawnSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" }).status === 0; } catch {}
const skip = !adminDatabaseUrl ? "DATABASE_URL is not set" : !hasPsql ? "psql is not available" : false;

const root = path.resolve(import.meta.dirname, "../../..");
const migrationsDir = path.join(root, "db/migrations");
const CONTRACT = "0083_vendor_gateway_billing.sql";
// migrate.mjs's boundary: through 0038 a file opens its own transaction.
const LEGACY_SELF_MANAGED_THROUGH = 38;
const scratches = [];

function adminUrl(database) {
  const parsed = new URL(adminDatabaseUrl);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function psql(url, sql, { file } = {}) {
  const args = ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
  if (file && Number(path.basename(file).slice(0, 4)) > LEGACY_SELF_MANAGED_THROUGH) args.push("--single-transaction");
  args.push(url);
  if (file) args.push("-f", file);
  const result = spawnSync(psqlBin, args, { encoding: "utf8", input: file ? undefined : sql });
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}
function must(url, sql) {
  const result = psql(url, `SET search_path TO control_plane,public,extensions;\n${sql}`);
  if (!result.ok) throw new Error(result.err);
  return result.out.split("\n").at(-1);
}

// A database with every migration before the contract, the way the runner
// would have left it.
function databaseBeforeContract() {
  const database = `infra_cod_a3_${randomUUID().slice(0, 8)}`;
  const created = psql(adminUrl("postgres"), `CREATE DATABASE ${database};`);
  if (!created.ok) throw new Error(created.err);
  scratches.push(database);
  const url = adminUrl(database);
  const files = readdirSync(migrationsDir).filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < CONTRACT).sort();
  for (const name of files) {
    const applied = psql(url, "", { file: path.join(migrationsDir, name) });
    if (!applied.ok) throw new Error(`${name}: ${applied.err}`);
  }
  return url;
}

const contract = (url) => psql(url, "", { file: path.join(migrationsDir, CONTRACT) });

test.after(() => {
  if (skip) return;
  for (const database of scratches) {
    psql(adminUrl("postgres"), `DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
  }
});

test("0083 moves the host's old words to a gateway and a billing, and reads the vendor off the id", { skip }, () => {
  const url = databaseBeforeContract();
  must(url, `DO $$ DECLARE u uuid; c_codex uuid; c_free uuid; c_go uuid; c_or uuid; BEGIN
    INSERT INTO users(display_name) VALUES('a3') RETURNING id INTO u;
    INSERT INTO provider_connections(operator_id,provider,auth_method,status) VALUES(u,'codex','device_code','connected') RETURNING id INTO c_codex;
    INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,native_credential_reference)
      VALUES(u,'opencode','native','connected','free','opencode-home:opencode-worker') RETURNING id INTO c_free;
    INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,native_credential_reference)
      VALUES(u,'opencode','api_key','action_required','go','opencode-home:opencode-worker') RETURNING id INTO c_go;
    INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,native_credential_reference)
      VALUES(u,'opencode','api_key','connected','external_api','opencode-home:opencode-worker') RETURNING id INTO c_or;
    INSERT INTO provider_model_catalog(operator_id,connection_id,billing_boundary,runtime_type,provider_id,model_id,discovery_source) VALUES
      (u,c_codex,'chatgpt_subscription','codex','chatgpt','gpt-5.5','codex_model_list'),
      (u,c_free,'free','opencode','opencode','big-pickle','opencode_provider_api'),
      (u,c_or,'external_api','opencode','openrouter','openai/gpt-6-luna','opencode_provider_api');
    INSERT INTO provider_secret_enrollments(operator_id,provider,billing_boundary,connection_id,state_digest)
      VALUES(u,'opencode','external_api',c_or,repeat('a',64));
  END $$;`);

  const applied = contract(url);
  assert.ok(applied.ok, applied.err);

  assert.equal(must(url, `SELECT string_agg(provider||':'||billing_boundary||':'||access_gateway, ',' ORDER BY provider, access_gateway)
    FROM provider_connections;`),
    "codex:subscription:openai_chatgpt,opencode:subscription:opencode_go,opencode:free:opencode_zen,opencode:third_party_metered:openrouter");
  assert.equal(must(url, `SELECT string_agg(model_id||':'||billing_boundary||':'||access_gateway||':'||model_vendor, ',' ORDER BY model_id)
    FROM provider_model_catalog;`),
    "big-pickle:free:opencode_zen:,gpt-5.5:subscription:openai_chatgpt:openai,openai/gpt-6-luna:third_party_metered:openrouter:openai");
  assert.equal(must(url, `SELECT string_agg(access_gateway, ',') FROM provider_secret_enrollments;`), "openrouter");
  // The old words cannot come back.
  const written = psql(url, `SET search_path TO control_plane,public,extensions;
    UPDATE provider_model_catalog SET billing_boundary='chatgpt_subscription' WHERE model_id='gpt-5.5';`);
  assert.ok(!written.ok);
  assert.match(written.err, /provider_model_catalog_billing_boundary_check/);
});
