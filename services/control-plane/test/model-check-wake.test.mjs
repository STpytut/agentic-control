// The check lane is woken, not polled (Stage 12 W6, §2.8): asking for a check
// NOTIFYs model_checks once the asking transaction commits, and a LISTEN on its
// own connection (db.mjs, listen) hears it with the check's id — which is what
// lets the worker claim within a second instead of at the next 60 s poll.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { closePool, listen, query, queryJson } from "../db.mjs";

const databaseUrl = process.env.DATABASE_URL;

after(async () => { await closePool(); });

test("a requested check wakes a listener with its id, after the commit", { skip: !databaseUrl }, async () => {
  const heard = [];
  let wakeUp = () => {};
  const listener = await listen("model_checks", (payload) => { heard.push(payload); wakeUp(); });
  let owner = null;
  try {
    const fixture = await queryJson(`
      WITH owner AS (INSERT INTO users(display_name) VALUES('Wake owner') RETURNING id),
      connection AS (
        INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
        SELECT id,'opencode','api_key','connected','openrouter','third_party_metered','opencode-home:opencode-worker' FROM owner
        RETURNING id, operator_id),
      entry AS (
        INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source)
        SELECT operator_id,id,'opencode','openrouter','openai/gpt-6-luna','opencode_provider_api' FROM connection
        RETURNING id, operator_id)
      SELECT jsonb_build_object('owner',operator_id,'entry',id)::text FROM entry;`);
    owner = fixture.owner;
    const arrived = new Promise((resolve) => { wakeUp = resolve; });
    const started = Date.now();
    const requested = await queryJson(`SELECT request_model_check(:'owner'::uuid,:'entry'::uuid,'pick')::text;`,
      { owner: fixture.owner, entry: fixture.entry });
    await Promise.race([arrived, new Promise((_, reject) => setTimeout(() => reject(new Error("no notification within 5 s")), 5_000))]);
    assert.ok(heard.includes(requested.check_id), `heard ${JSON.stringify(heard)}, asked ${requested.check_id}`);
    assert.ok(Date.now() - started < 5_000);
  } finally {
    await listener.close();
    if (owner) {
      await query(`DELETE FROM provider_model_catalog WHERE operator_id=:'owner'::uuid;`, { owner });
      await query(`DELETE FROM provider_connections WHERE operator_id=:'owner'::uuid;`, { owner });
      await query(`DELETE FROM audit_events WHERE actor_id=:'owner';`, { owner }).catch(() => {});
      await query(`DELETE FROM users WHERE id=:'owner'::uuid;`, { owner }).catch(() => {});
    }
  }
});
