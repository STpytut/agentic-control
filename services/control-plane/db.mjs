// Shared PostgreSQL access for the control-plane services.
//
// Replaces psql-client.mjs, which spawned a psql process per query. See
// docs/adr/0011-self-hosted-access-model.md for the connection model: peer
// authentication over the Unix socket, with the role named explicitly per
// service so one OS user cannot assume another's role.
//
// The `:'name'` placeholder syntax is kept so call sites did not have to change
// shape during the port, but it is now rewritten to real bind parameters
// instead of psql's client-side literal interpolation.

import path from "node:path";
import pg from "pg";
import { hasMultipleStatements } from "./sql-scan.mjs";

const { Pool } = pg;

let pool = null;

function applicationName() {
  if (process.env.INFRA_DB_APPLICATION_NAME) return process.env.INFRA_DB_APPLICATION_NAME;
  const entry = process.argv[1] ? path.basename(process.argv[1], ".mjs") : "node";
  return `infra-cod:${entry}`;
}

function configuration() {
  const options = [
    "-c search_path=control_plane,public,extensions",
    `-c statement_timeout=${Number(process.env.INFRA_DB_STATEMENT_TIMEOUT_MS ?? 30_000)}`,
    `-c idle_in_transaction_session_timeout=${Number(process.env.INFRA_DB_IDLE_TX_TIMEOUT_MS ?? 60_000)}`,
  ].join(" ");

  const base = {
    application_name: applicationName(),
    options,
    // Workers are single-flight; the supervisor needs a little more headroom.
    max: Number(process.env.INFRA_DB_POOL_MAX ?? 4),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // `... once` modes must be able to exit without an explicit close.
    allowExitOnIdle: true,
  };

  // Production authenticates by peer over the socket and has no DATABASE_URL.
  // The URL form stays for development, CI and the restore drill.
  if (process.env.DATABASE_URL) {
    return { ...base, connectionString: process.env.DATABASE_URL };
  }
  return {
    ...base,
    host: process.env.PGHOST ?? "/var/run/postgresql",
    port: Number(process.env.PGPORT ?? 5432),
    // No default role: each unit names the role it is entitled to.
    user: process.env.PGUSER,
    database: process.env.PGDATABASE ?? process.env.CONTROL_PLANE_DB ?? "infra_cod",
  };
}

export function getPool() {
  if (!pool) {
    pool = new Pool(configuration());
    // An idle client erroring out must not take the process down.
    pool.on("error", (error) => {
      process.stderr.write(`${JSON.stringify({ type: "db.pool_error", error: error.message })}\n`);
    });
  }
  return pool;
}

// Rewrites psql's :'name' placeholders into $1..$n bind parameters. A name used
// more than once reuses its parameter rather than sending the value twice.
export function bindVariables(sql, variables = {}) {
  const values = [];
  const positions = new Map();
  let text = sql;
  for (const [name, value] of Object.entries(variables)) {
    const token = `:'${name}'`;
    if (!text.includes(token)) continue;
    if (!positions.has(name)) {
      values.push(value);
      positions.set(name, values.length);
    }
    text = text.replaceAll(token, `$${positions.get(name)}`);
  }
  return { text, values };
}

// Re-exported so call sites and tests keep importing it from here; the walk
// itself is shared with the migration runner, which needs the same handling of
// literals, comments and dollar-quoted bodies.
export { hasMultipleStatements } from "./sql-scan.mjs";

function jsonValue(row) {
  const value = Object.values(row)[0];
  if (typeof value === "string") return JSON.parse(value);
  if (value && typeof value === "object") return value;
  return null;
}

// Runs exactly one statement. psql-client wrapped every call in BEGIN/COMMIT;
// with a pool each call is its own implicit transaction, which is equivalent
// for the single-statement call sites this replaced but not for anything
// multi-step — so multi-statement SQL is refused here rather than silently
// losing atomicity. Use withTransaction when more than one statement is meant.
export async function query(sql, variables = {}) {
  const { text, values } = bindVariables(sql, variables);
  if (hasMultipleStatements(text)) {
    throw new Error("db.query runs a single statement; use withTransaction for multiple");
  }
  const result = await getPool().query(text, values);
  return result.rows;
}

export async function queryJsonRows(sql, variables = {}) {
  const rows = await query(sql, variables);
  return rows.map(jsonValue).filter((value) => value !== null);
}

export async function queryJson(sql, variables = {}) {
  return (await queryJsonRows(sql, variables)).at(-1) ?? null;
}

// The same binding and JSON handling as `queryJson`, but on a caller-supplied
// client so several statements can share one transaction. A change and its audit
// row have to be one unit: written apart, an interrupted process leaves either an
// unaudited change or a recorded change that did not happen.
export async function queryJsonOn(client, sql, variables = {}) {
  const { text, values } = bindVariables(sql, variables);
  const result = await client.query(text, values);
  return result.rows.map(jsonValue).filter((value) => value !== null).at(-1) ?? null;
}

// Name used by the web layer's equivalent module.
export const executeJson = queryJson;

// The only supported way to run more than one statement atomically. psql-client
// wrapped every single call in BEGIN/COMMIT; with a pool each call is its own
// implicit transaction, which is equivalent for the single-statement call sites
// but not for anything multi-step.
export async function withTransaction(handler) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await handler(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// A connection of its own that LISTENs on one channel (Stage 12 W6: the model
// check lane is woken by `NOTIFY model_checks`). Not from the pool: a pooled
// client is handed to other queries between uses, and a LISTEN belongs to the
// session that issued it. The caller closes it; `ended` says it went away (a
// restart of the server, a network drop), and the caller listens again.
export async function listen(channel, onNotification, { onError = () => {} } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(channel)) throw new Error(`not a channel name: ${channel}`);
  const client = new pg.Client(configuration());
  const handle = { ended: false, close: async () => { handle.ended = true; await client.end().catch(() => {}); } };
  client.on("notification", (message) => {
    if (message.channel === channel) onNotification(message.payload ?? "");
  });
  client.on("error", (error) => { handle.ended = true; onError(error); });
  client.on("end", () => { handle.ended = true; });
  await client.connect();
  try {
    await client.query(`LISTEN ${channel}`);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

export function hasDatabaseConnection() {
  return Boolean(process.env.DATABASE_URL || process.env.PGUSER);
}

export async function closePool() {
  const current = pool;
  pool = null;
  if (current) await current.end();
}
