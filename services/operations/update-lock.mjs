// The host-wide mutation lock, shared with the installer.
//
// `install.sh` takes `flock -n` on `/run/lock/infra-cod-install.lock` and holds
// it for the whole run. An update, a rollback and — from 11.1 — a runtime
// install change the same directories, the same units and the same database, so
// they take the same lock on the same file. Inventing a second lock file would
// be inventing the ability for two of them to run at once.
//
// Node has no `flock(2)`, and the substitutes are worse than they look: an
// `O_EXCL` sidecar is not the same lock as `flock`, so it would not interlock
// with the installer at all, and it survives the process that made it. So the
// lock is held by a child `flock` process, exactly as the installer's is, and
// released by the kernel when that child exits — including when this process is
// killed, which is the case a PID file gets wrong.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LOCK_FILE } from "./release-inventory.mjs";

export class LockError extends Error {
  constructor(message) {
    super(message);
    this.name = "LockError";
  }
}

const HARNESS = (process.env.INFRA_COD_INSTALL_PREFIX ?? "").trim().length > 0;

function flockAvailable() {
  return new Promise((resolve) => {
    const probe = spawn("flock", ["--version"], { stdio: "ignore" });
    probe.on("error", () => resolve(false));
    probe.on("exit", (code) => resolve(code === 0));
  });
}

export async function acquireHostLock({ lockFile = LOCK_FILE, waitSeconds = 0 } = {}) {
  mkdirSync(path.dirname(lockFile), { recursive: true });

  if (!(await flockAvailable())) {
    // A real host without `flock` is a host where nothing can serialise these
    // commands, and proceeding would mean two updates believing they are alone.
    // The sandbox is the one place where that is not a safety claim about a
    // machine anybody depends on.
    if (!HARNESS) throw new LockError("flock is required to serialise host mutations and is not installed");
    return { held: false, reason: "flock is unavailable in the sandbox", release: async () => {} };
  }

  const args = waitSeconds > 0 ? ["-w", String(waitSeconds)] : ["-n"];
  // The child announces the lock and then blocks on a read that never returns.
  // `release()` closes its stdin, the read ends, the shell exits, and the kernel
  // drops the lock — no signal, no PID file, no cleanup path that can be skipped.
  const child = spawn("flock", [...args, lockFile, "sh", "-c", 'printf "locked\\n"; read _ignored'], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const acquired = await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("locked")) resolve(true);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(new LockError(`flock could not be started: ${error.message}`)));
    child.on("exit", () => {
      if (stdout.includes("locked")) return;
      resolve(false);
    });
    void stderr;
  });

  if (!acquired) {
    throw new LockError(
      `another infra-cod host operation holds ${lockFile}. `
      + "An installer, update, rollback or runtime install is already running; wait for it rather than forcing past it.",
    );
  }

  let released = false;
  return {
    held: true,
    lockFile,
    async release() {
      if (released) return;
      released = true;
      child.stdin.end();
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
        child.on("exit", () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

// Runs `body` with the lock held, and releases it on every path out — including
// a throw, which is the path that matters: a failed update that kept the lock
// would make the recovery command refuse to run.
export async function withHostLock(body, options = {}) {
  const lock = await acquireHostLock(options);
  try {
    return await body(lock);
  } finally {
    await lock.release();
  }
}
