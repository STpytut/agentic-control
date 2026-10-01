import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";
import {
  delegateTaskArguments,
  platformToolNamespace,
  validateDelegateTaskCall,
} from "./platform-tool-contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.join(here, "workspace");
const artifacts = path.join(here, "artifacts");
const resultFile = path.join(workspace, "platform-tool-result.txt");
const receiptFile = path.join(artifacts, "latest-delegate-receipt.json");
const reportFile = path.join(artifacts, "latest-result.json");
const model = process.env.CODEX_POC_MODEL ?? "gpt-5.4";

await mkdir(workspace, { recursive: true });
await mkdir(artifacts, { recursive: true });
await Promise.all([rm(resultFile, { force: true }), rm(receiptFile, { force: true })]);

let invalidArgumentsRejected = false;
try {
  validateDelegateTaskCall(
    {
      threadId: "thread-negative",
      turnId: "turn-negative",
      callId: "call-negative",
      namespace: "platform",
      tool: "delegate_task",
      arguments: { ...delegateTaskArguments, assignee: "unknown" },
    },
    { threadId: "thread-negative", turnId: "turn-negative" },
  );
} catch {
  invalidArgumentsRejected = true;
}

const timestamp = new Date().toISOString().replaceAll(":", "-");
const jsonlFile = path.join(artifacts, `run-${timestamp}.jsonl`);
const stderrFile = path.join(artifacts, `run-${timestamp}.stderr.log`);
const rawLines = [];
const messages = [];
const pending = new Map();
const waiters = new Set();
const toolCalls = [];
let nextId = 1;
let stderr = "";
let activeContext = null;

const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
  cwd: workspace,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
const closed = new Promise((resolve) => child.once("close", resolve));
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
  process.stderr.write(chunk);
});

const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  if (!line.trim()) return;
  rawLines.push(line);
  const message = JSON.parse(line);
  messages.push(message);

  if (message.method && message.id !== undefined) {
    void handleServerRequest(message);
  } else if (message.id !== undefined) {
    const entry = pending.get(String(message.id));
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(String(message.id));
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  }

  for (const waiter of [...waiters]) {
    if (waiter.predicate(message)) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  }
  process.stdout.write(`${message.method ?? `response:${message.id}`}\n`);
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  send({ method, id, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(String(id));
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(String(id), { resolve, reject, timer });
  });
}

function waitFor(predicate, description, timeoutMs = 120_000) {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, timer: null };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`Timed out waiting for ${description}`));
    }, timeoutMs);
    waiters.add(waiter);
  });
}

async function handleServerRequest(message) {
  if (message.method !== "item/tool/call") {
    send({
      id: message.id,
      error: { code: -32601, message: `Unsupported server request: ${message.method}` },
    });
    return;
  }

  toolCalls.push(message);
  try {
    if (!activeContext) throw new Error("tool call arrived before active context");
    const receipt = validateDelegateTaskCall(message.params, activeContext);
    await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    send({
      id: message.id,
      result: {
        contentItems: [{ type: "inputText", text: JSON.stringify(receipt) }],
        success: true,
      },
    });
  } catch (error) {
    send({
      id: message.id,
      result: {
        contentItems: [{ type: "inputText", text: `Rejected: ${error.message}` }],
        success: false,
      },
    });
  }
}

let report;
try {
  const initialize = await request("initialize", {
    clientInfo: {
      name: "infra_cod_platform_tools_poc",
      title: "infra_cod platform tools PoC",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized", params: {} });

  const threadResult = await request("thread/start", {
    model,
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    dynamicTools: [platformToolNamespace],
  });
  const threadId = threadResult.thread.id;

  const turnResult = await request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: [
          "Call platform.delegate_task exactly once using these exact JSON arguments:",
          JSON.stringify(delegateTaskArguments),
          "Do not simulate the tool and do not use shell before the tool result.",
          "After the tool succeeds, parse its JSON result and create platform-tool-result.txt with exactly three lines:",
          "PLATFORM_DELEGATE_OK",
          "HANDOFF_ID=<handoff_id returned by the tool>",
          "IDEMPOTENCY_KEY=<idempotency_key returned by the tool>",
        ].join("\n"),
        text_elements: [],
      },
    ],
  });
  const turnId = turnResult.turn.id;
  activeContext = { threadId, turnId };

  const completed = await waitFor(
    (message) =>
      message.method === "turn/completed" &&
      message.params?.threadId === threadId &&
      message.params?.turn?.id === turnId,
    `turn/completed for ${turnId}`,
  );

  const readOptional = async (file) => {
    try {
      return await readFile(file, "utf8");
    } catch {
      return null;
    }
  };
  const resultContents = await readOptional(resultFile);
  const receiptContents = await readOptional(receiptFile);
  const receipt = receiptContents ? JSON.parse(receiptContents) : null;
  const completedToolItem = messages.find(
    (message) =>
      message.method === "item/completed" &&
      message.params?.turnId === turnId &&
      message.params?.item?.type === "dynamicToolCall",
  );

  report = {
    interface: "codex app-server dynamic tools",
    model,
    initialize,
    threadId,
    turnId,
    observedToolCall: toolCalls[0]?.params ?? null,
    receipt,
    capabilities: {
      initialized: Boolean(initialize?.userAgent),
      invalidArgumentsRejected,
      dynamicToolRequested: toolCalls.length === 1,
      callContextValidated:
        toolCalls[0]?.params?.threadId === threadId &&
        toolCalls[0]?.params?.turnId === turnId,
      argumentsValidated:
        JSON.stringify(toolCalls[0]?.params?.arguments) ===
        JSON.stringify(delegateTaskArguments),
      durableReceiptWritten: receipt?.handoff_id === "handoff-poc-001",
      idempotencyKeyGenerated:
        receipt?.idempotency_key === "delegate:task-poc-001:1",
      toolResultDelivered:
        completedToolItem?.params?.item?.success === true &&
        completedToolItem?.params?.item?.contentItems?.some((item) =>
          item.text?.includes("handoff-poc-001"),
        ),
      agentContinuedAfterTool:
        resultContents ===
        "PLATFORM_DELEGATE_OK\nHANDOFF_ID=handoff-poc-001\nIDEMPOTENCY_KEY=delegate:task-poc-001:1\n",
      turnCompleted: completed.params?.turn?.status === "completed",
    },
    files: {
      result: { path: path.relative(here, resultFile), contents: resultContents },
      receipt: { path: path.relative(here, receiptFile), contents: receiptContents },
    },
    artifacts: {
      jsonl: path.relative(here, jsonlFile),
      stderr: path.relative(here, stderrFile),
    },
    testedAt: new Date().toISOString(),
  };
} finally {
  child.stdin.end();
  const exitCode = await Promise.race([
    closed,
    new Promise((resolve) =>
      setTimeout(() => {
        child.kill("SIGTERM");
        resolve(null);
      }, 2_000),
    ),
  ]);
  if (report) report.appServerExitCode = exitCode;
  await writeFile(jsonlFile, `${rawLines.join("\n")}\n`);
  await writeFile(stderrFile, stderr);
  if (report) await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
const failures = Object.entries(report.capabilities)
  .filter(([, passed]) => passed !== true)
  .map(([name]) => name);
if (failures.length > 0) {
  process.stderr.write(`Failed capabilities: ${failures.join(", ")}\n`);
  process.exit(1);
}
