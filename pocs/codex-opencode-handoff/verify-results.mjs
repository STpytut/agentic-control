import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const report = JSON.parse(
  await readFile(path.join(here, "artifacts/latest-result.json"), "utf8"),
);
const failures = Object.entries(report.capabilities)
  .filter(([, passed]) => passed !== true)
  .map(([name]) => name);

console.log(
  JSON.stringify(
    {
      passed: failures.length === 0,
      interface: report.interface,
      codexThreadId: report.threadId,
      openCodeSessionId: report.workerRun?.sessionId,
      ownership: report.ownership,
      checks: report.capabilities,
      failures,
    },
    null,
    2,
  ),
);

if (failures.length > 0) process.exit(1);
