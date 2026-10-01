export type CodexConnectionStatus =
  | "pending_finalize"
  | "connected"
  | "action_required"
  | "expired"
  | "disconnected";

export type CodexConnection = {
  connectionId: string;
  status: CodexConnectionStatus;
  accountLabel: string;
  planLabel: string;
  permissions: Record<string, string>;
  lastVerifiedAt: string;
  lastFailureCode: string;
  lastFailureMessage: string;
  requestedAction: string;
  createdAt: string;
  updatedAt: string;
} | null;

export type CodexLoginStatus = {
  sessionId: string;
  connectionId: string;
  status: "pending" | "consumed" | "expired" | "failed";
  verificationUrl: string;
  userCode: string;
  failureCode: string;
  expiresAt: string;
  createdAt: string;
} | null;

export function codexConnectionStatusLabel(connection: NonNullable<CodexConnection>) {
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

export function humanizeCodexFailure(connection: NonNullable<CodexConnection>) {
  if (connection.lastFailureMessage) return connection.lastFailureMessage;
  return connection.status === "expired"
    ? "The Codex authorization is no longer valid. Reconnect to continue."
    : "The Codex connection needs attention. Verify or reconnect to continue.";
}
