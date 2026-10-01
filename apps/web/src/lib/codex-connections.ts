import { executeJson } from "@/lib/database";
import type {
  CodexConnection,
  CodexLoginStatus,
} from "@/lib/codex-connections-shared";

export type {
  CodexConnection,
  CodexConnectionStatus,
  CodexLoginStatus,
} from "@/lib/codex-connections-shared";

function connectionFromRow(row: Record<string, unknown> | null): CodexConnection {
  if (!row || !row.connection_id) return null;
  return {
    connectionId: String(row.connection_id),
    status: String(row.status ?? "action_required") as NonNullable<CodexConnection>["status"],
    accountLabel: String(row.account_label ?? ""),
    planLabel: String(row.plan_label ?? ""),
    permissions: (row.permissions ?? {}) as Record<string, string>,
    lastVerifiedAt: String(row.last_verified_at ?? ""),
    lastFailureCode: String(row.last_failure_code ?? ""),
    lastFailureMessage: String(row.last_failure_message ?? ""),
    requestedAction: String(row.requested_action ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function loginFromRow(row: Record<string, unknown> | null): CodexLoginStatus {
  if (!row || !row.session_id) return null;
  return {
    sessionId: String(row.session_id),
    connectionId: String(row.connection_id ?? ""),
    status: String(row.status ?? "pending") as NonNullable<CodexLoginStatus>["status"],
    verificationUrl: String(row.verification_url ?? ""),
    userCode: String(row.user_code ?? ""),
    failureCode: String(row.failure_code ?? ""),
    expiresAt: String(row.expires_at ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

export async function getOperatorCodexConnection(operatorId: string): Promise<CodexConnection> {
  return connectionFromRow(await executeJson(
    `SELECT get_operator_codex_connection(:'operator_id'::uuid)::text;`,
    { operator_id: operatorId },
  ));
}

export async function getOperatorCodexLoginStatus(operatorId: string): Promise<CodexLoginStatus> {
  return loginFromRow(await executeJson(
    `SELECT get_operator_codex_login_status(:'operator_id'::uuid)::text;`,
    { operator_id: operatorId },
  ));
}

export async function getOperatorCodexState(operatorId: string) {
  const [connection, login] = await Promise.all([
    getOperatorCodexConnection(operatorId),
    getOperatorCodexLoginStatus(operatorId),
  ]);
  return { connection, login };
}
