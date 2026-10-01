import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.getuid?.() !== 0) throw new Error("OpenCode server PoC must run as root");

const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(here, "artifacts");
const model = process.env.OPENCODE_POC_MODEL ?? "opencode/north-mini-code-free";
const [providerID, ...modelParts] = model.split("/");
const modelID = modelParts.join("/");
if (!providerID || !modelID) throw new Error("OPENCODE_POC_MODEL must use provider/model format");

const runtimeUser = "opencode-worker";
const runtimeHome = "/home/opencode-worker";
const workspace = await mkdtemp(path.join(os.tmpdir(), "infra-cod-opencode-server-"));
const password = randomBytes(24).toString("hex");
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
const events = [];
const waiters = new Set();
const eventAbort = new AbortController();
let server = null;
let serverStdout = "";
let serverStderr = "";
let abortSession = null;
let inputSession = null;

function reservePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function bounded(value, limit = 64 * 1024) {
  const next = value.slice(-limit);
  return next;
}

function eventPayload(event) {
  return event?.payload?.type ? event.payload : event;
}

function rememberEvent(raw) {
  const event = eventPayload(raw);
  if (!event?.type) return;
  events.push(event);
  if (events.length > 500) events.shift();
  for (const notify of waiters) notify();
}

async function api(endpoint, { method = "GET", body, timeoutMs = 15_000 } = {}) {
  const response = await fetch(`${origin}${endpoint}`, {
    method,
    headers: {
      authorization,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${endpoint} returned ${response.status}: ${text.slice(0, 500)}`);
  if (!text) return null;
  return JSON.parse(text);
}

async function waitForEvent(predicate, description, timeoutMs = 60_000) {
  const existing = events.find(predicate);
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`timed out waiting for ${description}`));
    }, timeoutMs);
    function check() {
      const event = events.find(predicate);
      if (!event) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolve(event);
    }
    waiters.add(check);
  });
}

function belongsTo(event, sessionID) {
  return event?.properties?.sessionID === sessionID || event?.properties?.part?.sessionID === sessionID;
}

function sessionIdle(event, sessionID) {
  const status = event?.properties?.status;
  return event?.type === "session.status" && belongsTo(event, sessionID) &&
    (status === "idle" || status?.type === "idle");
}

async function startEventStream() {
  const response = await fetch(`${origin}/event`, {
    headers: { authorization },
    signal: eventAbort.signal,
  });
  if (!response.ok || !response.body) throw new Error(`SSE endpoint returned ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart()).join("\n");
          if (data) rememberEvent(JSON.parse(data));
        }
      }
    } catch (error) {
      if (!eventAbort.signal.aborted) process.stderr.write(`SSE reader failed: ${error.message}\n`);
    }
  })();
  await waitForEvent((event) => event.type === "server.connected", "server.connected", 10_000);
}

async function promptAsync(sessionID, text) {
  await api(`/session/${sessionID}/prompt_async`, {
    method: "POST",
    body: {
      agent: "build",
      model: { providerID, modelID },
      parts: [{ type: "text", text }],
    },
  });
}

function permissionRequestFor(sessionID) {
  return (event) => event.type === "permission.asked" && belongsTo(event, sessionID);
}

function questionRequestFor(sessionID) {
  return (event) => event.type === "question.asked" && belongsTo(event, sessionID);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  try { process.kill(-server.pid, "SIGTERM"); } catch {}
  await Promise.race([
    new Promise((resolve) => server.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (server.exitCode === null) {
    try { process.kill(-server.pid, "SIGKILL"); } catch {}
  }
}

await mkdir(artifacts, { recursive: true });
try {
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    permission: {
      "*": "allow",
      bash: "ask",
      question: "allow",
      task: "deny",
      external_directory: "deny",
    },
  }, null, 2)}\n`);
  execFileSync("/usr/bin/chown", ["-R", `${runtimeUser}:agent-workspace`, workspace]);

  server = spawn("/usr/sbin/runuser", [
    "-u", runtimeUser, "--", "/usr/bin/env", "-i",
    `HOME=${runtimeHome}`, "PATH=/usr/local/bin:/usr/bin:/bin", `PWD=${workspace}`,
    "LANG=C.UTF-8", "OPENCODE_DISABLE_AUTOUPDATE=true", "OPENCODE_AUTO_SHARE=false",
    "OPENCODE_SERVER_USERNAME=opencode", `OPENCODE_SERVER_PASSWORD=${password}`,
    "/usr/local/bin/opencode", "serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port),
  ], { cwd: workspace, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", (chunk) => { serverStdout = bounded(serverStdout + chunk); });
  server.stderr.on("data", (chunk) => { serverStderr = bounded(serverStderr + chunk); });

  let health = null;
  const readyBefore = Date.now() + 30_000;
  while (Date.now() < readyBefore) {
    if (server.exitCode !== null) throw new Error(`OpenCode server exited early: ${serverStderr}`);
    try {
      health = await api("/global/health", { timeoutMs: 1_000 });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!health?.healthy) throw new Error("OpenCode server did not become healthy");
  await startEventStream();

  abortSession = await api("/session", { method: "POST", body: { title: "infra_cod abort parity PoC" } });
  const marker = path.join(workspace, "abort-side-effect.txt");
  await promptAsync(abortSession.id, [
    "This is an interrupt capability test in an isolated workspace.",
    "Use the bash tool exactly once to run: sleep 30 && printf ABORT_FAILED > abort-side-effect.txt",
    "Do not create the file by another method. Wait for that command and then respond briefly.",
  ].join("\n"));
  const permissionEvent = await waitForEvent(permissionRequestFor(abortSession.id), "permission.asked", 60_000);
  const permissionRequestID = permissionEvent.properties.requestID ?? permissionEvent.properties.id;
  const permissionAccepted = await api(`/permission/${permissionRequestID}/reply`, {
    method: "POST", body: { reply: "once" },
  });
  await waitForEvent((event) => event.type === "message.part.updated" && belongsTo(event, abortSession.id) &&
    event.properties?.part?.type === "tool" && event.properties.part.tool === "bash" &&
    event.properties.part.state?.status === "running", "running bash tool", 30_000);
  const abortAccepted = await api(`/session/${abortSession.id}/abort`, { method: "POST" });
  await waitForEvent((event) => sessionIdle(event, abortSession.id), "aborted session idle", 15_000);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  let abortSideEffectPrevented = false;
  try { await readFile(marker); } catch (error) { abortSideEffectPrevented = error.code === "ENOENT"; }

  inputSession = await api("/session", { method: "POST", body: { title: "infra_cod active input parity PoC" } });
  await promptAsync(inputSession.id, [
    "This is an active input capability test.",
    "Call the question tool now and ask exactly one free-text question: What is the parity token?",
    "After the operator answers, respond exactly INPUT_ACCEPTED:<answer>. Do not use other tools.",
  ].join("\n"));
  const questionEvent = await waitForEvent(questionRequestFor(inputSession.id), "question.asked", 60_000);
  const questionRequestID = questionEvent.properties.requestID ?? questionEvent.properties.id;
  const questionAccepted = await api(`/question/${questionRequestID}/reply`, {
    method: "POST", body: { answers: [["PARITY_OK"]] },
  });
  await waitForEvent((event) => sessionIdle(event, inputSession.id), "input session idle", 60_000);
  const inputMessages = await api(`/session/${inputSession.id}/message`);
  const inputText = inputMessages.flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "text").map((part) => part.text).join("\n");

  const eventTypes = [...new Set(events.map((event) => event.type))].sort();
  const result = {
    tested_at: new Date().toISOString(),
    runtime_version: health.version,
    model,
    interface: "opencode serve localhost HTTP/SSE",
    capabilities: {
      authenticated_local_server: health.healthy === true,
      sse_stream: eventTypes.includes("server.connected") && eventTypes.includes("session.status"),
      structured_activity: eventTypes.includes("message.part.updated"),
      permission_response: permissionAccepted === true,
      abort_active_run: abortAccepted === true && abortSideEffectPrevented,
      active_input_request: questionAccepted === true && inputText.includes("INPUT_ACCEPTED:PARITY_OK"),
    },
    evidence: {
      abort_session_id: abortSession.id,
      input_session_id: inputSession.id,
      permission_request_id: permissionRequestID,
      question_request_id: questionRequestID,
      observed_event_types: eventTypes,
      abort_side_effect_prevented: abortSideEffectPrevented,
    },
  };
  await writeFile(path.join(artifacts, "latest-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (Object.values(result.capabilities).some((passed) => passed !== true)) process.exitCode = 1;
} finally {
  eventAbort.abort();
  for (const session of [abortSession, inputSession]) {
    if (!session?.id || !server || server.exitCode !== null) continue;
    try { await api(`/session/${session.id}`, { method: "DELETE", timeoutMs: 5_000 }); } catch {}
  }
  await stopServer();
  await writeFile(path.join(artifacts, "latest-server.log"), `${serverStdout}${serverStderr}`);
  await rm(workspace, { recursive: true, force: true });
}
