import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.join(here, "workspace");
const artifacts = path.join(here, "artifacts");
const sessionFile = path.join(artifacts, "latest-session-id.txt");
const model = process.env.OPENCODE_POC_MODEL ?? "opencode/north-mini-code-free";
const mode = process.argv[2] ?? "start";
const suppliedPrompt = process.argv.slice(3).join(" ").trim();

if (!new Set(["start", "resume"]).has(mode)) {
  console.error("Usage: node run-opencode.mjs <start|resume> [prompt]");
  process.exit(2);
}

await mkdir(workspace, { recursive: true });
await mkdir(artifacts, { recursive: true });

const defaultStartPrompt = [
  "This is an OpenCode runtime capability test.",
  "Work only inside the current directory.",
  "Create opencode-poc-phase-one.txt with exactly two lines:",
  "OPENCODE_POC_PHASE_ONE_OK",
  "MEMORY_TOKEN=APOLLO-WORKER-4815",
  "Then confirm briefly.",
].join("\n");

const defaultResumePrompt = [
  "Continue this same capability-test session.",
  "Without reading opencode-poc-phase-one.txt, create opencode-poc-phase-two.txt with exactly two lines:",
  "OPENCODE_POC_RESUME_OK",
  "MEMORY_TOKEN=<the token from the previous turn>",
  "Then confirm briefly.",
].join("\n");

let savedSessionId = null;
const prompt = suppliedPrompt || (mode === "start" ? defaultStartPrompt : defaultResumePrompt);
const args = [
  "run",
  "--pure",
  "--auto",
  "--format",
  "json",
  "--model",
  model,
];

if (mode === "resume") {
  savedSessionId = (await readFile(sessionFile, "utf8")).trim();
  if (!savedSessionId) throw new Error(`No session ID in ${sessionFile}`);
  args.push("--session", savedSessionId);
}
args.push(prompt);

const expectedFile = path.join(
  workspace,
  mode === "start" ? "opencode-poc-phase-one.txt" : "opencode-poc-phase-two.txt",
);
await rm(expectedFile, { force: true });

const timestamp = new Date().toISOString().replaceAll(":", "-");
const jsonlPath = path.join(artifacts, `${mode}-${timestamp}.jsonl`);
const stderrPath = path.join(artifacts, `${mode}-${timestamp}.stderr.log`);
const child = spawn("opencode", args, {
  cwd: workspace,
  env: {
    ...process.env,
    PWD: workspace,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_AUTO_SHARE: "false",
  },
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
  for (const line of lines) consumeLine(line);
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

const observedSessionIds = [...new Set(events.map((event) => event.sessionID).filter(Boolean))];
const observedSessionId = observedSessionIds[0] ?? savedSessionId;
const eventTypes = events.map((event) => event.type ?? "unknown");
const eventCounts = Object.fromEntries(
  [...new Set(eventTypes)].map((type) => [
    type,
    eventTypes.filter((candidate) => candidate === type).length,
  ]),
);

let expectedFileContents = null;
try {
  expectedFileContents = await readFile(expectedFile, "utf8");
} catch {
  // Reported by workspaceWrite below.
}

const finishEvents = events.filter((event) => event.type === "step_finish");
const costs = finishEvents
  .map((event) => event.part?.cost)
  .filter((cost) => typeof cost === "number");
const report = {
  mode,
  model,
  command: ["opencode", ...args.slice(0, -1), "<prompt>"],
  opencodeExitCode: exitCode,
  sessionId: observedSessionId,
  observedSessionIds,
  eventCounts,
  usage: {
    reportedCosts: costs,
    totalReportedCost: costs.reduce((sum, cost) => sum + cost, 0),
  },
  capabilities: {
    jsonStreaming: events.length > 0,
    stepStarted: eventTypes.includes("step_start"),
    toolUseObserved: eventTypes.includes("tool_use"),
    stepFinished: eventTypes.includes("step_finish"),
    finalTextObserved: eventTypes.includes("text"),
    workspaceWrite: expectedFileContents !== null,
    singleSessionInRun: observedSessionIds.length === 1,
    memoryContinuity:
      mode === "start"
        ? null
        : expectedFileContents?.includes("MEMORY_TOKEN=APOLLO-WORKER-4815") ?? false,
    sameSessionOnResume:
      mode === "start" ? null : observedSessionId === savedSessionId,
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
