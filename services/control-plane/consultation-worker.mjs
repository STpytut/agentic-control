// The analysts' runs (0147): a `consultation_run` job is one question to one
// analyst. This claims it, asks the supervisor to run the analyst read-only on
// a snapshot of the last commit, and records the answer — or why there is none
// — with finish_consultation, which tells the orchestrator either way.
//
// It runs in the orchestrator worker's process (orchestrator-worker.mjs), on
// its own loop and under its own worker id: a consultation does not wait for a
// turn, and a turn does not wait for a consultation.

import { queryJson, queryJsonRows } from "./db.mjs";
import { RuntimeSupervisorClient, cancelThrough } from "../runtime-supervisor/client.mjs";
import { waitForPoll } from "./poll-wait.mjs";
import { runLeasedJob, runPollLoop } from "./worker-loop.mjs";
import { analystInstructions, buildAnalystPrompt } from "./turn-prompts.mjs";

const LEASE = "20 minutes";
const CAPACITY_WAIT_MS = 10 * 60_000;
const CAPACITY_RETRY_MS = 30_000;

async function claimJobs(workerId) {
  return await queryJsonRows(
    `SELECT to_jsonb(j)::text FROM claim_consultation_jobs(:'worker_id', 1, :'lease'::interval) j;`,
    { worker_id: workerId, lease: LEASE },
  );
}

const finish = (job, workerId, result) => queryJson(
  `SELECT finish_consultation(:'job_id'::bigint, :'worker_id', :'result'::jsonb)::text;`,
  { job_id: job.id, worker_id: workerId, result: JSON.stringify(result) },
);

// The run's answer as finish_consultation takes it. An empty answer, or a run
// that failed, is a failure with the runtime's own reason where it gave one.
export function consultationOutcome(result, context) {
  // The database keeps 32000 characters of an answer; a longer one is cut
  // here, on a whole character, and says so.
  const full = String(result?.response ?? "").trim();
  const answer = full.length > 32000 ? `${full.slice(0, 31900).toWellFormed()}\n\n[… the answer was longer and was cut]` : full;
  const model = result?.resolved_model || context.model_display || context.model || null;
  if (result?.exit_code === 0 && answer) {
    return { status: "answered", answer, model, snapshot_sha: result.snapshot_sha ?? null };
  }
  const reason = String(result?.failure || result?.stderr?.trim().split("\n").at(-1) || "").slice(0, 300);
  return {
    status: "failed", model, snapshot_sha: result?.snapshot_sha ?? null,
    failure: answer ? `the run ended with code ${result?.exit_code}${reason ? `: ${reason}` : ""}`
      : `the analyst gave no answer${reason ? `: ${reason}` : ""}`,
  };
}

async function executeConsultation(job, { workerId, signal }) {
  const context = await queryJson(`SELECT consultation_job_context(:'job_id'::bigint, :'worker_id')::text;`,
    { job_id: job.id, worker_id: workerId });
  if (context.status !== "requested") return await finish(job, workerId, { status: "failed", failure: "already finished" });
  // A job claimed again after its worker died mid-run: a third try is not
  // going to answer where two did not.
  if (Number(job.attempt_count) > 2) return await finish(job, workerId, { status: "failed", failure: "the analyst's run was interrupted twice" });
  if (!context.analyst_enabled) return await finish(job, workerId, { status: "failed", failure: `${context.analyst} was removed from the team` });
  if (context.model_status && context.model_status !== "verified") {
    return await finish(job, workerId, { status: "failed", failure: `${context.analyst}'s model is ${context.model_status}, not verified` });
  }
  const heartbeat = setInterval(() => {
    queryJson(`SELECT to_jsonb(heartbeat_consultation_job(:'job_id'::bigint, :'worker_id', :'lease'::interval))::text;`,
      { job_id: job.id, worker_id: workerId, lease: LEASE }).catch(() => {});
  }, 60_000);
  const supervisor = new RuntimeSupervisorClient();
  // 0151: the owner may stop the question while the analyst reads; the run is
  // cancelled through the supervisor, which ends its cgroup.
  let stopped = false;
  const stopWatch = setInterval(() => {
    queryJson(`SELECT to_jsonb(consultation_stop_requested(:'job_id'::bigint, :'worker_id'))::text;`,
      { job_id: job.id, worker_id: workerId })
      .then((asked) => { if (asked === true && !stopped) { stopped = true; return cancelThrough(supervisor); } return null; })
      .catch(() => {});
  }, 5_000);
  try {
    if (context.stop_requested) return await finish(job, workerId, { status: "failed", failure: "the owner stopped the question" });
    await supervisor.connect();
    const prompt = buildAnalystPrompt(context);
    const waitUntil = Date.now() + CAPACITY_WAIT_MS;
    let result;
    for (;;) {
      try {
        result = await supervisor.run({ runtime: context.runtime_type, surface: "consult", jobId: job.id, prompt,
          systemPrompt: analystInstructions(context), workerId });
        break;
      } catch (error) {
        // A host without memory for the run: wait for one to finish, within a bound.
        if (error?.code === "runtime_capacity" && Date.now() + CAPACITY_RETRY_MS <= waitUntil && !signal?.aborted) {
          await waitForPoll(CAPACITY_RETRY_MS, signal);
          continue;
        }
        return await finish(job, workerId, { status: "failed",
          failure: stopped ? "the owner stopped the question" : String(error?.message ?? error).slice(0, 300) });
      }
    }
    if (stopped) return await finish(job, workerId, { status: "failed", failure: "the owner stopped the question" });
    return await finish(job, workerId, consultationOutcome(result, context));
  } finally {
    clearInterval(stopWatch);
    clearInterval(heartbeat);
    supervisor.close();
  }
}

export function runConsultationWorker({ workerId, signal, once = false }) {
  const pollMs = Number(process.env.CONSULTATION_POLL_MS ?? 5_000);
  return runPollLoop({
    name: "consultation", pollMs, signal, once,
    fallbackMessage: "The consultation worker cycle failed.",
    tick: async () => {
      for (const job of await claimJobs(workerId)) {
        await runLeasedJob({
          name: "consultation",
          job,
          handle: async (claimed) => ({ outcome: "completed", detail: await executeConsultation(claimed, { workerId, signal }) }),
          // A fault of the platform's own — the database, the supervisor's
          // socket — ends the consultation as failed, so the orchestrator hears
          // of it now rather than when the lease runs out. If even that cannot
          // be recorded, the lease runs out and the job is claimed again.
          classify: () => "retryable",
          report: (result, claimed) => (result.outcome === "retryable"
            ? finish(claimed, workerId, { status: "failed",
              failure: `the platform could not run the analyst: ${String(result.error?.message ?? result.error).slice(0, 300)}` })
            : undefined),
        });
      }
      return undefined;
    },
  });
}
