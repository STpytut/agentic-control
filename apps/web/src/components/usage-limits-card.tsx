"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card } from "@agentic/design-system";
import { UsageWindowBar } from "@/components/ui/usage-window-bar";
import {
  OPENCODE_GO_ESTIMATES, compactTokens, costText, costTitle, goEstimateText, limitsNote, planLabel, readAge, sourceLabel,
  type ConnectionUsage, type OperatorUsage, type UsageTotals,
} from "@/lib/usage";
import { runtimeLabel } from "@/lib/runtime-labels";

// Settings → Limits & usage (Stage 12). Each model connection: its windows as
// last read, with when and from where; what it used today and in its current
// window; and, where limits cannot be read, why. Refreshed every minute while
// the page is open, and on "Refresh", which says when it has answered.
const POLL_MS = 60_000;

function Totals({ label, totals }: { label: string; totals: UsageTotals }) {
  const cost = costText(totals.costUsd, totals.costBasis);
  return (
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <dt className="type-meta text-muted">{label}</dt>
      <dd className="type-meta m-0 text-right tabular-nums">
        {totals.totalTokens ? `${compactTokens(totals.totalTokens)} tokens` : "No tokens"}
        {totals.runs ? ` · ${totals.runs} run${totals.runs === 1 ? "" : "s"}` : ""}
        {cost && <span title={costTitle(totals.costBasis)}> · {cost}</span>}
        {totals.checks.count > 0 && <span className="text-muted"> · checks {compactTokens(totals.checks.totalTokens)} tokens ({totals.checks.count})</span>}
      </dd>
    </div>
  );
}

function ConnectionSection({ connection, now }: { connection: ConnectionUsage; now: number }) {
  const { limits } = connection;
  const note = limitsNote(connection);
  const statusTone = limits?.status === "rejected" ? "danger" : limits?.status === "allowed_warning" ? "warning" : null;
  return (
    <section className="grid gap-3 border-t border-line py-4 first:border-t-0 first:pt-0 last:pb-0" aria-label={`${connection.label} limits and usage`}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="type-meta m-0 font-medium">{connection.label}</h3>
          <p className="type-meta m-0 text-muted">{runtimeLabel(connection.runtimeType)}{connection.status !== "connected" ? ` · ${connection.status.replace(/_/g, " ")}` : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {limits?.plan && <Badge tone="neutral">{planLabel(limits.plan)}</Badge>}
          {statusTone && <Badge tone={statusTone}>{limits?.status === "rejected" ? "Limit reached" : "Near the limit"}</Badge>}
          {connection.limitsMode === "free" && <Badge tone="success">Free</Badge>}
        </div>
      </header>

      {limits && limits.windows.length > 0 && (
        <div className="grid gap-3 tablet:grid-cols-1 grid-cols-2">
          {limits.windows.map((window) => <UsageWindowBar key={window.key} window={window} now={now}/>)}
        </div>
      )}
      {limits && (
        <p className="type-meta m-0 text-muted">
          {readAge(limits.readAt, now)} · {sourceLabel(limits.source)}
          {limits.credits && (limits.credits.unlimited ? " · credits: unlimited"
            : limits.credits.balance !== null ? ` · credits: ${limits.credits.balance}`
              : limits.credits.hasCredits === false ? " · no credits" : "")}
          {limits.errorClass ? ` · last reading failed (${limits.errorClass.replace(/_/g, " ")})` : ""}
        </p>
      )}
      {note && <p className="type-meta m-0 text-muted">{note}</p>}

      <dl className="m-0 grid gap-1">
        <Totals label="Today (UTC)" totals={connection.today}/>
        {connection.window && <Totals label="This window" totals={connection.window.usage}/>}
      </dl>

      {connection.requests5h && (
        <div className="grid gap-1">
          <p className="type-eyebrow m-0 text-muted">REQUESTS IN THE LAST 5 HOURS, PER MODEL</p>
          {connection.requests5h.models.length === 0
            ? <p className="type-meta m-0 text-muted">No requests from this platform in the last five hours.</p>
            : <ul className="m-0 grid list-none divide-y divide-line p-0">
              {connection.requests5h.models.map((model) => (
                <li key={model.model} className="type-meta grid gap-0.5 py-1.5">
                  <span className="flex min-w-0 items-baseline justify-between gap-2">
                    <span className="type-mono-small truncate">{model.model}</span>
                    <span className="shrink-0 tabular-nums">{model.requests.toLocaleString("en")} request{model.requests === 1 ? "" : "s"}</span>
                  </span>
                  {model.estimate && <span className="text-muted">{goEstimateText(model.estimate)}</span>}
                </li>
              ))}
            </ul>}
          <p className="type-meta m-0 text-muted">
            Estimates as published at <a className="underline" href={OPENCODE_GO_ESTIMATES.source} target="_blank" rel="noreferrer">opencode.ai/go</a> on {OPENCODE_GO_ESTIMATES.fetchedAt}; our count is this platform&apos;s runs and checks only.
          </p>
        </div>
      )}
    </section>
  );
}

export function UsageLimitsCard({ initial }: { initial: OperatorUsage | null }) {
  const [usage, setUsage] = useState(initial);
  const [now, setNow] = useState(() => Date.parse(initial?.generatedAt ?? "") || 0);
  const [state, setState] = useState<"idle" | "refreshing" | "updated" | "failed">("idle");

  const refresh = useCallback(async (manual: boolean) => {
    if (manual) setState("refreshing");
    try {
      const response = await fetch("/api/control-plane/usage", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { usage: OperatorUsage | null };
      setUsage(body.usage);
      setNow(Date.now());
      if (manual) setState("updated");
    } catch {
      if (manual) setState("failed");
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    const poll = window.setInterval(() => void refresh(false), POLL_MS);
    return () => { window.clearTimeout(first); window.clearInterval(clock); window.clearInterval(poll); };
  }, [refresh]);

  const connections = usage?.connections ?? [];
  return (
    <Card className="min-w-0">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="type-eyebrow m-0 text-muted">LIMITS & USAGE</p>
          <p className="type-meta mt-1 mb-0 text-muted">Each connection&apos;s usage windows as its provider last reported them, and what this platform used on it.</p>
        </div>
        <div className="flex items-center gap-2">
          <span role="status" className="type-meta text-muted">
            {state === "refreshing" ? "Refreshing…" : state === "updated" ? "Updated just now" : state === "failed" ? "Could not refresh" : ""}
          </span>
          <Button variant="secondary" size="sm" disabled={state === "refreshing"} onClick={() => void refresh(true)}>
            {state === "refreshing" ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>
      {!usage
        ? <p className="type-meta m-0 text-muted">Limits and usage are not available on this server yet.</p>
        : connections.length === 0
          ? <p className="type-meta m-0 text-muted">No model connections yet. Connect ChatGPT, Claude or OpenCode in Connections.</p>
          : <div className="grid">{connections.map((connection) => <ConnectionSection key={connection.connectionId} connection={connection} now={now}/>)}</div>}
    </Card>
  );
}
