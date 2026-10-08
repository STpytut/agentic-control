"use client";

import { useState } from "react";
import { Button, Field, Select, TextInput } from "@agentic/design-system";
import type { MemberRunSettings as Settings, TeamModel } from "@/lib/team";

// rc.142 (0152): one executor's or analyst's run settings — the most tokens one
// run may use, and for Claude Code a fallback model. The supervisor stops a
// run past its limit (counted as the usage panel counts: input, output,
// reasoning and cache); Claude Code switches to the fallback when the model is
// overloaded or not available, and the chat says so.
export function MemberRunSettings({ memberId, runtime, modelId, settings, models, busy, onSave }: {
  memberId: string; runtime: string; modelId: string; settings: Settings | undefined; models: TeamModel[]; busy: string;
  onSave: (next: { tokenLimit: number | null; fallbackEntryId: string | null }) => void;
}) {
  const saved = { limit: settings?.tokenLimit ? String(settings.tokenLimit) : "", fallback: settings?.fallbackEntryId ?? "" };
  const [limit, setLimit] = useState(saved.limit);
  const [fallback, setFallback] = useState(saved.fallback);
  const claude = runtime === "claude";
  const fallbacks = claude ? models.filter((model) => model.runtime === "claude" && model.modelId !== modelId) : [];
  const digits = limit.replace(/[\s_,]/g, "");
  const parsed = digits === "" ? null : Number(digits);
  const invalid = parsed !== null && !(Number.isInteger(parsed) && parsed >= 10_000 && parsed <= 1_000_000_000);
  const changed = digits !== saved.limit || fallback !== saved.fallback;
  const saving = busy === `run:${memberId}`;
  // A fallback that is no longer verified is kept on record but not passed.
  const lapsed = claude && settings?.fallbackEntryId && !settings.fallbackModel;

  return <div className="mt-3 grid grid-cols-2 gap-3 phone:grid-cols-1">
    <Field label="Token limit per run" htmlFor={`run-limit-${memberId}`} labelSuffix="optional"
      error={invalid ? "From 10 000 to 1 000 000 000 tokens, or empty for no limit." : undefined}
      hint={runtime === "codex" ? "Codex reports its tokens at the end of a turn, so it is held to this after the turn." : "The run is stopped once it passes this."}>
      <TextInput id={`run-limit-${memberId}`} inputMode="numeric" placeholder="No limit" value={limit} invalid={invalid}
        disabled={Boolean(busy)} onChange={(event) => setLimit(event.target.value)}/>
    </Field>
    {claude && <Field label="Fallback model" htmlFor={`run-fallback-${memberId}`} labelSuffix="optional"
      hint={lapsed ? "The chosen fallback is no longer verified, so runs go without one." : "Used when this member's model is overloaded or not available."}>
      <Select id={`run-fallback-${memberId}`} value={fallback} disabled={Boolean(busy)} onChange={(event) => setFallback(event.target.value)}>
        <option value="">None</option>
        {fallbacks.map((model) => <option key={model.entryId} value={model.entryId}>{model.displayName || model.modelId}</option>)}
        {fallback && !fallbacks.some((model) => model.entryId === fallback) && <option value={fallback} disabled>No longer offered</option>}
      </Select>
    </Field>}
    {changed && <div className="col-span-2 flex items-center gap-2 phone:col-span-1">
      <Button variant="secondary" size="sm" disabled={Boolean(busy) || invalid}
        onClick={() => onSave({ tokenLimit: parsed, fallbackEntryId: fallback || null })}>
        {saving ? "Saving…" : "Save run settings"}
      </Button>
      <Button variant="secondary" size="sm" disabled={Boolean(busy)} onClick={() => { setLimit(saved.limit); setFallback(saved.fallback); }}>Cancel</Button>
    </div>}
  </div>;
}
