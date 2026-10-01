import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const result = JSON.parse(await readFile(path.join(here, "artifacts/latest-result.json"), "utf8"));
const failures = Object.entries(result.capabilities)
  .filter(([, passed]) => passed !== true)
  .map(([capability]) => capability);

process.stdout.write(`${JSON.stringify({
  passed: failures.length === 0,
  runtime_version: result.runtime_version,
  model: result.model,
  capabilities: result.capabilities,
  failures,
}, null, 2)}\n`);
if (failures.length > 0) process.exit(1);
