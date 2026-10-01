// Pure helpers for the Codex capability-gate smoke. Kept separate from the
// worker so the transcript parsing is unit-testable without a runtime.

export function parseGateThreadResult(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  return response.thread?.id ?? null;
}

export function parseGateTurnResult(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  return response.turn?.id ?? null;
}

// turn/completed notification (server → client push).
export function parseGateTurnCompleted(message) {
  if (!message || message.method !== "turn/completed" || !message.params || typeof message.params !== "object") {
    return null;
  }
  const params = message.params;
  const turn = params.turn;
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return null;
  const items = Array.isArray(turn.items) ? turn.items : [];
  const agentMessage = [...items].reverse().find((item) => item?.type === "agentMessage");
  return {
    threadId: params.threadId ?? null,
    turnId: turn.id ?? null,
    status: turn.status ?? "unknown",
    agentText: typeof agentMessage?.text === "string" ? agentMessage.text : "",
  };
}

export function collectGateAgentText(messages, threadId, turnId, maximum = 8000) {
  let text = "";
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.params?.threadId !== threadId || message?.params?.turnId !== turnId) continue;
    if (message.method === "item/agentMessage/delta" && typeof message.params?.delta === "string") {
      text = `${text}${message.params.delta}`.slice(-maximum);
    }
    if (message.method === "item/completed"
        && message.params?.item?.type === "agentMessage"
        && typeof message.params.item.text === "string") {
      text = message.params.item.text.slice(-maximum);
    }
  }
  return text;
}
