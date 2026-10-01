import { executeJson } from "@/lib/database";
import type {
  OpenCodeConnection,
  OpenCodeEnrollmentStatus,
} from "@/lib/opencode-connections-shared";

export type {
  OpenCodeConnection,
  OpenCodeConnectionStatus,
  OpenCodeEnrollmentStatus,
} from "@/lib/opencode-connections-shared";

function connectionFromRow(row: Record<string, unknown>): OpenCodeConnection {
  return {
    connectionId: String(row.connection_id),
    status: String(row.status ?? "action_required") as OpenCodeConnection["status"],
    billingBoundary: String(row.billing_boundary ?? ""),
    accessGateway: String(row.access_gateway ?? "") as OpenCodeConnection["accessGateway"],
    accountLabel: String(row.account_label ?? ""),
    installationLabel: String(row.installation_label ?? ""),
    authMethod: String(row.auth_method ?? ""),
    permissions: (row.permissions ?? {}) as Record<string, string>,
    lastVerifiedAt: String(row.last_verified_at ?? ""),
    verifyRequestedAt: String(row.verify_requested_at ?? ""),
    lastFailureCode: String(row.last_failure_code ?? ""),
    lastFailureMessage: String(row.last_failure_message ?? ""),
    requestedAction: String(row.requested_action ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function enrollmentFromRow(row: Record<string, unknown> | null): OpenCodeEnrollmentStatus {
  if (!row || !row.enrollment_id) return null;
  return {
    enrollmentId: String(row.enrollment_id),
    connectionId: String(row.connection_id ?? ""),
    accessGateway: String(row.access_gateway ?? "opencode_go") as NonNullable<OpenCodeEnrollmentStatus>["accessGateway"],
    status: String(row.status ?? "pending") as NonNullable<OpenCodeEnrollmentStatus>["status"],
    failureCode: String(row.failure_code ?? ""),
    expiresAt: String(row.expires_at ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

export async function getOperatorOpenCodeConnections(operatorId: string): Promise<OpenCodeConnection[]> {
  const rows = await executeJson(
    `SELECT get_operator_opencode_connections(:'operator_id'::uuid)::text;`,
    { operator_id: operatorId },
  );
  return Array.isArray(rows) ? rows.map(connectionFromRow) : [];
}

export async function getOperatorOpenCodeEnrollmentStatus(operatorId: string): Promise<OpenCodeEnrollmentStatus> {
  return enrollmentFromRow(await executeJson(
    `SELECT get_operator_opencode_enrollment_status(:'operator_id'::uuid)::text;`,
    { operator_id: operatorId },
  ));
}

export async function getOperatorOpenCodeState(operatorId: string) {
  const [connections, enrollment] = await Promise.all([
    getOperatorOpenCodeConnections(operatorId),
    getOperatorOpenCodeEnrollmentStatus(operatorId),
  ]);
  const free = connections.find((item) => item.accessGateway === "opencode_zen") ?? null;
  const go = connections.find((item) => item.accessGateway === "opencode_go") ?? null;
  const openrouter = connections.find((item) => item.accessGateway === "openrouter") ?? null;
  return { connections, free, go, openrouter, enrollment };
}
