// Pure helpers for deprovisioning safety. Kept separate from the worker and
// supervisor so containment and process-probe logic are unit-testable.

// A run's process_ref, as the supervisor records it. Since sprint C (K1) a run
// is `runtime-supervisor:<pid>:<cgroup leaf>`, and the leaf is what liveness
// asks: a pid can be reused and answers for one process, the leaf answers for
// everything the run started. A ref without a leaf was written by the release
// before, or by the process-group isolation the gate's container runs with,
// and is probed by pid as before. Anything else is nobody's, and fails closed.
export function parseProcessRef(raw) {
  const match = /^runtime-supervisor:(\d+)(?::([a-z]+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}))?$/.exec(String(raw ?? ""));
  if (!match) return null;
  return { pid: Number(match[1]), cgroup: match[2] ?? null };
}

// Probe a supervisor-owned writer PID. Returns true when the process exists
// (alive), false only on ESRCH. The answer for a ref that names no cgroup.
export function writerProcessAlive(pid) {
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    if (error?.code !== "ESRCH") alive = true;
  }
  return alive;
}

// Whether the run behind a parsed ref is still doing anything. A ref with a
// cgroup is answered by `cgroupAlive(name)` — the supervisor's cgroup
// isolation, fail-closed itself — and, without one to ask, is alive: the
// question cannot be answered and the caller is about to delete a workspace.
export async function writerAlive(ref, { cgroupAlive = null } = {}) {
  if (!ref) return true;
  if (ref.cgroup) {
    if (typeof cgroupAlive !== "function") return true;
    return await cgroupAlive(ref.cgroup);
  }
  return writerProcessAlive(ref.pid);
}

// Fresh-writer scan: given the DB rows for the project's task_runs (ALL
// non-null process refs, any run status — a terminal/stale run may still hold
// a live process), assert none of the process refs is alive. A ref that does
// not match the supervisor format is fail-closed (unknown writers abort);
// a missing ref is fine (a later rescan covers it). Any live writer aborts.
export async function assertNoLiveWriters(runs, { cgroupAlive = null } = {}) {
  for (const run of Array.isArray(runs) ? runs : []) {
    const raw = String(run?.process_ref ?? "");
    if (!raw) continue;
    const ref = parseProcessRef(raw);
    if (!ref) {
      throw new Error(`workspace writer process ref is not recognized: ${raw.slice(0, 120)}`);
    }
    if (await writerAlive(ref, { cgroupAlive })) {
      throw new Error(`workspace writer process ${raw} is still alive`);
    }
  }
  return true;
}

// Prove that `target` is a canonical directory strictly inside `root`
// (never `/`, never the root itself, never empty, never a glob, never a
// symlink escape). Returns the canonical path or throws.
export async function proveContainedDirectory(target, root, label) {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error(`${label} path is empty`);
  }
  if (target === "/" || target === root || target === `${root}/`) {
    throw new Error(`${label} path resolves to the root boundary`);
  }
  if (target.includes("*") || target.includes("?") || target.includes("[")) {
    throw new Error(`${label} path contains glob characters`);
  }
  const { realpath } = await import("node:fs/promises");
  let canonical;
  try {
    canonical = await realpath(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null; // absent workspace is fine for idempotent cleanup
    throw new Error(`${label} path does not resolve`);
  }
  const canonicalRoot = await realpath(root);
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}/`)) {
    throw new Error(`${label} path escapes the configured root`);
  }
  if (canonical === canonicalRoot) {
    throw new Error(`${label} path resolves to the root boundary`);
  }
  const { lstat } = await import("node:fs/promises");
  const info = await lstat(canonical);
  if (!info.isDirectory()) {
    throw new Error(`${label} path is not a directory`);
  }
  return canonical;
}
