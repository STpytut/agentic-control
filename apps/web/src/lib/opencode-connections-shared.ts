export type OpenCodeConnectionStatus =
  | "pending_finalize"
  | "connected"
  | "action_required"
  | "expired"
  | "disconnected";

export type OpenCodeConnection = {
  connectionId: string;
  status: OpenCodeConnectionStatus;
  billingBoundary: string;
  accessGateway: "opencode_zen" | "opencode_go" | "openrouter";
  accountLabel: string;
  installationLabel: string;
  authMethod: string;
  permissions: Record<string, string>;
  lastVerifiedAt: string;
  verifyRequestedAt: string;
  lastFailureCode: string;
  lastFailureMessage: string;
  requestedAction: string;
  createdAt: string;
  updatedAt: string;
};

export type OpenCodeEnrollmentStatus = {
  enrollmentId: string;
  connectionId: string;
  accessGateway: "opencode_go" | "openrouter";
  status: "pending" | "provisioned" | "claimed" | "completed" | "failed" | "expired" | "superseded";
  failureCode: string;
  expiresAt: string;
  createdAt: string;
} | null;

export function opencodeConnectionStatusLabel(connection: OpenCodeConnection) {
  if (connection.accessGateway === "opencode_zen") return "Available";
  if (connection.requestedAction === "disconnect") return "Disconnecting";
  if (connection.requestedAction === "verify") return "Verifying";
  return {
    pending_finalize: "Connecting",
    connected: "Connected",
    action_required: "Action required",
    expired: "Expired",
    disconnected: "Disconnected",
  }[connection.status];
}

// The API-key gateways (0083).
export const OPENCODE_KEY_PROVIDERS = [
  { gateway: "opencode_go", label: "OpenCode Go", note: "paid OpenCode models, a subscription" },
  { gateway: "openrouter", label: "OpenRouter", note: "models from OpenRouter, metered to your OpenRouter key" },
] as const;

export function opencodeProviderLabel(gateway: string) {
  return OPENCODE_KEY_PROVIDERS.find((item) => item.gateway === gateway)?.label ?? "OpenCode";
}

export function humanizeOpenCodeFailure(connection: OpenCodeConnection) {
  if (connection.lastFailureMessage) return connection.lastFailureMessage;
  return connection.status === "expired"
    ? `The ${opencodeProviderLabel(connection.accessGateway)} authorization is no longer valid. Reconnect to continue.`
    : "The OpenCode connection needs attention. Verify or reconnect to continue.";
}
