// The MCP bridge that carries a Claude Code turn's platform commands to the
// run's socket (sprint C K2). What it must hold: only the platform's commands
// are offered, with the platform's schemas; a call carries the session and the
// tool-use id the database keys it by; the capability comes from the
// environment and goes only to the socket.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { callSocket, handleMessage, serve, toolList } from "../claude-mcp/platform-bridge.mjs";
import { PLATFORM_COMMAND_TOOLS } from "../drivers/tool-contracts.mjs";

const environment = {
  INFRA_WORKER_TOOL_SOCKET: "/run/tool.sock", INFRA_WORKER_CAPABILITY: "k".repeat(32),
  INFRA_WORKER_RUN_ID: "run-1", INFRA_NATIVE_SESSION_ID: "s-1",
};

test("the bridge offers the platform's commands with the platform's schemas, and nothing else", async () => {
  assert.deepEqual(toolList().map((tool) => tool.name), PLATFORM_COMMAND_TOOLS.map((tool) => tool.name));
  assert.deepEqual(toolList()[0].inputSchema, PLATFORM_COMMAND_TOOLS[0].inputSchema);
  const init = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, { environment });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, { environment }), null);
  const unknown = await handleMessage({ jsonrpc: "2.0", id: 2, method: "resources/list" }, { environment });
  assert.equal(unknown.error.code, -32601);
  const refused = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "complete_task", arguments: {} } },
    { environment, call: () => assert.fail("an unoffered tool reached the socket") });
  assert.equal(refused.result.isError, true);
});

test("a call carries the session, the tool-use id and the arguments; the answer is the socket's", async () => {
  const calls = [];
  const call = async (request, target) => { calls.push({ request, target }); return { ok: true, result: { handoff_id: "h-1" } }; };
  const args = { objective: "Add a greeting", instructions: ["Create greeting.txt"], relevant_paths: ["README.md"] };
  const answer = await handleMessage({ jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "delegate_task", arguments: args, _meta: { "claudecode/toolUseId": "toolu_9" } } }, { environment, call });
  assert.equal(answer.result.isError, false);
  assert.deepEqual(JSON.parse(answer.result.content[0].text), { handoff_id: "h-1" });
  assert.deepEqual(calls[0].request, { type: "delegate_task", native_session_id: "s-1", call_id: "toolu_9", arguments: args });
  assert.deepEqual(calls[0].target, { socketPath: "/run/tool.sock", capability: "k".repeat(32) });

  // Without a tool-use id the call is still named, by run and request.
  await handleMessage({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "request_revision", arguments: { changes_required: ["x"] } } }, { environment, call });
  assert.equal(calls[1].request.call_id, "mcp:run-1:8");

  // A refusal from the platform is the tool's error, not the bridge's crash.
  const refusal = await handleMessage({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "delegate_task", arguments: args } },
    { environment, call: async () => ({ ok: false, error: "the task was already delegated" }) });
  assert.equal(refusal.result.isError, true);
  assert.match(refusal.result.content[0].text, /already delegated/);
});

test("the capability goes to the socket in the request line and nowhere else", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "claude-bridge-"));
  const socketPath = path.join(directory, "run.sock");
  const received = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (line) => { received.push(JSON.parse(line)); socket.end(`${JSON.stringify({ ok: true, result: { accepted: true } })}\n`); });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const answer = await callSocket({ type: "delegate_task", call_id: "c" }, { socketPath, capability: "cap".repeat(8) });
    assert.deepEqual(answer, { ok: true, result: { accepted: true } });
    assert.equal(received[0].capability, "cap".repeat(8));
    await assert.rejects(callSocket({ type: "x" }, { socketPath, capability: "" }), /unavailable/);
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the stdio framing answers line by line and ignores what is not JSON", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.setEncoding("utf8");
  output.on("data", (chunk) => lines.push(...chunk.split("\n").filter(Boolean)));
  let exited = null;
  serve({ input, output, environment, exit: (code) => { exited = code; } });
  input.write("not json\n");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).result.tools.map((tool) => tool.name), ["delegate_task", "request_revision", "consult"]);
  input.end();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(exited, 0);
});

// Stage 12 X1: an executor's bridge serves its terminal reports, and each
// reaches the run's socket in the shape the OpenCode tool files send.
test("a reports bridge lists and sends the executor's terminal reports, and nothing else", async () => {
  const environment = { INFRA_BRIDGE_TOOLS: "reports", INFRA_WORKER_TOOL_SOCKET: "/run/s.sock", INFRA_WORKER_CAPABILITY: "cap",
    INFRA_WORKER_RUN_ID: "run-1", INFRA_NATIVE_SESSION_ID: "ses-1" };
  const listed = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { environment });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["complete_task", "report_blocker", "request_user_input"]);
  const sent = [];
  const call = async (message, options) => { sent.push({ message, options }); return { ok: true, result: { accepted: true } }; };
  const done = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "complete_task",
    arguments: { changed_files: ["a.txt"], checks: { tests: "passed" }, summary: "done" } } }, { environment, call });
  assert.equal(done.result.isError, false);
  assert.deepEqual(sent[0].message, { type: "complete_task", native_session_id: "ses-1",
    result_summary: { summary: "done", changed_files: ["a.txt"] }, checks_summary: { tests: "passed" }, notes: null,
    idempotency_key: "complete:run-1" });
  assert.deepEqual(sent[0].options, { socketPath: "/run/s.sock", capability: "cap" });
  await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "request_user_input",
    arguments: { question: "Which currency?" } } }, { environment, call });
  assert.deepEqual(sent[1].message, { type: "request_user_input", native_session_id: "ses-1",
    payload: { sensitivity: "normal", question: "Which currency?" }, idempotency_key: "input:run-1" });
  // An orchestrator's command is not one of an executor's tools.
  const refused = await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "delegate_task", arguments: {} } }, { environment, call });
  assert.equal(refused.result.isError, true);
  assert.equal(sent.length, 2);
  // Without the switch the bridge is the orchestrator's, as it always was.
  const commands = await handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { environment: {} });
  assert.deepEqual(commands.result.tools.map((tool) => tool.name), ["delegate_task", "request_revision", "consult"]);
});
