import Link from "next/link";
import type { AssignmentReadiness, PrerequisiteState, ProjectReadiness, ReadinessBlocker } from "@/lib/readiness";
import { runtimeLabel } from "@/lib/runtime-labels";
import { Badge, Card, cx, type BadgeTone } from "@agentic/design-system";

// The four prerequisites of an assignment, shown where the operator acts
// (sprint C U1; exit criterion 6, the panel half).
//
// What is rendered is the database's own reading, `project_readiness` (0088):
// the same states task creation refuses a task with and a launch asks again.
// The states stay apart all the way to the markup — "installed", "signed in",
// "model verified" and "connection connected" are fixed by different commands,
// and one green dot would hide which one — and a blocked assignment carries
// the sentence and the fix, not only a colour.
//
// On the design system's components (Card, Badge) and tokens; the chips keep
// their list semantics, each Badge inside its own <li>.

const STATE_WORDS: Record<PrerequisiteState, string> = { ready: "", missing: "not ", unknown: "unknown: " };

const STATE_TONES: Record<PrerequisiteState, BadgeTone> = { ready: "success", missing: "danger", unknown: "warning" };

function StateChip({ label, state }: { label: string; state: PrerequisiteState }) {
  // The chip is read by its word. `aria-label` carries the full sentence for a
  // screen reader; sighted readers get the short form beside the dot.
  // In a narrow column the longest chip ("not connection connected") wraps
  // rather than widening the card; the word is never cut.
  return <li className="flex min-w-0 max-w-full" aria-label={`${label}: ${state}`}><Badge dot tone={STATE_TONES[state]} className="[&]:whitespace-normal">{STATE_WORDS[state]}{label}</Badge></li>;
}

const fixLink = "text-ink underline decoration-line-strong underline-offset-[3px] transition-[text-decoration-color] duration-150 hover:decoration-ink";

// The action names either a command (in backticks) or a screen. Commands are
// shown as code; "Settings" is a link, because that is where the click goes.
function ActionText({ action, projectId }: { action: string; projectId: string }) {
  const parts = action.split(/(`[^`]+`|Settings|project settings)/g);
  return <>{parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index} className="type-mono-small text-ink">{part.slice(1, -1)}</code>;
    if (part === "project settings") return <Link key={index} className={fixLink} href={`/projects/${projectId}/settings/team`}>project settings</Link>;
    // Settings is pages now (Stage 12 N7): a fix about a model is on Models, any other on Connections.
    if (part === "Settings") return <Link key={index} className={fixLink} href={/model/i.test(action) ? "/settings/models" : "/settings/connections"}>Settings</Link>;
    return <span key={index} className="inline">{part}</span>;
  })}</>;
}

export function ReadinessBlockerNote({ blocker, projectId, subject }: { blocker: ReadinessBlocker; projectId: string; subject?: string }) {
  const unknown = blocker.reason === "runtime_readiness_unknown";
  const message = blocker.message.charAt(0).toUpperCase() + blocker.message.slice(1);
  return <p className={cx("type-meta mt-2 rounded-r-sm border-l-2 px-3 py-2 text-ink [overflow-wrap:anywhere]", unknown ? "border-warning bg-warning-soft" : "border-danger bg-danger-soft")} role="status">
    <strong className="block font-medium">{subject ? `${subject}: ${message}` : message}</strong>
    <span className="block text-muted">To fix: <ActionText action={blocker.action} projectId={projectId}/></span>
  </p>;
}

function roleWord(assignment: AssignmentReadiness) {
  return assignment.role === "orchestrator" ? "Orchestrator" : assignment.role === "executor" ? "Executor" : "Assignment";
}

function AssignmentRow({ assignment, projectId }: { assignment: AssignmentReadiness; projectId: string }) {
  const model = assignment.modelId
    ? `${assignment.providerId ? `${assignment.providerId}/` : ""}${assignment.modelId}`
    : "";
  return <section className="mt-3 min-w-0 border-t border-line pt-3 first-of-type:mt-0 first-of-type:border-t-0 first-of-type:pt-0" aria-label={`${roleWord(assignment)} readiness`}>
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <strong className="type-card-title">{roleWord(assignment)}{assignment.isDefault && assignment.role === "orchestrator" ? " · default" : ""}</strong>
      <span className="type-meta text-muted">{runtimeLabel(assignment.runtime)}{assignment.runtimeVersion ? ` ${assignment.runtimeVersion}` : ""}</span>
    </div>
    {model
      ? <span className="type-mono-small mt-1 block min-w-0 break-words [overflow-wrap:anywhere]">{model}</span>
      : <span className="type-meta mt-1 block text-muted">No model chosen for this assignment yet.</span>}
    <ul className="mt-2 flex list-none flex-wrap gap-1.5 p-0">
      <StateChip label="installed" state={assignment.runtimeInstalled}/>
      <StateChip label="signed in" state={assignment.runtimeAuthenticated}/>
      <StateChip label="model verified" state={assignment.modelVerified}/>
      <StateChip label="connection connected" state={assignment.connectionConnected}/>
    </ul>
    {assignment.blockedBy && <ReadinessBlockerNote blocker={assignment.blockedBy} projectId={projectId}/>}
  </section>;
}

// The card in the project's context column and on its settings page.
export function AssignmentReadinessCard({ readiness }: { readiness: ProjectReadiness }) {
  return <Card className="min-w-0" aria-labelledby="ads-readiness-title">
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
      <span className="type-eyebrow text-muted" id="ads-readiness-title">Team readiness</span>
      <small className="type-meta whitespace-nowrap text-muted tabular-nums">{observedText(readiness)}</small>
    </div>
    {readiness.assignments.length === 0 && <p className="type-meta text-muted">This project has no enabled assignments.</p>}
    {readiness.assignments.map((assignment) => <AssignmentRow assignment={assignment} projectId={readiness.projectId} key={assignment.assignmentId}/>)}
  </Card>;
}

function observedText(readiness: ProjectReadiness) {
  return readiness.observedAt ? `host reported ${new Date(readiness.observedAt).toISOString().slice(11, 16)} UTC` : "host never reported";
}

// On the task's heading: the executors the task is bound to, before the
// delegation that would launch them. The database asks again at that
// delegation; this is the same answer, earlier.
export function TaskExecutorReadiness({ executors, projectId }: { executors: AssignmentReadiness[]; projectId: string }) {
  const blocked = executors.filter((executor) => executor.blockedBy);
  if (blocked.length === 0) return null;
  return <ul className="mt-2 grid list-none gap-1 px-8 py-0 phone:px-4" aria-label="Executors that are not ready">
    {blocked.map((executor) => <li key={executor.assignmentId} className="type-meta flex flex-wrap items-baseline gap-x-2 gap-y-1 [overflow-wrap:anywhere]">
      <span className="text-muted">Executor {runtimeLabel(executor.runtime)}{executor.modelId ? ` · ${executor.modelId}` : ""} cannot be delegated to</span>
      <ReadinessBlockerNote blocker={executor.blockedBy as ReadinessBlocker} projectId={projectId}/>
    </li>)}
  </ul>;
}
