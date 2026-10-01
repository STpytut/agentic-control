// OpenCode Go's subscription windows, read as the runtime's own user
// (ADR-0019). The supervisor runs this file with `runuser -u opencode-worker --
// env -i … node <this file>`; it takes no arguments, reads the Go key from that
// user's OpenCode store itself, calls one fixed address, and prints one line of
// JSON holding numbers and words from a closed list — never the key, never a
// response body. stderr is discarded by the supervisor, and the supervisor
// checks this line against the same schema before anything is recorded.
//
// Deliberately standalone: no imports beyond Node's own, so what runs as the
// runtime's user is exactly this file.

import { readFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const HOST = "opencode.ai";
const PATHNAME = "/zen/go/v1/usage";
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;
// The windows the endpoint reports, and how long each is (opencode
// console/app/src/routes/zen/go/v1/usage.ts; opencode.ai/go).
const WINDOWS = Object.freeze({ rolling: 300, weekly: 10_080, monthly: 43_200 });

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function goKey() {
  const file = path.join(os.homedir(), ".local/share/opencode/auth.json");
  const store = JSON.parse(readFileSync(file, "utf8"));
  const entry = store?.["opencode-go"];
  const key = entry && typeof entry === "object" ? entry.key : null;
  return typeof key === "string" && key.length >= 8 && key.length <= 1024 ? key : null;
}

function request(key) {
  return new Promise((resolve) => {
    const req = https.request({
      host: HOST, path: PATHNAME, method: "GET", timeout: TIMEOUT_MS,
      headers: { authorization: `Bearer ${key}`, accept: "application/json", "user-agent": "infra-cod-usage-probe" },
    }, (res) => {
      // A redirect is not followed: the one address is the only one this reads.
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); resolve({ error: "unavailable" }); return; }
      if (res.statusCode === 401) { res.resume(); resolve({ error: "unauthorized" }); return; }
      if (res.statusCode === 403) { res.resume(); resolve({ error: "not_subscribed" }); return; }
      if (res.statusCode !== 200) { res.resume(); resolve({ error: "unavailable" }); return; }
      let size = 0;
      const chunks = [];
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) { req.destroy(); resolve({ error: "malformed" }); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          resolve({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          resolve({ error: "malformed" });
        }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
    req.on("error", () => resolve({ error: "unavailable" }));
    req.end();
  });
}

// Only numbers and words from the closed list leave this function.
export function usageReading(body) {
  const usage = body?.usage;
  if (!usage || typeof usage !== "object") return { error_class: "malformed" };
  const windows = [];
  let limited = false;
  for (const [key, minutes] of Object.entries(WINDOWS)) {
    const window = usage[key];
    if (!window || typeof window !== "object") continue;
    const percent = Number(window.percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) continue;
    const resets = Date.parse(window.resetsAt);
    windows.push({
      key, used_percent: Math.round(percent * 10) / 10, window_minutes: minutes,
      ...(Number.isFinite(resets) ? { resets_at: Math.floor(resets / 1000) } : {}),
    });
    if (window.status === "rate-limited") limited = true;
  }
  if (!windows.length) return { error_class: "malformed" };
  return { windows, status: limited ? "rejected" : "allowed" };
}

async function main() {
  let key;
  try {
    key = goKey();
  } catch {
    key = null;
  }
  if (!key) {
    emit({ error_class: "unauthorized" });
    return;
  }
  const answer = await request(key);
  emit(answer.error ? { error_class: answer.error } : usageReading(answer.body));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}