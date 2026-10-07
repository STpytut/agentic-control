"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AgentAssignmentSummary } from "@/lib/product-data";
import type { AssignmentReadiness, ProjectReadiness } from "@/lib/readiness";
import { taskAssignmentReadiness } from "@/lib/readiness";
import { ReadinessBlockerNote } from "@/components/assignment-readiness";
import { runtimeLabel } from "@/lib/runtime-labels";
import { Select, cx } from "@agentic/design-system";
import { Notice } from "@/components/ui/notice";

const maximumMessageLength = 64_000;
const maximumMarkdownFiles = 3;
const maximumMarkdownFileSize = 48 * 1024;

type MarkdownAttachment = { name: string; content: string; size: number };

function composeMessage(message: string, attachments: MarkdownAttachment[]) {
  const documents = attachments.map((attachment) => {
    const safeName = attachment.name.replace(/[\r\n`]/g, "_");
    return `## Attached document: ${safeName}\n\n${attachment.content.trim()}`;
  });
  return [message.trim(), ...documents].filter(Boolean).join("\n\n---\n\n");
}

const followUpStatuses = new Set(["approved", "completed", "deployed"]);

// The assignments this send would bind, and which of them are not ready
// (sprint C U1). A new task binds the chosen orchestrator and executors; a
// message on a task starts a turn of the task's orchestrator. The database
// refuses the same send with the same reason (0088); this says so before the
// click, with the fix, instead of a generic error after it.
function readinessBlockers(readiness: ProjectReadiness | null | undefined, bound: string[]): AssignmentReadiness[] {
  return taskAssignmentReadiness(readiness, bound).filter((assignment) => assignment.blockedBy);
}

// `variant="start"` is the project's start screen (Stage 12 N4): the same new
// task, the same validation and action, with the team as chips under the field
// and a "Start chat" button; `memberLabels` names each member there (model,
// the resolved one, the level) where the page knows more than the roster.
export function ChatComposer({ projectId, taskId, taskStatus, taskVersion, taskOrchestratorAssignmentId = "", taskExecutorAssignmentIds = [], enabled, disabledReason = "Operator authentication is required to send messages", agentRoster = [], readiness = null, variant = "chat", className, memberLabels = {}, examples = [] }: { examples?: string[]; projectId: string; taskId?: string; taskStatus?: string; taskVersion?: number; taskOrchestratorAssignmentId?: string; taskExecutorAssignmentIds?: string[]; enabled: boolean; disabledReason?: string; agentRoster?: AgentAssignmentSummary[]; readiness?: ProjectReadiness | null; variant?: "chat" | "start"; className?: string; memberLabels?: Record<string, string> }) {
  const start = variant === "start" && !taskId;
  const router = useRouter();
  const orchestrators = agentRoster.filter((item) => item.assignmentRole === "orchestrator" && item.canOrchestrate);
  const executors = agentRoster.filter((item) => item.assignmentRole === "executor" && item.canExecute);
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<MarkdownAttachment[]>([]);
  const [orchestratorAssignmentId, setOrchestratorAssignmentId] = useState(orchestrators.find((item) => item.isDefault)?.assignmentId ?? orchestrators[0]?.assignmentId ?? "");
  const [executorAssignmentIds, setExecutorAssignmentIds] = useState(executors.map((item) => item.assignmentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const createsFollowUp = Boolean(taskId && taskStatus && followUpStatuses.has(taskStatus));
  const outgoingMessage = composeMessage(message, attachments);
  const messageIsValid = outgoingMessage.length >= 2 && outgoingMessage.length <= maximumMessageLength;
  // A follow-up binds the source task's assignments again, so it is asked the
  // same as a new task would be; a message on an open task starts a turn of
  // its orchestrator only.
  const blockers = readinessBlockers(readiness,
    !taskId ? [orchestratorAssignmentId, ...executorAssignmentIds]
      : createsFollowUp ? [taskOrchestratorAssignmentId, ...taskExecutorAssignmentIds]
      : [taskOrchestratorAssignmentId]);
  const refused = blockers.length > 0;
  const refusalText = blockers.map((assignment) => `${assignment.role === "orchestrator" ? "The orchestrator" : "An executor"} is not ready: ${assignment.blockedBy?.message}.`).join(" ");

  async function send() {
    if (refused) {
      setError(refusalText);
      return;
    }
    if (!messageIsValid || busy || !enabled) {
      if (outgoingMessage.length > maximumMessageLength) setError(`Message and attachments exceed the ${maximumMessageLength.toLocaleString("en-US")} character limit`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/control-plane/actions", {
        method: "POST",
        headers: controlPlaneActionHeaders(),
        body: JSON.stringify({
          kind: !taskId ? "create_task" : createsFollowUp ? "create_followup" : "chat_message",
          projectId, taskId, message: outgoingMessage,
          ...(createsFollowUp ? { sourceTaskId: taskId, taskVersion } : {}),
          ...(!taskId ? { orchestratorAssignmentId, executorAssignmentIds } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "Message was not recorded");
      setMessage("");
      setAttachments([]);
      router.replace(`/projects/${projectId}?task=${body.result.task_id}`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Message was not recorded");
    } finally {
      setBusy(false);
    }
  }

  // The field grows with its text up to 40% of the screen, then scrolls inside
  // (CSS field-sizing). Where the browser has no field-sizing, the same by hand.
  useEffect(() => {
    const element = field.current;
    if (!element || CSS.supports("field-sizing", "content")) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [message]);

  function toggleExecutor(assignmentId: string) {
    setExecutorAssignmentIds((current) => current.includes(assignmentId)
      ? current.filter((id) => id !== assignmentId)
      : [...current, assignmentId]);
  }

  async function addAttachments(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    if (attachments.length + files.length > maximumMarkdownFiles) {
      setError(`Attach up to ${maximumMarkdownFiles} Markdown files`);
      return;
    }
    const invalid = files.find((file) => !/\.(md|markdown)$/i.test(file.name) || file.size > maximumMarkdownFileSize);
    if (invalid) {
      setError(`${invalid.name} must be a Markdown file smaller than 48 KB`);
      return;
    }
    const additions = await Promise.all(files.map(async (file) => ({ name: file.name, content: await file.text(), size: file.size })));
    const next = [...attachments, ...additions];
    if (composeMessage(message, next).length > maximumMessageLength) {
      setError(`Message and attachments exceed the ${maximumMessageLength.toLocaleString("en-US")} character limit`);
      return;
    }
    setAttachments(next);
    setError("");
  }

  const memberLabel = (item: AgentAssignmentSummary) => memberLabels[item.assignmentId] ?? `${runtimeLabel(item.runtimeType)} · ${item.model}`;
  const chip = "type-meta inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-line px-3 phone:min-h-11";
  const cannotStart = !taskId && (!orchestratorAssignmentId || !executorAssignmentIds.length);

  return (
    <div className={cx("group flex-none rounded-lg border border-line-strong bg-canvas px-3 pt-2.5 pb-2 text-ink transition-colors duration-150 focus-within:border-ink", className ?? "mx-auto mt-2 mb-3 w-[min(760px,calc(100%-60px))] phone:mt-2 phone:mb-2.5 phone:w-[calc(100%-28px)]")}>
      {createsFollowUp && <Notice tone="info" className="mb-3 flex items-baseline gap-2"><strong className="flex-none font-medium">Continue with changes</strong><span>This chat&apos;s last step is {taskStatus}. Your next message starts a linked follow-up step with the same agent sessions.</span></Notice>}
      {!taskId && !start && <div className="mb-2.5 grid grid-cols-[1fr_1.4fr] gap-3 border-b border-line pb-2.5 phone:grid-cols-1">
        <label className="grid min-w-0 gap-1.5"><span className="type-meta font-medium">Orchestrator</span><Select value={orchestratorAssignmentId} onChange={(event) => setOrchestratorAssignmentId(event.target.value)}>
          {orchestrators.map((item) => <option value={item.assignmentId} key={item.assignmentId}>{runtimeLabel(item.runtimeType)} · {item.model}</option>)}
        </Select></label>
        <div className="grid min-w-0 content-start gap-1.5"><span className="type-meta font-medium">Executors</span><section className="flex flex-wrap gap-1.5">{executors.map((item) => <label key={item.assignmentId} className="touch-target type-meta inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-sm border border-line px-2.5 transition-colors duration-150 hover:border-ink/45">
          <input type="checkbox" className="h-4 w-4 accent-[var(--color-ink)]" checked={executorAssignmentIds.includes(item.assignmentId)} onChange={() => toggleExecutor(item.assignmentId)}/>
          {runtimeLabel(item.runtimeType)} · {item.model}
        </label>)}</section></div>
      </div>}
      {refused && <div className="mb-3 grid gap-2 [&>p]:mt-0" id="composer-refusal">
        {blockers.map((assignment) => assignment.blockedBy && <ReadinessBlockerNote key={assignment.assignmentId} blocker={assignment.blockedBy} projectId={projectId}
          subject={assignment.role === "orchestrator" ? "The orchestrator cannot start" : `Executor ${runtimeLabel(assignment.runtime)} cannot start`}/>)}
      </div>}
      <textarea
        ref={field}
        className={cx("type-app-body block max-h-[40dvh] w-full resize-none overflow-y-auto border-0 bg-transparent p-0.5 text-ink outline-none [field-sizing:content] placeholder:text-muted disabled:cursor-not-allowed phone:text-base", start ? "min-h-[3lh]" : "min-h-7")}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
        placeholder={enabled ? (createsFollowUp ? "Describe the changes for the follow-up…" : taskId ? "Continue the conversation…" : start ? "Describe the work, or paste an issue…" : "Describe what you want the orchestrator to work on…") : disabledReason}
        disabled={!enabled || busy}
        aria-describedby={refused ? "composer-refusal" : undefined}
        aria-label={start ? "Describe the work" : undefined}
        rows={start ? 3 : 1}
      />
      {attachments.length > 0 && <div className="flex flex-wrap gap-1.5 pt-1.5 pb-1">
        {attachments.map((attachment, index) => <span key={`${attachment.name}-${index}`} className="type-meta inline-flex max-w-[220px] items-center gap-0.5 rounded-sm bg-wash py-0.5 pr-0.5 pl-2">
          <span className="truncate">{attachment.name}</span>
          <button type="button" className="grid h-8 w-8 shrink-0 place-items-center rounded-xs text-muted transition-colors duration-150 hover:text-ink" onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove ${attachment.name}`}>×</button>
        </span>)}
      </div>}
      {/* A first project's start screen offers a few first tasks (rc.128): a
          click puts one in the field to edit or send as it is. */}
      {start && examples.length > 0 && !message.trim() && <div className="flex flex-wrap gap-1.5 pt-2" role="group" aria-label="Example tasks">
        {examples.map((example) => <button key={example} type="button" onClick={() => setMessage(example)}
          className="type-meta max-w-full truncate rounded-full border border-dashed border-line-strong px-3 py-1.5 text-left text-ink/80 transition-colors duration-150 hover:border-ink hover:text-ink">
          {example}
        </button>)}
      </div>}
      {start && <div className="flex flex-wrap items-center gap-1.5 pt-2" aria-label="The team for this chat" role="group">
        {orchestrators.length > 1
          ? <label className={cx(chip, "pr-1")}><span className="shrink-0 text-muted">Orchestrator</span>
              <select value={orchestratorAssignmentId} onChange={(event) => setOrchestratorAssignmentId(event.target.value)} aria-label="Orchestrator"
                className="min-w-0 max-w-[16rem] truncate rounded-full bg-transparent py-1 pr-1 text-ink outline-none focus-visible:outline-2 focus-visible:outline-focus">
                {orchestrators.map((item) => <option value={item.assignmentId} key={item.assignmentId}>{memberLabel(item)}</option>)}
              </select></label>
          : orchestrators[0]
            ? <span className={chip}><span className="text-muted">Orchestrator</span> <span className="truncate">{memberLabel(orchestrators[0])}</span></span>
            : <span className={cx(chip, "text-danger")}>No orchestrator in the team</span>}
        {/* One executor is simply the team's: a checkbox beside it, and none
            beside the orchestrator, asked a question there was no choice in.
            With several, each is a choice for this chat, and says so. */}
        {executors.length === 1
          ? <span className={chip}><span className="text-muted">Executor</span> <span className="truncate">{memberLabel(executors[0])}</span></span>
          : executors.map((item) => <label key={item.assignmentId} title="Use this executor in the new chat" className={cx(chip, "cursor-pointer transition-colors duration-150 hover:border-ink/45 has-[input:checked]:border-ink/60")}>
          <input type="checkbox" className="h-4 w-4 accent-[var(--color-ink)]" checked={executorAssignmentIds.includes(item.assignmentId)} onChange={() => toggleExecutor(item.assignmentId)}
            aria-label={`Use executor ${runtimeLabel(item.runtimeType)} in the new chat`}/>
          <span className="text-muted">Executor</span> <span className="truncate">{memberLabel(item)}</span>
        </label>)}
        {executors.length > 1 && <span className="type-meta text-muted">Tick the executors this chat may use.</span>}
        {!executors.length && <span className={cx(chip, "text-danger")}>No executor in the team</span>}
      </div>}
      <div className="flex items-center justify-between gap-2 pt-1.5">
        <div className="type-meta flex flex-wrap items-center gap-x-2.5 gap-y-1 text-muted">
          <label className="touch-target inline-flex h-8 cursor-pointer items-center rounded-sm border border-line px-2.5 font-medium text-ink/80 transition-colors duration-150 hover:border-ink/45 has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-55 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-3 has-[input:focus-visible]:outline-focus" title={`Attach up to ${maximumMarkdownFiles} Markdown files (.md)`}>
            <input className="sr-only" type="file" accept=".md,.markdown,text/markdown" multiple onChange={(event) => void addAttachments(event)} disabled={!enabled || busy || attachments.length >= maximumMarkdownFiles}/>
            <span aria-hidden="true">＋&nbsp;</span>Attach .md
          </label>
          {/* The count only once it matters: "0 / 64,000" under every empty box was noise. */}
          {outgoingMessage.length > maximumMessageLength * 0.8
            && <span className={outgoingMessage.length > maximumMessageLength ? "font-medium text-danger tabular-nums" : "tabular-nums"}>{outgoingMessage.length.toLocaleString("en-US")} / {maximumMessageLength.toLocaleString("en-US")}</span>}
          <span className="hidden group-focus-within:inline">Enter to send · Shift+Enter for a new line</span>
        </div>
        {start
          ? <button className="touch-target inline-flex h-10 shrink-0 items-center rounded-full bg-ink px-4 text-[0.875rem] font-medium text-on-ink transition-colors duration-150 hover:bg-accent hover:text-on-accent disabled:cursor-not-allowed disabled:bg-line-strong disabled:text-canvas disabled:hover:bg-line-strong phone:h-11" onClick={() => void send()} disabled={!enabled || busy || refused || !messageIsValid || cannotStart}
              aria-label={refused ? `Start is refused: ${refusalText}` : undefined} aria-describedby={refused ? "composer-refusal" : undefined} title={refused ? refusalText : undefined}>{busy ? "Starting…" : "Start chat"}</button>
          : <button className="touch-target grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink text-[1rem] text-on-ink transition-colors duration-150 hover:bg-accent hover:text-on-accent disabled:cursor-not-allowed disabled:bg-line-strong disabled:text-canvas disabled:hover:bg-line-strong" onClick={() => void send()} disabled={!enabled || busy || refused || !messageIsValid || cannotStart}
              aria-label={refused ? `Send is refused: ${refusalText}` : "Send message"} aria-describedby={refused ? "composer-refusal" : undefined} title={refused ? refusalText : undefined}>{busy ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" aria-hidden="true"/> : "↑"}</button>}
      </div>
      {error && <Notice tone="danger" className="mt-2">{error}</Notice>}
    </div>
  );
}
