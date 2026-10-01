// The platform's commands for a Claude Code turn (sprint C K2): a minimal MCP
// stdio server that carries delegate_task and request_revision to the run's
// tool socket — what the tool files in opencode-tools/ are for OpenCode.
//
// Claude Code starts it from the run's `--mcp-config` as the runtime's user,
// and it inherits the run's environment: the socket, the run's capability and
// the session the supervisor chose. None of them is in the config, the argv or
// the model's context. The model can call only the tools listed here, with
// arguments the socket checks again; what a call may do is the supervisor's
// to decide (server.mjs, servePlatformTool), under the job's lease.
//
// Newline-delimited JSON-RPC 2.0, MCP's stdio framing. Bounded: a line over
// 1 MiB ends the process rather than being buffered. The tool-use id Claude
// Code sends in `_meta` is the call's id, which is what makes a repeated call
// the same call to the database.

import { realpathSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { PLATFORM_COMMAND_TOOLS, WORKER_REPORT_TOOL_CONTRACTS } from "../drivers/tool-contracts.mjs";

export const MAX_LINE = 1024 * 1024;
const PROTOCOL_VERSION = "2025-06-18";

// Which tools this bridge serves: an orchestrator's commands, or — for a run
// that writes (Stage 12 X1/X2), INFRA_BRIDGE_TOOLS=reports — the executor's
// terminal reports. Never both: a run is one or the other.
function reportsBridge(environment = process.env) {
  return environment.INFRA_BRIDGE_TOOLS === "reports";
}

export function toolList(environment = process.env) {
  const tools = reportsBridge(environment) ? WORKER_REPORT_TOOL_CONTRACTS : PLATFORM_COMMAND_TOOLS;
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

// One call to the run's socket: one line out, one answer back, then closed.
export function callSocket(request, { socketPath, capability, connect = net.createConnection } = {}) {
  return new Promise((resolve, reject) => {
    if (!socketPath || !capability) {
      reject(new Error("platform command channel is unavailable"));
      return;
    }
    const socket = connect(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...request, capability })}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length > MAX_LINE) socket.destroy(new Error("the platform's answer is oversized"));
    });
    socket.once("error", reject);
    socket.once("close", () => {
      try {
        resolve(JSON.parse(response.trim()));
      } catch {
        reject(new Error("the platform's answer is not JSON"));
      }
    });
  });
}

// The answer to one JSON-RPC message, or null for a notification.
export async function handleMessage(message, { environment = process.env, call = callSocket } = {}) {
  const { id, method, params } = message ?? {};
  if (id === undefined || id === null) return null;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  if (method === "initialize") {
    return reply({
      protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "infra-cod-platform", version: "1.0.0" },
    });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: toolList(environment) });
  if (method === "tools/call") {
    const name = params?.name;
    const text = (value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
    if (reportsBridge(environment)) {
      const contract = WORKER_REPORT_TOOL_CONTRACTS.find((tool) => tool.name === name);
      if (!contract) return reply({ isError: true, content: text(`unknown tool ${String(name).slice(0, 80)}`) });
      try {
        const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
        const answer = await call(contract.message(args, {
          sessionId: environment.INFRA_NATIVE_SESSION_ID ?? null, runId: environment.INFRA_WORKER_RUN_ID ?? "",
        }), { socketPath: environment.INFRA_WORKER_TOOL_SOCKET, capability: environment.INFRA_WORKER_CAPABILITY });
        return reply({ isError: !answer?.ok, content: text(answer?.ok ? answer.result : { error: answer?.error ?? "the report was rejected" }) });
      } catch (error) {
        return reply({ isError: true, content: text(String(error?.message ?? error)) });
      }
    }
    if (!PLATFORM_COMMAND_TOOLS.some((tool) => tool.name === name)) {
      return reply({ isError: true, content: text(`unknown tool ${String(name).slice(0, 80)}`) });
    }
    const toolUseId = params?._meta?.["claudecode/toolUseId"];
    try {
      const answer = await call({
        type: name,
        native_session_id: environment.INFRA_NATIVE_SESSION_ID ?? null,
        call_id: typeof toolUseId === "string" && toolUseId ? toolUseId : `mcp:${environment.INFRA_WORKER_RUN_ID ?? ""}:${id}`,
        arguments: params?.arguments && typeof params.arguments === "object" ? params.arguments : {},
      }, { socketPath: environment.INFRA_WORKER_TOOL_SOCKET, capability: environment.INFRA_WORKER_CAPABILITY });
      return reply({ isError: !answer?.ok, content: text(answer?.ok ? answer.result : { error: answer?.error ?? "platform command rejected" }) });
    } catch (error) {
      return reply({ isError: true, content: text(String(error?.message ?? error)) });
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(method).slice(0, 80)}` } };
}

export function serve({ input = process.stdin, output = process.stdout, environment = process.env, exit = process.exit } = {}) {
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE && !buffer.includes("\n")) exit(3);
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      void handleMessage(message, { environment }).then((answer) => {
        if (answer) output.write(`${JSON.stringify(answer)}\n`);
      });
    }
  });
  input.on("end", () => exit(0));
}

// Started as a program — through the release's `current` link, which Node
// resolves for the module and not for argv — or imported by its test.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
