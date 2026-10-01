// Shared GitHub connection types and pure display helpers. This module must
// stay free of Node-only imports (pg, node:crypto) so it can be imported from
// client components. Server-only helpers live in `github-connections.ts`.

export type GitHubConnectionStatus =
  | "pending_finalize"
  | "connected"
  | "action_required"
  | "expired"
  | "disconnected";

export type GitHubConnection = {
  connectionId: string;
  status: GitHubConnectionStatus;
  accountLabel: string;
  installationLabel: string;
  repositorySelection: string;
  permissions: Record<string, string>;
  lastVerifiedAt: string;
  verifyRequestedAt: string;
  lastFailureCode: string;
  lastFailureMessage: string;
  createdAt: string;
  updatedAt: string;
};

export type GitHubRepository = {
  connectionId: string;
  githubRepositoryId: string;
  fullName: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  cloneUrl: string;
  verifiedAt: string;
};

// Verify marks the connection action_required until the broker's next cycle
// (0022), up to a minute: that is a check in progress, not a failure, while
// no failure is recorded.
export function isGitHubVerifying(connection: GitHubConnection | undefined): boolean {
  return Boolean(connection && connection.status === "action_required" && !connection.lastFailureCode
    && connection.verifyRequestedAt && (!connection.lastVerifiedAt || connection.verifyRequestedAt > connection.lastVerifiedAt));
}

const failureMessages: Record<string, string> = {
  installation_not_found: "The GitHub App installation was removed. Reconnect to continue.",
  installation_revoked: "The GitHub App installation was revoked. Reconnect to continue.",
  app_not_installed: "The GitHub App is no longer installed on this account. Reconnect to continue.",
  bad_credentials: "GitHub rejected the App credentials. Contact the owner to rotate the private key.",
  forbidden: "The GitHub App does not have read access to this repository.",
  github_unavailable: "GitHub is temporarily unavailable. Try again.",
  installation_not_permitted: "No accessible installation was found for this GitHub account.",
  multiple_installations: "More than one GitHub App installation is available. Installation selection is required.",
};

export function humanizeConnectionFailure(connection: GitHubConnection): string {
  if (!connection.lastFailureCode) return "GitHub connection needs attention. Reconnect to continue.";
  return failureMessages[connection.lastFailureCode] ?? "GitHub connection needs attention. Reconnect to continue.";
}

export function connectionStatusLabel(connection: GitHubConnection): string {
  switch (connection.status) {
    case "connected": return "Connected";
    case "pending_finalize": return "Finalizing connection…";
    case "action_required": return "Action required";
    case "expired": return "Expired";
    case "disconnected": return "Disconnected";
    default: return connection.status;
  }
}
