import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";

// Concurrent claims of the model check lane (Stage 12 W6, migration 0100):
// the host runs one check at a time, so claims racing each other — a check
// worker and one a restart left behind — hand out one check between them,
// never two. The lane's advisory
// lock is what serialises them. Skipped only when DATABASE_URL or psql is
// genuinely unavailable.

const databaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";
let hasPsql = false;
try {
  execFileSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" });
  hasPsql = true;
} catch {}

function runPsql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(psqlBin, [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `psql exited ${code}`)));
  });
}

test("parallel claims of the check lane never run two checks at once", { skip: !databaseUrl || !hasPsql }, async () => {
  await runPsql(`
    SET search_path TO control_plane,public,extensions;
    BEGIN;
    -- Whatever another suite left queued is not this test's.
    DELETE FROM model_checks WHERE finished_at IS NULL;
    DO \$\$
    DECLARE v_owner uuid; v_conn uuid; v_id uuid; v_name text;
    BEGIN
      INSERT INTO users(display_name) VALUES('Quota race owner') RETURNING id INTO v_owner;
      INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,native_credential_reference)
      VALUES(v_owner,'opencode','native','connected','free','opencode-home:opencode-worker') RETURNING id INTO v_conn;
      FOR v_name IN SELECT unnest(ARRAY['race-model-1','race-model-2','race-model-3','race-model-4']) LOOP
        INSERT INTO provider_model_catalog(operator_id,connection_id,billing_boundary,runtime_type,provider_id,model_id,discovery_source,status)
        VALUES(v_owner,v_conn,'free','opencode','opencode',v_name,'opencode_provider_api','discovered')
        RETURNING id INTO v_id;
        PERFORM request_model_check(v_owner,v_id,'pick');
      END LOOP;
    END \$\$;
    COMMIT;
  `);

  const [a, b, c] = await Promise.all([
    runPsql(`SET search_path TO control_plane,public,extensions;
      SELECT jsonb_array_length(claim_model_checks('race-worker-a',interval '10 minutes'));`),
    runPsql(`SET search_path TO control_plane,public,extensions;
      SELECT jsonb_array_length(claim_model_checks('race-worker-b',interval '10 minutes'));`),
    runPsql(`SET search_path TO control_plane,public,extensions;
      SELECT jsonb_array_length(claim_model_checks('race-worker-c',interval '10 minutes'));`),
  ]);
  const claimed = Number(a) + Number(b) + Number(c);
  assert.equal(claimed, 1, `parallel claims handed out ${claimed} checks`);

  const running = await runPsql(`SET search_path TO control_plane,public,extensions;
    SELECT count(*) FROM model_checks WHERE finished_at IS NULL AND lease_until > clock_timestamp()
      AND operator_id=(SELECT id FROM users WHERE display_name='Quota race owner');`);
  assert.equal(Number(running), 1, "leased checks must match the claimed count");

  // Cleanup so repeated runs are isolated; the checks go with their models.
  await runPsql(`SET search_path TO control_plane,public,extensions;
    DELETE FROM provider_model_catalog WHERE operator_id=(SELECT id FROM users WHERE display_name='Quota race owner');
    DELETE FROM provider_connections WHERE operator_id=(SELECT id FROM users WHERE display_name='Quota race owner');
    DELETE FROM users WHERE display_name='Quota race owner';`).catch(() => undefined);
});
