// A Codex review's tokens, from its own session files (rc.146).
//
// `codex exec review --json` reports zero usage on its stream (0.160 on the
// host): the review runs as a subagent session whose `token_count` events go
// only to its rollout file. The supervisor, which made the scratch repository
// the review ran in, finds the sessions whose `session_meta.cwd` is that
// repository — no other run shares it — and counts each one's last running
// total. Unknown is null, never a guess.

import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const obj = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);
const count = (value) => (Number.isInteger(value) && value >= 0 && value <= 1e12 ? value : 0);

// The day directories a run that started at `since` may have written into.
function dayDirectories(root, since, now) {
  const days = new Set();
  for (let t = since.getTime() - 86_400_000; t <= now.getTime() + 86_400_000; t += 86_400_000) {
    for (const date of [new Date(t)]) {
      const pad = (n) => String(n).padStart(2, "0");
      days.add(path.join(root, String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())));
      days.add(path.join(root, String(date.getUTCFullYear()), pad(date.getUTCMonth() + 1), pad(date.getUTCDate())));
    }
  }
  return [...days];
}

// One rollout's usage, if it is a session of `cwd`: its last total.
export function rolloutUsage(text, cwd) {
  const lines = String(text ?? "").split("\n");
  let meta = null;
  try { meta = JSON.parse(lines[0] ?? ""); } catch { return null; }
  if (meta?.type !== "session_meta" || obj(meta.payload)?.cwd !== cwd) return null;
  let total = null;
  for (const line of lines) {
    if (!line.includes('"token_count"')) continue;
    try {
      const event = JSON.parse(line);
      const usage = obj(obj(obj(event.payload)?.info)?.total_token_usage);
      if (usage) total = usage;
    } catch {}
  }
  if (!total) return { input: 0, cache_read: 0, output: 0, reasoning: 0 };
  const input = count(total.input_tokens);
  const cached = Math.min(count(total.cached_input_tokens), input);
  const output = count(total.output_tokens);
  const reasoning = Math.min(count(total.reasoning_output_tokens), output);
  return { input: input - cached, cache_read: cached, output: output - reasoning, reasoning };
}

export async function reviewSessionUsage({ sessionsRoot, cwd, since, now = new Date(), maxFiles = 400 }) {
  const sum = { input: 0, cache_read: 0, output: 0, reasoning: 0 };
  let found = 0;
  for (const directory of dayDirectories(sessionsRoot, since, now)) {
    let names = [];
    // Rollouts are named by their start time, so the last by name are the newest.
    try { names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort().slice(-maxFiles); } catch { continue; }
    for (const name of names) {
      const file = path.join(directory, name);
      try {
        // Root reads these under a runtime user's home: a link is not followed.
        const info = await lstat(file);
        if (!info.isFile() || info.mtimeMs < since.getTime() - 60_000 || info.size > 64 * 1024 * 1024) continue;
        const usage = rolloutUsage(await readFile(file, "utf8"), cwd);
        if (!usage) continue;
        found += 1;
        for (const key of Object.keys(sum)) sum[key] += usage[key];
      } catch {}
    }
  }
  return found ? sum : null;
}
