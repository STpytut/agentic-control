// The fence, as a lock the kernel holds rather than state a process remembers.
//
// Every earlier version of this lived inside one supervisor process: a map
// entry, then a map entry owned by a connection. Both closed the case where the
// *installer* dies. Neither could close the case where the *supervisor* dies,
// because a new supervisor starts with an empty map and knows nothing about the
// installation in progress. It would admit a launch, the installer would notice
// afterwards and undo the switch, and the session it admitted would be left
// running a version that is no longer active — the exact outcome the fence
// exists to prevent, reached a generation later.
//
// A kernel lock has no generations. It is held by a process, released when that
// process dies however it dies, and — the part that matters here — it is visible
// to every other process on the machine, including ones that did not exist when
// it was taken.
//
// Shared and exclusive, so the two sides need no protocol between them:
//
//   * a launch takes a SHARED lock and holds it for as long as it runs;
//   * an installation takes an EXCLUSIVE lock for the length of the switch.
//
// The kernel then guarantees both directions at once. An installation cannot
// begin while any launch is open, and no launch — from this supervisor or from
// one started a second ago — can begin while an installation holds the lock.
//
// `flock(1)` is not used: macOS does not ship it, and the suite has to run on
// the machine the code is written on. `python3` is present on every host this
// project supports and is already how the update coordinator takes dpkg's lock.

import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";

// Deliberately not under `/run/infra-cod`.
//
// That directory is the supervisor's `RuntimeDirectory=`, which means systemd
// deletes it when the unit stops. The lock would then be held on an unlinked
// inode while the restarted supervisor created a fresh file at the same path and
// took a lock on *that* — two processes each holding "the" lock, neither
// excluding the other, and the fence silently absent exactly when a restart made
// it matter most.
//
// This directory belongs to no unit's lifecycle. It is created by tmpfiles and
// outlives every service that uses it.
const FENCE_DIR = `${(process.env.INFRA_COD_INSTALL_PREFIX ?? "").trim()}/var/lib/infra-cod/runtime-fence`;

export function fenceFile(name, directory = null) {
  // The directory is read at call time, not at import time: a sandbox sets it
  // per test, and a module-level constant would freeze whichever test imported
  // this file first.
  const root = directory
    ?? process.env.INFRA_COD_RUNTIME_FENCE_DIR
    ?? FENCE_DIR;
  return path.join(root, `runtime-fence.${name}`);
}

export class FenceUnavailableError extends Error {
  constructor(name, mode) {
    super(
      mode === "shared"
        ? `${name} is being installed right now, so it cannot be launched`
        : `${name} has launches in flight, so it cannot be installed right now`,
    );
    this.name = "FenceUnavailableError";
  }
}

// Holds a lock on the runtime's fence file until `release()` is called.
//
// The lock lives in a child process, which is what makes it survive nothing:
// kill the parent, kill the child, crash either, and the kernel drops the lock.
// A PID file cannot do that, and neither can a map.
export function holdRuntimeFence(name, { mode = "shared", python = "python3", fenceDir = null } = {}) {
  const file = fenceFile(name, fenceDir);
  mkdirSync(path.dirname(file), { recursive: true });

  const lockType = mode === "exclusive" ? "fcntl.LOCK_EX" : "fcntl.LOCK_SH";
  const child = spawn(python, ["-c", [
    "import fcntl, os, sys",
    `handle = os.open(${JSON.stringify(file)}, os.O_RDWR | os.O_CREAT, 0o600)`,
    "try:",
    `    fcntl.flock(handle, ${lockType} | fcntl.LOCK_NB)`,
    "except OSError:",
    "    sys.stdout.write('busy\\n')",
    "    sys.stdout.flush()",
    "    sys.exit(3)",
    // The identity of the file the lock is actually on, so the holder can notice
    // if the path later names a different file.
    "info = os.fstat(handle)",
    "sys.stdout.write('held %d %d\\n' % (info.st_dev, info.st_ino))",
    "sys.stdout.flush()",
    // Waits on a pipe that is only closed when this process is killed or the
    // parent goes away. Holding the lock is the entire job.
    "sys.stdin.read()",
  ].join("\n")], { stdio: ["pipe", "pipe", "pipe"] });

  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve(value);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("held")) {
        const [, dev, ino] = /held (\d+) (\d+)/.exec(output) ?? [];
        finish(null, {
          release() {
            try {
              child.kill("SIGKILL");
            } catch { /* already gone, and the lock with it */ }
          },
          // True while this process still holds the lock. Unlike a socket, this
          // cannot be true while the guarantee is false: the child holding the
          // lock and the answer here are the same fact.
          held() {
            if (child.exitCode !== null || child.signalCode !== null) return false;
            // The lock is on an inode, not on a name. If the file at this path
            // is now a different file — deleted and recreated, which is what a
            // RuntimeDirectory teardown does — then this lock excludes nobody,
            // and saying it is held would be the most dangerous kind of true.
            try {
              const current = statSync(file);
              return String(current.dev) === dev && String(current.ino) === ino;
            } catch {
              return false;
            }
          },
        });
      }
      if (output.includes("busy")) finish(new FenceUnavailableError(name, mode));
    });

    child.on("error", (error) => finish(new Error(
      `the runtime fence could not be taken (${error.message}). `
      + "python3 is required for it, and is how the update coordinator takes dpkg's lock too.",
    )));
    child.on("exit", (code) => finish(
      code === 3 ? new FenceUnavailableError(name, mode) : new Error(`the runtime fence holder exited with ${code}`),
    ));
  });
}
