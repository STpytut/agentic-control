import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { transactionControlStatement, hasMultipleStatements, stripNonCode } from "../sql-scan.mjs";

// migrate.mjs wraps post-0038 migrations in its own transaction. Any
// transaction-control statement inside the file breaks that: BEGIN nests, and
// COMMIT/END/ROLLBACK/ABORT close the wrapper early and silently give up the
// atomicity it exists to provide. The guard has to recognise all of them, and
// must not be fooled by the same words appearing inside function bodies —
// every migration in this repo is full of dollar-quoted plpgsql containing
// BEGIN and COMMIT.

test("detects each transaction-control statement", () => {
  for (const statement of [
    "BEGIN;", "begin;", "START TRANSACTION;", "start  transaction;",
    "COMMIT;", "END;", "ROLLBACK;", "ABORT;",
    "SAVEPOINT s1;", "RELEASE SAVEPOINT s1;", "PREPARE TRANSACTION 'x';",
  ]) {
    assert.ok(
      transactionControlStatement(`SET search_path TO x;\n${statement}\nSELECT 1;`),
      `${statement} was not detected`,
    );
  }
});

test("a lone COMMIT is detected, not just BEGIN", () => {
  // The gap that shipped: the guard only looked for BEGIN, so a file ending in
  // a bare COMMIT passed and then closed the runner's transaction.
  assert.equal(transactionControlStatement("CREATE TABLE t(a int);\nCOMMIT;"), "COMMIT");
  assert.equal(transactionControlStatement("START TRANSACTION;\nCREATE TABLE t(a int);"), "START TRANSACTION");
});

test("accepts a migration that leaves transactions to the runner", () => {
  assert.equal(transactionControlStatement(`
    SET search_path TO control_plane, public;
    CREATE TABLE thing(id uuid PRIMARY KEY);
    CREATE INDEX thing_id ON thing(id);
  `), null);
});

test("BEGIN and COMMIT inside a plpgsql body are not transaction control", () => {
  // This is what every function in db/migrations looks like.
  const sql = `
    CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO t VALUES (1);
      COMMIT;
    END $$;
  `;
  assert.equal(transactionControlStatement(sql), null);
});

test("the words in comments and literals are ignored", () => {
  assert.equal(transactionControlStatement("-- BEGIN; the table\nCREATE TABLE t(a int);"), null);
  assert.equal(transactionControlStatement("/* COMMIT; */ CREATE TABLE t(a int);"), null);
  assert.equal(transactionControlStatement("SELECT 'BEGIN;' AS label;"), null);
});

test("a word that merely starts with a keyword is not a match", () => {
  assert.equal(transactionControlStatement("CREATE TABLE beginning(a int);"), null);
  assert.equal(transactionControlStatement("SELECT commits FROM t;"), null);
  assert.equal(transactionControlStatement("CREATE TABLE ended(a int);"), null);
});

test("stripNonCode preserves offsets", () => {
  const sql = "SELECT 'abc', 1;";
  assert.equal(stripNonCode(sql).length, sql.length);
});

test("the shared scan still backs hasMultipleStatements", () => {
  assert.equal(hasMultipleStatements("SELECT $$a; b$$;"), false);
  assert.equal(hasMultipleStatements("SELECT 1; SELECT 2;"), true);
});

// --- escape strings -------------------------------------------------------
// In an escape string a backslash escapes the next character, so E'a\'' is one
// literal containing a quote. A scan that ends the literal at that quote reads
// the rest of the file shifted by one string and can miss a trailing COMMIT or
// a whole second statement.

test("an escape string cannot hide a transaction-control statement", () => {
  assert.equal(transactionControlStatement(String.raw`SELECT E'a\''; COMMIT;`), "COMMIT");
  assert.equal(transactionControlStatement(String.raw`SELECT e'a\''; ROLLBACK;`), "ROLLBACK");
});

test("an escape string cannot hide a second statement", () => {
  assert.equal(hasMultipleStatements(String.raw`SELECT E'a\''; SELECT 2;`), true);
});

test("an escape string that ends cleanly is still one statement", () => {
  assert.equal(hasMultipleStatements(String.raw`SELECT E'back\\slash';`), false);
  assert.equal(transactionControlStatement(String.raw`SELECT E'back\\slash';`), null);
});

test("a backslash in a standard literal is an ordinary character", () => {
  // standard_conforming_strings is on, so 'a\' is a complete string.
  assert.equal(hasMultipleStatements(String.raw`SELECT 'a\';`), false);
});

test("an identifier ending in e does not start an escape string", () => {
  assert.equal(transactionControlStatement("SELECT name FROM cte WHERE name='x';"), null);
  assert.equal(hasMultipleStatements("SELECT name FROM cte WHERE name='x';"), false);
});

test("no migration after 0038 carries its own transaction control", () => {
  // The scanner above is exercised on strings this file writes. That proves the
  // detector and says nothing about the corpus it exists to guard — and the
  // corpus is where the defect appeared: the lease migration shipped with
  // BEGIN/COMMIT, so
  // `migrate.mjs` refused it and no database could be installed or updated from
  // this tree at all.
  //
  // Nothing caught it. `check-lease-contract.sh` feeds the files to `psql`
  // directly, where BEGIN is ordinary and correct, and never asks the runner
  // whether it would accept them; the DB suites need a migrated database, so
  // they failed for this reason without naming it.
  //
  // This reads the directory rather than a list, so a migration added tomorrow
  // is covered by having been added.
  const directory = path.join(import.meta.dirname, "../../../db/migrations");
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.length > 0, "there must be migrations to check");

  const offenders = [];
  for (const name of files) {
    // The same boundary migrate.mjs uses: through 0038 the files manage their
    // own transactions and are deployed, so they are read but never judged.
    if (Number(name.slice(0, 4)) <= 38) continue;
    const statement = transactionControlStatement(readFileSync(path.join(directory, name), "utf8"));
    if (statement) offenders.push(`${name} runs ${statement}`);
  }

  assert.deepEqual(
    offenders,
    [],
    "migrate.mjs refuses these, so a fresh install and every update fails until they are removed",
  );
});

test("every control-plane function the web tier calls is on the infra_web allowlist", () => {
  // Three permission defects reached the production host one after another, each
  // found by a person clicking the next button: the connect button, then the
  // callback it returns to, then project creation. Each fix named the function in
  // front of it, so the flow met the same cause one step further on.
  //
  // The allowlist in `db/tests/0026` is the privilege boundary and is checked in
  // one direction — nothing outside it may be executable. This is the other
  // direction: everything the web tier actually calls must be inside it. A
  // function the panel invokes and the allowlist omits is a `permission denied`
  // waiting for somebody to reach that screen.
  //
  // Static on purpose: it reads the TypeScript and the test fixture, needs no
  // database, and so runs in `test:unit` where a missing grant costs seconds
  // instead of a release.
  const webRoot = path.join(import.meta.dirname, "../../../apps/web/src");
  const sources = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) sources.push(full);
    }
  };
  walk(webRoot);

  // Functions this project defines, so a call to `jsonb_build_object` or `count`
  // is not mistaken for one of ours.
  const migrations = path.join(import.meta.dirname, "../../../db/migrations");
  const defined = new Set();
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql"))) {
    const text = readFileSync(path.join(migrations, name), "utf8");
    for (const match of text.matchAll(/CREATE OR REPLACE FUNCTION\s+([a-z0-9_]+)\s*\(/gi)) {
      defined.add(match[1]);
    }
  }

  const allowlist = readFileSync(
    path.join(import.meta.dirname, "../../../db/tests/0026_local_role_privileges_test.sql"),
    "utf8",
  );

  const called = new Set();
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\b([a-z][a-z0-9_]{4,})\s*\(\s*:'/g)) {
      if (defined.has(match[1])) called.add(match[1]);
    }
  }
  assert.ok(called.size > 10, `expected the web tier to call several control-plane functions, found ${called.size}`);

  const missing = [...called].filter((name) => !allowlist.includes(`('${name}(`)).sort();
  assert.deepEqual(
    missing,
    [],
    "the web tier calls these and the infra_web allowlist does not list them, "
    + "so they are `permission denied` on a correctly provisioned host",
  );
});

test("no SQL comment inside a template literal carries a backtick", () => {
  // Twice in one session a comment written into a shipped query contained
  // backticks, which end the template literal that holds it. The file stops
  // parsing, and the next thing to run says so in a way that names neither the
  // comment nor the quote.
  //
  // `lint:services` catches it and did; this names the cause instead, and costs
  // no database. Markdown habits do not belong inside a SQL string.
  const roots = [
    path.join(import.meta.dirname, "../.."),
  ];
  const offenders = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".mjs")) continue;
      const source = readFileSync(full, "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        // A SQL line comment that also holds a backtick. Inside a template
        // literal that backtick is not punctuation; it is the end of the string.
        if (/^\s*--/.test(line) && line.includes("`")) {
          offenders.push(`${path.relative(roots[0], full)}:${index + 1}`);
        }
      }
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders.sort(), [], "a backtick in a SQL comment closes the template literal that holds it");
});

// A refusal raised from 0067 onwards says which refusal it is (WP-8a).
//
// `submit_worker_completion` raised one sentence for six conditions, and a
// worker that cannot tell them apart resubmitted an accepted completion five
// times (defect 104). The fix is only a fix while it holds: a migration written
// next month that raises a bare sentence puts the next caller back where that
// one was.
//
// So every `RAISE EXCEPTION` added after 0067 must either go through `refuse()`
// or carry `DETAIL` itself, and every reason named must be in the vocabulary
// 0067 declares. Earlier migrations are left alone — they are already applied,
// and rewriting them would change functions nothing in this package touches.
test("every refusal raised from 0067 onwards names a reason from the vocabulary", () => {
  const migrations = path.join(import.meta.dirname, "../../../db/migrations");
  // The vocabulary accumulates in migration order: a later migration may add
  // reasons, and 0068 does. What is refused is a reason no migration up to and
  // including this one has declared — which is a call site inventing one.
  const vocabulary = new Set();
  const bare = [];
  const unknown = [];
  for (const file of readdirSync(migrations).sort()) {
    if (!file.endsWith(".sql") || Number(file.slice(0, 4)) < 67) continue;
    const source = readFileSync(path.join(migrations, file), "utf8");
    for (const match of source.matchAll(/^\s*\('([a-z_]+)','[a-z_]+','/gm)) vocabulary.add(match[1]);
    if (file === "0067_failure_reasons.sql") {
      assert.ok(vocabulary.size >= 20, `0067 declares ${vocabulary.size} reasons; the seed was not read`);
    }
    // `refuse()` itself raises the two exceptions that cannot go through it.
    const body = file === "0067_failure_reasons.sql"
      ? source.replace(/CREATE OR REPLACE FUNCTION refuse[\s\S]*?\nEND \$\$;/, "") : source;
    for (const [index, line] of body.split("\n").entries()) {
      if (!/RAISE\s+EXCEPTION/i.test(line)) continue;
      const statement = body.split("\n").slice(index, index + 4).join("\n");
      if (!/DETAIL\s*=/i.test(statement)) bare.push(`${file}:${index + 1}`);
    }
    for (const match of body.matchAll(/refuse\('([a-z_]+)'/g)) {
      if (!vocabulary.has(match[1])) unknown.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(bare, [], "these refusals carry no reason, so a caller can only match on the sentence");
  assert.deepEqual(unknown, [], "these refusals name a reason no migration declares");
  // The accumulation must not turn into "anything goes": a reason nobody
  // declares is still refused, and the check is run against a name no migration
  // contains.
  assert.equal(vocabulary.has("a_reason_nobody_declares"), false);
});
