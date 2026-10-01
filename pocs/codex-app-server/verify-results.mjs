import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const result = JSON.parse(
  await readFile(path.join(here, "artifacts/latest-result.json"), "utf8"),
);

const checks = result.capabilities;
const failures = Object.entries(checks)
  .filter(([, passed]) => passed !== true)
  .map(([name]) => name);

console.log(
  JSON.stringify(
    {
      passed: failures.length === 0,
      interface: result.interface,
      threads: result.threads,
      checks,
      failures,
    },
    null,
    2,
  ),
);

if (failures.length > 0) process.exit(1);
