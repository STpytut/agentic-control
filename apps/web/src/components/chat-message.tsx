"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "@agentic/design-system";
import type { ChatMessage as ChatMessageData } from "@/lib/product-data";

const COLLAPSED_CHARACTERS = 1200;
const COLLAPSED_LINES = 12;

export function ChatMessage({ message, timeLabel }: { message: ChatMessageData; timeLabel: string }) {
  const collapsible = message.role === "user"
    && (message.content.length > COLLAPSED_CHARACTERS || message.content.split("\n").length > COLLAPSED_LINES);
  const [expanded,setExpanded] = useState(!collapsible);

  const avatar = message.role === "user" ? "rounded-full bg-wash text-ink"
    : message.role === "agent" ? "rounded-sm bg-ink text-on-ink"
    : "rounded-sm bg-wash text-muted";
  const completion = /completed|approved/.test(message.eventType);

  return <article className="mb-6 grid grid-cols-[32px_minmax(0,1fr)] gap-3">
    <span className={cx("grid h-8 w-8 place-items-center text-[0.6875rem] font-medium", completion ? "rounded-sm bg-success-soft text-success" : avatar)}>{message.role === "user" ? "ST" : message.role === "agent" ? (message.author.trim()[0] ?? "A").toUpperCase() : "•"}</span>
    <div className={cx("min-w-0", completion && "rounded-md border border-success/40 bg-success-soft/50 px-3 py-2.5")}>
      <header className="flex h-6 items-center gap-2"><strong className="type-meta font-medium">{message.author}</strong><time className="type-meta text-muted">{timeLabel}</time></header>
      {message.role === "agent"
        ? <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
        : <p className={cx("type-app-body mt-1 whitespace-pre-wrap text-ink", !expanded && "line-clamp-12")}>{message.content}</p>}
      {collapsible && <button className="type-meta mt-2 inline-flex min-h-8 items-center font-medium underline-offset-4 hover:underline" type="button" aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}>{expanded ? "Collapse" : "Show full message"}</button>}
      {message.role === "system" && <small className="type-mono-small mt-1 block text-muted">{message.eventType}</small>}
    </div>
  </article>;
}
