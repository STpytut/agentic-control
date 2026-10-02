import { executeJson } from "@/lib/database";

// The Claude Code card's state (sprint C K2): the operator's connection, if
// any, and what the host last reported of the runtime — the two halves of
// being usable, since the login is the host's and the connection the panel's.
export type ClaudeConnectionState = {
  connection: { connectionId: string; status: string; lastVerifiedAt: string; updatedAt: string } | null;
  runtime: { known: boolean; installed: boolean | null; authenticated: boolean | null; version: string; observedAt: string };
  /** The latest sign-in from the panel (0136), if any. */
  login: { id: string; status: string; authorizeUrl: string; codeSubmitted: boolean; failure: string; expiresAt: string } | null;
};

export async function getOperatorClaudeState(operatorId: string): Promise<ClaudeConnectionState> {
  const row = await executeJson(
    `SELECT get_operator_claude_connection(:'operator_id'::uuid)::text;`,
    { operator_id: operatorId },
  ) as Record<string, unknown> | null;
  const connection = row?.connection as Record<string, unknown> | null | undefined;
  const runtime = (row?.runtime ?? {}) as Record<string, unknown>;
  const login = await executeJson(`SELECT get_claude_login(:'operator_id'::uuid)::text;`, { operator_id: operatorId }) as Record<string, unknown> | null;
  return {
    connection: connection && connection.connection_id ? {
      connectionId: String(connection.connection_id),
      status: String(connection.status ?? "disconnected"),
      lastVerifiedAt: String(connection.last_verified_at ?? ""),
      updatedAt: String(connection.updated_at ?? ""),
    } : null,
    runtime: {
      known: runtime.known === true,
      installed: typeof runtime.installed === "boolean" ? runtime.installed : null,
      authenticated: typeof runtime.authenticated === "boolean" ? runtime.authenticated : null,
      version: String(runtime.version ?? ""),
      observedAt: String(runtime.observed_at ?? ""),
    },
    login: login && login.id ? {
      id: String(login.id),
      status: String(login.status ?? ""),
      authorizeUrl: String(login.authorize_url ?? ""),
      codeSubmitted: login.code_submitted === true,
      failure: String(login.failure ?? ""),
      expiresAt: String(login.expires_at ?? ""),
    } : null,
  };
}
