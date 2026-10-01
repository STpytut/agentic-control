import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

const start = JSON.parse(
  await readFile(path.join(here, "artifacts/latest-start.json"), "utf8"),
);
const resume = JSON.parse(
  await readFile(path.join(here, "artifacts/latest-resume.json"), "utf8"),
);

const checks = {
  startExitCode: start.codexExitCode === 0,
  startThread: start.capabilities.threadStarted === true,
  startCompleted: start.capabilities.turnCompleted === true,
  startWrite: start.capabilities.workspaceWrite === true,
  resumeExitCode: resume.codexExitCode === 0,
  resumeSameSession: resume.capabilities.sameSessionOnResume === true,
  resumeCompleted: resume.capabilities.turnCompleted === true,
  resumeWrite: resume.capabilities.workspaceWrite === true,
  memoryContinuity: resume.capabilities.memoryContinuity === true,
};

const failures = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);

console.log(
  JSON.stringify(
    {
      passed: failures.length === 0,
      sessionId: resume.sessionId,
      checks,
      failures,
    },
    null,
    2,
  ),
);

if (failures.length > 0) process.exit(1);
