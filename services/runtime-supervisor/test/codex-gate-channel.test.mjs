import test from "node:test";
import assert from "node:assert/strict";
import { validateCodexGateInput, createCodexGateChannelStateValidator, bindCodexGateResponse } from "../codex-gate-channel.mjs";

test("gate channel accepts the pinned smoke protocol", () => {
  assert.doesNotThrow(() => validateCodexGateInput([
    JSON.stringify({ method: "initialize", id: 1, params: { clientInfo: { name: "gate", version: "1" } } }),
    JSON.stringify({ method: "initialized", params: {} }),
    JSON.stringify({ method: "thread/start", id: 2, params: { model: "gpt-5.6-sol" } }),
    JSON.stringify({ method: "turn/start", id: 3, params: { threadId: "t-1", input: [{ type: "text", text: "Reply PARITY_OK", text_elements: [] }] } }),
    JSON.stringify({ method: "turn/interrupt", id: 4, params: { threadId: "t-1", turnId: "u-1" } }),
    JSON.stringify({ method: "item/list", id: 5, params: { threadId: "t-1", turnId: "u-1" } }),
  ].join("\n")));
});

test("gate channel rejects runtime methods, writes and parameter drift", () => {
  // Stage 12 M0: a thread takes the launch's permission profile. Naming a
  // sandbox — read-only included — would replace it and uncover the login.
  for (const params of [{ model: "m", sandbox: "workspace-write" }, { model: "m", sandbox: "read-only" },
    { model: "m", approvalPolicy: "on-request" }, { model: "m", config: { default_permissions: ":workspace" } }, {}]) {
    assert.throws(
      () => validateCodexGateInput(JSON.stringify({ method: "thread/start", id: 1, params })),
      /only permits threads with an explicit model and the launch's sandbox/, JSON.stringify(params),
    );
  }
  assert.throws(
    () => validateCodexGateInput(JSON.stringify({ method: "account/read", id: 1, params: {} })),
    /does not permit account\/read/,
  );
  assert.throws(
    () => validateCodexGateInput(JSON.stringify({ method: "turn/interrupt", id: 1, params: { threadId: "t" } })),
    /turn\/interrupt parameters are invalid/,
  );
  assert.throws(
    () => validateCodexGateInput(JSON.stringify({ method: "turn/start", id: 1, params: { threadId: "t", input: [{ type: "text", text: "x", text_elements: [] }], dynamicTools: true } })),
    /turn\/start parameters are invalid/,
  );
  assert.throws(
    () => validateCodexGateInput(JSON.stringify({ method: "turn/start", id: 1, params: { threadId: "t", input: "x" } })),
    /turn\/start parameters are invalid/,
  );
  assert.throws(
    () => validateCodexGateInput(JSON.stringify({ method: "turn/start", id: 1, params: { threadId: "t", input: [{ type: "image", text: "x", text_elements: [] }] } })),
    /turn\/start parameters are invalid/,
  );
  assert.throws(
    () => validateCodexGateInput("not-json"),
    /requires JSON messages/,
  );
});

test("gate channel state binds thread/turn ids and rejects unbound references", () => {
  const state = { threadId: null, turnId: null, pending: new Map() };
  const validateState = createCodexGateChannelStateValidator(state);

  assert.throws(
    () => validateState(JSON.stringify({ method: "thread/start", id: 1, params: { model: "m", cwd: "/tmp/evil" } })),
    /does not permit a cwd parameter/,
  );

  // thread/start binds via the app-server response for the matching request id.
  validateState(JSON.stringify({ method: "thread/start", id: 1, params: { model: "m" } }));
  assert.throws(
    () => validateState(JSON.stringify({ method: "thread/start", id: 2, params: { model: "m" } })),
    /already pending/,
  );
  // A response for an unknown request id must not bind anything.
  bindCodexGateResponse(state, { id: 999, result: { thread: { id: "thread-evil" } } });
  assert.equal(state.threadId, null);
  bindCodexGateResponse(state, { id: 1, result: { thread: { id: "thread-1" } } });
  assert.equal(state.threadId, "thread-1");

  // thread/resume must reference the bound thread exactly.
  assert.throws(
    () => validateState(JSON.stringify({ method: "thread/resume", id: 3, params: { threadId: "thread-other", model: "m" } })),
    /references an unbound thread/,
  );
  validateState(JSON.stringify({ method: "thread/resume", id: 3, params: { threadId: "thread-1", model: "m" } }));
  bindCodexGateResponse(state, { id: 3, result: { thread: { id: "thread-1" } } });

  // turn/start on the bound thread; turn id bound by response for its id.
  validateState(JSON.stringify({ method: "turn/start", id: 4, params: { threadId: "thread-1", input: "PARITY_OK" } }));
  bindCodexGateResponse(state, { id: 4, result: { turn: { id: "turn-1" } } });
  assert.equal(state.turnId, "turn-1");

  // interrupt must reference the bound turn.
  validateState(JSON.stringify({ method: "turn/interrupt", id: 5, params: { threadId: "thread-1", turnId: "turn-1" } }));
  assert.throws(
    () => validateState(JSON.stringify({ method: "turn/interrupt", id: 6, params: { threadId: "thread-1", turnId: "turn-other" } })),
    /references an unbound turn/,
  );
  assert.throws(
    () => validateState(JSON.stringify({ method: "turn/start", id: 7, params: { threadId: "thread-other", input: "x" } })),
    /references an unbound thread/,
  );
  assert.throws(
    () => validateState(JSON.stringify({ method: "item/list", id: 8, params: { threadId: "thread-other" } })),
    /references an unbound thread/,
  );
  // item/list with a bound turn must reference it exactly.
  assert.throws(
    () => validateState(JSON.stringify({ method: "item/list", id: 9, params: { threadId: "thread-1", turnId: "turn-other" } })),
    /references an unbound turn/,
  );
  validateState(JSON.stringify({ method: "item/list", id: 9, params: { threadId: "thread-1", turnId: "turn-1" } }));

  // resume before any thread is bound is rejected.
  const fresh = { threadId: null, turnId: null, pending: new Map() };
  const validateFresh = createCodexGateChannelStateValidator(fresh);
  assert.throws(
    () => validateFresh(JSON.stringify({ method: "thread/resume", id: 10, params: { model: "m" } })),
    /thread is not bound/,
  );
});
