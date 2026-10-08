"use client";

import type { ProjectTeam, TeamAnalyst } from "@/lib/team";
import type { OperatorModels } from "@/lib/models";
import { runtimeLabel } from "@/lib/runtime-labels";
import { useState } from "react";
import { Button, Card } from "@agentic/design-system";
import { TeamModelPicker } from "@/components/team-model-picker";
import { ANALYST_PICKER } from "@/lib/team-candidates";
import { SubagentSwitch } from "@/components/subagent-switch";

type Submit = (key: string, body: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;

const field = "type-app-body w-full rounded-md border border-line bg-canvas px-3 py-2 text-ink";
const EXAMPLE = "Security reviewer: look for injection, secrets in code and unsafe defaults. Name the file and line of each finding.";

// Project settings → Team (Stage 12, 0147): the analysts. An analyst reads a
// snapshot of the last commit and answers the orchestrator's question; it never
// writes. Each has a name the orchestrator calls it by, the operator's
// instructions for how to work, and a model on a runtime that plays the
// analyst. The database checks the owner, the team version, the model and the
// name; this form only collects them.
export function TeamAnalysts({ team, models, busy, submit }: {
  team: ProjectTeam; models: OperatorModels | null; busy: string; submit: Submit;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const full = team.analysts.length >= 4;

  return <Card as="section" className="min-w-0" aria-labelledby="team-analysts">
    <h2 id="team-analysts" className="type-card-title mb-1">Analysts</h2>
    <p className="type-meta mb-3 text-muted">
      Read-only members the orchestrator can ask to study the code — while the executor writes, if need be. Each reads a copy of the last commit and answers once; it never changes the project.
    </p>
    {team.analysts.length === 0 && !adding && <p className="type-meta text-muted">No analysts yet.</p>}
    <ul className="m-0 grid list-none gap-3 p-0">
      {team.analysts.map((analyst) => editing === analyst.id
        ? <li key={analyst.id}><AnalystEditor analyst={analyst} busy={busy}
            onCancel={() => setEditing(null)}
            onSave={async (next) => {
              const result = await submit(`analyst:${analyst.id}`, { kind: "team_update_analyst", projectId: team.projectId, analystId: analyst.id, ...next });
              if (result.ok) setEditing(null);
            }}/></li>
        : <AnalystRow key={analyst.id} analyst={analyst} busy={busy} onEdit={() => setEditing(analyst.id)}
            subagents={team.subagents[analyst.id] === true}
            onSubagents={(enabled) => submit(`subagents:${analyst.id}`, { kind: "team_set_subagents", projectId: team.projectId, memberId: analyst.id, enabled })}
            onRemove={() => submit(`analyst-remove:${analyst.id}`, { kind: "team_remove_analyst", projectId: team.projectId, analystId: analyst.id })}/>)}
    </ul>

    <div className="mt-4 grid gap-2 border-t border-line pt-3">
      {adding
        ? <div className="grid gap-3">
            <label className="grid gap-1">
              <span className="type-eyebrow text-muted">Name</span>
              <input className={field} value={name} maxLength={60} placeholder="Security reviewer" onChange={(event) => setName(event.target.value)}/>
              <span className="type-meta text-muted">The orchestrator asks it by this name.</span>
            </label>
            <label className="grid gap-1">
              <span className="type-eyebrow text-muted">Instructions</span>
              <textarea className={`${field} min-h-24`} value={instructions} maxLength={4000} placeholder={EXAMPLE}
                onChange={(event) => setInstructions(event.target.value)}/>
              <span className="type-meta text-muted">What this analyst looks for and how it reports. Optional.</span>
            </label>
            {name.trim()
              ? <TeamModelPicker key="analyst" team={team} models={models} mode={ANALYST_PICKER}
                  onClose={() => setAdding(false)}
                  onSubmit={async (entryId, reasoningEffort) => {
                    const result = await submit("analyst-add", { kind: "team_add_analyst", projectId: team.projectId, entryId, name: name.trim(),
                      instructions: instructions.trim(), reasoningEffort: reasoningEffort ?? "" });
                    if (result.ok) { setAdding(false); setName(""); setInstructions(""); }
                    return result;
                  }}/>
              : <p className="type-meta text-muted">Name the analyst, then choose its model.</p>}
            <Button variant="secondary" size="sm" className="justify-self-start" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        : <Button variant="accent" className="justify-self-start phone:justify-self-stretch" disabled={Boolean(busy) || full}
            onClick={() => setAdding(true)}>Add analyst</Button>}
      {full && <p className="type-meta mt-1 text-muted">A project has at most four analysts.</p>}
    </div>
  </Card>;
}

function AnalystRow({ analyst, busy, onEdit, onRemove, subagents, onSubagents }: {
  analyst: TeamAnalyst; busy: string; onEdit: () => void; onRemove: () => void; subagents: boolean; onSubagents: (enabled: boolean) => void;
}) {
  return <li className="min-w-0 border-t border-line pt-3 first-of-type:border-t-0 first-of-type:pt-0">
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <strong className="type-card-title [overflow-wrap:anywhere]">{analyst.name}</strong>
      <span className="type-meta text-muted">{runtimeLabel(analyst.runtime)} · {analyst.displayName || analyst.modelId}
        {analyst.reasoningEffort ? ` · ${analyst.reasoningEffort}` : ""}</span>
    </div>
    {analyst.modelStatus && analyst.modelStatus !== "verified" && <p className="type-meta mt-1 text-danger">
      Its model is {analyst.modelStatus}: the orchestrator&apos;s questions to it will fail until the model is verified again.
    </p>}
    <p className="type-meta mt-1 whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{analyst.instructions || "No instructions: it answers the question as asked."}</p>
    <SubagentSwitch memberId={analyst.id} allowed={subagents} busy={busy} onChange={onSubagents}/>
    <div className="mt-2 flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" disabled={Boolean(busy)} onClick={onEdit}>Edit</Button>
      <Button variant="secondary" size="sm" disabled={Boolean(busy)} onClick={onRemove}>
        {busy === `analyst-remove:${analyst.id}` ? "Removing…" : "Remove from team"}
      </Button>
    </div>
  </li>;
}

function AnalystEditor({ analyst, busy, onSave, onCancel }: {
  analyst: TeamAnalyst; busy: string; onSave: (next: { name: string; instructions: string }) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(analyst.name);
  const [instructions, setInstructions] = useState(analyst.instructions);
  return <div className="grid gap-2 border-t border-line pt-3">
    <label className="grid gap-1">
      <span className="type-eyebrow text-muted">Name</span>
      <input className={field} value={name} maxLength={60} onChange={(event) => setName(event.target.value)}/>
    </label>
    <label className="grid gap-1">
      <span className="type-eyebrow text-muted">Instructions</span>
      <textarea className={`${field} min-h-24`} value={instructions} maxLength={4000} onChange={(event) => setInstructions(event.target.value)}/>
    </label>
    <div className="flex flex-wrap gap-2">
      <Button variant="accent" size="sm" disabled={Boolean(busy) || !name.trim()}
        onClick={() => onSave({ name: name.trim(), instructions: instructions.trim() })}>
        {busy === `analyst:${analyst.id}` ? "Saving…" : "Save"}
      </Button>
      <Button variant="secondary" size="sm" disabled={Boolean(busy)} onClick={onCancel}>Cancel</Button>
    </div>
  </div>;
}
