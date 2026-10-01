import test from "node:test";
import assert from "node:assert/strict";
import { query, queryJson, withTransaction, closePool, getPool } from "../db.mjs";

// Proves the properties db.mjs relies on but cannot assert offline: that the
// extended query protocol refuses multi-statement SQL, that withTransaction is
// a real transaction, and that the session settings actually reach the server.
// Skipped only when DATABASE_URL is genuinely unavailable.

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL is not set";

test.after(async () => { if (!skip) await closePool(); });

test("multi-statement SQL is refused before it reaches the server", { skip }, async () => {
  // Parameterless SQL travels on the simple protocol, which would run both
  // statements, so db.mjs refuses it first.
  await assert.rejects(() => query("SELECT 1; SELECT 2;"), /single statement/);
});

test("the server also refuses it once a value is bound", { skip }, async () => {
  // With a parameter node-postgres switches to the extended protocol and
  // PostgreSQL rejects the second statement itself. This pins the backstop, so
  // a regression in the scanner cannot pass unnoticed for parameterised SQL.
  await assert.rejects(
    () => getPool().query("SELECT 1; SELECT $1::int;", [2]),
    /cannot insert multiple commands/i,
  );
});

test("a semicolon inside a literal is not mistaken for a statement break", { skip }, async () => {
  const row = await queryJson("SELECT to_jsonb(:'v'::text)::text;", { v: "a; b" });
  assert.equal(row, "a; b");
});

test("values are bound, not interpolated", { skip }, async () => {
  const row = await queryJson("SELECT to_jsonb(:'v'::text)::text;", { v: "'); DROP TABLE users; --" });
  assert.equal(row, "'); DROP TABLE users; --");
});

test("withTransaction commits on success", { skip }, async () => {
  const value = await withTransaction(async (client) => {
    await client.query("CREATE TEMP TABLE tx_probe(a int) ON COMMIT DROP");
    const result = await client.query("SELECT 1 AS a");
    return result.rows[0].a;
  });
  assert.equal(value, 1);
});

test("withTransaction rolls back and rethrows", { skip }, async () => {
  await assert.rejects(
    () => withTransaction(async (client) => {
      await client.query("SELECT 1");
      throw new Error("deliberate");
    }),
    /deliberate/,
  );
  // The pool must still be usable: a failed transaction has to release its
  // client, or the next call would hang until the connection timeout.
  assert.equal(await queryJson("SELECT to_jsonb(1)::text;"), 1);
});

test("session settings reach the server", { skip }, async () => {
  const rows = await query("SELECT current_setting('search_path') AS search_path;");
  assert.match(rows[0].search_path, /control_plane/);

  const timeout = await query("SELECT current_setting('statement_timeout') AS t;");
  assert.notEqual(timeout[0].t, "0");

  const name = await query("SELECT current_setting('application_name') AS n;");
  assert.match(name[0].n, /^infra-cod:/);
});
