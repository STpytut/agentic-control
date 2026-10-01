import test from "node:test";
import assert from "node:assert/strict";
import { bindVariables, hasMultipleStatements } from "../db.mjs";

// psql interpolated :'name' as a quoted literal on the client side. db.mjs
// rewrites the same syntax into real bind parameters, so these cases pin the
// rewrite that every control-plane query now depends on.

test("rewrites a placeholder into a bind parameter", () => {
  const { text, values } = bindVariables("SELECT f(:'a');", { a: "x" });
  assert.equal(text, "SELECT f($1);");
  assert.deepEqual(values, ["x"]);
});

test("a repeated name reuses one parameter instead of sending it twice", () => {
  const { text, values } = bindVariables(
    "SELECT * FROM t WHERE a=:'id' OR b=:'id';", { id: "7" });
  assert.equal(text, "SELECT * FROM t WHERE a=$1 OR b=$1;");
  assert.deepEqual(values, ["7"]);
});

test("numbers parameters in the order the names are consumed", () => {
  const { text, values } = bindVariables(
    "SELECT :'one',:'two',:'three';", { one: "1", two: "2", three: "3" });
  assert.equal(text, "SELECT $1,$2,$3;");
  assert.deepEqual(values, ["1", "2", "3"]);
});

test("leaves type casts alone", () => {
  // ::uuid and ::interval share the colon but are not placeholders. If the
  // rewrite touched them every existing call site would break.
  const { text } = bindVariables(
    "SELECT f(:'id'::uuid, :'ttl'::interval, now()::text);", { id: "a", ttl: "1 hour" });
  assert.equal(text, "SELECT f($1::uuid, $2::interval, now()::text);");
});

test("ignores variables the SQL does not mention", () => {
  // Call sites pass a fixed variable bag to several queries. An unused name
  // must not consume a parameter slot and shift the others.
  const { text, values } = bindVariables("SELECT :'used';", { used: "y", unused: "n" });
  assert.equal(text, "SELECT $1;");
  assert.deepEqual(values, ["y"]);
});

test("passes an empty values array when there are no placeholders", () => {
  // The array is what puts node-postgres on the extended query protocol, which
  // is what makes multi-statement SQL impossible. It must never be omitted.
  const { text, values } = bindVariables("SELECT 1;");
  assert.equal(text, "SELECT 1;");
  assert.deepEqual(values, []);
});

test("does not interpolate the value into the SQL text", () => {
  // The whole point of the port: psql built a literal, this builds a parameter.
  const injection = "'); DROP TABLE users; --";
  const { text, values } = bindVariables("SELECT f(:'a');", { a: injection });
  assert.equal(text, "SELECT f($1);");
  assert.ok(!text.includes("DROP TABLE"));
  assert.deepEqual(values, [injection]);
});

// --- statement separation -------------------------------------------------
// node-postgres picks its wire protocol from the parameter count: with at
// least one bound value the extended protocol makes PostgreSQL refuse a second
// statement, but with none it falls back to the simple protocol, which runs
// them all. So parameterless SQL needs this check to hold the same line.

test("accepts a single statement, with or without a trailing semicolon", () => {
  assert.equal(hasMultipleStatements("SELECT 1"), false);
  assert.equal(hasMultipleStatements("SELECT 1;"), false);
  assert.equal(hasMultipleStatements("SELECT 1;   \n  "), false);
});

test("rejects a genuine second statement", () => {
  assert.equal(hasMultipleStatements("SELECT 1; SELECT 2;"), true);
  assert.equal(hasMultipleStatements("SELECT 1;\nDROP TABLE users;"), true);
});

test("a semicolon inside a string literal is not a separator", () => {
  assert.equal(hasMultipleStatements("SELECT 'a; b';"), false);
  assert.equal(hasMultipleStatements("SELECT 'it''s; fine';"), false);
  assert.equal(hasMultipleStatements(`SELECT "col;name" FROM t;`), false);
});

test("a semicolon inside a comment is not a separator", () => {
  assert.equal(hasMultipleStatements("SELECT 1; -- and; then\n"), false);
  assert.equal(hasMultipleStatements("SELECT 1 /* a; b */;"), false);
  assert.equal(hasMultipleStatements("SELECT 1 /* a /* nested; */ b */;"), false);
});

test("a semicolon inside a dollar-quoted body is not a separator", () => {
  // Every function body in db/migrations looks like this.
  assert.equal(hasMultipleStatements("SELECT $$a; b$$;"), false);
  assert.equal(hasMultipleStatements("SELECT $tag$ BEGIN; END; $tag$;"), false);
});

test("still catches a second statement hidden after a quoted one", () => {
  assert.equal(hasMultipleStatements("SELECT 'a; b'; DROP TABLE users;"), true);
  assert.equal(hasMultipleStatements("SELECT $$x;$$; DROP TABLE users;"), true);
});

test("an escape string cannot smuggle a second statement past the guard", () => {
  // The same scan backs db.query's single-statement guarantee. Parameterless
  // SQL travels on the simple protocol, which would run both statements.
  assert.equal(hasMultipleStatements(String.raw`SELECT E'a\''; DROP TABLE users;`), true);
});
