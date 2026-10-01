import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.join(here, "workspace");
const artifacts = path.join(here, "artifacts");
const sessionFile = path.join(artifacts, "latest-session-id.txt");
const model = process.env.CODEX_POC_MODEL ?? "gpt-5.4";

const mode = process.argv[2] ?? "start";
const suppliedPrompt = process.argv.slice(3).join(" ").trim();

if (!new Set(["start", "resume"]).has(mode)) {
  console.error("Usage: node run-exec.mjs <start|resume> [prompt]");
  process.exit(2);
}

await mkdir(workspace, { recursive: true });
await mkdir(artifacts, { recursive: true });

const defaultStartPrompt = [
  "This is a Codex runtime capability test.",
  "Work only inside the current directory.",
  "Create a file named codex-poc-phase-one.txt with exactly two lines:",
  "CODEX_POC_PHASE_ONE_OK",
  "MEMORY_TOKEN=ATHENA-ORBIT-7319",
  "Then reply with a short confirmation.",
].join("\n");

const defaultResumePrompt = [
  "Continue this same capability-test session.",
  "Without reading codex-poc-phase-one.txt, create codex-poc-phase-two.txt with exactly two lines:",
  "CODEX_POC_RESUME_OK",
  "MEMORY_TOKEN=<the token from the previous turn>",
  "Then reply with a short confirmation.",
].join("\n");

let sessionId;
let prompt;
let args;

if (mode === "start") {
  prompt = suppliedPrompt || defaultStartPrompt;
  args = [
    "exec",
    "--json",
    "--ignore-user-config",
    "--color",
    "never",
    "--model",
    model,
    "--sandbox",
    "workspace-write",
    prompt,
  ];
} else {
  sessionId = (await readFile(sessionFile, "utf8")).trim();
  if (!sessionId) {
    throw new Error(`No session ID in ${sessionFile}`);
  }
  prompt = suppliedPrompt || defaultResumePrompt;
  args = [
    "exec",
    "resume",
    "--json",
    "--ignore-user-config",
    "--model",
    model,
    "--config",
    'sandbox_mode="workspace-write"',
    "--config",
    'approval_policy="never"',
    sessionId,
    prompt,
  ];
}

const timestamp = new Date().toISOString().replaceAll(":", "-");
const jsonlPath = path.join(artifacts, `${mode}-${timestamp}.jsonl`);
const stderrPath = path.join(artifacts, `${mode}-${timestamp}.stderr.log`);
const expectedFile = path.join(
  workspace,
  mode === "start" ? "codex-poc-phase-one.txt" : "codex-poc-phase-two.txt",
);
await rm(expectedFile, { force: true });

const child = spawn("codex", args, {
  cwd: workspace,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdoutBuffer = "";
let stderr = "";
const rawLines = [];
const events = [];

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  const lines = stdoutBuffer.split("\n");
  stdoutBuffer = lines.pop() ?? "";

  for (const line of lines) {
    consumeLine(line);
  }
});

child.stderr.on("data", (chunk) => {
  stderr += chunk;
  process.stderr.write(chunk);
});

function consumeLine(line) {
  if (!line.trim()) return;
  rawLines.push(line);

  try {
    const event = JSON.parse(line);
    events.push(event);
    process.stdout.write(`${event.type ?? "unknown"}\n`);
  } catch {
    process.stdout.write(`non-json: ${line}\n`);
  }
}

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});

if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);

const started = events.find((event) => event.type === "thread.started");
const observedSessionId = started?.thread_id ?? started?.thread?.id ?? sessionId ?? null;
const eventTypes = events.map((event) => event.type ?? "unknown");
const eventCounts = Object.fromEntries(
  [...new Set(eventTypes)].map((type) => [
    type,
    eventTypes.filter((candidate) => candidate === type).length,
  ]),
);

const expectedMemoryToken = "MEMORY_TOKEN=ATHENA-ORBIT-7319";

let expectedFileContents = null;
try {
  expectedFileContents = await readFile(expectedFile, "utf8");
} catch {
  // Reported as a failed capability below.
}

const report = {
  mode,
  model,
  command: ["codex", ...args.slice(0, -1), "<prompt>"],
  codexExitCode: exitCode,
  sessionId: observedSessionId,
  eventCounts,
  capabilities: {
    jsonlStreaming: events.length > 0,
    threadStarted: eventTypes.includes("thread.started"),
    turnStarted: eventTypes.includes("turn.started"),
    turnCompleted: eventTypes.includes("turn.completed"),
    workspaceWrite: expectedFileContents !== null,
    memoryContinuity:
      mode === "start"
        ? null
        : expectedFileContents?.includes(expectedMemoryToken) ?? false,
    sameSessionOnResume:
      mode === "start" ? null : observedSessionId === sessionId,
  },
  expectedFile: path.relative(here, expectedFile),
  expectedFileContents,
  artifacts: {
    jsonl: path.relative(here, jsonlPath),
    stderr: path.relative(here, stderrPath),
  },
  testedAt: new Date().toISOString(),
};

await writeFile(jsonlPath, `${rawLines.join("\n")}\n`);
await writeFile(stderrPath, stderr);
await writeFile(
  path.join(artifacts, `latest-${mode}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
);

if (mode === "start" && observedSessionId) {
  await writeFile(sessionFile, `${observedSessionId}\n`);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (exitCode !== 0) process.exit(exitCode || 1);
