import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

// The AsyncLocalStorage transaction context in `apps/web/src/lib/database.ts`.
//
// Two other suites cover different things and neither covers this one:
// `db-protocol.test.mjs` exercises `services/control-plane/db.mjs`, the helper the
// workers and the CLI use — a different file with a different implementation, and
// a passing test there says nothing about the web module. `action-atomicity.test.mjs`
// covers the product path end to end, through HTTP and fault injection. What is
// left, and what this file is for, is the mechanism itself: that the connection a
// `withTransaction` handler runs on is the transaction's connection, that a
// concurrent handler cannot land on it, and that the scope ends where it says it
// does.
//
// The failure this pins is the one the context exists to prevent: every helper in
// the web tier — including modules that take no client parameter — reads the
// ambient scope, so the moment the scope leaks or is dropped, statements written
// inside a handler are silently executed on a pooled autocommit connection. The
// change is invisible in the handler's source and invisible in an HTTP status;
// only the PostgreSQL state it leaves behind shows it.
//
// There is no skip. A missing database is a failure here, not a reason to report
// a green suite that asserted nothing — the point of the file is the assertion,
// and a skipped assertion is the one outcome that must not look like success. The
// database is this file's own: a temporary one, created and migrated by the test,
// so the assertions do not depend on, or disturb, whatever state a developer's
// database happens to hold.

const root = path.resolve(import.meta.dirname, "../../..");
const psqlBin = process.env.PSQL_BIN ?? "psql";
const databaseName = `infra_cod_txcontext_${process.pid}`;

// Captured before `pointAt` overwrites them, so a developer who points the suite
// somewhere other than the default socket keeps that target.
const target = {
  host: process.env.PGHOST ?? "localhost",
  port: process.env.PGPORT ?? "5432",
  user: process.env.PGUSER ?? process.env.USER ?? "",
};

function adminUrlFor(database) {
  // `.env.local` is loaded by the npm script, so the developer's own
  // DATABASE_URL is the natural source for the maintenance connection; the
  // fallback is the local peer default.
  if (process.env.DATABASE_URL) {
    const parsed = new URL(process.env.DATABASE_URL);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  }
  return `postgresql:///${database}`;
}

function psql(database, sql) {
  const result = spawnSync(
    psqlBin,
    ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", adminUrlFor(database)],
    { encoding: "utf8", input: sql },
  );
  if (result.error) throw new Error(`psql could not be started: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `psql exited ${result.status}`);
  return result.stdout.trim();
}

// A session outside the pool under test. The transaction's own handler always
// sees its own write, so only a second connection can show that nobody else does.
function observer(database, sql) {
  return psql(database, sql);
}

// `withTransaction` reads PGHOST/PGUSER/PGDATABASE when DATABASE_URL is unset, and
// the pool is built lazily on the first query — so the environment has to be
// correct before the module is imported, and the import has to be dynamic.
function pointAt(database) {
  delete process.env.DATABASE_URL;
  process.env.PGHOST = target.host;
  process.env.PGPORT = target.port;
  process.env.PGUSER = target.user;
  process.env.PGDATABASE = database;
}

let database = null;

test.before(async () => {
  psql("postgres", `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
  psql("postgres", `CREATE DATABASE ${databaseName};`);
  const migrated = spawnSync(
    process.execPath,
    [path.join(root, "services/control-plane/migrate.mjs")],
    { encoding: "utf8", env: { ...process.env, DATABASE_URL: adminUrlFor(databaseName) } },
  );
  if (migrated.status !== 0) {
    throw new Error(`migrating the temporary database failed: ${migrated.stderr.trim()}`);
  }
  // Ordinary committed tables: the assertions are about what survives a commit or
  // a rollback, which a temp table could not express.
  psql(databaseName, `
    CREATE TABLE control_plane.tx_iso(label text NOT NULL);
    CREATE TABLE control_plane.tx_nest(label text NOT NULL);
    CREATE TABLE control_plane.tx_rollback(label text NOT NULL, n integer NOT NULL);
  `);
  pointAt(databaseName);
  database = await import("../../../apps/web/src/lib/database.ts");
});

test.after(async () => {
  // The pool goes first: PostgreSQL refuses to drop a database that still has a
  // connection on it, and a leaked pool would otherwise turn a later run into a
  // failure that looks like this file's fault.
  if (database) {
    const pool = globalThis.controlPlanePool;
    if (pool) await pool.end();
  }
  psql("postgres", `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
});

// An advisory lock held for the rest of the transaction. Coordination is a
// PostgreSQL lock, never a timer: the whole point of the first test is that two
// PostgreSQL transactions are genuinely open at once, and a `sleep` cannot show
// that.
//
// The deadline is set with `SET LOCAL` inside the handler, so it applies to the
// connection that transaction actually runs on. A session-level `SET` through the
// pool is a different thing entirely: it lands on whichever pooled connection
// answers, and a second concurrent scope may get a different one and wait on an
// advisory lock with no timeout at all. The failure that would produce is a hung
// test run, which is why the deadline has to be part of each transaction.
const DEADLINE_MS = 15_000;

async function armDeadline() {
  // `set_config(..., true)` is the function form of `SET LOCAL`: it lasts until
  // the current transaction ends, on this connection.
  await database.queryJsonRows(
    "SELECT jsonb_build_object('armed', set_config('statement_timeout', $1, true))::text AS r",
    { deadline: String(DEADLINE_MS) },
  );
}

async function holdLock(label) {
  await armDeadline();
  await database.queryJsonRows(
    "SELECT jsonb_build_object('lock', pg_advisory_xact_lock(hashtextextended($1, 0)))::text AS l",
    { label },
  );
}

function jsonRow(expression, alias = "r") {
  return `SELECT jsonb_build_object(${expression})::text AS ${alias}`;
}

test("two concurrent transactions run on different backends and only committed writes are visible to anyone else", { timeout: 60_000 }, async (t) => {
  // No session-level deadline is armed here on purpose: each handler arms its own
  // inside its transaction (see `armDeadline`), so both of the two concurrent
  // connections are covered. A single pooled `SET` before this point would have
  // reached only one of them.

  // Two things pin the ordering, and both are needed.
  //
  // The advisory lock is what makes the second transaction queue behind the first
  // one's commit. It cannot on its own decide *which* of the two gets there first,
  // though: starting a transaction begins with an asynchronous `pool.connect()`, so
  // either handler can reach its first statement first. Leaving that to chance is
  // not theoretical — with B holding the gate, A observed B's committed row while
  // asserting its own write was invisible to every other session.
  //
  // So the order is established explicitly: the first handler signals once it is
  // inside its transaction and holding the lock, and the second waits for that
  // before reaching for the same lock. The lock then does the rest — the second
  // blocks until the first commits. A's observation happens with its transaction
  // open, and neither wait is a timer.
  const gate = "tx-isolation:gate";
  const table = "control_plane.tx_iso";

  let signalEntered;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  // Released however the test ends. If the first handler failed before it reached
  // the lock, the second would otherwise wait on `entered` forever and the run
  // would end in a timeout instead of the real failure.
  t.after(() => signalEntered());

  const first = database.withTransaction(async () => {
    await holdLock(gate);
    signalEntered();
    await database.executeJson(
      `INSERT INTO ${table}(label) VALUES ('first') RETURNING jsonb_build_object('label', label)::text`,
    );
    return {
      pid: (await database.executeJson(jsonRow("'pid', pg_backend_pid()")))?.pid,
      // The transaction is still open here. If the scope had leaked this write
      // onto a pooled autocommit connection, the observer would already see it.
      outside: Number(observer(databaseName, `SELECT count(*) FROM ${table};`)),
    };
  });

  const second = database.withTransaction(async () => {
    // A is already inside its transaction and holding the gate, so this waits for
    // A's commit rather than racing it.
    await entered;
    await holdLock(gate);
    await database.executeJson(
      `INSERT INTO ${table}(label) VALUES ('second') RETURNING jsonb_build_object('label', label)::text`,
    );
    return {
      pid: (await database.executeJson(jsonRow("'pid', pg_backend_pid()")))?.pid,
      // A's row is committed and visible; this handler's own row is not, and the
      // observer is a different session, which is why it counts exactly one.
      outside: Number(observer(databaseName, `SELECT count(*) FROM ${table};`)),
    };
  });

  const [a, b] = await Promise.all([first, second]);
  assert.notEqual(a.pid, b.pid, "two concurrent transactions must not share one connection");
  assert.equal(a.outside, 0, "an uncommitted write must be invisible to every other session");
  assert.equal(b.outside, 1, "a committed write must be visible, and an uncommitted one must not");
  const committed = await database.queryJsonRows(
    `SELECT jsonb_build_object('label', label)::text AS row FROM ${table} ORDER BY label`,
  );
  assert.deepEqual(committed.map((row) => row.label), ["first", "second"], "both commits persisted");
});

test("a nested transaction joins the outer one, and the outer rollback takes the inner writes with it", { timeout: 60_000 }, async () => {
  const pids = [];
  await assert.rejects(
    () => database.withTransaction(async () => {
      pids.push((await database.executeJson(jsonRow("'pid', pg_backend_pid()")))?.pid);
      await database.executeJson(
        "INSERT INTO tx_nest(label) VALUES ('outer') RETURNING jsonb_build_object('label', label)::text",
      );
      // A nested call. If it opened its own transaction and committed it, the
      // write below would survive the failure after it — which is the assertion.
      await database.withTransaction(async () => {
        pids.push((await database.executeJson(jsonRow("'pid', pg_backend_pid()")))?.pid);
        await database.executeJson(
          "INSERT INTO tx_nest(label) VALUES ('inner') RETURNING jsonb_build_object('label', label)::text",
        );
      });
      // And it must still be cancellable as part of the outer unit of work.
      await database.executeJson(
        "INSERT INTO tx_nest(label) VALUES ('after-inner') RETURNING jsonb_build_object('label', label)::text",
      );
      throw new Error("deliberate failure after the nested block");
    }),
    /deliberate failure after the nested block/,
  );

  assert.equal(pids.length, 2, "both blocks must have run");
  assert.equal(pids[0], pids[1], "a nested withTransaction must reuse the outer connection");
  const rows = await database.queryJsonRows(
    "SELECT jsonb_build_object('label', label)::text AS row FROM tx_nest ORDER BY label",
  );
  assert.deepEqual(rows, [], "the outer rollback must have undone the nested writes too");
});

test("an exception after several statements rolls every one of them back", { timeout: 60_000 }, async () => {
  await assert.rejects(
    () => database.withTransaction(async () => {
      await database.executeJson("INSERT INTO tx_rollback(label, n) VALUES ('a', 1) RETURNING jsonb_build_object('n', n)::text");
      await database.executeJson("INSERT INTO tx_rollback(label, n) VALUES ('b', 2) RETURNING jsonb_build_object('n', n)::text");
      await database.executeJson("INSERT INTO tx_rollback(label, n) VALUES ('c', 3) RETURNING jsonb_build_object('n', n)::text");
      throw new Error("deliberate failure after three writes");
    }),
    /deliberate failure after three writes/,
  );
  const rows = await database.queryJsonRows(
    "SELECT jsonb_build_object('label', label)::text AS row FROM tx_rollback ORDER BY label",
  );
  assert.deepEqual(rows, [], "no statement from a failed transaction may survive");
});

test("a query after the scope runs outside the transaction on a pooled connection", { timeout: 60_000 }, async () => {
  await database.withTransaction(async () => {
    // A temp table the transaction creates and commits. It belongs to the
    // *connection's* temp schema, so if the pool hands the same connection back
    // it is expected to still be there — that is reuse, not a leak.
    await database.executeJson("CREATE TEMP TABLE tx_after_scope(marker text)");
    await database.executeJson(
      "INSERT INTO tx_after_scope(marker) VALUES ('inside') RETURNING jsonb_build_object('marker', marker)::text",
    );
  });

  // The scope is over, so the next statement must be its own autocommit statement.
  // A client that was released while still holding the transaction would report an
  // assigned transaction id here, and one that was never released would make this
  // statement wait for a connection instead of running.
  const state = await database.queryJsonRows(
    jsonRow("'inTx', pg_current_xact_id_if_assigned() IS NOT NULL"),
  );
  assert.equal(state[0]?.inTx, false, "a post-scope query must run in autocommit mode");

  // The committed write is durable, so the transaction really committed rather
  // than being abandoned on a connection the pool then reused.
  const rows = await database.queryJsonRows("SELECT jsonb_build_object('n', count(*))::text AS row FROM tx_iso");
  assert.equal(Number(rows[0]?.n), 2, "the earlier commits must still be durable");

  // And the pool is still usable for ordinary work.
  await database.executeJson("CREATE TEMP TABLE tx_post(marker text)");
  const cleanup = await database.queryJsonRows(
    jsonRow("'ok', to_regclass(pg_my_temp_schema()::regnamespace::text || '.tx_post') IS NOT NULL"),
  );
  assert.equal(cleanup[0]?.ok, true, "the pool must serve ordinary queries after the scope ends");

  // A scope never consumes more than one connection, so more sequential
  // transactions than the pool has connections must all complete. A client leaked
  // on any of them would exhaust the pool and stall here instead.
  for (let i = 0; i < 14; i += 1) {
    await database.withTransaction(async () => {
      await database.queryJsonRows(jsonRow("'one', 1"));
    });
  }
});
