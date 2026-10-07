"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "@agentic/design-system";
import type { ChatMessage as ChatMessageData } from "@/lib/product-data";

const COLLAPSED_CHARACTERS = 1200;
const COLLAPSED_LINES = 12;

const ROLE_LABELS = { orchestrator: "orchestrator", reviewer: "reviewer", executor: "executor" } as const;

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
      <span className="min-w-0">{message.content} <time className="whitespace-nowrap">· {timeLabel}</time></span>
    </p>;
  }
  if (message.role === "system") {
    return <article className="mb-6 ml-11 rounded-r-sm border-l-2 border-warning bg-warning-soft px-3 py-2.5" data-event-type={message.eventType}>
      <p className="type-app-body whitespace-pre-wrap text-ink">{message.content}</p>
      <time className="type-meta mt-1 block text-muted" title={message.eventType}>{timeLabel}</time>
    </article>;
  }

  const avatar = message.role === "user" ? "rounded-full bg-wash text-ink" : "rounded-sm bg-ink text-on-ink";
  const detail = [message.actorRole && ROLE_LABELS[message.actorRole], modelLabel].filter(Boolean).join(" · ");

  return <article className="mb-6 grid grid-cols-[32px_minmax(0,1fr)] gap-3">
    <span className={cx("grid h-8 w-8 place-items-center text-[0.6875rem] font-medium", avatar)}>{message.role === "user" ? "ST" : (message.author.trim()[0] ?? "A").toUpperCase()}</span>
    <div className="min-w-0">
      <header className="flex min-h-6 flex-wrap items-center gap-x-2"><strong className="type-meta font-medium">{message.author}</strong>{detail && <span className="type-meta text-muted">{detail}</span>}<time className="type-meta text-muted">{timeLabel}</time></header>
      {message.role === "agent"
        ? <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
        : <p className={cx("type-app-body mt-1 whitespace-pre-wrap text-ink", !expanded && "line-clamp-12")}>{message.content}</p>}
      {collapsible && <button className="type-meta mt-2 inline-flex min-h-8 items-center font-medium underline-offset-4 hover:underline" type="button" aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}>{expanded ? "Collapse" : "Show full message"}</button>}
    </div>
  </article>;
}
