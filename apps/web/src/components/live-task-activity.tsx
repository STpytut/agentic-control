"use client";

import { RuntimeMark } from "@/components/runtime-mark";
import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { TaskActivity } from "@/lib/product-data";
import { Badge, cx } from "@agentic/design-system";
import { dangerOutlineClasses } from "@/components/ui/danger-button";

const phaseLabels: Record<string,string> = {
  queued: "Queued",
  retrying: "Retrying",
  // A Codex turn held back while an implementation writes (migration 0060).
  // Without its own label it would fall through to "Working", which is the one
  // thing it is not.
  waiting_for_workspace: "Waiting for the implementation",
  // The lock needs the operator, not a writer (P-6): nothing is running.
  waiting_for_recovery: "Workspace needs recovery",
  // Ingress (migration 0070): a message or handoff behind the conversation's
  // live run. It becomes a run of its own after that one, never part of it.
  waiting_for_run: "Waiting for the current run",
  starting_runtime: "Starting runtime",
  opening_session: "Opening native session",
  running_turn: "Working",
  finalizing: "Saving result",
  waiting_for_input: "Waiting for input",
  blocked: "Blocked",
  failed: "Failed",
};

function duration(from: string, to: number) {
  if (!from) return "0:00";
  const total = Math.max(0,Math.floor((to-new Date(from).getTime())/1000));
  const minutes = Math.floor(total/60);
  return `${minutes}:${String(total%60).padStart(2,"0")}`;
}

function heartbeatAge(activity: TaskActivity, now: number) {
  if (!activity.heartbeatAt) return null;
  return Math.max(0,Math.floor((now-new Date(activity.heartbeatAt).getTime())/1000));
}

export function LiveTaskActivity({ projectId, taskId, initialActivity, awaitingResponse, modelNames = {} }: {
  projectId: string;
  taskId: string;
  initialActivity: TaskActivity | null;
  awaitingResponse: boolean;
  // The catalogue's name for each model id ("sonnet" → "Claude Sonnet
  // (latest)"), as the chat's messages show it. A map, not a function: this is
  // a client component, and a server page cannot hand it a function (rc.136).
  modelNames?: Record<string, string>;
}) {
  const router = useRouter();
  const [activity,setActivity] = useState(initialActivity);
  const [now,setNow] = useState(0);
  const [reachable,setReachable] = useState(true);
  const [interrupting,setInterrupting] = useState(false);
  const [interruptError,setInterruptError] = useState("");
  const initialCursor = initialActivity?.eventCursor ?? "";

  useEffect(() => {
    const initial = window.setTimeout(() => setNow(Date.now()),0);
    const clock = window.setInterval(() => setNow(Date.now()),1000);
    return () => { window.clearTimeout(initial); window.clearInterval(clock); };
  },[]);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const response = await fetch(`/api/projects/${projectId}/activity?taskId=${taskId}`,{ cache: "no-store" });
        if (!response.ok) throw new Error(`Activity request failed with ${response.status}`);
        const body = await response.json() as { activity: TaskActivity | null };
        if (cancelled) return;
        setReachable(true);
        setActivity((previous) => {
          if ((body.activity?.eventCursor ?? "") !== (previous?.eventCursor ?? initialCursor)
            || (previous?.active && !body.activity?.active)) {
            router.refresh();
          }
          return body.activity;
        });
      } catch {
        if (!cancelled) setReachable(false);
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(),10_000);
    return () => { cancelled=true; window.clearInterval(timer); };
  },[initialCursor,projectId,router,taskId]);

  const heartbeat = activity ? heartbeatAge(activity,now) : null;
  const stalled = Boolean(activity?.status === "in_flight" && (heartbeat === null || heartbeat > 75));
  const failed = activity?.status === "dead_letter" || activity?.phase === "failed";
  const shouldShow = awaitingResponse || Boolean(activity?.active) || failed;
  const startedAt = activity?.startedAt || activity?.queuedAt || "";
  // The clock runs only while something runs. A finished or failed activity
  // shows how long it took, not how long ago it started.
  const endedAt = !activity || activity.active ? now
    : activity.finishedAt ? new Date(activity.finishedAt).getTime()
    : startedAt ? new Date(startedAt).getTime() : now;
  const phase = failed ? "Failed" : stalled ? "Heartbeat delayed" : phaseLabels[activity?.phase ?? "queued"] ?? "Working";
  const connection = useMemo(() => {
    if (!reachable) return "Live status unavailable";
    if (!activity) return "Waiting for dispatcher";
    if (activity.status === "pending") return activity.attemptCount ? `Retry ${activity.attemptCount}` : "Waiting in queue";
    if (stalled) return heartbeat === null ? "No heartbeat received" : `Last heartbeat ${heartbeat}s ago`;
    if (heartbeat !== null && activity.active) return `Heartbeat ${heartbeat}s ago`;
    return "State confirmed by control plane";
  },[activity,heartbeat,reachable,stalled]);

  async function interrupt() {
    setInterrupting(true);
    setInterruptError("");
    try {
      const response = await fetch("/api/control-plane/actions",{ method: "POST",
        headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ kind: "interrupt", projectId, taskId, reason: "Interrupted from project chat" }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "Interrupt failed");
      router.refresh();
    } catch (error) {
      setInterruptError(error instanceof Error ? error.message : "Interrupt failed");
    } finally { setInterrupting(false); }
  }

  if (!shouldShow) return null;
  const tone = failed ? "failed" : stalled ? "stalled" : "active";
  return <article className={cx("mb-6 grid grid-cols-[32px_minmax(0,1fr)] gap-3 rounded-lg border p-3.5", tone === "failed" ? "border-danger/50" : tone === "stalled" ? "border-warning/50" : "border-line-strong")} aria-live="polite">
    <RuntimeMark runtime={activity?.runtimeType} fallback={activity?.agentName ?? "?"}/>
    <div className="min-w-0">
      <header className="flex items-center justify-between gap-3"><span className="flex min-w-0 items-baseline gap-1.5"><strong className="type-meta font-medium">{activity?.agentName ?? "Orchestrator"}</strong><small className="type-mono-small truncate text-muted">{activity?.model ? modelNames[activity.model] ?? activity.model : "Waiting for assignment"}</small></span><Badge tone={tone === "failed" ? "danger" : tone === "stalled" ? "warning" : "active"} className="shrink-0">{phase}</Badge></header>
      <p className="type-app-body mt-2 mb-2.5 text-ink/80">{activity?.detail ?? "Your message is durable and waiting to be routed to the agent."}</p>
      {!!activity?.events?.length && <ul className="type-meta mb-2.5 grid list-none gap-0.5 p-0 text-muted">{activity.events.slice(0,3).map((event) => <li key={event.id} className="before:mr-1.5 before:content-['›']">{event.summary}</li>)}</ul>}
      {interruptError && <p className="type-mono-small mb-2 text-danger">{interruptError}</p>}
      {activity?.status === "in_flight" && activity.canSteer && <SteerExecutor projectId={projectId} taskId={taskId} name={activity.agentName}/>}
      {activity?.lastError && failed && <p className="type-mono-small mb-2 text-danger">{activity.lastError}</p>}
      <footer className="type-meta flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-2.5 text-muted"><span className={cx("h-1.5 w-1.5 rounded-full", tone === "failed" ? "bg-danger" : tone === "stalled" ? "bg-warning" : "bg-success animate-pulse motion-reduce:animate-none")}/><span>{connection}</span><span className="tabular-nums">{activity && !activity.active ? "Took" : "Elapsed"} {duration(startedAt,endedAt)}</span>{(activity?.attemptCount ?? 0) > 1 && <span>Attempt {activity?.attemptCount}</span>}{activity?.status === "in_flight" && activity.canInterrupt && <button className={cx(dangerOutlineClasses, "ml-auto")} disabled={interrupting} onClick={interrupt}>{interrupting ? "Stopping…" : "Stop run"}</button>}</footer>
    </div>
  </article>;
}

// rc.146 (0154): tell the executor something while it works, without waiting
// for its turn to end. It takes the message at its next step; the chat shows
// whether it arrived.
function SteerExecutor({ projectId, taskId, name }: { projectId: string; taskId: string; name: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "error">("idle");
  const [error, setError] = useState("");
  async function send() {
    const message = text.trim();
    if (!message) return;
    setState("sending");
    try {
      const response = await fetch("/api/control-plane/actions", { method: "POST", headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ kind: "executor_message", projectId, taskId, text: message,
          idempotencyKey: `steer:${crypto.randomUUID()}` }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "The message was not sent");
      setText("");
      setState("idle");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message was not sent");
      setState("error");
    }
  }
  return <form className="mb-2.5 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
    <input className="type-meta h-9 min-w-0 flex-1 rounded-md border border-line bg-canvas px-3 text-ink" value={text} maxLength={8000}
      placeholder={`Tell ${name} something while it works…`} aria-label={`Message to ${name} while it works`}
      disabled={state === "sending"} onChange={(event) => { setText(event.target.value); if (state === "error") setState("idle"); }}/>
    <button type="submit" className="type-meta h-9 shrink-0 rounded-md border border-line-strong px-3 font-medium text-ink hover:border-ink disabled:opacity-50"
      disabled={!text.trim() || state === "sending"}>{state === "sending" ? "Sending…" : "Send"}</button>
    {state === "error" && <span className="type-meta text-danger">{error}</span>}
  </form>;
}
