// The project's own check, run by the platform (0143, rc.131).
//
// review-evidence.mjs deliberately runs nothing the project owns; this does,
// and only this: the one command the owner set for the project, at the end of
// an implementation or revision, before the completion is accepted. It runs as
// the account that just ran the executor, in that runtime's sandbox shell
// (bubblewrap, its login covered, its own PID namespace) and with no network
// — the same reach the executor's own `npm test` had, minus the network — and
// it is killed at the project's timeout. Its outcome joins the
// platform-verified checks; prepare_publish refuses evidence whose platform
// checks did not all pass.

export const CHECK_NAME = "project_checks";
const OUTPUT_TAIL = 3000;

// The end of what the command printed, where test runners put the summary.
export function outputTail(stdout, stderr, limit = OUTPUT_TAIL) {
  const text = [String(stdout ?? ""), String(stderr ?? "")].filter((part) => part.trim()).join("\n--- stderr ---\n");
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

// The platform check the evidence carries.
export function checkResult({ command, code, timedOut = false, error = null, seconds, stdout = "", stderr = "", timeoutSeconds }) {
  const tail = outputTail(stdout, stderr);
  if (error) {
    return { name: CHECK_NAME, status: "failed", command, detail: `\`${command}\` could not run: ${String(error).slice(0, 300)}`, output: tail };
  }
  if (timedOut) {
    return { name: CHECK_NAME, status: "failed", command, detail: `\`${command}\` did not finish within ${timeoutSeconds} s and was stopped`, output: tail };
  }
  return {
    name: CHECK_NAME, status: code === 0 ? "passed" : "failed", command,
    detail: code === 0 ? `\`${command}\` passed in ${seconds} s (run by the platform, without network)`
      : `\`${command}\` exited ${code} after ${seconds} s (run by the platform, without network)`,
    output: tail,
  };
}

// Runs it. `spawnCheck(args, { timeout })` is the caller's: the supervisor binds
// it to runuser, the account, the workspace and the sandbox environment, and it
// resolves to { code, stdout, stderr } or rejects on timeout.
export async function runProjectCheck({ command, timeoutSeconds, spawnCheck, now = () => Date.now() }) {
  const started = now();
  const seconds = () => Math.round((now() - started) / 100) / 10;
  try {
    const result = await spawnCheck(["-c", command], { timeout: timeoutSeconds * 1000 });
    return checkResult({ command, code: result.code, seconds: seconds(), stdout: result.stdout, stderr: result.stderr, timeoutSeconds });
  } catch (error) {
    const timedOut = /exceeded \d+ ms/.test(String(error?.message));
    return checkResult({ command, timedOut, error: timedOut ? null : error?.message ?? error, seconds: seconds(), timeoutSeconds,
      stdout: error?.stdout, stderr: error?.stderr });
  }
}
