// Protocol allowlist for the Codex capability-gate channel.
//
// The gate channel is narrower than the account channel and the read-only
// chat channel: it exists only to prove initialize/start/resume/stream/
// interrupt for a candidate model in a scratch workspace. Every method and
// parameter shape is pinned; anything else is rejected. The thread takes the
// launch's sandbox — from Codex 0.155.0 a permission profile that also denies
// the login (Stage 12 M0) — so it may not name one; the model must be present
// on start/resume, and interruption is limited to the active turn.

const allowedMethods = new Set([
  "initialize",
  "initialized",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt",
  "item/list",
]);

function validTextInput(input) {
  return Array.isArray(input) && input.length === 1
    && input[0] !== null && typeof input[0] === "object" && !Array.isArray(input[0])
    && input[0].type === "text"
    && typeof input[0].text === "string"
    && input[0].text.length > 0 && input[0].text.length <= 4000
    && Array.isArray(input[0].text_elements) && input[0].text_elements.length === 0
    && Object.keys(input[0]).every((key) => ["type", "text", "text_elements"].includes(key));
}

export function validateCodexGateInput(data) {
  for (const line of String(data).split("\n").filter((item) => item.trim())) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      throw new Error("Codex gate channel requires JSON messages");
    }
    if (!allowedMethods.has(message.method)) {
      throw new Error(`Codex gate channel does not permit ${String(message.method ?? "unknown")}`);
    }
    if (message.method === "initialize") {
      if (
        message.params === undefined || message.params === null
        || typeof message.params !== "object" || Array.isArray(message.params)
        || !message.params.clientInfo
      ) {
        throw new Error("Codex gate initialize parameters are invalid");
      }
    }
    if (message.method === "initialized"
        && message.params !== undefined && message.params !== null
        && (typeof message.params !== "object" || Array.isArray(message.params) || Object.keys(message.params).length)) {
      throw new Error("Codex gate initialized does not accept parameters");
    }
    if (message.method === "thread/start" || message.method === "thread/resume") {
      if (
        message.params === undefined || message.params === null
        || typeof message.params !== "object" || Array.isArray(message.params)
        || typeof message.params.model !== "string"
        || message.params.model.length < 2 || message.params.model.length > 200
        || Object.keys(message.params).some((key) => !["threadId", "model"].includes(key))
      ) {
        throw new Error("Codex gate only permits threads with an explicit model and the launch's sandbox");
      }
    }
    if (message.method === "turn/start") {
      if (
        message.params === undefined || message.params === null
        || typeof message.params !== "object" || Array.isArray(message.params)
        || typeof message.params.threadId !== "string"
        || !validTextInput(message.params.input)
        || Object.keys(message.params).some((key) => !["threadId", "input", "clientUserMessageId"].includes(key))
      ) {
        throw new Error("Codex gate turn/start parameters are invalid");
      }
    }
    if (message.method === "turn/interrupt") {
      if (
        message.params === undefined || message.params === null
        || typeof message.params !== "object" || Array.isArray(message.params)
        || typeof message.params.threadId !== "string"
        || typeof message.params.turnId !== "string"
        || Object.keys(message.params).some((key) => !["threadId", "turnId"].includes(key))
      ) {
        throw new Error("Codex gate turn/interrupt parameters are invalid");
      }
    }
    if (message.method === "item/list") {
      if (
        message.params === undefined || message.params === null
        || typeof message.params !== "object" || Array.isArray(message.params)
        || Object.keys(message.params).some((key) => !["threadId", "turnId"].includes(key))
      ) {
        throw new Error("Codex gate item/list parameters are invalid");
      }
    }
  }
}

// Stateful gate-protocol enforcement layered on the stateless validator.
//
// The gate channel is a strict state machine:
//   - the scratch workspace is fixed by the channel process (cwd), never by a
//     message;
//   - thread/start and turn/start are pending until the app-server response
//     with the matching request id arrives (bindCodexGateResponse);
//   - only one thread/start may be in flight at a time; a second start before
//     the first response is rejected;
//   - thread/resume must reference the bound threadId exactly;
//   - turn/start, turn/interrupt and item/list may only reference the bound
//     thread/turn ids.
//
// `state` is the per-channel gate state:
//   { threadId, turnId, pending: Map<requestId, method> }
export function createCodexGateChannelStateValidator(state) {
  return function validateCodexGateChannelState(data) {
    for (const line of String(data).split("\n").filter((item) => item.trim())) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error("Codex gate channel requires JSON messages");
      }
      if (message.params && typeof message.params === "object" && "cwd" in message.params) {
        throw new Error("Codex gate channel does not permit a cwd parameter");
      }
      if (message.method === "thread/start") {
        if (state.threadId) throw new Error("Codex gate thread is already started");
        const pendingStart = [...state.pending.values()].find((method) => method === "thread/start");
        if (pendingStart) throw new Error("Codex gate thread/start is already pending");
        state.pending.set(String(message.id), "thread/start");
      }
      if (message.method === "thread/resume") {
        if (!state.threadId) throw new Error("Codex gate thread is not bound");
        if (message.params?.threadId !== state.threadId) {
          throw new Error("Codex gate thread/resume references an unbound thread");
        }
        if (state.pending.has(String(message.id))) throw new Error("Codex gate thread/resume is already pending");
        state.pending.set(String(message.id), "thread/resume");
      }
      if (message.method === "turn/start") {
        if (!state.threadId) throw new Error("Codex gate thread is not bound");
        if (message.params?.threadId !== state.threadId) {
          throw new Error("Codex gate turn/start references an unbound thread");
        }
        if (state.pending.has(String(message.id))) throw new Error("Codex gate turn/start is already pending");
        state.pending.set(String(message.id), "turn/start");
      }
      if (message.method === "turn/interrupt") {
        if (!state.threadId || !state.turnId) {
          throw new Error("Codex gate turn is not bound");
        }
        if (message.params?.threadId !== state.threadId || message.params?.turnId !== state.turnId) {
          throw new Error("Codex gate turn/interrupt references an unbound turn");
        }
        if (state.pending.has(String(message.id))) throw new Error("Codex gate turn/interrupt is already pending");
        state.pending.set(String(message.id), "turn/interrupt");
      }
      if (message.method === "item/list") {
        if (message.params?.threadId !== state.threadId) {
          throw new Error("Codex gate item/list references an unbound thread");
        }
        if (state.turnId && message.params?.turnId && message.params?.turnId !== state.turnId) {
          throw new Error("Codex gate item/list references an unbound turn");
        }
        if (state.pending.has(String(message.id))) throw new Error("Codex gate item/list is already pending");
        state.pending.set(String(message.id), "item/list");
      }
    }
  };
}

// Bind thread/turn ids and resolve pending requests from app-server responses.
// Only a response whose id matches a pending request may advance the state,
// so a stray or reordered response can never bind an unrelated id.
export function bindCodexGateResponse(state, response) {
  if (!response || typeof response !== "object" || response.id === undefined) return state;
  const pendingMethod = state.pending.get(String(response.id));
  if (!pendingMethod || response.method) return state;
  state.pending.delete(String(response.id));
  if (response.error) return state;
  if (pendingMethod === "thread/start" || pendingMethod === "thread/resume") {
    if (response.result?.thread?.id) state.threadId = response.result.thread.id;
  }
  if (pendingMethod === "turn/start") {
    if (response.result?.turn?.id) state.turnId = response.result.turn.id;
  }
  return state;
}
