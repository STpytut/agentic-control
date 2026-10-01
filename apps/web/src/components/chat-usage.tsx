"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { compactTokens, type OperatorUsage, type TaskUsage } from "@/lib/usage";

// The live numbers a chat shows in two places — the Team tab's tokens per
// member and the limits strip under the composer — read once, by the existing
// routes: the chat's usage every 4 s while a run is going and every minute
// otherwise (as the task usage card did), and the operator's limits every
// minute (as Settings → Limits & usage does). Refresh re-reads both, at most
// once a minute.
const LIVE_MS = 4_000;
const IDLE_MS = 60_000;
export const REFRESH_EVERY_MS = 60_000;

type RefreshState = "idle" | "refreshing" | "updated" | "failed" | "wait";
type UsageState = {
  taskUsage: TaskUsage | null;
  operatorUsage: OperatorUsage | null;
  now: number;
  refreshState: RefreshState;
  refresh: () => void;
};

const UsageContext = createContext<UsageState | null>(null);

export function useChatUsage() {
  return useContext(UsageContext);
}

export function ChatUsageProvider({ projectId, taskId, initialTaskUsage = null, initialOperatorUsage = null, children }: {
  projectId: string;
  taskId?: string;
  initialTaskUsage?: TaskUsage | null;
  initialOperatorUsage?: OperatorUsage | null;
  children: ReactNode;
}) {
  const [taskUsage, setTaskUsage] = useState(initialTaskUsage);
  const [operatorUsage, setOperatorUsage] = useState(initialOperatorUsage);
  const [now, setNow] = useState(() => Date.parse(initialOperatorUsage?.generatedAt ?? initialTaskUsage?.generatedAt ?? "") || 0);
  const [refreshState, setRefreshState] = useState<RefreshState>("idle");
  const lastManual = useRef(0);
  const live = Boolean(taskUsage?.active);

  const readTask = useCallback(async () => {
    if (!taskId) return true;
    const response = await fetch(`/api/projects/${projectId}/usage?taskId=${taskId}`, { cache: "no-store" });
    if (!response.ok) return false;
    const body = await response.json() as { taskUsage?: TaskUsage | null };
    setTaskUsage(body.taskUsage ?? null);
    return true;
  }, [projectId, taskId]);

  const readOperator = useCallback(async () => {
    const response = await fetch("/api/control-plane/usage", { cache: "no-store" });
    if (!response.ok) return false;
    const body = await response.json() as { usage: OperatorUsage | null };
    setOperatorUsage(body.usage);
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    const task = window.setInterval(() => { void readTask().then(() => { if (!cancelled) setNow(Date.now()); }).catch(() => {}); }, live ? LIVE_MS : IDLE_MS);
    const operator = window.setInterval(() => { void readOperator().catch(() => {}); }, IDLE_MS);
    return () => { cancelled = true; window.clearTimeout(first); window.clearInterval(clock); window.clearInterval(task); window.clearInterval(operator); };
  }, [readTask, readOperator, live]);

  const refresh = useCallback(() => {
    const since = Date.now() - lastManual.current;
    if (since < REFRESH_EVERY_MS) {
      setRefreshState("wait");
      window.setTimeout(() => setRefreshState((current) => current === "wait" ? "idle" : current), 2_500);
      return;
    }
    lastManual.current = Date.now();
    setRefreshState("refreshing");
    Promise.all([readTask(), readOperator()])
      .then(([task, operator]) => { setNow(Date.now()); setRefreshState(task && operator ? "updated" : "failed"); })
      .catch(() => setRefreshState("failed"))
      .finally(() => window.setTimeout(() => setRefreshState((current) => current === "updated" || current === "failed" ? "idle" : current), 4_000));
  }, [readTask, readOperator]);

  return <UsageContext.Provider value={{ taskUsage, operatorUsage, now, refreshState, refresh }}>{children}</UsageContext.Provider>;
}

// One member's tokens in this chat, live; a dot while its run is going.
export function MemberTokens({ assignmentId }: { assignmentId: string }) {
  const usage = useChatUsage();
  const member = usage?.taskUsage?.members.find((candidate) => candidate.assignmentId === assignmentId);
  if (!member) return null;
  return <span className="inline-flex items-center gap-1.5 tabular-nums">
    {/* Claude Code reports its tokens when a turn ends: while it runs, nothing
        has been counted yet, which is not "none". */}
    {member.usage.totalTokens ? `${compactTokens(member.usage.totalTokens)} tokens` : member.running ? "counting…" : "no tokens yet"}
    {member.running && <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse motion-reduce:animate-none" role="img" aria-label="running"/>}
  </span>;
}
