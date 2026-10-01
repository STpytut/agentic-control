// The models Claude's subscription offers (after Codex 0.159.3: Opus 5.5 was
// out and the catalog — three aliases — could not say so).
//
// Run by the supervisor as claude-worker, in its home, like the usage probe
// (provider-usage.mjs): it reads the login Claude Code keeps in
// ~/.claude/.credentials.json and asks Anthropic's model list with it. The
// token is read here and sent to api.anthropic.com only; it is never printed,
// passed in an argument or written anywhere. A token past its expiry is not
// refreshed — that would rotate the login under Claude Code — the answer is
// then "expired", and the next refresh, after Claude Code has renewed it, reads
// the list. What comes out is one line of JSON: model ids and names, or why
// there are none.

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function say(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  const credentials = JSON.parse(await readFile(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8"));
  const oauth = credentials?.claudeAiOauth;
  if (!oauth?.accessToken) {
    say({ error: "not_signed_in" });
  } else if (Number(oauth.expiresAt) && Number(oauth.expiresAt) <= Date.now() + 60_000) {
    say({ error: "expired" });
  } else {
    const response = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      say({ error: `http_${response.status}` });
    } else {
      const body = await response.json();
      say({ models: (Array.isArray(body?.data) ? body.data : []).map((model) => ({
        id: String(model?.id ?? ""), display_name: String(model?.display_name ?? ""), created_at: String(model?.created_at ?? ""),
      })) });
    }
  }
} catch (error) {
  say({ error: error?.name === "TimeoutError" ? "timeout" : "unreadable" });
}
