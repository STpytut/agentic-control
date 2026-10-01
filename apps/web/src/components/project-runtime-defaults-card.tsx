"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { useState } from "react";
import type { RuntimeChoice } from "@/lib/product-data";
import { runtimeLabel } from "@/lib/runtime-labels";
import { modelWithResolved } from "@/lib/models";
import { Button, Card, Checkbox, Field, Select } from "@agentic/design-system";
import { Notice } from "@/components/ui/notice";
import { ReasoningSelect } from "@/components/reasoning-select";

type Json = Record<string, unknown>;

export function ProjectRuntimeDefaultsCard({
  projectId,
  catalog,
  defaults,
  roster,
}: {
  projectId: string;
  catalog: RuntimeChoice[];
  defaults: Json | null;
  roster: { assignmentRole: string; runtimeType: string }[];
}) {
  // A default is run by the runtime of the project's assignment for that role,
  // so only that runtime's models are offered. Every runtime's models used to
  // be, and a Codex model saved for an OpenCode orchestrator would have handed
  // the one to the other (rc.47); the database refuses it as well.
  const runtimesFor = (role: string) => new Set(roster.filter((item) => item.assignmentRole === role).map((item) => item.runtimeType));
  const orchestratorRuntimes = runtimesFor("orchestrator");
  const executorRuntimes = runtimesFor("executor");
  const orchestrators = catalog.filter((choice) => choice.canOrchestrate && orchestratorRuntimes.has(choice.runtimeType));
  const executors = catalog.filter((choice) => choice.canExecute && executorRuntimes.has(choice.runtimeType));
  const orchestratorLabel = [...orchestratorRuntimes].map(runtimeLabel).join(" or ") || "orchestrator";
  const defaultsJson = (defaults ?? {}) as Json;
  const orchestratorJson = (defaultsJson.orchestrator ?? {}) as Json;
  const currentOrchestrator = String(orchestratorJson.entry_id ?? "");
  const currentExecutors = Array.isArray(defaultsJson.executors)
    ? (defaultsJson.executors as unknown[]).map((entry) => String((entry as Json).entry_id)) : [];
  // Each executor's saved level, by its model (0111); "" is the runtime's default.
  const currentExecutorLevels = Object.fromEntries(Array.isArray(defaultsJson.executors)
    ? (defaultsJson.executors as Json[]).map((entry) => [String(entry.entry_id), String(entry.reasoning_effort ?? "")]) : []);
  const currentVersion = Number(defaultsJson.version ?? 1);

  const [orchestratorEntryId, setOrchestratorEntryId] = useState(currentOrchestrator);
  const [executorEntryIds, setExecutorEntryIds] = useState<string[]>(currentExecutors);
  const [reasoningEffort, setReasoningEffort] = useState(String(defaultsJson.reasoning_effort ?? ""));
  const [executorReasoning, setExecutorReasoning] = useState<Record<string, string>>(currentExecutorLevels);
  const [serviceTier, setServiceTier] = useState(String(defaultsJson.service_tier ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const selectedOrchestrator = orchestrators.find((choice) => choice.profileId === orchestratorEntryId);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const payload: Record<string, unknown> = {
        kind: "set_runtime_defaults",
        projectId,
        orchestratorEntryId,
        executorEntryIds,
        defaultsVersion: currentVersion,
      };
      if (reasoningEffort) payload.reasoningEffort = reasoningEffort;
      payload.executorReasoningEfforts = Object.fromEntries(executorEntryIds.map((id) => [id, executorReasoning[id] ?? ""]));
      if (serviceTier) payload.serviceTier = serviceTier;
      const response = await fetch("/api/control-plane/actions", {
        method: "POST",
        headers: controlPlaneActionHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Runtime defaults could not be saved");
      setMessage("Defaults saved. Only chats started from now on use them; active chats keep their snapshot.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Runtime defaults could not be saved");
    } finally {
      setBusy(false);
    }
  }

  function toggleExecutor(entryId: string) {
    setExecutorEntryIds((current) => current.includes(entryId)
      ? current.filter((id) => id !== entryId)
      : [...current, entryId]);
  }

  return (
    <Card as="section">
      <p className="type-eyebrow text-muted">RUNTIME DEFAULTS</p><h2 className="type-card-title mt-1.5">New-chat runtime selection</h2>
      <p className="type-app-body mt-2 text-muted">These defaults are snapshotted into each new chat. Changing them never alters an active one.</p>
      <form onSubmit={save} className="mt-4 grid gap-4">
        <Field label="Orchestrator model" htmlFor="defaults-orchestrator">
            <Select id="defaults-orchestrator" value={orchestratorEntryId} onChange={(event) => { setOrchestratorEntryId(event.target.value); setReasoningEffort(""); setServiceTier(""); }} required>
            <option value="" disabled>{`Select a verified ${orchestratorLabel} model`}</option>
            {orchestrators.map((choice) => <option value={choice.profileId} key={choice.profileId}>
              {modelWithResolved(choice.model, choice.resolvedModel)}{choice.planBadge ? ` · ${choice.planBadge}` : ""}{choice.displayName ? ` (${choice.displayName})` : ""}
            </option>)}
          </Select>
        </Field>
        {(selectedOrchestrator?.reasoningLevels ?? []).length > 0 && (
          <Field label="Orchestrator reasoning level" htmlFor="defaults-reasoning">
            <ReasoningSelect id="defaults-reasoning" levels={selectedOrchestrator?.reasoningLevels ?? []}
              defaultLevel={selectedOrchestrator?.defaultReasoningEffort} value={reasoningEffort} onChange={setReasoningEffort}/>
          </Field>
        )}
        {(selectedOrchestrator?.serviceTiers ?? []).length > 0 && (
          <Field label="Service tier" htmlFor="defaults-tier">
            <Select id="defaults-tier" value={serviceTier} onChange={(event) => setServiceTier(event.target.value)}>
              <option value="">Runtime default</option>
              {(selectedOrchestrator?.serviceTiers ?? []).map((tier) => <option value={tier} key={tier}>{tier}</option>)}
            </Select>
          </Field>
        )}
        <fieldset className="m-0 min-w-0 border-0 border-t border-line p-0 pt-3">
          <legend className="type-meta float-left mb-2 w-full p-0 font-medium">Executors</legend>
          <div className="clear-left grid divide-y divide-line">
            {executors.map((choice) => (
              <div key={choice.profileId} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <Checkbox className="min-w-0 flex-1 [overflow-wrap:anywhere]" label={runtimeLabel(choice.runtimeType)} description={`${modelWithResolved(choice.model, choice.resolvedModel)}${choice.planBadge ? ` · ${choice.planBadge}` : ""}`} checked={executorEntryIds.includes(choice.profileId)} onChange={() => toggleExecutor(choice.profileId)}/>
                {executorEntryIds.includes(choice.profileId) && <ReasoningSelect id={`defaults-executor-reasoning-${choice.profileId}`}
                  label={`Reasoning level for ${choice.model}`} className="w-[11rem] phone:w-full"
                  levels={choice.reasoningLevels ?? []} defaultLevel={choice.defaultReasoningEffort}
                  value={executorReasoning[choice.profileId] ?? ""}
                  onChange={(value) => setExecutorReasoning((current) => ({ ...current, [choice.profileId]: value }))}/>}
              </div>
            ))}
            {!executors.length && <p className="type-meta text-muted">No capability-verified executors are available yet.</p>}
          </div>
        </fieldset>
        {error && <Notice tone="danger">{error}</Notice>}
        {message && <Notice tone="info">{message}</Notice>}
        <div className="flex justify-end">
          <Button type="submit" disabled={busy || !orchestratorEntryId || !executorEntryIds.length}>
            {busy ? "Saving…" : "Save defaults"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
