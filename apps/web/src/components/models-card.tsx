"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import {
  BILLING_WORDS, canCheckAgain, clockTime, compareVendors, connectionVendor, rollupWords, someNames, stateWords, timeAgo, vendorLabel,
  type CatalogSearch, type ModelCheck, type ModelConnection, type ModelRow, type ModelState, type OperatorModels,
} from "@/lib/models";
import { runtimeLabel } from "@/lib/runtime-labels";
import { pinModelRequest, requestModelCheckRequest, useClock, useModelChecks, type WatchedCheck } from "@/components/ui/model-check-client";
import { Spinner } from "@/components/ui/spinner";
import { Badge, Button, Card, Checkbox, Select, TextInput, cx } from "@agentic/design-system";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

// `/settings` → Models (Stage 12 W7; docs/RUNTIMES_AND_MODELS_DESIGN.md §2.5,
// §2.7; docs/W6_W7_CONTRACT.md).
//
// One card; one section per connection, the connections in the redesign's
// vendor order (Anthropic, OpenAI, others). A connection shows what
// `get_operator_models` gives it — pinned, in use, or its whole list when that
// is small — and for the rest "N more — search", a server-side search capped
// at 50. Each row has one state word (ready, checking…, not checked, refused,
// waiting) and at most two actions: ☆ pin, which starts the model's check, and
// "Check again" on a row whose check did not pass. There is no Verify button.
//
// Every click answers on the row it was made on, at once: the button turns
// busy, then the row says what the database answered — "checking… 12 s" while
// the check runs, polled every 2 s, then its result.

type Busy = { entryId: string; what: "pin" | "unpin" | "check" };
type RowOverride = { pinned?: boolean; state?: ModelState; reason?: string | null; error?: string };

const ROLE_WORDS: Record<string, string> = { orchestrator: "orchestrator", executor: "executor", coder: "coder", checker: "checker" };

function mergeCheck(row: ModelRow, override: RowOverride | undefined, watched: WatchedCheck | undefined): ModelRow {
  let merged: ModelRow = override ? {
    ...row,
    pinned: override.pinned ?? row.pinned,
    state: override.state ?? row.state,
    reason: override.reason !== undefined ? override.reason : row.reason,
  } : row;
  if (watched) {
    const check = watched.check;
    if (!check || check.state === "checking") merged = { ...merged, state: "checking", reason: null };
    else merged = { ...merged, state: check.state, reason: check.reason, retryAt: check.retryAt,
      checkedAt: check.finishedAt ?? merged.checkedAt };
  }
  return merged;
}

export function ModelsCard({ models }: { models: OperatorModels }) {
  const router = useRouter();
  const now = useClock(Date.parse(models.readAt) || 0, 1000);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [overrides, setOverrides] = useState<Record<string, RowOverride>>({});
  const [announcement, setAnnouncement] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<{ ok: boolean; text: string } | null>(null);

  const onSettled = useCallback((check: ModelCheck) => {
    setAnnouncement(check.state === "ready" ? "A model check passed." : `A model check ended: ${check.state}${check.reason ? `, ${check.reason}` : ""}.`);
    // The server's view catches up: the counters, "in use", the row order.
    router.refresh();
  }, [router]);
  const { watched, watch } = useModelChecks(onSettled);

  const connections = useMemo(() => [...models.connections].sort((a, b) =>
    compareVendors(connectionVendor(a), connectionVendor(b)) || a.label.localeCompare(b.label)), [models.connections]);
  // Settings → Models (Stage 12 N7): the connections under vendor tabs —
  // Anthropic, OpenAI, the others — in the order above.
  const groups = useMemo(() => [...new Set(connections.map(vendorGroup))], [connections]);
  const [group, setGroup] = useState<string>("");
  const shownGroup = groups.includes(group) ? group : groups[0] ?? "";
  const shown = groups.length > 1 ? connections.filter((connection) => vendorGroup(connection) === shownGroup) : connections;

  function override(entryId: string, change: RowOverride) {
    setOverrides((all) => ({ ...all, [entryId]: { ...all[entryId], ...change } }));
  }

  async function togglePin(row: ModelRow) {
    const pin = !row.pinned;
    setBusy({ entryId: row.entryId, what: pin ? "pin" : "unpin" });
    override(row.entryId, { error: undefined });
    try {
      const result = await pinModelRequest(row.entryId, pin);
      override(row.entryId, { pinned: result.pinned });
      if (result.checkId) watch(row.entryId, result.checkId);
      setAnnouncement(`${row.displayName || row.modelId} ${result.pinned ? "pinned" : "unpinned"}${result.checkId ? "; its check has started" : ""}.`);
      if (!result.checkId) router.refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : "The pin was not changed";
      override(row.entryId, { error: text });
      setAnnouncement(text);
    } finally {
      setBusy(null);
    }
  }

  async function checkAgain(row: ModelRow) {
    setBusy({ entryId: row.entryId, what: "check" });
    override(row.entryId, { error: undefined });
    try {
      const request = await requestModelCheckRequest(row.entryId, "check_again");
      // An answer that is already a verdict carries its reason (0105): shown
      // on the row at once; anything else is watched until it settles.
      if (request.state === "refused" || request.state === "failed" || !request.checkId) {
        override(row.entryId, { state: request.state, reason: request.reason });
      } else watch(row.entryId, request.checkId);
      setAnnouncement(`${row.displayName || row.modelId}: check ${request.deduplicated ? "already running" : "started"}.`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "The check was not started";
      override(row.entryId, { error: text });
      setAnnouncement(text);
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const response = await fetch("/api/control-plane/actions", {
        method: "POST",
        headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ kind: "catalog_refresh" }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Catalog refresh failed");
      const refreshes = Array.isArray(data.result?.refreshes) ? data.result.refreshes : [];
      setRefreshResult({ ok: true, text: `Reading the list again for ${refreshes.length} connection${refreshes.length === 1 ? "" : "s"}; new models appear here when it is read.` });
    } catch (cause) {
      setRefreshResult({ ok: false, text: cause instanceof Error ? cause.message : "Catalog refresh failed" });
    } finally {
      setRefreshing(false);
    }
  }

  const rowProps = { now, busy, watched, overrides, onPin: togglePin, onCheckAgain: checkAgain };
  const overLimit = models.hardLimit > 0 && models.checksToday >= models.hardLimit;
  const autoSpent = models.autoChecks.limit > 0 && models.autoChecks.used >= models.autoChecks.limit;
  // The budget is the last 24 hours, not a calendar day: a check frees when
  // the oldest counted one ages out, and the count is clear when the newest does.
  const budgetNote = overLimit && models.budget.nextSlotAt ? `the next check frees at ${clockTime(models.budget.nextSlotAt)}`
    : autoSpent && models.budget.autoNextSlotAt ? `automatic checks resume at ${clockTime(models.budget.autoNextSlotAt)}`
    : models.budget.clearAt ? `rolling 24 h, clear at ${clockTime(models.budget.clearAt)}` : "rolling 24 h";

  return <Card as="section" className="min-w-0" aria-labelledby="models-title">
    <header className="flex items-start justify-between gap-4 phone:flex-col">
      <div className="min-w-0">
        <p className="type-eyebrow text-muted">MODELS</p>
        <h2 id="models-title" className="type-section-title mt-1.5">Models</h2>
        <p className="type-app-body mt-1.5 max-w-[70ch] text-muted">What each connection offers your projects. A model is checked once with one short turn before a team can use it; pin one (☆) to offer it in Team — its check starts at once.</p>
      </div>
      <div className="grid shrink-0 justify-items-end gap-1.5 phone:w-full phone:justify-items-start">
        <p className="type-meta tabular-nums text-right phone:text-left">
          <strong className="font-medium">{models.checksToday} check{models.checksToday === 1 ? "" : "s"} today</strong>
          <span className="text-muted"> · automatic {models.autoChecks.used} of {models.autoChecks.limit}{models.hardLimit ? ` · limit ${models.hardLimit} a day` : ""}</span>
          <span className="block text-muted" suppressHydrationWarning>{budgetNote}</span>
        </p>
        <Button variant="secondary" size="sm" disabled={refreshing} aria-busy={refreshing} onClick={refresh}>
          {refreshing && <Spinner/>}{refreshing ? "Requesting…" : "Refresh now"}
        </Button>
        <p role="status" className={cx("type-meta max-w-[34ch] text-right empty:hidden phone:max-w-none phone:text-left", refreshResult?.ok ? "text-info" : "text-danger")}>{refreshResult?.text}</p>
      </div>
    </header>
    {overLimit && <p className="type-meta mt-3 text-warning">The limit of {models.hardLimit} checks in 24 hours is reached: pins and picks are refused{models.budget.nextSlotAt ? ` until ${clockTime(models.budget.nextSlotAt)}` : " until the oldest check ages out"}.</p>}
    <p role="status" className="sr-only">{announcement}</p>

    {connections.length === 0
      ? <p className="type-app-body mt-5 border-t border-line pt-4 text-muted">No connection lists models yet. Connect ChatGPT, OpenCode or Claude in Connections.</p>
      : <>
        {groups.length > 1 && <div role="tablist" aria-label="Vendors" className="mt-5 flex flex-wrap gap-1.5">
          {groups.map((name) => <button key={name} type="button" role="tab" aria-selected={name === shownGroup} aria-controls="models-vendor-panel"
            onClick={() => setGroup(name)}
            className={cx("touch-target h-9 rounded-full border px-3.5 text-[0.8125rem] font-medium transition-colors duration-150 phone:h-11",
              name === shownGroup ? "border-ink bg-ink text-on-ink" : "border-line-strong text-ink hover:border-ink")}>{vendorLabel(name)}</button>)}
        </div>}
        <div id="models-vendor-panel" role={groups.length > 1 ? "tabpanel" : undefined}>
          {shown.map((connection) => <ConnectionSection key={connection.connectionId} connection={connection} {...rowProps}/>)}
        </div>
      </>}
  </Card>;
}

// A connection's tab: its main vendor when that is Anthropic or OpenAI, else
// the others ("" reads "Other vendors").
function vendorGroup(connection: ModelConnection): string {
  const vendor = connectionVendor(connection).toLowerCase();
  return vendor === "anthropic" || vendor === "openai" ? vendor : "";
}

type RowProps = {
  now: number; busy: Busy | null; watched: Record<string, WatchedCheck>; overrides: Record<string, RowOverride>;
  onPin: (row: ModelRow) => void; onCheckAgain: (row: ModelRow) => void;
};

function ConnectionSection({ connection, ...rowProps }: { connection: ModelConnection } & RowProps) {
  const vendors = [...new Set(connection.models.map((row) => row.vendor))].sort(compareVendors);
  const grouped = vendors.length > 1;
  const read = timeAgo(connection.listReadAt, rowProps.now);
  return <section className="mt-5 border-t border-line pt-4" aria-labelledby={`connection-${connection.connectionId}`}>
    <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <h3 id={`connection-${connection.connectionId}`} className="type-card-title">
        {connection.label || connection.provider}
        <span className="type-meta font-normal text-muted"> ({runtimeLabel(connection.runtimeType)}{connection.runtimeVersion ? ` ${connection.runtimeVersion}` : ""})</span>
      </h3>
      <span className="type-meta text-muted">· {BILLING_WORDS[connection.billing] ?? connection.billing}</span>
      <span className="type-meta text-muted tabular-nums" suppressHydrationWarning>· {connection.totalModels} model{connection.totalModels === 1 ? "" : "s"} · {read ? `list read ${read}` : "list not read yet"}</span>
    </header>
    {connection.rollup && connection.rollup.total > 0 && <p className="type-meta mt-0.5 text-muted tabular-nums">{rollupWords(connection.rollup)}</p>}
    {connection.newerRuntime && <p className="type-meta mt-0.5 text-info [overflow-wrap:anywhere]">
      {runtimeLabel(connection.runtimeType)} {connection.newerRuntime.version} would
      {connection.newerRuntime.added.length > 0 && ` add ${someNames(connection.newerRuntime.added)}`}
      {connection.newerRuntime.added.length > 0 && connection.newerRuntime.removed.length > 0 && " and"}
      {connection.newerRuntime.removed.length > 0 && ` drop ${someNames(connection.newerRuntime.removed)}`}
      <span className="text-muted"> — {connection.newerRuntime.result === "passed" ? "qualified; see Runtimes" : "its qualification did not pass; see Runtimes"}</span>
    </p>}
    {connection.models.length === 0
      ? <p className="type-meta mt-2 text-muted">{connection.moreCount > 0 ? "Nothing pinned or in use yet: search the list below and pin (☆) what you want to offer." : "This connection lists no models yet."}</p>
      : vendors.map((vendor) => <div key={vendor || "-"} className={grouped ? "mt-3" : "mt-1"}>
        {grouped && <p className="type-eyebrow text-muted">{vendorLabel(vendor)}</p>}
        <ul className="m-0 grid list-none divide-y divide-line p-0">
          {connection.models.filter((row) => row.vendor === vendor).map((row) => <ModelRowItem key={row.entryId} row={row} {...rowProps}/>)}
        </ul>
      </div>)}
    {connection.moreCount > 0 && <CatalogSearchPanel connection={connection} {...rowProps}/>}
  </section>;
}

function ModelRowItem({ row: base, now, busy, watched, overrides, onPin, onCheckAgain }: { row: ModelRow } & RowProps) {
  const watch = watched[base.entryId];
  const extra = overrides[base.entryId];
  const row = mergeCheck(base, extra, watch);
  const words = stateWords(row.state, row.retryAt);
  const mine = busy?.entryId === row.entryId ? busy.what : null;
  const name = row.displayName || row.modelId;
  const elapsed = watch && row.state === "checking" ? Math.max(0, Math.round((now - watch.since) / 1000)) : null;
  const checked = row.state !== "checking" ? timeAgo(row.checkedAt, now) : null;
  const pinLabel = row.pinned ? `Unpin ${name}` : `Pin ${name} and check it`;
  const progress = [elapsed !== null ? `${elapsed} s` : null, watch?.check?.queuePosition ? `${watch.check.queuePosition} ahead` : null,
    elapsed === null || elapsed < 5 ? "about 40 s" : null, watch?.unreachable ? "reconnecting…" : null].filter(Boolean).join(" · ");
  // One line per model on a wide screen — pin, name, state, action — and the
  // state under the name on a phone.
  return <li className="grid grid-cols-[32px_minmax(0,1.2fr)_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 py-2 tablet:grid-cols-[32px_minmax(0,1fr)_auto] phone:grid-cols-[32px_minmax(0,1fr)]">
    <button type="button" onClick={() => onPin(row)} disabled={Boolean(busy)} aria-pressed={row.pinned} aria-label={pinLabel} title={pinLabel}
      aria-busy={mine === "pin" || mine === "unpin"}
      className={cx("grid h-8 w-8 place-items-center rounded-sm text-[1.05rem] leading-none hover:bg-ink/5 focus-visible:outline-2 disabled:cursor-default",
        row.pinned ? "text-ink" : "text-muted", busy && !mine && "opacity-60")}>
      {mine === "pin" || mine === "unpin" ? <Spinner/> : <span aria-hidden="true">{row.pinned ? "★" : "☆"}</span>}
    </button>
    <div className="min-w-0 pt-1">
      <p className="type-meta flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <strong className="font-medium [overflow-wrap:anywhere]">{name}</strong>
        {row.resolvedModel && <span className="text-muted">→ {row.resolvedModel}</span>}
      </p>
      {row.aliasDrift && <p className="type-meta text-warning [overflow-wrap:anywhere]" suppressHydrationWarning>
        {row.modelId} now resolves to {row.aliasDrift.model}{row.aliasDrift.seenAt ? ` (seen ${timeAgo(row.aliasDrift.seenAt, now)})` : ""} — re-checking; it stays usable meanwhile
      </p>}
      {row.displayName && row.displayName !== row.modelId && <p className="type-mono-small text-muted [overflow-wrap:anywhere]">{row.modelId}</p>}
      {row.inUse.length > 0 && <p className="type-meta text-muted">in use: {row.inUse.map((use) => `${ROLE_WORDS[use.role] ?? use.role}, project “${use.projectName}”`).join("; ")}</p>}
    </div>
    <div className="min-w-0 pt-1 tablet:col-start-2 tablet:row-start-2">
      <p className="type-meta flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" suppressHydrationWarning>
        <Badge tone={words.tone} dot={row.state === "ready"}>{row.state === "checking" ? <><Spinner/>checking…</> : words.word}</Badge>
        {row.state === "checking" && progress && <span className="tabular-nums text-muted">{progress}</span>}
        {(row.state === "refused" || row.state === "failed" || row.state === "waiting") && row.reason && <span className={cx("[overflow-wrap:anywhere]", row.state === "waiting" ? "text-warning" : "text-danger")}>{row.reason}</span>}
        {words.note && <span className="text-muted">({words.note})</span>}
        {checked && row.state !== "not_checked" && <span className="text-muted">checked {checked}</span>}
      </p>
      {extra?.error && <p role="status" className="type-meta mt-1 text-danger">{extra.error}</p>}
    </div>
    {canCheckAgain(row.state) && <div className="tablet:col-start-3 tablet:row-start-1 phone:col-start-2 phone:row-start-3">
      <Button variant="secondary" size="sm" disabled={Boolean(busy)} aria-busy={mine === "check"} onClick={() => onCheckAgain(row)}>
        {mine === "check" && <Spinner/>}{mine === "check" ? "Requesting…" : "Check again"}
      </Button>
    </div>}
  </li>;
}

// "N more — search": collapsed until asked, then a server-side search of this
// connection's list — debounced, at most 50 answers, with the vendor filter and
// "checked only". A result can be pinned right here.
function CatalogSearchPanel({ connection, ...rowProps }: { connection: ModelConnection } & RowProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [vendor, setVendor] = useState("");
  const [checkedOnly, setCheckedOnly] = useState(false);
  const [answer, setAnswer] = useState<CatalogSearch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // The connection's vendors come with the card (0105), so the filter is
  // complete before any search; what a search turns up is added, just in case.
  const [vendorsSeen, setVendorsSeen] = useState<string[]>(() => [...new Set([
    ...connection.vendors.map((entry) => entry.vendor), ...connection.models.map((row) => row.vendor)].filter(Boolean))]);
  const vendorCounts = useMemo(() => new Map(connection.vendors.map((entry) => [entry.vendor, entry.count])), [connection.vendors]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      const params = new URLSearchParams({ connection: connection.connectionId, q: query.trim(), limit: "50" });
      if (vendor) params.set("vendor", vendor);
      if (checkedOnly) params.set("checked", "1");
      try {
        const response = await fetch(`/api/control-plane/models/search?${params}`, { signal: controller.signal, cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error ?? "The search failed");
        const result: CatalogSearch = { total: Number(data.total ?? 0), results: Array.isArray(data.results) ? data.results : [] };
        setAnswer(result);
        setVendorsSeen((seen) => [...new Set([...seen, ...result.results.map((row) => row.vendor).filter(Boolean)])]);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "The search failed");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, query ? 300 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [open, query, vendor, checkedOnly, connection.connectionId]);

  const inputId = `search-${connection.connectionId}`;
  if (!open) {
    return <Button variant="secondary" size="sm" className="mt-3" onClick={() => setOpen(true)} aria-expanded={false} aria-controls={inputId}>
      {connection.moreCount} more — search
    </Button>;
  }
  const shown = answer?.results ?? [];
  return <div className="mt-3 grid gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <TextInput id={inputId} type="search" autoFocus className="min-w-0 flex-[1_1_240px] max-w-[420px]" value={query}
        onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${connection.moreCount} more models…`}
        aria-label={`Search ${connection.label || connection.provider} models by id or name`}/>
      <Select value={vendor} onChange={(event) => setVendor(event.target.value)} aria-label="Vendor" className="w-auto min-w-[140px] phone:flex-1">
        <option value="">All vendors</option>
        {[...vendorsSeen].sort(compareVendors).map((name) => <option key={name} value={name}>{vendorLabel(name)}{vendorCounts.has(name) ? ` (${vendorCounts.get(name)})` : ""}</option>)}
      </Select>
      <Checkbox label="checked only" checked={checkedOnly} onChange={(event) => setCheckedOnly(event.target.checked)} className="min-h-8 items-center"/>
    </div>
    <p role="status" className="type-meta flex items-center gap-1.5 text-muted">
      {loading ? <><Spinner/>Searching…</>
        : error ? <span className="text-danger">{error}</span>
        : answer ? (answer.total === 0 ? `No model matches${query.trim() ? ` “${query.trim()}”` : ""}.`
          : answer.total > shown.length ? `${answer.total} match — showing the first ${shown.length}; narrow the search to see the rest.`
          : `${answer.total} match${answer.total === 1 ? "" : "es"}.`) : ""}
    </p>
    {shown.length > 0 && <ul className={cx("m-0 grid list-none divide-y divide-line border-t border-line p-0", loading && "opacity-60")}>
      {shown.map((row) => <ModelRowItem key={row.entryId} row={row} {...rowProps}/>)}
    </ul>}
    <Button variant="secondary" size="sm" className="justify-self-start" onClick={() => setOpen(false)} aria-expanded aria-controls={inputId}>Close search</Button>
  </div>;
}
