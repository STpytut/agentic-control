// Protocol allowlist for the Codex account-management channel. This channel
// operates the native credential store and must never become a general Codex
// runtime escape hatch.

const allowedMethods = new Set([
  "initialize",
  "initialized",
  "account/login/start",
  "account/login/cancel",
  "account/read",
  "account/logout",
  "model/list",
  // The subscription's usage windows (Stage 12 W6, §2.6): read-only, no model
  // call, and nothing of the credential leaves the runtime's user. The check
  // lane reads it before automatic Codex checks.
  "account/rateLimits/read",
]);

export function validateCodexAccountInput(data) {
  for (const line of String(data).split("\n").filter((item) => item.trim())) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      throw new Error("Codex account channel requires JSON messages");
    }
    if (!allowedMethods.has(message.method)) {
      throw new Error(`Codex account channel does not permit ${String(message.method ?? "unknown")}`);
    }
    if (
      message.method === "account/login/start"
      && (
        message.params?.type !== "chatgptDeviceCode"
        || Object.keys(message.params ?? {}).some((key) => key !== "type")
      )
    ) {
      throw new Error("Codex account channel only permits ChatGPT device-code login");
    }
    if (
      message.method === "account/read"
      && message.params !== undefined
      && message.params !== null
      && (
        typeof message.params !== "object"
        || Array.isArray(message.params)
        || Object.keys(message.params).some((key) => key !== "refreshToken")
        || (message.params.refreshToken !== undefined && typeof message.params.refreshToken !== "boolean")
      )
    ) {
      throw new Error("Codex account read parameters are invalid");
    }
    if (
      new Set(["initialized", "account/logout", "model/list", "account/rateLimits/read"]).has(message.method)
      && message.params !== undefined
      && message.params !== null
      && Object.keys(message.params).length
    ) {
      throw new Error(`Codex ${message.method} does not accept parameters`);
    }
  }
}
