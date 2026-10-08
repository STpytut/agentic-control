"use client";

import { RuntimeMark } from "@/components/runtime-mark";
import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "@agentic/design-system";
import type { ChatMessage as ChatMessageData } from "@/lib/product-data";

const COLLAPSED_CHARACTERS = 1200;
const COLLAPSED_LINES = 12;

const ROLE_LABELS = { orchestrator: "orchestrator", reviewer: "reviewer", executor: "executor", analyst: "analyst" } as const;

// The part an agent plays, as a chip of its own colour beside its name: who
// plans, who reviews, who writes and who reads, before a word is read. Colours
// of their own, not the status tones — a reviewer is not a warning. Tinted
// from the colour, so they hold in light and dark.
const ROLE_COLORS: Record<keyof typeof ROLE_LABELS, string> = {
  orchestrator: "#5B5BD6", reviewer: "#8E4EC6", executor: "#12A594", analyst: "#D9822B",
};

function RoleChip({ role }: { role: keyof typeof ROLE_LABELS }) {
  const color = ROLE_COLORS[role];
  return <span className="type-meta inline-flex items-center rounded-sm px-1.5 py-px font-medium leading-5"
    style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{ROLE_LABELS[role]}</span>;
}

export function ChatMessage({ message, timeLabel, modelLabel }: { message: ChatMessageData; timeLabel: string; modelLabel?: string }) {
  const collapsible = message.role === "user"
    && (message.content.length > COLLAPSED_CHARACTERS || message.content.split("\n").length > COLLAPSED_LINES);
  const [expanded,setExpanded] = useState(!collapsible);
  const completion = /completed|approved/.test(message.eventType);

  // The workflow's own record — a handoff, a revision started — is a line in
  // the timeline, not a participant: it showed as "Control plane", a name the
  // operator had no reason to know. Its event type stays in the tooltip.
  if (message.role === "system" && !message.notice) {
    return <p className="type-meta mb-5 ml-11 flex items-baseline gap-2 text-muted" title={message.eventType} data-event-type={message.eventType}>
      <span aria-hidden="true" className={cx("shrink-0", completion && "text-success")}>{completion ? "✓" : "↳"}</span>
      <span className="min-w-0">{message.content} <time className="whitespace-nowrap">· {timeLabel}</time>
        {message.stopConsultation && <StopConsultation {...message.stopConsultation}/>}</span>
    </p>;
  }
  if (message.role === "system") {
    return <article className="mb-6 ml-11 rounded-r-sm border-l-2 border-warning bg-warning-soft px-3 py-2.5" data-event-type={message.eventType}>
      <p className="type-app-body whitespace-pre-wrap text-ink">{message.content}</p>
      <time className="type-meta mt-1 block text-muted" title={message.eventType}>{timeLabel}</time>
    </article>;
  }

  // The operator's own messages sit on the right as a bubble, the agents' on
  // the left with their name, as in any messenger: who said what reads from
  // the side before a single word.
  if (message.role === "user") {
    return <article className="mb-6 flex flex-col items-end" aria-label={`${message.author}, ${timeLabel}`}>
      <div className="max-w-[80%] rounded-lg rounded-br-sm bg-wash px-4 py-2.5 phone:max-w-[88%]">
        <p className={cx("type-app-body whitespace-pre-wrap text-ink [overflow-wrap:anywhere]", !expanded && "line-clamp-12")}>{message.content}</p>
        {collapsible && <button className="type-meta mt-2 inline-flex min-h-8 items-center font-medium underline-offset-4 hover:underline" type="button" aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}>{expanded ? "Collapse" : "Show full message"}</button>}
      </div>
      <time className="type-meta mt-1 text-muted">{timeLabel}</time>
    </article>;
  }

  const detail = modelLabel ?? "";

  return <article className="mb-6 grid grid-cols-[32px_minmax(0,1fr)] gap-3">
    <RuntimeMark runtime={message.runtime} fallback={message.author}/>
    <div className="min-w-0">
      <header className="flex min-h-6 flex-wrap items-center gap-x-2"><strong className="type-meta font-medium">{message.author}</strong>{message.actorRole && <RoleChip role={message.actorRole}/>}{detail && <span className="type-meta text-muted">{detail}</span>}<time className="type-meta text-muted">{timeLabel}</time></header>
      <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
    </div>
  </article>;
}

// M7 (0151): stop a question an analyst is still reading. The worker cancels
// the run within a few seconds and the orchestrator is told it was stopped.
function StopConsultation({ projectId, consultationId }: { projectId: string; consultationId: string }) {
  const [state, setState] = useState<"idle" | "stopping" | "stopped" | "error">("idle");
  async function stop() {
    setState("stopping");
    try {
      const response = await fetch("/api/control-plane/actions", { method: "POST", headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ kind: "consultation_stop", projectId, consultationId }) });
      const answer = await response.json();
      setState(response.ok && answer.ok ? "stopped" : "error");
    } catch {
      setState("error");
    }
  }
  if (state === "stopped") return <span className="ml-2 text-muted">· stopping the analyst…</span>;
  return <button type="button" className="ml-2 font-medium text-ink underline-offset-4 hover:underline disabled:opacity-50"
    disabled={state === "stopping"} onClick={stop}>{state === "error" ? "Stop failed — retry" : "Stop"}</button>;
}
