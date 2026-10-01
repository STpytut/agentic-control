"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cx } from "@agentic/design-system";
import { useChatUsage } from "@/components/chat-usage";
import {
  compactTokens, costText, costTitle, limitsNote, readAge, resetText, windowLabel, windowTone,
  type ConnectionUsage, type UsageWindow,
} from "@/lib/usage";
import { runtimeLabel } from "@/lib/runtime-labels";

// The limits strip under the composer (Stage 12 N5): one line, only the
// connections the project's team runs on. A subscription shows its nearest
// window as a tiny bar, the percentage and how old the reading is; a
// pay-per-token gateway what it cost today (an estimate); a free one "free".
// On a chat, the chat's tokens. Refresh re-reads (at most once a minute) and
// says so; a click on the line opens the windows' reset times.

export type TeamConnectionHint = { runtime: string; gateway?: string };

const fill = { success: "bg-success", warning: "bg-warning", danger: "bg-danger", neutral: "bg-line-strong" } as const;

function shortWindow(window: UsageWindow) {
  return windowLabel(window).replace(/ window/, "");
}

function nearest(connection: ConnectionUsage) {
  const windows = connection.limits?.windows.filter((window) => !window.resetPassed) ?? [];
  return [...windows].sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity))[0] ?? null;
}

export function teamConnections(connections: ConnectionUsage[], team: TeamConnectionHint[], taskConnectionIds: string[] = []) {
  if (taskConnectionIds.length) return connections.filter((connection) => taskConnectionIds.includes(connection.connectionId));
  return connections.filter((connection) => team.some((member) => member.runtime === connection.runtimeType
    && (!member.gateway || !connection.gateway || member.gateway === connection.gateway)));
}

function Segment({ connection, now }: { connection: ConnectionUsage; now: number }) {
  const window = nearest(connection);
  const label = <strong className="font-semibold text-ink">{connection.label || runtimeLabel(connection.runtimeType)}</strong>;
  if (window) {
    const percent = Math.round(window.usedPercent);
    return <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      {label} {shortWindow(window)}
      <span className="inline-block h-1.5 w-14 overflow-hidden rounded-full bg-wash" aria-hidden="true"><span className={cx("block h-full rounded-full", fill[windowTone(window)])} style={{ width: `${Math.max(percent, percent > 0 ? 3 : 0)}%` }}/></span>
      <span className="tabular-nums">{percent} %</span>
      {connection.limits && <span className="phone:hidden">· {connection.limits.source === "runtime_stream" ? `reported during a run, ${readAge(connection.limits.readAt, now).replace(/^read /, "")}` : readAge(connection.limits.readAt, now)}</span>}
    </span>;
  }
  if (connection.limitsMode === "free") return <span className="whitespace-nowrap">{label} free</span>;
  const cost = costText(connection.today.costUsd, connection.today.costBasis);
  if (cost) return <span className="whitespace-nowrap" title={costTitle(connection.today.costBasis)}>{label} {cost.replace(/ est\.$/, "")} today (estimate)</span>;
  if (connection.today.totalTokens) return <span className="whitespace-nowrap">{label} {compactTokens(connection.today.totalTokens)} tokens today</span>;
  return <span className="max-w-full truncate" title={limitsNote(connection)}>{label} {connection.limitsMode === "stream" ? "limits during a run" : connection.limitsMode === "none" ? "no limits" : "not read yet"}</span>;
}

export function LimitsStrip({ team, className }: { team: TeamConnectionHint[]; className?: string }) {
  const usage = useChatUsage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  if (!usage) return null;
  const { operatorUsage, taskUsage, now, refreshState, refresh } = usage;
  const connections = teamConnections(operatorUsage?.connections ?? [], team, taskUsage?.connections.map((connection) => connection.connectionId));
  const chatTokens = taskUsage?.totals.totalTokens ?? null;
  const status = refreshState === "refreshing" ? "Refreshing…" : refreshState === "updated" ? "Updated" : refreshState === "failed" ? "Could not refresh" : refreshState === "wait" ? "Refreshed less than a minute ago" : "";

  return <div ref={ref} className={cx("relative flex min-w-0 items-center gap-2 px-1 text-muted", className)}>
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="limits-popover"
      className="type-meta flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 rounded-sm py-1 text-left transition-colors duration-150 hover:text-ink">
      <span className="sr-only">Limits and usage: </span>
      {connections.length
        ? connections.map((connection, index) => <span key={connection.connectionId} className="flex max-w-full items-center gap-3">
            {index > 0 && <span className="h-3.5 w-px shrink-0 bg-line-strong phone:hidden" aria-hidden="true"/>}
            <Segment connection={connection} now={now}/>
          </span>)
        : <span className="truncate">{operatorUsage ? "No connection of this team reports limits." : "Limits are not available on this server yet."}</span>}
      {chatTokens !== null && <span className="ml-auto shrink-0 whitespace-nowrap pl-2 tabular-nums">This chat: {compactTokens(chatTokens)} tokens</span>}
    </button>
    <span role="status" className="type-meta shrink-0 whitespace-nowrap phone:sr-only">{status}</span>
    <button type="button" onClick={refresh} disabled={refreshState === "refreshing"} aria-label="Refresh limits" title="Refresh limits"
      className="touch-target grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-wash hover:text-ink disabled:opacity-60 phone:h-9 phone:w-9">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className={cx(refreshState === "refreshing" && "animate-spin motion-reduce:animate-none")}><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
    </button>
    {open && <div id="limits-popover" role="dialog" aria-label="Limits and resets"
      className="absolute bottom-full left-0 z-40 mb-2 grid w-[min(380px,calc(100vw-28px))] gap-3 rounded-lg border border-line bg-canvas p-3.5 text-ink shadow-popover">
      {connections.map((connection) => {
        const windows = connection.limits?.windows ?? [];
        return <section key={connection.connectionId} className="grid gap-1" aria-label={connection.label}>
          <strong className="type-meta font-semibold">{connection.label}</strong>
          {windows.map((window) => <p key={window.key} className="type-meta m-0 flex justify-between gap-3"><span className="text-muted">{windowLabel(window)}</span><span className="tabular-nums">{Math.round(window.usedPercent)} % · {resetText(window, now)}</span></p>)}
          {!windows.length && <p className="type-meta m-0 text-muted">{limitsNote(connection) || "No windows reported."}</p>}
          {connection.limits && <p className="type-meta m-0 text-muted">{readAge(connection.limits.readAt, now)}</p>}
        </section>;
      })}
      {!connections.length && <p className="type-meta m-0 text-muted">This team&apos;s connections report nothing yet.</p>}
      <Link href="/settings/usage" className="type-meta inline-flex min-h-8 items-center font-medium underline-offset-4 hover:underline">All limits and usage in Settings →</Link>
    </div>}
  </div>;
}
