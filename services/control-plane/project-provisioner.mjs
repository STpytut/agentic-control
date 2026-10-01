import { isMain } from "./entrypoint.mjs";
import { queryJson, closePool } from "./db.mjs";
import { waitForPoll } from "./poll-wait.mjs";
import { runPollLoop, shutdownSignal } from "./worker-loop.mjs";

// Coordinates project workspace provisioning. It owns no filesystem access:
// every directory, clone and ownership change is requested as a workspace
// operation and carried out by the Runtime Supervisor, which is the only
// process privileged enough to chown a workspace to a runtime user.
//
// That split is what lets this unit run as infra-control instead of codex-worker.
// It previously ran as the sandboxed agent's own account purely so its chown
// would succeed, which meant that account also carried database access.
// See docs/adr/0011-self-hosted-access-model.md, decision 3.

const pollMs = Number(process.env.PROJECT_PROVISIONER_POLL_MS ?? 60_000);
const workerId = process.env.PROJECT_PROVISIONER_ID ?? "project-provisioner-1";

// A clone is allowed 180s by the supervisor, so the wait has to outlast it.
const operationTimeoutMs = Number(process.env.WORKSPACE_OPERATION_TIMEOUT_MS ?? 300_000);
const operationPollMs = Number(process.env.WORKSPACE_OPERATION_POLL_MS ?? 1_000);

async function claimProject() {
  return await queryJson(`
    WITH candidate AS (
      SELECT id FROM projects
      WHERE status='needs_attention'
        AND COALESCE(credential_mode,'empty')<>'github_app'
        AND (
          settings->>'provisioning_status'='pending'
          OR (settings->>'provisioning_status'='provisioning' AND updated_at<clock_timestamp()-interval '10 minutes')
        )
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ), claimed AS (
      UPDATE projects p SET
        settings=jsonb_set(p.settings,'{provisioning_status}','"provisioning"'::jsonb,true),
        updated_at=clock_timestamp()
      FROM candidate c WHERE p.id=c.id
      RETURNING p.*
    )
    SELECT jsonb_build_object(
      'id',p.id,'name',p.name,'workspace_path',p.workspace_path,'repository_url',p.repository_url,
      'default_branch',p.default_branch,'version',p.version,'credential_locator',c.secret_locator,
      'credential_mode',COALESCE(p.credential_mode,'empty')
    )::text FROM claimed p LEFT JOIN LATERAL (
      SELECT secret_locator FROM credential_references
      WHERE project_id=p.id AND provider='github_deploy_key' AND status='active'
        AND 'clone' = ANY(allowed_actions)
      ORDER BY version DESC LIMIT 1
    ) c ON true;
  `);
}

async function claimInspection() {
  return await queryJson(`
    SELECT jsonb_build_object('id',p.id,'workspace_path',p.workspace_path)::text
    FROM projects p LEFT JOIN project_workspace_states s ON s.project_id=p.id
    WHERE p.status<>'archived' AND p.settings->>'provisioning_status'='ready'
      AND (s.observed_at IS NULL OR s.observed_at<clock_timestamp()-interval '20 seconds')
    -- A workspace a run has written since it was last seen comes first. In
    -- turn, one project a cycle, a commit waited for every other project to be
    -- seen before Changes showed it — twenty minutes with ten projects (battle
    -- test, chat 1).
    -- A publish moves origin/* in the workspace too (the supervisor's
    -- recordPublishedRefs), so a finished publish counts like a finished run.
    ORDER BY (EXISTS (SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.task_id
                      WHERE t.project_id=p.id AND r.finished_at>COALESCE(s.observed_at,'-infinity'::timestamptz))
              OR EXISTS (SELECT 1 FROM publish_intents i
                      WHERE i.project_id=p.id AND i.finished_at>COALESCE(s.observed_at,'-infinity'::timestamptz))) DESC,
      s.observed_at NULLS FIRST,p.updated_at LIMIT 1;
  `);
}

// Requests a workspace operation and waits for the supervisor to finish it.
//
// One operation per project is enforced by the database. A conflict means the
// supervisor is already working on this project, which is not a provisioning
// failure — the project is released so the next cycle retries rather than being
// marked as needing attention.
class WorkspaceBusy extends Error {}

// The project moved on — deleted, archived, or reprovisioned by someone else —
// while the supervisor was working. Not a provisioning failure, and the project
// must not be written back.
class ProjectMoved extends Error {}

// The process is stopping while an operation the supervisor owns is still
// running. Not a failure of anything: the operation lives in the database, the
// supervisor is still performing it, and a stalled one is reclaimed after five
// minutes. This says "we stopped waiting", which is a different statement from
// "it did not work", and it matters because the second one marks the project as
// needing attention.
class ShuttingDown extends Error {}

async function runWorkspaceOperation(projectId, operationType, correlation, signal) {
  let requested;
  try {
    requested = await queryJson(
      `SELECT request_workspace_provisioning(
         :'project_id'::uuid,:'operation_type',:'worker_id',:'correlation')::text;`,
      { project_id: projectId, operation_type: operationType, worker_id: workerId, correlation },
    );
  } catch (error) {
    if (error.code === "23505") throw new WorkspaceBusy("a workspace operation is already in flight");
    throw error;
  }

  const operationId = requested.operation_id;
  const deadline = Date.now() + operationTimeoutMs;

  while (Date.now() < deadline) {
    const state = await queryJson(
      `SELECT workspace_operation_state(:'operation_id'::uuid,:'worker_id')::text;`,
      { operation_id: operationId, worker_id: workerId },
    );
    if (state?.status === "completed") return state.result ?? {};
    if (state?.status === "failed") throw new Error(state.error || "workspace operation failed");
    // Interruptible, but the abort is not treated as a failure. The first
    // version of this left the wait uninterruptible on the reasoning that
    // abandoning a privileged operation mid-flight is worse than waiting — which
    // is true of the operation and false of the waiting. The operation is the
    // supervisor's and lives in the database either way; only this loop's
    // patience is ours to give up. With operationTimeoutMs at five minutes
    // against TimeoutStopSec=20, not giving it up meant this service was still
    // SIGKILLed on every restart after the poll waits were fixed.
    await waitForPoll(operationPollMs, signal);
    if (signal?.aborted) throw new ShuttingDown("stopped waiting for the workspace operation: shutting down");
  }

  // Left pending or running: the supervisor reclaims a stalled operation after
  // five minutes, so saying so is more useful than inventing an outcome.
  throw new Error("the Runtime Supervisor did not complete the workspace operation in time");
}

// Puts a claimed project back so the next cycle picks it up, instead of leaving
// it parked in `provisioning` until the ten-minute stale window elapses.
async function release(project) {
  return await queryJson(`
    UPDATE projects SET
      settings=jsonb_set(settings,'{provisioning_status}','"pending"'::jsonb,true),
      updated_at=clock_timestamp()
    WHERE id=:'project_id'::uuid AND settings->>'provisioning_status'='provisioning'
    RETURNING jsonb_build_object('project_id',id)::text;
  `, { project_id: project.id });
}

async function provision(project, signal) {
  await runWorkspaceOperation(project.id, "provision_workspace", `project-provision:${project.id}`, signal);

  // Compare-and-set, not a blind update. Deletion can start while the
  // supervisor works, and matching on the project id alone would put a deleting
  // project back to active. A null result means the project is no longer the
  // one that was claimed.
  const completed = await queryJson(
    `SELECT complete_project_provisioning(:'project_id'::uuid,:'worker_id',:'correlation')::text;`,
    { project_id: project.id, worker_id: workerId, correlation: `project-provision:${project.id}` },
  );
  if (!completed) throw new ProjectMoved("the project changed state while it was being provisioned");
  return completed;
}

// Records the state the supervisor collected. The reading is privileged work
// against a workspace owned by a runtime user; the writing is not, and stays
// here so the supervisor's database surface remains narrow.
async function inspectWorkspace(project, signal) {
  const state = await runWorkspaceOperation(
    project.id, "inspect_workspace", `project-inspect:${project.id}`, signal);

  return await queryJson(`SELECT record_project_workspace_state(:'project_id'::uuid,:'collector',:'branch',:'head_sha',
    :'upstream',:'ahead'::integer,:'behind'::integer,:'dirty'::boolean,:'files'::jsonb,:'summary'::jsonb)::text;`, {
    project_id: project.id, collector: workerId,
    branch: state.branch ?? "unborn", head_sha: state.head_sha ?? "",
    upstream: state.upstream ?? "", ahead: String(state.ahead ?? 0), behind: String(state.behind ?? 0),
    dirty: String(Boolean(state.dirty)),
    files: JSON.stringify(state.files ?? []), summary: JSON.stringify(state.summary ?? {}),
  });
}

async function fail(project, error) {
  // Same fence on the failure path: a project that entered deletion must not be
  // pulled back to needs_attention by a provisioning error.
  return await queryJson(
    `SELECT fail_project_provisioning(:'project_id'::uuid,:'error')::text;`,
    { project_id: project.id, error: error.message.slice(0, 1000) },
  );
}

export async function provisionOnce({ signal } = {}) {
  const project = await claimProject();
  if (!project) {
    const inspection = await claimInspection();
    if (!inspection) return { claimed: false };
    try {
      return { claimed: true, projectId: inspection.id, inspection: await inspectWorkspace(inspection, signal) };
    } catch (error) {
      if (error instanceof WorkspaceBusy) return { claimed: true, projectId: inspection.id, busy: true };
      if (error instanceof ShuttingDown) return { claimed: true, projectId: inspection.id, stopping: true };
      return { claimed: true, projectId: inspection.id, inspectionError: error.message };
    }
  }
  try {
    return { claimed: true, projectId: project.id, result: await provision(project, signal) };
  } catch (error) {
    if (error instanceof WorkspaceBusy) {
      await release(project);
      return { claimed: true, projectId: project.id, busy: true };
    }
    if (error instanceof ProjectMoved) {
      return { claimed: true, projectId: project.id, skipped: error.message };
    }
    // Released rather than failed: the claim is given back so the next start
    // picks the project up, and nothing records a failure that did not happen.
    if (error instanceof ShuttingDown) {
      await release(project);
      return { claimed: true, projectId: project.id, stopping: true };
    }
    return { claimed: true, projectId: project.id, error: error.message, result: await fail(project, error) };
  }
}

export function runProjectProvisioner({ signal, once = false } = {}) {
  return runPollLoop({
    name: "project.provision", pollMs, signal, once,
    fallbackMessage: "The project provisioner cycle failed.",
    tick: async () => {
      const result = await provisionOnce({ signal });
      return result.claimed ? result : undefined;
    },
  });
}

async function main() {
  if (process.argv[2] === "once") {
    process.stdout.write(`${JSON.stringify(await provisionOnce())}\n`);
    return;
  }
  await runProjectProvisioner({ signal: shutdownSignal() });
}

if (isMain(import.meta.url)) {
  try { await main(); } finally { await closePool(); }
}
