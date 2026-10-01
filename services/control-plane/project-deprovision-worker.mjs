// Project deprovision worker (7.1E).
//
// Claims deletion-ready projects (past their grace deadline) and orchestrates
// destructive cleanup through the Runtime Supervisor's authenticated
// `deprovision_project` operation:
//
//   1. The Supervisor interrupts active jobs worker-first (native interrupt →
//      receipts), then uses its own bounded fallback (SIGTERM → SIGKILL of the
//      recorded runtime process groups) and refuses to proceed while any
//      writer process is alive.
//   2. The Supervisor removes only the specific project workspace after
//      proving containment under PROJECT_WORKSPACE_ROOT (realpath; rejects `/`,
//      the root, home, empty paths, glob and symlink escapes), removes
//      project-scoped deploy-key material, then re-verifies absence.
//
// Shared Codex/OpenCode homes, provider connections, GitHub App installations
// and remote repositories are never touched. Partial failure leaves the
// project in `deletion_failed` for an idempotent retry; success is never
// reported after a partial cleanup. The worker itself (infra-control) never
// performs filesystem mutation — only the root Supervisor may unlink runtime
// users' files.

import { queryJson, closePool } from "./db.mjs";
import { RuntimeSupervisorClient } from "../runtime-supervisor/client.mjs";
import { isMain } from "./entrypoint.mjs";
import { redactError, runPollLoop, shutdownSignal } from "./worker-loop.mjs";

const workerId = process.env.DEPROVISION_WORKER_ID ?? `project-deprovision-worker-${process.pid}`;
const pollMs = Number(process.env.DEPROVISION_POLL_MS ?? 60_000);
const cleanupLease = process.env.DEPROVISION_LEASE ?? "10 minutes";

// The redaction and the bounds live in worker-loop.mjs; this names the
// fallback sentence for this service.
const safeError = (error, fallback = "Project cleanup failed.", transientValues = []) =>
  redactError(error, fallback, transientValues);

async function processCleanup(project) {
  const supervisor = new RuntimeSupervisorClient();
  await supervisor.connect();
  try {
    const result = await supervisor.deprovisionProject({
      projectId: project.project_id,
      workerId,
    });
    if (!result?.workspace_removed) {
      throw new Error("supervisor did not confirm workspace absence");
    }
    const complete = await queryJson(
      `SELECT complete_project_cleanup(:'project_id'::uuid,:'worker_id')::text;`,
      { project_id: project.project_id, worker_id: workerId },
    );
    return { ...complete, receipts: result.receipts ?? [] };
  } finally {
    supervisor.close();
  }
}

export async function releaseCleanupClaim(project, message, runQuery = queryJson) {
  let released;
  try {
    released = await runQuery(
      `SELECT release_project_cleanup(:'project_id'::uuid,:'worker_id',:'reason')::text;`,
      { project_id: project.project_id, worker_id: workerId, reason: message },
    );
  } catch (error) {
    return {
      kind: "project_cleanup_release_failed", project_id: project.project_id,
      error: safeError(error, "Cleanup claim release failed."),
    };
  }
  if (!released) {
    return {
      kind: "project_cleanup_lease_lost", project_id: project.project_id,
      error: "cleanup claim was not held while deferring",
    };
  }
  return {
    kind: "project_cleanup_deferred", project_id: project.project_id,
    reason: message, result: released,
  };
}

async function deprovisionOnce() {
  const claims = await queryJson(
    `SELECT claim_project_cleanup(:'worker_id',:'limit'::integer,:'lease'::interval)::text;`,
    { worker_id: workerId, limit: process.env.DEPROVISION_BATCH_SIZE ?? "1", lease: cleanupLease },
  );
  const results = [];
  for (const project of Array.isArray(claims) ? claims : []) {
    try {
      const result = await processCleanup(project);
      results.push({ kind: "project_deprovisioned", project_id: project.project_id, result });
    } catch (error) {
      const message = safeError(error);
      // "Not now" is not a failure. Cleanup refuses to run while a system
      // workspace operation is active, and inspection runs every twenty seconds
      // per project, so collisions are routine. Recording them as
      // deletion_failed would demand an operator for something that resolves
      // itself on the next cycle.
      if (error?.retryable === true) {
        results.push(await releaseCleanupClaim(project, message));
        continue;
      }
      try {
        const failure = await queryJson(
          `SELECT fail_project_cleanup(:'project_id'::uuid,:'worker_id',:'failure_code',:'failure_message')::text;`,
          {
            project_id: project.project_id,
            worker_id: workerId,
            failure_code: "cleanup_failed",
            failure_message: message,
          },
        );
        results.push({ kind: "project_cleanup_failed", project_id: project.project_id, result: failure });
      } catch {
        results.push({ kind: "project_cleanup_lease_lost", project_id: project.project_id, error: message });
      }
    }
  }
  return results;
}

async function main() {
  if (process.argv.includes("once")) {
    const results = await deprovisionOnce();
    process.stdout.write(`${JSON.stringify({ type: "project-deprovision.once", results })}\n`);
    return;
  }
  await runPollLoop({
    name: "project-deprovision", pollMs, signal: shutdownSignal(),
    fallbackMessage: "Project cleanup failed.",
    tick: async () => {
      const results = await deprovisionOnce();
      return results.length ? results : undefined;
    },
  });
}

if (isMain(import.meta.url)) {
  main()
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ type: "project-deprovision.fatal", error: safeError(error) })}\n`);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
