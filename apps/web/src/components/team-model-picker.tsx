"use client";

import { HELD_BACK_WORDS, type ProjectTeam } from "@/lib/team";
import { candidatesFor, roleOf, type Candidate, type PickerMode } from "@/lib/team-candidates";

export type { PickerMode } from "@/lib/team-candidates";
import { runtimeLabel } from "@/lib/runtime-labels";
import {
  BILLING_WORDS, GATEWAY_WORDS, checkSettled, stateWords, type ModelCheck, type ModelRow, type ModelState, type OperatorModels,
} from "@/lib/models";
import { requestModelCheckRequest, useClock, useModelChecks } from "@/components/ui/model-check-client";
import { Spinner } from "@/components/ui/spinner";
import { Button, TextInput, cx } from "@agentic/design-system";
import { ReasoningSelect } from "@/components/reasoning-select";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// Team → Add executor / Change model (Stage 12 W7; docs/RUNTIMES_AND_MODELS_DESIGN.md
// §2.7, R7; docs/W6_W7_CONTRACT.md "Team: picking a not-checked model").
//
// The models for the role in three groups: ready on the role's runtimes; not
// checked yet ("checked when you pick it, ~40 s"); not available for this role,
// with the reason. Picking a not-checked model starts its check at once
// (`request_model_check(…, 'pick')`) and the dialog asks `get_model_check`
// every 2 s. "Add" on a ready model calls the team action it always called; on
// a model still being checked it waits, and adds when the check passes — never
// before, so a member is never half-added, and the database still refuses an
// unchecked model on its own. A refusal stays in the dialog with its reason.
// Closing the dialog stops the asking, not the check: the model is simply ready
// next time.

// The level beside the model (Stage 12, 0111): undefined when the operator did
// not choose one — a changed member then keeps its own where the new model
// lists it — "" for the runtime's default.
export type PickerSubmit = (entryId: string, reasoningEffort?: string) => Promise<{ ok: boolean; text: string }>;

type Phase =
  | { step: "idle" }
  | { step: "requesting"; entryId: string }
  | { step: "checking"; entryId: string; armed: boolean }
  | { step: "submitting"; entryId: string }
  | { step: "refused"; entryId: string; text: string };

const SHOWN_UNAVAILABLE = 6;
const WORDS = { runtime: runtimeLabel, heldBack: HELD_BACK_WORDS, gateway: GATEWAY_WORDS };

export function TeamModelPicker({ team, models, mode, onSubmit, onClose }: {
  team: ProjectTeam; models: OperatorModels | null; mode: PickerMode; onSubmit: PickerSubmit; onClose: () => void;
}) {
  const role = roleOf(mode);
  const title = mode.kind === "add" ? "Add executor" : `Change model · ${mode.assignment.roleName}`;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const [searched, setSearched] = useState<{ rows: ModelRow[]; connectionOf: Record<string, string> }>({ rows: [], connectionOf: {} });
  const [searching, setSearching] = useState(false);
  const now = useClock(Date.parse(models?.readAt ?? "") || 0, 1000);
  const [readyNow, setReadyNow] = useState<Set<string>>(() => new Set());
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  // The level chosen for the picked model; null until the operator chooses.
  const [level, setLevel] = useState<string | null>(null);
  const levelRef = useRef(level);
  useEffect(() => { levelRef.current = level; }, [level]);

  const submit = useCallback(async (entryId: string) => {
    setPhase({ step: "submitting", entryId });
    const answer = await onSubmit(entryId, levelRef.current ?? undefined);
    // On success the tab closes the dialog; on a refusal it stays, with the words.
    if (!answer.ok) setPhase({ step: "refused", entryId, text: answer.text });
  }, [onSubmit]);

  const onSettled = useCallback((check: ModelCheck) => {
    const current = phaseRef.current;
    if (current.step !== "checking" || current.entryId !== check.entryId) return;
    if (check.state === "ready") {
      setReadyNow((set) => new Set(set).add(check.entryId));
      if (current.armed) void submit(check.entryId);
      else setPhase({ step: "idle" });
    } else {
      const words = stateWords(check.state, check.retryAt);
      setPhase({ step: "refused", entryId: check.entryId, text: `${words.word}${check.reason ? `: ${check.reason}` : ""}${words.note ? ` (${words.note})` : ""}` });
    }
  }, [submit]);
  const { watched, watch } = useModelChecks(onSettled);

  // "Search all": the connections this role can use whose lists are larger than
  // what the page already holds, searched on the server as the operator types.
  const searchable = useMemo(() => (models?.connections ?? []).filter((connection) => connection.moreCount > 0
    && (mode.kind === "change" ? connection.runtimeType === mode.assignment.runtime
      : team.runtimes.find((entry) => entry.runtime === connection.runtimeType)?.plays.includes(role))), [models, mode, team.runtimes, role]);
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2 || searchable.length === 0) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      const rows: ModelRow[] = [];
      const connectionOf: Record<string, string> = {};
      await Promise.all(searchable.map(async (connection) => {
        const params = new URLSearchParams({ connection: connection.connectionId, q: term, limit: "20" });
        try {
          const response = await fetch(`/api/control-plane/models/search?${params}`, { signal: controller.signal, cache: "no-store" });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok || !Array.isArray(data.results)) return;
          for (const row of data.results as ModelRow[]) { rows.push(row); connectionOf[row.entryId] = connection.connectionId; }
        } catch { /* a failed search leaves the lists the page already has */ }
      }));
      if (controller.signal.aborted) return;
      setSearched({ rows, connectionOf });
      setSearching(false);
    }, 300);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, searchable]);

  const all = candidatesFor(team, models, mode, WORDS, searched.rows, searched.connectionOf);
  const term = query.trim().toLowerCase();
  const matches = (candidate: Candidate) => !term
    || `${candidate.name} ${candidate.modelId} ${candidate.resolved ?? ""} ${candidate.where}`.toLowerCase().includes(term);
  // A model whose check passed while the dialog was open moves up to "Ready".
  const passed = (candidate: Candidate) => candidate.group === "unchecked" && effectiveState(candidate) === "ready";
  const ready = all.filter((candidate) => (candidate.group === "ready" || passed(candidate)) && matches(candidate));
  const unchecked = all.filter((candidate) => candidate.group === "unchecked" && !passed(candidate) && matches(candidate));
  const unavailable = all.filter((candidate) => candidate.group === "unavailable" && matches(candidate));
  const readyRuntimes = [...new Set(ready.map((candidate) => candidate.runtime))];
  const moreToSearch = searchable.reduce((sum, connection) => sum + connection.moreCount, 0);

  const pickedWatch = selected ? watched[selected] : undefined;
  const picked = all.find((candidate) => candidate.entryId === selected);
  const working = phase.step === "requesting" || phase.step === "submitting" || (phase.step === "checking" && phase.armed);

  function effectiveState(candidate: Candidate): ModelState {
    if (readyNow.has(candidate.entryId)) return "ready";
    const entry = watched[candidate.entryId];
    if (entry) return !entry.check || entry.check.state === "checking" ? "checking" : entry.check.state;
    return candidate.group === "ready" ? "ready" : candidate.row?.state ?? "not_checked";
  }

  // Picking starts the check at once; the answer shows on the row and beside
  // the buttons, and the poller carries it from there.
  async function pick(candidate: Candidate) {
    const id = candidate.entryId;
    setSelected(id);
    setLevel(null);
    if (effectiveState(candidate) === "ready") { setPhase({ step: "idle" }); return; }
    const existing = watched[id];
    if (existing && (!existing.check || !checkSettled(existing.check.state))) { setPhase({ step: "checking", entryId: id, armed: false }); return; }
    setPhase({ step: "requesting", entryId: id });
    try {
      const request = await requestModelCheckRequest(id, "pick");
      if (request.state === "ready") {
        setReadyNow((set) => new Set(set).add(id));
        setPhase({ step: "idle" });
      } else if (request.state === "refused" || request.state === "failed" || !request.checkId) {
        // A refusal at the model's current key comes with its reason (0105):
        // shown at once, no poll.
        const words = stateWords(request.state, request.retryAt);
        setPhase({ step: "refused", entryId: id,
          text: `${words.word}${request.reason ? `: ${request.reason}` : ""}${words.note ? ` (${words.note})` : ""}` });
      } else {
        watch(id, request.checkId);
        setPhase({ step: "checking", entryId: id, armed: false });
      }
    } catch (error) {
      setPhase({ step: "refused", entryId: id, text: error instanceof Error ? error.message : "The check was not started" });
    }
  }

  function confirm() {
    if (!picked) return;
    if (effectiveState(picked) === "ready") { void submit(picked.entryId); return; }
    if (phase.step === "checking" && phase.entryId === picked.entryId) setPhase({ ...phase, armed: true });
    else void pick(picked).then(() => setPhase((current) => current.step === "checking" ? { ...current, armed: true } : current));
  }

  const elapsed = pickedWatch ? Math.max(0, Math.round((now - pickedWatch.since) / 1000)) : 0;
  const status = !picked ? ""
    : phase.step === "requesting" ? `Starting the check of ${picked.name}…`
    : phase.step === "checking" ? `Checking ${picked.name}… (${elapsed} s${pickedWatch?.check?.queuePosition ? `, ${pickedWatch.check.queuePosition} ahead` : ""}${pickedWatch?.check?.state === "waiting" ? `, waiting: ${pickedWatch.check.reason ?? "its turn"}` : ""})${phase.armed ? " — adds when it passes" : ""}`
    : phase.step === "submitting" ? (mode.kind === "add" ? `Adding ${picked.name}…` : `Changing to ${picked.name}…`)
    : "";
  const verb = mode.kind === "add" ? "Add" : "Change";
  // The picked model's levels, where the team's read knows them; the member's
  // own level is shown while the new model lists it, as the change keeps it.
  const pickedLevels = picked ? team.reasoning.models[picked.entryId] : undefined;
  const memberLevel = mode.kind === "change" ? team.reasoning.members[mode.assignment.assignmentId]?.level ?? null : null;
  const shownLevel = level ?? (memberLevel && pickedLevels?.levels.some((entry) => entry.level === memberLevel) ? memberLevel : "");

  return <section role="group" aria-labelledby="team-picker-title" className="mt-3 grid gap-3 border-t border-line pt-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 id="team-picker-title" className="type-card-title">{title}</h3>
      <span className="type-meta text-muted">Role: {role === "orchestrator" ? "orchestrator" : "executor"}</span>
    </div>
    <TextInput type="search" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus
      placeholder={moreToSearch ? `Search models (and ${moreToSearch} more)…` : "Search models…"} aria-label="Search models"/>
    {searching && <p className="type-meta flex items-center gap-1.5 text-muted"><Spinner/>Searching all models…</p>}

    <div className="grid max-h-[min(60vh,520px)] gap-3 overflow-y-auto overscroll-contain" role="radiogroup" aria-label="Model">
      <Group title={readyRuntimes.length === 1 ? `Ready on ${runtimeLabel(readyRuntimes[0])}` : "Ready"}>
        {ready.length === 0 ? <Empty>No model is ready for this role{term ? " that matches" : ""}.</Empty>
          : ready.map((candidate) => <Option key={candidate.entryId} candidate={candidate} selected={selected === candidate.entryId}
            state={effectiveState(candidate)} onPick={pick} disabled={working || candidate.current}/>)}
      </Group>
      {models && <Group title="Not checked (checked when you pick it, ~40 s)">
        {unchecked.length === 0 ? <Empty>{moreToSearch && term.length < 2 ? "Type to search the rest of the lists." : "Nothing here."}</Empty>
          : unchecked.map((candidate) => <Option key={candidate.entryId} candidate={candidate} selected={selected === candidate.entryId}
            state={effectiveState(candidate)} onPick={pick} disabled={working || candidate.current}
            reason={watched[candidate.entryId]?.check?.reason ?? candidate.row?.reason ?? null}/>)}
      </Group>}
      {unavailable.length > 0 && <Group title="Not available for this role">
        {unavailable.slice(0, SHOWN_UNAVAILABLE).map((candidate) => <li key={candidate.entryId} className="type-meta py-1.5 text-muted [overflow-wrap:anywhere]">
          {candidate.name}{candidate.resolved ? ` → ${candidate.resolved}` : ""} <span>· {candidate.where}</span> — {candidate.why}
        </li>)}
        {unavailable.length > SHOWN_UNAVAILABLE && <li className="type-meta py-1 text-muted">and {unavailable.length - SHOWN_UNAVAILABLE} more</li>}
      </Group>}
    </div>

    {picked && pickedLevels && pickedLevels.levels.length > 0 && <div className="flex min-w-0 flex-wrap items-center gap-2">
      <label htmlFor="team-picker-reasoning" className="type-meta text-muted">Reasoning level for {picked.name}</label>
      <ReasoningSelect id="team-picker-reasoning" className="w-[16rem] max-w-full phone:w-full" levels={pickedLevels.levels}
        defaultLevel={pickedLevels.defaultLevel} value={shownLevel} onChange={setLevel} disabled={working}/>
    </div>}
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="accent" disabled={!picked || working || picked.current || (phase.step === "refused" && phase.entryId === selected)}
        aria-busy={working} onClick={confirm}>
        {working && <Spinner/>}{phase.step === "checking" && phase.armed ? "Waiting for the check…" : phase.step === "submitting" ? `${verb === "Add" ? "Adding" : "Changing"}…` : verb}
      </Button>
      <Button variant="secondary" onClick={onClose}>Close</Button>
      <p role="status" className="type-meta flex min-w-0 flex-1 items-center gap-1.5 [overflow-wrap:anywhere]">
        {(phase.step === "checking" || phase.step === "requesting") && <Spinner/>}
        <span>{status}</span>
      </p>
    </div>
    {phase.step === "refused" && <p role="alert" className="type-meta text-danger [overflow-wrap:anywhere]">
      {picked ? `${picked.name}: ` : ""}{phase.text}. Pick another model, or close.
    </p>}
    {phase.step === "checking" && <p className="type-meta text-muted">Closing this does not stop the check; the model will be ready next time.</p>}
  </section>;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <div>
    <p className="type-eyebrow border-b border-line pb-1 text-muted">{title}</p>
    <ul className="m-0 grid list-none divide-y divide-line p-0">{children}</ul>
  </div>;
}

function Empty({ children }: { children: ReactNode }) {
  return <li className="type-meta py-2 text-muted">{children}</li>;
}

function Option({ candidate, selected, state, onPick, disabled, reason = null }: {
  candidate: Candidate; selected: boolean; state: ModelState; onPick: (candidate: Candidate) => void;
  disabled: boolean; reason?: string | null;
}) {
  const words = stateWords(state, null);
  return <li>
    <label className={cx("flex min-h-10 cursor-pointer items-start gap-2.5 py-1.5", disabled && !selected && "cursor-default opacity-60")}>
      <input type="radio" name="team-model" className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-ink)]" checked={selected}
        disabled={disabled} onChange={() => onPick(candidate)}/>
      <span className="type-meta grid min-w-0 gap-0.5">
        <span className="[overflow-wrap:anywhere]"><strong className="font-medium">{candidate.name}</strong>
          {candidate.resolved && <span className="text-muted"> → {candidate.resolved}</span>}
          <span className="text-muted"> · {candidate.where}{candidate.billing ? ` · ${BILLING_WORDS[candidate.billing] ?? candidate.billing}` : ""}</span>
          {candidate.current && <span className="text-muted"> · current</span>}</span>
        {state !== "ready" && <span className={cx("flex flex-wrap items-center gap-1.5", words.tone === "danger" ? "text-danger" : words.tone === "warning" ? "text-warning" : "text-muted")}>
          {state === "checking" && <Spinner/>}{words.word}{reason && state !== "checking" && state !== "not_checked" ? `: ${reason}` : ""}
        </span>}
      </span>
    </label>
  </li>;
}
