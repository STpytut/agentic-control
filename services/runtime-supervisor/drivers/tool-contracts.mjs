// The control plane's tools, as the platform defines them — before any runtime
// has wrapped them in its own shape (WP-5b).
//
// A driver's tool bridge decides how a runtime receives these: Codex as
// app-server dynamic tools under a namespace, OpenCode as tool files it loads
// from its own config directory that call back over a capability-bound socket.
// What the tools are, and what they accept, is the platform's, and is written
// once here.

// The orchestrator's commands: ADR-0008, RUNTIME_CONTRACT §10.
export const PLATFORM_COMMAND_NAMESPACE = Object.freeze({
  name: "platform",
  description: "Durable control-plane orchestration commands bound to the active task and its configured agents.",
});

export const PLATFORM_COMMAND_TOOLS = Object.freeze([
  Object.freeze({
    name: "delegate_task",
    description: "Finalize planning and delegate the active task to its selected executor.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", minLength: 4 },
        instructions: { type: "array", items: { type: "string", minLength: 1 } },
        relevant_paths: { type: "array", items: { type: "string", minLength: 1 } },
      },
      required: ["objective", "instructions", "relevant_paths"],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: "request_revision",
    description: "Return the active completed implementation to the same executor with concrete required changes.",
    inputSchema: {
      type: "object",
      properties: {
        changes_required: {
          type: "array", minItems: 1, items: { type: "string", minLength: 1 },
        },
      },
      required: ["changes_required"],
      additionalProperties: false,
    },
  }),
  // Stage 12 (0147): one question to one of the project's analysts. The answer
  // is not this call's result: it arrives later as a new turn.
  Object.freeze({
    name: "consult",
    description: "Ask one of the project's analysts to read the code and answer a question. The answer arrives later as a new message; this call only asks.",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "The analyst's name; may be empty when the project has exactly one" },
        question: { type: "string", minLength: 10, maxLength: 8000 },
      },
      required: ["question"],
      additionalProperties: false,
    },
  }),
]);

// The names the orchestrator's run socket accepts (11.2 N4): a runtime whose
// tools are files calls these over the socket, as the executor calls its own.
export const PLATFORM_COMMAND_TOOL_NAMES = Object.freeze(PLATFORM_COMMAND_TOOLS.map((tool) => tool.name));

// The executor's terminal tools: RUNTIME_CONTRACT §9. Their definitions ship as
// files (services/runtime-supervisor/opencode-tools) because that is how the one
// executor runtime loads tools; the names are what the gateway accepts.
export const WORKER_REPORT_TOOLS = Object.freeze(["complete_task", "report_blocker", "request_user_input"]);

// The same three as schemas and socket messages, for a runtime that receives
// its tools over MCP rather than as files — Claude Code and Codex as executors
// (Stage 12 X1/X2). Each message is exactly what the OpenCode file for that
// tool sends (opencode-tools/*.ts), so the worker gateway reads one shape
// whoever called it.
export const WORKER_REPORT_TOOL_CONTRACTS = Object.freeze([
  Object.freeze({
    name: "complete_task",
    description: "Submit the structured implementation result. Call exactly once after all edits and checks are finished.",
    inputSchema: {
      type: "object",
      properties: {
        changed_files: { type: "array", minItems: 1, items: { type: "string" }, description: "Workspace-relative files changed" },
        checks: { type: "object", additionalProperties: { type: "string" }, description: "Check name to result mapping" },
        summary: { type: "string", minLength: 1, description: "Concise implementation summary" },
        notes: { type: "string", description: "Optional reviewer notes" },
      },
      required: ["changed_files", "checks", "summary"],
      additionalProperties: false,
    },
    message: (args, { sessionId, runId }) => ({
      type: "complete_task",
      native_session_id: sessionId,
      result_summary: { summary: args.summary, changed_files: args.changed_files },
      checks_summary: args.checks,
      notes: args.notes ?? null,
      idempotency_key: `complete:${runId}`,
    }),
  }),
  Object.freeze({
    name: "report_blocker",
    description: "Report a blocker that prevents safe completion. Call only after documenting attempted work.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", minLength: 1 },
        attempted: { type: "array", minItems: 1, items: { type: "string" } },
        requested_action: { type: "string" },
      },
      required: ["reason", "attempted"],
      additionalProperties: false,
    },
    message: (args, { sessionId, runId }) => ({
      type: "report_blocker", native_session_id: sessionId, payload: args, idempotency_key: `blocker:${runId}`,
    }),
  }),
  Object.freeze({
    name: "request_user_input",
    description: "Request user input when implementation cannot continue safely without a decision.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1 },
        sensitivity: { type: "string", enum: ["normal", "sensitive"] },
        context: { type: "string" },
      },
      required: ["question"],
      additionalProperties: false,
    },
    message: (args, { sessionId, runId }) => ({
      type: "request_user_input", native_session_id: sessionId,
      payload: { sensitivity: "normal", ...args }, idempotency_key: `input:${runId}`,
    }),
  }),
]);
