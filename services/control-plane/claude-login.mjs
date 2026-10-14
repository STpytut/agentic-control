// A runtime's sign-in from the panel by a pasted code (rc.123; migration 0136;
// generalised for Antigravity in rc.150).
//
// The runtime's sign-in, run by the supervisor as the runtime's user on its
// account surface, prints an authorize URL and waits on stdin for the code the
// browser shows after signing in. This shows the URL in the panel, waits for
// the owner to paste the code, hands it to the same process — only that
// process holds the PKCE verifier that makes the code worth anything — and
// records how it ended. The credential is written by the runtime into its
// user's home and never passes through here.
//
// What differs between runtimes is a spec the driver declares (`input.login`):
// the link's pattern, what a success looks like, whether a run that ends well
// without showing a link was already signed in (Antigravity's headless prompt
// is), and how long the runtime waits for the code.

import { waitForPoll } from "./poll-wait.mjs";

const CLAUDE_URL_PATTERN = /https:\/\/\S+\/oauth\/authorize\?\S+/;

// Claude Code's, as rc.123 read it: `claude auth login` shows its link on
// stdout and says "Login successful".
export const CLAUDE_LOGIN = Object.freeze({
  label: "Claude Code",
  urlPattern: CLAUDE_URL_PATTERN,
  succeeded: (output, code) => /login successful/i.test(output) && (code === null || code === 0),
  signedInWithoutLink: false,
  codeWithinMs: null,
});

export async function processRuntimeLogin(session, {
  open, record, workerId, login = CLAUDE_LOGIN, signal = null, now = () => Date.now(), sleep = (ms) => waitForPoll(ms, signal),
  urlWithinMs = 60_000, codePollMs = 2_000, finishWithinMs = 90_000,
}) {
  const label = login.label ?? "The runtime";
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
      url = login.urlPattern.exec(output)?.[0] ?? null;
      if (!url) await sleep(250);
    }
    if (!url) {
      // A sign-in that ended well without asking: the runtime was signed in
      // already, and the token it holds is the one the host will report.
      if (closed && login.signedInWithoutLink && login.succeeded(output, closed.code)) {
        await step("succeeded");
        return { status: "succeeded", already: true };
      }
      throw new Error(closed ? `${label}'s sign-in ended before showing a link: ${lastLine(output, login)}` : `${label}'s sign-in showed no link`);
    }
    await step("url", url);

    // The runtime's own patience, where it has one (agy reads the code for
    // 60 s), is the panel's deadline too: a code pasted after it would reach a
    // process that has gone.
    const codeBy = login.codeWithinMs ? Math.min(expiresAt, now() + login.codeWithinMs) : expiresAt;
    let code = null;
    while (!code && !closed && !signal?.aborted && now() < codeBy) {
      code = (await step("take_code"))?.code ?? null;
      if (!code) await sleep(codePollMs);
    }
    if (!code) {
      throw new Error(closed ? `${label}'s sign-in ended while waiting for the code: ${lastLine(output, login)}`
        : login.codeWithinMs && now() >= codeBy && now() < expiresAt
          ? `${label} waits ${Math.round(login.codeWithinMs / 1000)} seconds for the code, and it did not arrive. Start it again and paste the code at once.`
          : "The sign-in link expired. Start it again.");
    }
    handle.stdin.write(`${code}\n`);

    const result = await Promise.race([exited, sleep(finishWithinMs).then(() => null)]);
    if (login.succeeded(output, result ? result.code : null) && (!result || result.code === 0)) {
      await step("succeeded");
      return { status: "succeeded" };
    }
    throw new Error(result ? `${label} did not accept the code: ${lastLine(output, login)}` : `${label} did not answer after the code was given`);
  } catch (error) {
    const message = String(error?.message ?? "The sign-in failed.").slice(0, 500);
    await step("failed", message).catch(() => {});
    return { status: "failed", error: message };
  } finally {
    if (handle && !closed) { try { handle.stdin.end(); } catch {} }
  }
}

// Claude Code's sign-in, as before rc.150.
export async function processClaudeLogin(session, options) {
  return processRuntimeLogin(session, { ...options, login: CLAUDE_LOGIN });
}

// The last thing the runtime said, without the authorize URL.
function lastLine(output, login = CLAUDE_LOGIN) {
  const lines = String(output).split(/\r?\n/)
    .map((line) => line.replace(login.urlPattern, "<link>").replace(/^.*paste code here if prompted >\s*/i, "")
      .replace(/^.*paste the authorization code here and press Enter:\s*/i, "").trim())
    .filter(Boolean);
  return (lines.at(-1) ?? "no output").slice(0, 200);
}
