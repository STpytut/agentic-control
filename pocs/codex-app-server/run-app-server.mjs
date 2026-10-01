import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.join(here, "workspace");
const artifacts = path.join(here, "artifacts");
const model = process.env.CODEX_POC_MODEL ?? "gpt-5.4";
const steerFile = path.join(workspace, "app-server-steer.txt");
const interruptFile = path.join(workspace, "app-server-interrupt-should-not-exist.txt");
const approvalFile = path.join(here, "approval-outside-workspace.txt");

await mkdir(workspace, { recursive: true });
await mkdir(artifacts, { recursive: true });
await Promise.all([
  rm(steerFile, { force: true }),
  rm(interruptFile, { force: true }),
  rm(approvalFile, { force: true }),
]);

const timestamp = new Date().toISOString().replaceAll(":", "-");
const jsonlPath = path.join(artifacts, `run-${timestamp}.jsonl`);
const stderrPath = path.join(artifacts, `run-${timestamp}.stderr.log`);
const rawLines = [];
const messages = [];
const pending = new Map();
const waiters = new Set();
const approvalRequests = [];
let stderr = "";
let nextRequestId = 1;

const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
  cwd: workspace,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
  process.stderr.write(chunk);
});

const closed = new Promise((resolve) => child.once("close", resolve));
child.once("error", failAll);
child.once("close", (code) => failAll(new Error(`app-server exited with code ${code}`)));

const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  if (!line.trim()) return;
  rawLines.push(line);

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write(`Non-JSON app-server output: ${line}\n`);
    return;
  }

  messages.push(message);

  if (message.method && message.id !== undefined) {
    handleServerRequest(message);
  } else if (message.id !== undefined) {
    const request = pending.get(String(message.id));
    if (request) {
      clearTimeout(request.timer);
      pending.delete(String(message.id));
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
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

function request(method, params, timeoutMs = 45_000) {
  const id = nextRequestId++;
  send({ method, id, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(String(id));
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(String(id), { resolve, reject, timer });
  });
}

function waitFor(predicate, description, timeoutMs = 90_000) {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`Timed out waiting for ${description}`));
    }, timeoutMs);
    waiters.add(waiter);
  });
}

function failAll(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  waiters.clear();
}

function handleServerRequest(message) {
  if (
    message.method === "item/commandExecution/requestApproval" ||
    message.method === "item/fileChange/requestApproval"
  ) {
    approvalRequests.push(message);
    send({ id: message.id, result: { decision: "accept" } });
    return;
  }

  send({
    id: message.id,
    error: { code: -32601, message: `Unsupported server request: ${message.method}` },
  });
}

const textInput = (text) => [{ type: "text", text, text_elements: [] }];

async function startThread(approvalPolicy = "never") {
  const result = await request("thread/start", {
    model,
    cwd: workspace,
    approvalPolicy,
    sandbox: "workspace-write",
  });
  return result.thread.id;
}

async function startTurn(threadId, prompt) {
  const result = await request("turn/start", {
    threadId,
    input: textInput(prompt),
  });
  return result.turn.id;
}

function waitForTurn(threadId, turnId) {
  return waitFor(
    (message) =>
      message.method === "turn/completed" &&
      message.params?.threadId === threadId &&
      message.params?.turn?.id === turnId,
    `turn/completed for ${turnId}`,
  );
}

let report;
try {
  const initialize = await request("initialize", {
    clientInfo: {
      name: "infra_cod_poc",
      title: "infra_cod app-server capability PoC",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized", params: {} });

  const steerThreadId = await startThread();
  const steerTurnId = await startTurn(
    steerThreadId,
    [
      "This is an app-server steering capability test.",
      "Run the shell command `sleep 8` first.",
      "Then create app-server-steer.txt with exactly two lines:",
      "APP_SERVER_STEER_OK",
      "STEER_TOKEN=<the token supplied by the next user input during this active turn>",
      "Do not guess the token and do not finish before processing the next input.",
    ].join("\n"),
  );
  await waitFor(
    (message) =>
      message.method === "turn/started" &&
      message.params?.threadId === steerThreadId &&
      message.params?.turn?.id === steerTurnId,
    `turn/started for ${steerTurnId}`,
  );
  const steerResult = await request("turn/steer", {
    threadId: steerThreadId,
    expectedTurnId: steerTurnId,
    input: textInput("Use STEER_TOKEN=HERMES-STEER-2048 in the requested file."),
  });
  const steerCompleted = await waitForTurn(steerThreadId, steerTurnId);

  const interruptThreadId = await startThread();
  const interruptTurnId = await startTurn(
    interruptThreadId,
    [
      "This is an interrupt capability test.",
      "Run exactly the foreground shell command `sleep 60`.",
      "Only after it finishes, create app-server-interrupt-should-not-exist.txt.",
    ].join("\n"),
  );
  await waitFor(
    (message) =>
      message.method === "item/started" &&
      message.params?.threadId === interruptThreadId &&
      message.params?.turnId === interruptTurnId &&
      message.params?.item?.type === "commandExecution",
    `commandExecution item for ${interruptTurnId}`,
    45_000,
  );
  await request("turn/interrupt", {
    threadId: interruptThreadId,
    turnId: interruptTurnId,
  });
  const interruptCompleted = await waitForTurn(interruptThreadId, interruptTurnId);

  const approvalThreadId = await startThread("on-request");
  const approvalTurnId = await startTurn(
    approvalThreadId,
    [
      "This is an approval protocol capability test.",
      "Use a shell command, not apply_patch, to write exactly APP_SERVER_APPROVAL_OK followed by a newline to:",
      approvalFile,
      "The path is intentionally outside the active workspace. Request approval and wait for the client response.",
    ].join("\n"),
  );
  const approvalCompleted = await waitForTurn(approvalThreadId, approvalTurnId);

  const readOptional = async (file) => {
    try {
      return await readFile(file, "utf8");
    } catch {
      return null;
    }
  };
  const steerContents = await readOptional(steerFile);
  const interruptContents = await readOptional(interruptFile);
  const approvalContents = await readOptional(approvalFile);
  const methods = messages.map((message) => message.method).filter(Boolean);
  const methodCounts = Object.fromEntries(
    [...new Set(methods)].map((method) => [
      method,
      methods.filter((candidate) => candidate === method).length,
    ]),
  );

  report = {
    interface: "codex app-server stdio JSONL",
    model,
    initialize,
    threads: {
      steer: { threadId: steerThreadId, turnId: steerTurnId },
      interrupt: { threadId: interruptThreadId, turnId: interruptTurnId },
      approval: { threadId: approvalThreadId, turnId: approvalTurnId },
    },
    methodCounts,
    capabilities: {
      initialized: Boolean(initialize?.userAgent),
      threadStart: Boolean(steerThreadId && interruptThreadId && approvalThreadId),
      structuredStreaming: methods.includes("item/started") && methods.includes("turn/completed"),
      steerAccepted: steerResult?.turnId === steerTurnId,
      steerApplied:
        steerContents === "APP_SERVER_STEER_OK\nSTEER_TOKEN=HERMES-STEER-2048\n",
      interruptAccepted: interruptCompleted.params?.turn?.status === "interrupted",
      interruptStoppedWrite: interruptContents === null,
      approvalRequested: approvalRequests.some(
        (message) => message.params?.turnId === approvalTurnId,
      ),
      approvalApplied: approvalContents === "APP_SERVER_APPROVAL_OK\n",
      approvalTurnCompleted: approvalCompleted.params?.turn?.status === "completed",
      steerTurnCompleted: steerCompleted.params?.turn?.status === "completed",
    },
    files: {
      steer: { path: path.relative(here, steerFile), contents: steerContents },
      interrupt: { path: path.relative(here, interruptFile), contents: interruptContents },
      approval: { path: path.relative(here, approvalFile), contents: approvalContents },
    },
    artifacts: {
      jsonl: path.relative(here, jsonlPath),
      stderr: path.relative(here, stderrPath),
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
  await writeFile(jsonlPath, `${rawLines.join("\n")}\n`);
  await writeFile(stderrPath, stderr);
  if (report) {
    await writeFile(
      path.join(artifacts, "latest-result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const failures = Object.entries(report.capabilities)
  .filter(([, passed]) => passed !== true)
  .map(([name]) => name);
if (failures.length > 0) {
  process.stderr.write(`Failed capabilities: ${failures.join(", ")}\n`);
  process.exit(1);
}
