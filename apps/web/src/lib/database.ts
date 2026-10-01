import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";

type Json = Record<string, unknown>;

const globalForDatabase = globalThis as typeof globalThis & { controlPlanePool?: Pool };

function configuration() {
  const base = {
    application_name: process.env.INFRA_DB_APPLICATION_NAME ?? "infra-cod:web",
    options: "-c search_path=control_plane,public,extensions",
    max: Number(process.env.INFRA_WEB_DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  };

  // A URL is the development, CI and restore-drill form. In production there is
  // none: the web process reaches PostgreSQL by peer authentication over the
  // Unix socket, where the OS user and the database role are mapped 1:1 (see
  // ADR-0011), so PGHOST/PGUSER/PGDATABASE is the entire configuration and no
  // password exists to leak.
  if (process.env.DATABASE_URL) {
    return { ...base, connectionString: process.env.DATABASE_URL };
  }
  return {
    ...base,
    host: process.env.PGHOST ?? "/var/run/postgresql",
    port: Number(process.env.PGPORT ?? 5432),
    // No default role: the unit names the role it is entitled to.
    user: process.env.PGUSER,
    database: process.env.PGDATABASE ?? process.env.CONTROL_PLANE_DB ?? "infra_cod",
  };
}

function pool() {
  if (!globalForDatabase.controlPlanePool) {
    globalForDatabase.controlPlanePool = new Pool(configuration());
  }
  return globalForDatabase.controlPlanePool;
}

function bindVariables(sql: string, variables: Record<string, string>) {
  const values: string[] = [];
  let text = sql;
  for (const [name, value] of Object.entries(variables)) {
    values.push(value);
    text = text.replaceAll(`:'${name}'`, `$${values.length}`);
  }
  return { text, values };
}

function jsonValue(row: Record<string, unknown>) {
  const value = Object.values(row)[0];
  if (typeof value === "string") return JSON.parse(value) as Json;
  if (value && typeof value === "object") return value as Json;
  return null;
}

function rowsToJson(rows: Record<string, unknown>[]) {
  return rows.map(jsonValue).filter((value): value is Json => value !== null);
}

type ScopedQuery = (sql: string, variables: Record<string, string>) => Promise<Json[]>;

// Set only while `withTransaction` is running, and read by every query helper
// below. That is what makes the boundary real rather than advisory: code inside
// the handler — including code in modules that have never heard of transactions —
// runs on the transaction's connection without having to be passed one.
const transactionScope = new AsyncLocalStorage<ScopedQuery>();

export async function queryJsonRows(sql: string, variables: Record<string, string> = {}) {
  const scoped = transactionScope.getStore();
  if (scoped) return scoped(sql, variables);
  const query = bindVariables(sql, variables);
  const result = await pool().query(query.text, query.values);
  return rowsToJson(result.rows);
}

export async function executeJson(
  sql: string,
  variables: Record<string, string> = {},
): Promise<Json | null> {
  const rows = await queryJsonRows(sql, variables);
  return rows.at(-1) ?? null;
}

// One database transaction, for the one case where a single SECURITY DEFINER
// function is not enough to express the operation.
//
// That case is the control-plane action route: it dispatches in TypeScript across
// a dozen action kinds, and only afterwards records that the operator asked for
// it. Committed separately, a failed audit row leaves the change applied with no
// record of who asked and the caller told it failed, so a retry duplicates or
// conflicts. Neither the dispatch nor the audit is wrong; the split is.
//
// Everything the handler calls joins this transaction — including modules that
// take no transaction parameter — because the query helpers read the scope. Two
// consequences worth knowing: the transaction is held for the whole handler, so
// the handler must not do slow non-database work; and a nested `withTransaction`
// joins the outer one rather than opening a second.
export async function withTransaction<T>(handler: () => Promise<T>): Promise<T> {
  if (transactionScope.getStore()) return handler();

  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const scoped: ScopedQuery = async (sql, variables = {}) => {
      const query = bindVariables(sql, variables);
      const result = await client.query(query.text, query.values);
      return rowsToJson(result.rows);
    };
    const value = await transactionScope.run(scoped, handler);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function hasDatabaseConnection() {
  return Boolean(process.env.DATABASE_URL || process.env.PGUSER);
}
