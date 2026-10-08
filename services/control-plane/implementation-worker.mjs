import { isMain } from "./entrypoint.mjs";
import { queryJson, queryJsonRows, closePool } from "./db.mjs";
import { RuntimeSupervisorClient } from "../runtime-supervisor/client.mjs";
import { issueWorkspaceGrant } from "../runtime-supervisor/workspace-grant.mjs";
import { driverFor } from "../runtime-supervisor/drivers/index.mjs";
import { adapterFor } from "../operations/runtime-adapters.mjs";
import { InfraError } from "./failure.mjs";
import { waitForPoll } from "./poll-wait.mjs";
import { redactError, runLeasedJob, runPollLoop, shutdownSignal } from "./worker-loop.mjs";
import { buildExecutorPrompt, EXECUTOR_INSTRUCTIONS, isOperatorResponse } from "./turn-prompts.mjs";

const defaultWorkerId = process.env.RUNTIME_SUPERVISOR_ID ?? "vps-runtime-supervisor-1";

async function claimJobs({ workerId, batchSize, lease }) {
  return await queryJsonRows(
    `SELECT to_jsonb(j)::text FROM claim_executor_jobs(
      :'worker_id', :'batch_size'::integer, :'lease'::interval
    ) j;`,
    { worker_id: workerId, batch_size: batchSize, lease },
  );
}

async function heartbeat(jobId, workerId, lease, start) {
  await queryJson(
    `SELECT to_jsonb(heartbeat_runtime_job(
      :'job_id'::bigint, :'worker_id', :'lease'::interval
    ))::text;`,
    { job_id: jobId, worker_id: workerId, lease },
  );
  if (start) {
    await queryJson(
      `SELECT to_jsonb(heartbeat_workspace_lock(
        :'project_id'::uuid, :'run_id'::uuid, :'fencing_token'::bigint, :'lease'::interval
      ))::text;`,
      {
        project_id: start.project_id, run_id: start.run_id,
        fencing_token: start.fencing_token, lease,
      },
    );
  }
}

async function updateActivity(jobId, workerId, phase, detail) {
  await queryJson(
    `SELECT to_jsonb(update_runtime_job_activity(
      :'job_id'::bigint, :'worker_id', :'phase', :'detail'
    ))::text;`,
    { job_id: jobId, worker_id: workerId, phase, detail },
  );
}

// The questions the operator's answers in this handoff reply to, by report id,
// so the prompt can state question and answer together (turn-prompts.mjs).
async function answeredQuestions(context) {
  const ids = (Array.isArray(context.instructions) ? context.instructions : [])
    .filter(isOperatorResponse).map((item) => item.report_id).filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await queryJsonRows(
    `SELECT jsonb_build_object('id',r.id,'question',COALESCE(r.payload->>'question',r.payload->>'reason'))::text
     FROM worker_interaction_reports r
     WHERE r.task_id=:'task_id'::uuid AND r.id=ANY(string_to_array(:'ids',',')::uuid[]);`,
    { task_id: context.task_id, ids: ids.join(",") },
  );
  return new Map(rows.map((row) => [String(row.id), row.question ? String(row.question) : null]));
}

function buildTerminalRepairPrompt() {
  return [
    "Your implementation turn ended without the required terminal control-plane report.",
    "Do not repeat the implementation and do not respond with ordinary prose.",
    // rc.143: the role's standing rules (run checks, commit) reach this run too,
    // as its system prompt; the checks were run in the turn that ended.
    "Do not re-run the checks. If your changes are not committed yet, commit them as the instructions say.",
    "Inspect the current workspace state and call exactly one terminal control-plane tool now:",
    "complete_task if the requested changes and checks are complete, report_blocker if they cannot be completed,",
    "or request_user_input only when operator input is genuinely required.",
  ].join("\n");
}

const capacityWaitMs = Number(process.env.EXECUTOR_CAPACITY_WAIT_MS ?? 15 * 60_000);
const capacityRetryMs = Number(process.env.EXECUTOR_CAPACITY_RETRY_MS ?? 10_000);

async function executeJob(job, { workerId, lease, signal = null }) {
  const context = await queryJson(
    `SELECT executor_job_context(:'job_id'::bigint, :'worker_id')::text;`,
    { job_id: job.id, worker_id: workerId },
  );
  // The executor resumes the conversation's session, a follow-up included
  // (ADR-0014). Until the rc.26 panel run a follow-up's executor was given a
  // new session every run and its report bound to the stored one: a revision
  // resumed after the operator's answer had no memory of having asked, and the
  // new session's id was recorded nowhere.
  await updateActivity(job.id, workerId, "opening_session", context.native_session_id
    ? "Resuming the selected executor session"
    : "Creating the selected executor session");
  const start = await queryJson(
    `SELECT start_implementation_job(
      :'job_id'::bigint, :'session_id'::uuid, :'worker_id', :'lease'::interval
    )::text;`,
    { job_id: job.id, session_id: context.session_id, worker_id: workerId, lease },
  );
  // start_implementation_job took the workspace lock; each launch gets a fresh
  // read_write grant bound to that lock's fencing token. Fresh per launch, not
  // one for the job: the finalizer below can run an hour after the first launch,
  // long after a grant issued at the start would have expired. Issuing again
  // revokes the previous one. Not deferred when refused: this run holds the lock,
  // and a refusal means something is wrong, not busy.
  const freshGrantToken = async () => (await issueWorkspaceGrant(job.id, workerId, queryJson)).token;
  // The runtime of the executor this job was assigned (its snapshot, else its
  // profile): since Stage 12 X1 more than one runtime executes, so the job type
  // no longer names one. The run is its driver's task surface (WP-5b). Resolved
  // before the connection, which nothing would close if this refused.
  const driver = driverFor(context.runtime_type);
  const label = adapterFor(driver.name).display.label;
  const supervisor = new RuntimeSupervisorClient();
  await supervisor.connect();
  // A host without memory for the run refuses it before anything starts
  // (runtime_capacity, sprint C K3). This run already holds the workspace, so
  // it is not handed back to the queue: it waits here, its lease kept by the
  // heartbeat, and tries again when a run has finished — up to a bound, after
  // which the refusal is the failure it reports. `activity` is what the job
  // shows while the run goes: put back once the wait ends, or the panel said
  // "Waiting for memory" for the whole run (battle test, chat 1).
  const runTask = async (fields, activity) => {
    const waitUntil = Date.now() + capacityWaitMs;
    for (;;) {
      try {
        return await supervisor.run({
          runtime: driver.name, surface: "task",
          jobId: job.id, runId: start.run_id, projectId: context.project_id, fencingToken: start.fencing_token,
          grantToken: await freshGrantToken(), model: context.model, systemPrompt: EXECUTOR_INSTRUCTIONS, ...fields,
        });
      } catch (error) {
        if (error?.code !== "runtime_capacity" || Date.now() + capacityRetryMs > waitUntil) throw error;
        await updateActivity(job.id, workerId, "queued", "Waiting for memory on the host: another run is using it");
        // Cut short by the worker's stop, like every other wait here: a
        // restart must not wait out a host that is full.
        await waitForPoll(capacityRetryMs, signal);
        if (signal?.aborted) throw error;
        await updateActivity(job.id, workerId, ...activity);
      }
    }
  };
  // heartbeat is async now, so a surrounding try/catch would catch nothing and
  // the rejection would surface as an unhandled rejection. Catch on the promise.
  const heartbeatTimer = setInterval(() => {
    heartbeat(job.id, workerId, lease, { ...start, project_id: context.project_id })
      .catch((error) => {
        process.stderr.write(`${JSON.stringify({ type: "executor.heartbeat_failed", jobId: job.id, error: error.message })}\n`);
      });
  }, 30_000);
  try {
    // The operator reads this line in the chat: the agent's internal name
    // (executor-claude-1-<project>) meant nothing there, and the card's header
    // already names the runtime and model.
    const running = ["running_turn", Number(context.revision_number) > 1
      ? `Working on the review notes (revision ${context.revision_number})`
      : "Implementing the plan"];
    await updateActivity(job.id, workerId, ...running);
    let runtime = await runTask({
      prompt: buildExecutorPrompt(context, { questions: await answeredQuestions(context) }),
      nativeSessionId: context.native_session_id,
      terminalReportSessionId: null,
    }, running);
    const implementationSessionId = context.native_session_id ?? runtime.native_session_id;
    for (let repairAttempt = 1; runtime.missing_terminal_report && repairAttempt <= 2; repairAttempt += 1) {
      if (!implementationSessionId) throw new Error(`${label} omitted both terminal report and native session id`);
      const finalizing = ["finalizing", `Asking for the final report (${repairAttempt}/2)`];
      await updateActivity(job.id, workerId, ...finalizing);
      runtime = await runTask({
        prompt: buildTerminalRepairPrompt(),
        nativeSessionId: null,
        terminalReportSessionId: implementationSessionId,
      }, finalizing);
    }
    if (runtime.interrupted) {
      return await queryJson(`SELECT finalize_runtime_interrupt(
        :'job_id'::bigint,:'worker_id',:'native_session_id'
      )::text;`, { job_id: job.id, worker_id: workerId, native_session_id: runtime.native_session_id ?? "" });
    }
    if (runtime.exit_code !== 0) {
      // `OpenCode exited with code 1: ` — with nothing after the colon — is what
      // reached the operator when the runtime failed on a read-only model cache
      // (defect 93). It had said so; it had said so on stdout, and only stderr
      // was kept. Both are kept now, redacted and bounded, and they travel as
      // details of the failure rather than as more sentence.
      const tail = (stream) => {
        const text = typeof stream === "string" ? stream.trimEnd() : "";
        return text ? redactError(text, "", [], { maxLength: 2000, keep: "tail" }) : undefined;
      };
      throw new InfraError(`${label} exited with code ${runtime.exit_code}`, {
        code: "process_failed",
        retryable: false,
        operation: "run the implementation",
        details: {
          exit_code: runtime.exit_code,
          ...(runtime.signal ? { signal: runtime.signal } : {}),
          ...(tail(runtime.stderr) ? { stderr: tail(runtime.stderr) } : {}),
          ...(tail(runtime.stdout) ? { stdout: tail(runtime.stdout) } : {}),
        },
      });
    }
    if (runtime.missing_terminal_report) {
      // Not a transient failure (panel finding P-3). Retrying ran the whole
      // implementation again, three times, and then dead-lettered it with the
      // work already on disk and the lock held until the lease ran out. The run
      // ends here as terminal_report_missing, the lock is released now, and the
      // operator is asked how to continue; an answer resumes this session.
      return await queryJson(`SELECT finalize_unreported_run(
        :'job_id'::bigint,:'worker_id',:'native_session_id',:'detail'
      )::text;`, {
        job_id: job.id, worker_id: workerId, native_session_id: implementationSessionId ?? "",
        detail: `${label} ended its turn and two finalization turns in the same session without calling a terminal tool.`,
      });
    }
    const terminalResult = runtime.completion_result ?? runtime.interaction_result;
    if (!terminalResult || Boolean(runtime.completion_result) === Boolean(runtime.interaction_result)) {
      throw new Error(`${label} did not produce exactly one finalized terminal report`);
    }
    await updateActivity(job.id, workerId, "finalizing", "Saving the executor terminal receipt");
    await queryJson(
      `SELECT to_jsonb(acknowledge_runtime_job(
        :'job_id'::bigint, :'worker_id', :'result'::jsonb
      ))::text;`,
      { job_id: job.id, worker_id: workerId, result: JSON.stringify(terminalResult) },
    );
    return { ...terminalResult, native_session_id: runtime.completion_report?.native_session_id
      ?? runtime.interaction_report?.native_session_id };
  } finally {
    clearInterval(heartbeatTimer);
    supervisor.close();
  }
}

export function runImplementationWorker({ signal, once = false } = {}) {
  const workerId = process.env.EXECUTOR_WORKER_ID ?? defaultWorkerId;
  const pollMs = Number(process.env.EXECUTOR_POLL_MS ?? 15_000);
  const batchSize = Number(process.env.EXECUTOR_BATCH_SIZE ?? 1);
  const lease = process.env.EXECUTOR_LEASE ?? "5 minutes";
  const retryDelay = process.env.EXECUTOR_RETRY_DELAY ?? "15 seconds";
  const maxAttempts = Number(process.env.EXECUTOR_MAX_ATTEMPTS ?? 3);

  return runPollLoop({
    name: "executor", pollMs, signal, once,
    fallbackMessage: "The executor worker cycle failed.",
    tick: async () => {
      for (const job of await claimJobs({ workerId, batchSize, lease })) {
        await runLeasedJob({
          name: "executor",
          job,
          handle: async (claimed) => ({ outcome: "completed", detail: await executeJob(claimed, { workerId, lease, signal }) }),
          // Only a retry is recorded here; a completed job recorded its own
          // terminal state before it returned.
          report: (result, claimed) => result.outcome !== "retryable" ? undefined : queryJson(
            `SELECT to_jsonb(retry_runtime_job(
              :'job_id'::bigint, :'worker_id', :'error', :'delay'::interval, :'max_attempts'::integer
            ))::text;`,
            { job_id: claimed.id, worker_id: workerId, error: result.error.message, delay: retryDelay, max_attempts: maxAttempts },
          ),
        });
      }
      // The per-job lines are this cycle's log; the cycle itself has nothing to add.
      return undefined;
    },
  });
}

async function main() {
  await runImplementationWorker({ signal: shutdownSignal(), once: process.argv[2] === "once" });
}

if (isMain(import.meta.url)) {
  try { await main(); } finally { await closePool(); }
}
