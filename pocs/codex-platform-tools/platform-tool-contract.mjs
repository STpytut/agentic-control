export const delegateTaskArguments = Object.freeze({
  task_id: "task-poc-001",
  assignee: "opencode",
  objective: "Create a worker proof file",
  revision_number: 1,
  acceptance_criteria: ["The worker proof file contains WORKER_OK"],
});

export const platformToolNamespace = {
  type: "namespace",
  name: "platform",
  description: "Control-plane tools for validated agent handoffs.",
  tools: [
    {
      type: "function",
      name: "delegate_task",
      description:
        "Create an idempotent implementation handoff to an allowed worker runtime.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", minLength: 1 },
          assignee: { type: "string", enum: ["opencode"] },
          objective: { type: "string", minLength: 1 },
          revision_number: { type: "integer", minimum: 1 },
          acceptance_criteria: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
        },
        required: [
          "task_id",
          "assignee",
          "objective",
          "revision_number",
          "acceptance_criteria",
        ],
        additionalProperties: false,
      },
    },
  ],
};

export function validateDelegateTaskCall(params, context) {
  if (params.threadId !== context.threadId || params.turnId !== context.turnId) {
    throw new Error("stale or foreign thread/turn context");
  }
  if (!params.callId) throw new Error("missing callId");
  if (params.namespace !== "platform" || params.tool !== "delegate_task") {
    throw new Error("unsupported platform tool");
  }

  const actual = params.arguments;
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    throw new Error("arguments must be an object");
  }
  if (JSON.stringify(actual) !== JSON.stringify(delegateTaskArguments)) {
    throw new Error("delegate_task arguments do not match the active task contract");
  }

  return {
    status: "accepted",
    command: "delegate_task",
    task_id: actual.task_id,
    assignee: actual.assignee,
    revision_number: actual.revision_number,
    handoff_id: "handoff-poc-001",
    run_id: "opencode-run-poc-001",
    idempotency_key: `delegate:${actual.task_id}:${actual.revision_number}`,
  };
}
