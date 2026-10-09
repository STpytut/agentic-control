// Pull request reviews (rc.145, 0153): a review the GitHub broker has fetched
// is claimed here, run by the supervisor with Codex's review mode in a
// scratch repository built from the pull request, and finished with the
// review and its findings — or why there is none — which the chat shows.
//
// It runs in the orchestrator worker's process, on its own loop and worker id,
// like the analysts' (consultation-worker.mjs): a review does not wait for a
// turn, and nothing it records starts one.

import { queryJson } from "./db.mjs";
import { RuntimeSupervisorClient } from "../runtime-supervisor/client.mjs";
import { waitForPoll } from "./poll-wait.mjs";
import { runPollLoop } from "./worker-loop.mjs";

const CAPACITY_WAIT_MS = 10 * 60_000;
const CAPACITY_RETRY_MS = 30_000;

const finish = (reviewId, workerId, result) => queryJson(
  `SELECT finish_pr_review(:'id'::uuid, :'worker_id', :'result'::jsonb)::text;`,
  { id: reviewId, worker_id: workerId, result: JSON.stringify(result) },
);

// The run as finish_pr_review takes it: a review with its findings, or the
// reason there is none, in the runtime's words where it gave some.
export function reviewOutcome(result, model) {
  const review = String(result?.review ?? "").trim();
  if (result?.exit_code === 0 && review) {
    return { status: "reviewed", review, findings: Array.isArray(result.findings) ? result.findings : [], model };
  }
  const reason = String(result?.failure || result?.stderr?.trim().split("\n").at(-1) || "").slice(0, 300);
  return { status: "failed", failure: review ? `the review ended with code ${result?.exit_code}${reason ? `: ${reason}` : ""}`
    : `Codex gave no review${reason ? `: ${reason}` : ""}` };
}

export async function executeReview(reviewId, { workerId, signal, supervisor = new RuntimeSupervisorClient(), db = queryJson } = {}) {
  const context = await db(`SELECT pr_review_run_context(:'id'::uuid, :'worker_id')::text;`, { id: reviewId, worker_id: workerId });
  const heartbeat = setInterval(() => {
    db(`SELECT to_jsonb(heartbeat_pr_review(:'id'::uuid, :'worker_id'))::text;`, { id: reviewId, worker_id: workerId }).catch(() => {});
  }, 60_000);
  try {
    await supervisor.connect();
    const waitUntil = Date.now() + CAPACITY_WAIT_MS;
    for (;;) {
      try {
        const result = await supervisor.run({ runtime: context.runtime_type, surface: "review", reviewId, workerId });
        return await finish(reviewId, workerId, reviewOutcome(result, context.model));
      } catch (error) {
        if (error?.code === "runtime_capacity" && Date.now() + CAPACITY_RETRY_MS <= waitUntil && !signal?.aborted) {
          await waitForPoll(CAPACITY_RETRY_MS, signal);
          continue;
        }
        return await finish(reviewId, workerId, { status: "failed", failure: String(error?.message ?? error).slice(0, 300) });
      }
    }
  } finally {
    clearInterval(heartbeat);
    supervisor.close();
  }
}

export function runPrReviewWorker({ workerId, signal, once = false }) {
  const pollMs = Number(process.env.PR_REVIEW_POLL_MS ?? 10_000);
  return runPollLoop({
    name: "pr-review", pollMs, signal, once,
    fallbackMessage: "The pull request review worker cycle failed.",
    tick: async () => {
      const claimed = await queryJson(`SELECT claim_pr_reviews(:'worker_id')::text;`, { worker_id: workerId });
      if (!claimed?.review_id) return undefined;
      try {
        return await executeReview(claimed.review_id, { workerId, signal });
      } catch (error) {
        // The platform's own fault — the database, the supervisor's socket —
        // fails the review now rather than when its lease runs out.
        await finish(claimed.review_id, workerId, { status: "failed",
          failure: `the platform could not run the review: ${String(error?.message ?? error).slice(0, 300)}` }).catch(() => undefined);
        throw error;
      }
    },
  });
}
