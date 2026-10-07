import type { ReactNode } from "react";
import { cx } from "@agentic/design-system";
import type { TaskChanges } from "@/lib/product-data";

// The chat's work steps in one line (Stage 12 N2): Plan → Implementation →
// Review → Approve → Publish, read from its newest task's status and, for a
// task that stopped, from how far its conversation got. Publish (battle test,
// chat 2) is read from where the approved task's publish stands. The status word stays beside
// it in the top bar; this is where the chat stands in the workflow.
export type StepState = "done" | "current" | "stopped" | "waiting";
const STEPS = ["Plan", "Implementation", "Review", "Approve", "Publish"] as const;

const PLAN = new Set(["draft", "planning", "ready"]);
const IMPLEMENTATION = new Set(["implementation_requested", "implementing", "changes_requested", "revising"]);
// awaiting_review: the orchestrator has reviewed; approving is the operator's step.
const REVIEW = new Set(["reviewing"]);
const APPROVE = new Set(["awaiting_review"]);
const APPROVED = new Set(["approved", "publishing", "deployed", "completed"]);

export function workSteps(status: string, eventTypes: string[], publishStage: string | null = null): StepState[] {
  if (APPROVED.has(status)) {
    const publish: StepState = publishStage === "published" ? "done"
      : publishStage === "failed" || publishStage === "refused" ? "stopped"
      : publishStage === "unavailable" ? "waiting" : "current";
    return STEPS.map((_, step) => step < 4 ? "done" : publish);
  }
  const index = PLAN.has(status) ? 0 : IMPLEMENTATION.has(status) ? 1 : REVIEW.has(status) ? 2 : APPROVE.has(status) ? 3 : -1;
  if (index >= 0) return STEPS.map((_, step) => step < index ? "done" : step === index ? "current" : "waiting");
  // needs_attention, failed, cancelled: where the conversation stopped.
  const reached = eventTypes.includes("implementation.completed") ? 2
    : eventTypes.some((type) => type.startsWith("implementation.")) ? 1 : 0;
  return STEPS.map((_, step) => step < reached ? "done" : step === reached ? "stopped" : "waiting");
}

const mark: Record<StepState, string> = { done: "✓", current: "●", stopped: "!", waiting: "" };
const tone: Record<StepState, string> = { done: "text-success font-medium", current: "text-warning font-medium", stopped: "text-danger font-medium", waiting: "text-muted" };
const word: Record<StepState, string> = { done: "done", current: "in progress", stopped: "stopped", waiting: "not started" };

const SHOWN_FILES = 6;

// The reviewed diff's files under the steps, so the decision to approve does
// not start with opening another tab to see what changed.
function ChangedFiles({ changes }: { changes: TaskChanges }) {
  const shown = changes.files.slice(0, SHOWN_FILES);
  return <div className="basis-full">
    <ul className="m-0 grid list-none gap-0.5 p-0">
      {shown.map((file) => <li key={file.path} className="type-meta flex min-w-0 items-baseline gap-2">
        <code className="type-mono-small min-w-0 flex-1 truncate" title={file.path}>{file.path}</code>
        <span className="shrink-0 tabular-nums"><span className="text-success">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span></span>
      </li>)}
    </ul>
    {changes.files.length > SHOWN_FILES && <p className="type-meta mt-0.5 text-muted">and {changes.files.length - SHOWN_FILES} more</p>}
  </div>;
}

export function StepCard({ states, executor, files, changes, action }: { states: StepState[]; executor?: string; files?: number; changes?: TaskChanges | null; action?: ReactNode }) {
  return <section aria-label="Work steps" className="mb-6 ml-11 flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-2 rounded-lg border border-line bg-canvas px-4 py-3 phone:ml-0 phone:px-3">
    <ol className="type-meta m-0 flex min-w-0 list-none flex-wrap items-center gap-x-1.5 gap-y-1 p-0">
      {STEPS.map((step, index) => <li key={step} className="flex items-center gap-1.5">
        {index > 0 && <span aria-hidden="true" className="text-muted">→</span>}
        <span className={cx(tone[states[index]])}>{mark[states[index]] && <span aria-hidden="true">{mark[states[index]]} </span>}{step}<span className="sr-only"> ({word[states[index]]})</span></span>
      </li>)}
    </ol>
    <span className="flex-1"/>
    {(executor || files !== undefined) && <span className="type-meta min-w-0 text-ink/80">{[executor ? `Executor · ${executor}` : "", files !== undefined ? `${files} file${files === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}</span>}
    {action}
    {changes && changes.files.length > 0 && <ChangedFiles changes={changes}/>}
  </section>;
}
