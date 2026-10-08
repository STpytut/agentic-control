"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import type { ProjectReadiness } from "@/lib/readiness";
import { runtimeLabel } from "@/lib/runtime-labels";
import { HELD_BACK_WORDS, type ProjectTeam, type TeamAssignment, type TeamModel, type TeamReasoning } from "@/lib/team";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card } from "@agentic/design-system";
import { Notice } from "@/components/ui/notice";
import { resolvedModelOf, type OperatorModels } from "@/lib/models";
import { TeamModelPicker, type PickerMode } from "@/components/team-model-picker";
import { ReasoningSelect } from "@/components/reasoning-select";
import { defaultReasoningLabel } from "@/lib/reasoning";
import { TeamAnalysts } from "@/components/team-analysts";
import { SubagentSwitch } from "@/components/subagent-switch";
import { MemberRunSettings } from "@/components/member-run-settings";

const hint = "type-meta mt-1 text-muted";

// The project's team (sprint C U2; exit criterion 10).
//
// One place to see who the team is and to change it: each assignment with its
// role, runtime and model; what each built-in role may do and which runtime
// capabilities that needs; which models can be picked for each role, and why
// the others are not offered. Every option comes from `project_team` (0089),
// and every change goes to a function that checks the owner, the version the
// tab showed and the team's rules again — so nothing here invents a role, a
// model or a connection the database would not accept. Running tasks keep
// their snapshot; a change applies to new tasks, and the tab says so.
//
// Adding an executor and changing a member's model go through one picker
// (Stage 12 W7, team-model-picker.tsx): ready models first, then the ones not
// checked yet — picking one checks it, and the change is made only when it
// passes — then those this role cannot use, with the reason.
//
// On the design system's components: Card, Button, Badge for the permissions,
// Notice for the result of a change.

function modelName(model: Pick<TeamModel, "displayName" | "modelId">) {
  return model.displayName || model.modelId;
}

export function ProjectTeamTab({ projectId, team, readiness, models = null }: {
  projectId: string; team: ProjectTeam; readiness: ProjectReadiness | null; models?: OperatorModels | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [picker, setPicker] = useState<PickerMode | null>(null);

  const executorCount = team.assignments.filter((a) => a.roleKey === "executor").length;
  // With the model checks (W6) the picker lists the unchecked models itself;
  // the count of them "not verified" would say the same thing twice.
  const heldBack = models ? team.heldBack.filter((held) => held.reason !== "model_not_verified") : team.heldBack;

  // A change of model can reset a member's reasoning level its new model does
  // not offer (0111); the result says so, and so does the notice.
  function savedText(result: Record<string, unknown> | undefined) {
    const reset = typeof result?.reasoning_effort_reset === "string" ? result.reasoning_effort_reset : "";
    return `Saved.${reset ? ` The new model does not offer the reasoning level ${reset}, so this member now runs at the runtime's default.` : ""} New chats use the team as it is now; running chats keep theirs.`;
  }

  async function submit(key: string, body: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    setBusy(key);
    setNotice(null);
    try {
      const response = await fetch("/api/control-plane/actions", {
        method: "POST",
        headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ projectId, teamVersion: team.version, ...body }),
      });
      const answer = await response.json();
      if (!response.ok || !answer.ok) {
        if (response.status === 409) router.refresh();
        throw new Error(answer.error ?? "The team was not changed");
      }
      const text = savedText(answer.result);
      setNotice({ ok: true, text });
      setPicker(null);
      router.refresh();
      return { ok: true, text };
    } catch (error) {
      const text = error instanceof Error ? error.message : "The team was not changed";
      // A refusal from inside the picker stays in the picker, beside the choice.
      if (!picker) setNotice({ ok: false, text });
      return { ok: false, text };
    } finally {
      setBusy("");
    }
  }

  if (!team.managed) {
    return <Card><p className="type-meta text-muted">This project has no catalog models yet, so its team is fixed. Choose its models in project settings first.</p></Card>;
  }

  return <div className="grid gap-3" aria-busy={Boolean(busy)}>
    {notice && <Notice role="status" tone={notice.ok ? "success" : "danger"}>{notice.text}</Notice>}

    <Card as="section" className="min-w-0" aria-labelledby="team-members">
      <h2 id="team-members" className="type-card-title mb-3 flex items-baseline justify-between gap-2">Team <small className="type-meta text-muted tabular-nums">version {team.version}</small></h2>
      <ul className="m-0 grid list-none gap-3 p-0">
        {team.assignments.map((assignment) => <AssignmentRow key={assignment.assignmentId} assignment={assignment}
          resolved={resolvedModelOf(models, assignment.entryId)} readiness={readiness} busy={busy} executorCount={executorCount}
          reasoning={team.reasoning.members[assignment.assignmentId] ?? null}
          levels={team.reasoning.models[assignment.entryId] ?? null}
          onLevel={(reasoningEffort) => submit(`level:${assignment.assignmentId}`, { kind: "team_set_reasoning", assignmentId: assignment.assignmentId, reasoningEffort })}
          picking={picker?.kind === "change" && picker.assignment.assignmentId === assignment.assignmentId}
          onChange={() => setPicker({ kind: "change", assignment })}
          onDisable={() => submit(`disable:${assignment.assignmentId}`, { kind: "team_disable_executor", assignmentId: assignment.assignmentId })}
          subagents={assignment.roleKey === "executor" ? team.subagents[assignment.assignmentId] === true : null}
          onSubagents={(enabled) => submit(`subagents:${assignment.assignmentId}`, { kind: "team_set_subagents", memberId: assignment.assignmentId, enabled })}
          runSettings={assignment.roleKey === "executor" ? <MemberRunSettings memberId={assignment.assignmentId} runtime={assignment.runtime}
            modelId={assignment.modelId} settings={team.runSettings[assignment.assignmentId]} models={team.models} busy={busy}
            onSave={(next) => submit(`run:${assignment.assignmentId}`, { kind: "team_set_run_settings", memberId: assignment.assignmentId, ...next })}/> : null}/>)}
      </ul>

      {picker?.kind === "change" && <TeamModelPicker key={picker.assignment.assignmentId} team={team} models={models} mode={picker}
        onClose={() => setPicker(null)}
        onSubmit={(entryId, reasoningEffort) => submit(`model:${picker.assignment.assignmentId}`, { kind: "team_change_model",
          assignmentId: picker.assignment.assignmentId, entryId, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })}/>}

      <div className="mt-4 grid gap-2 border-t border-line pt-3">
        {picker?.kind === "add"
          ? <TeamModelPicker key="add" team={team} models={models} mode={picker} onClose={() => setPicker(null)}
            onSubmit={(entryId, reasoningEffort) => submit("add", { kind: "team_add_executor", entryId, reasoningEffort: reasoningEffort ?? "" })}/>
          : <Button variant="accent" className="justify-self-start phone:justify-self-stretch" disabled={Boolean(busy) || executorCount >= 8}
            aria-expanded={false} onClick={() => setPicker({ kind: "add" })}>
            Add executor
          </Button>}
        {executorCount >= 8 && <p className={hint}>A project has at most eight executors.</p>}
      </div>

      {heldBack.length > 0 && <div className="mt-3">
        <span className="type-eyebrow text-muted">Not offered</span>
        <ul className="type-meta mt-1 list-disc pl-4 text-muted">{heldBack.map((held) => <li key={`${held.runtime}:${held.reason}`}>
          {held.count} {runtimeLabel(held.runtime)} model{held.count === 1 ? "" : "s"}: {HELD_BACK_WORDS[held.reason] ?? held.reason}
        </li>)}</ul>
      </div>}
    </Card>

    <TeamAnalysts team={team} models={models} busy={busy} submit={submit}/>

    <Card as="section" className="min-w-0" aria-labelledby="team-roles">
      <h2 id="team-roles" className="type-card-title mb-3">What each role may do</h2>
      {team.roles.map((role) => <div key={role.id} className="border-t border-line py-3 first-of-type:border-t-0 first-of-type:pt-0">
        <strong className="type-meta font-medium">{role.name}</strong>
        <ul className="mt-2 flex list-none flex-wrap gap-1.5 p-0">{role.permissions.map((permission) => <li key={permission} className="flex"><Badge dot tone="success">{permission}</Badge></li>)}</ul>
        <p className={hint}>Needs from its runtime: {role.capabilities.join(", ") || "nothing"}</p>
        <ul className="type-meta mt-1 list-disc pl-4">{team.runtimes.map((runtime) => {
          const missing = role.capabilities.filter((capability) => !runtime.capabilities.includes(capability));
          return <li key={runtime.runtime} className={missing.length ? "text-danger" : "text-success"}>
            {runtimeLabel(runtime.runtime)}: {missing.length ? `lacks ${missing.join(", ")}` : "can hold it"}
          </li>;
        })}</ul>
      </div>)}
    </Card>
  </div>;
}

function AssignmentRow({ assignment, resolved, readiness, busy, executorCount, picking, reasoning, levels, onLevel, onChange, onDisable, subagents, onSubagents, runSettings }: {
  assignment: TeamAssignment; resolved: string | null; readiness: ProjectReadiness | null; busy: string; executorCount: number; picking: boolean;
  reasoning: TeamReasoning["members"][string] | null; levels: TeamReasoning["models"][string] | null;
  onLevel: (level: string) => void; onChange: () => void; onDisable: () => void;
  subagents: boolean | null; onSubagents: (enabled: boolean) => void; runSettings: React.ReactNode;
}) {
  const orchestrator = assignment.roleKey === "orchestrator";
  const state = readiness?.assignments.find((row) => row.assignmentId === assignment.assignmentId);
  const disableReason = executorCount <= 1 ? "the only executor"
    : assignment.openTasks > 0 ? `${assignment.openTasks} open task${assignment.openTasks === 1 ? " is" : "s are"} bound to it` : "";
  return <li className="min-w-0 border-t border-line pt-3 first-of-type:border-t-0 first-of-type:pt-0">
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <strong className="type-card-title">{assignment.roleName}{orchestrator && assignment.isDefault ? " · default" : ""}</strong>
      <span className="type-meta text-muted">{runtimeLabel(assignment.runtime)}</span>
    </div>
    <div className="mt-2 grid gap-1">
      <span className="type-eyebrow text-muted">Model</span>
      <p className="type-meta [overflow-wrap:anywhere]" aria-label={`${assignment.roleName} model`}>
        {assignment.entryId ? <><strong className="font-medium">{modelName(assignment)}</strong>
          {resolved && resolved !== assignment.modelId && <span className="text-muted"> → {resolved}</span>}</>
          : <span className="text-muted">No model set</span>}
      </p>
    </div>
    {assignment.entryId && <div className="mt-2 grid gap-1">
      <span className="type-eyebrow text-muted">Reasoning level</span>
      {levels && levels.levels.length > 0
        ? <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ReasoningSelect id={`team-reasoning-${assignment.assignmentId}`} className="w-[16rem] max-w-full phone:w-full"
            label={`${assignment.roleName} reasoning level`} levels={levels.levels} defaultLevel={levels.defaultLevel}
            value={reasoning?.level ?? ""} disabled={Boolean(busy)} onChange={onLevel}/>
          {busy === `level:${assignment.assignmentId}` && <span role="status" className="type-meta text-muted">Saving…</span>}
        </div>
        : <p className="type-meta text-muted">{defaultReasoningLabel(null)} — this model offers no levels to choose from</p>}
      {reasoning && !reasoning.supported && reasoning.level && <p className={hint}>
        The model no longer offers {reasoning.level}; new chats run this member at the runtime&apos;s default until you pick another level.
      </p>}
    </div>}
    {subagents !== null && <SubagentSwitch memberId={assignment.assignmentId} allowed={subagents} busy={busy} onChange={onSubagents}/>}
    {runSettings}
    {state?.blockedBy && <p className={hint}>Not ready: {state.blockedBy.message}</p>}
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" disabled={Boolean(busy)} aria-expanded={picking} onClick={onChange}>
        {busy === `model:${assignment.assignmentId}` ? "Changing…" : "Change model"}
      </Button>
      {!orchestrator && <Button variant="secondary" size="sm" disabled={Boolean(busy) || Boolean(disableReason)}
        title={disableReason ? `Cannot remove: ${disableReason}` : undefined} onClick={onDisable}>
        {busy === `disable:${assignment.assignmentId}` ? "Removing…" : "Remove from team"}
      </Button>}
      {!orchestrator && disableReason && <span className="type-meta text-muted">Cannot remove: {disableReason}</span>}
    </div>
  </li>;
}
