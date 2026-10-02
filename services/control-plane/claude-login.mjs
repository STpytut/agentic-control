// Claude Code's sign-in from the panel (rc.123; migration 0136).
//
// `claude auth login`, run by the supervisor as claude-worker on Claude's
// account surface, prints an authorize URL and waits on stdin for the code the
// browser shows after signing in. This shows the URL in the panel, waits for
// the owner to paste the code, hands it to the same process — only that
// process holds the PKCE verifier that makes the code worth anything — and
// records how it ended. The credential is written by Claude Code into
// claude-worker's home and never passes through here.

import { waitForPoll } from "./poll-wait.mjs";

const URL_PATTERN = /https:\/\/\S+\/oauth\/authorize\?\S+/;
const SUCCESS_PATTERN = /login successful/i;

export async function processClaudeLogin(session, {
  open, record, workerId, signal = null, now = () => Date.now(), sleep = (ms) => waitForPoll(ms, signal),
  urlWithinMs = 60_000, codePollMs = 2_000, finishWithinMs = 90_000,
}) {
  const expiresAt = new Date(session.expires_at).getTime();
  let handle = null;
  let output = "";
  let closed = null;
  const step = (name, value = null) => record({ sessionId: session.id, workerId, step: name, value });
  try {
    handle = await open();
    handle.stdout.setEncoding?.("utf8");
    handle.stderr.setEncoding?.("utf8");
    handle.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8000); });
    handle.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8000); });
    const exited = new Promise((resolve) => handle.once("close", (code) => { closed = { code }; resolve(closed); }));

    const urlBy = now() + urlWithinMs;
    let url = null;
    while (!url && !closed && !signal?.aborted && now() < urlBy) {
      url = URL_PATTERN.exec(output)?.[0] ?? null;
      if (!url) await sleep(250);
    }
    if (!url) throw new Error(closed ? `Claude Code's sign-in ended before showing a link: ${lastLine(output)}` : "Claude Code's sign-in showed no link");
    await step("url", url);

    let code = null;
    while (!code && !closed && !signal?.aborted && now() < expiresAt) {
      code = (await step("take_code"))?.code ?? null;
      if (!code) await sleep(codePollMs);
    }
    if (!code) throw new Error(closed ? `Claude Code's sign-in ended while waiting for the code: ${lastLine(output)}` : "The sign-in link expired. Start it again.");
    handle.stdin.write(`${code}\n`);

    const result = await Promise.race([exited, sleep(finishWithinMs).then(() => null)]);
    if (SUCCESS_PATTERN.test(output) && (!result || result.code === 0)) {
      await step("succeeded");
      return { status: "succeeded" };
    }
    throw new Error(result ? `Claude Code did not accept the code: ${lastLine(output)}` : "Claude Code did not answer after the code was given");
  } catch (error) {
    const message = String(error?.message ?? "The sign-in failed.").slice(0, 500);
    await step("failed", message).catch(() => {});
    return { status: "failed", error: message };
  } finally {
    if (handle && !closed) { try { handle.stdin.end(); } catch {} }
  }
}

// The last thing Claude Code said, without the authorize URL.
function lastLine(output) {
  const lines = String(output).split(/\r?\n/)
    .map((line) => line.replace(URL_PATTERN, "<link>").replace(/^.*paste code here if prompted >\s*/i, "").trim())
    .filter(Boolean);
  return (lines.at(-1) ?? "no output").slice(0, 200);
}
