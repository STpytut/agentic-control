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
  startExitCode: start.opencodeExitCode === 0,
  startStreaming: start.capabilities.jsonStreaming === true,
  startToolUse: start.capabilities.toolUseObserved === true,
  startCompleted: start.capabilities.stepFinished === true,
  startWrite: start.capabilities.workspaceWrite === true,
  resumeExitCode: resume.opencodeExitCode === 0,
  resumeSameSession: resume.capabilities.sameSessionOnResume === true,
  resumeCompleted: resume.capabilities.stepFinished === true,
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
      model: start.model,
      sessionId: resume.sessionId,
      reportedCost: start.usage.totalReportedCost + resume.usage.totalReportedCost,
      checks,
      failures,
    },
    null,
    2,
  ),
);

if (failures.length > 0) process.exit(1);
