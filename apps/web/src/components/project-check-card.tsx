"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, TextInput } from "@agentic/design-system";
import { Notice } from "@/components/ui/notice";

// The commands most repositories run their tests with; one click fills the
// field, and nothing runs until it is saved.
const COMMON = ["npm test", "pnpm test", "yarn test", "pytest", "go test ./...", "cargo test"];

// Project settings → Workspace (0143): the command the platform runs itself
// after each implementation or revision. Its result is a fact the reviewer
// reads, and a failure blocks the pull request.
export function ProjectCheckCard({ projectId, command, timeoutSeconds }: { projectId: string; command: string; timeoutSeconds: number }) {
  const router = useRouter();
  const [value, setValue] = useState(command);
  const [minutes, setMinutes] = useState(String(Math.round(timeoutSeconds / 60)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function save(next: string) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const timeout = Math.round(Number(minutes) * 60);
      if (!Number.isFinite(timeout) || timeout < 30 || timeout > 1800) throw new Error("The timeout is between 1 and 30 minutes.");
      const response = await fetch("/api/control-plane/actions", { method: "POST", headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ kind: "project_check_set", projectId, command: next, timeoutSeconds: timeout }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "The check could not be saved");
      setValue(next);
      setSaved(true);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The check could not be saved");
    } finally {
      setBusy(false);
    }
  }

  return <Card as="section" className="min-w-0">
    <div className="flex items-start justify-between gap-4 phone:flex-col phone:gap-2">
      <div>
        <p className="type-eyebrow text-muted">CHECKS</p>
        <h2 className="type-section-title mt-1.5">Tests the platform runs</h2>
        <p className="type-meta mt-1.5 text-muted">After every implementation, the platform runs this command in the workspace itself — in the executor&apos;s sandbox, without network. The reviewer reads the result as a fact, and a failure blocks the pull request.</p>
      </div>
      <Badge tone={command ? "success" : "neutral"} className="shrink-0">{command ? "On" : "Off"}</Badge>
    </div>
    {error && <Notice tone="danger" className="mt-3.5">{error}</Notice>}
    {saved && <Notice tone="success" className="mt-3.5">{value ? "Saved. It runs after the next implementation." : "The platform check is off."}</Notice>}
    <form className="mt-4 grid gap-2.5" onSubmit={(event) => { event.preventDefault(); void save(value.trim()); }}>
      <div className="flex flex-wrap gap-2">
        <TextInput className="min-w-0 flex-1 font-mono" value={value} onChange={(event) => setValue(event.target.value)}
          placeholder="npm test" aria-label="Check command" autoComplete="off" spellCheck={false}/>
        <label className="type-meta flex items-center gap-1.5 text-muted">
          <TextInput className="w-16 text-right" value={minutes} onChange={(event) => setMinutes(event.target.value)} inputMode="numeric" aria-label="Timeout in minutes"/>
          min
        </label>
      </div>
      {!value && <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common commands">
        {COMMON.map((example) => <button key={example} type="button" onClick={() => setValue(example)}
          className="type-mono-small rounded-full border border-dashed border-line-strong px-2.5 py-1 text-ink/80 transition-colors duration-150 hover:border-ink hover:text-ink">{example}</button>)}
      </div>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={busy || (value.trim() === command && minutes === String(Math.round(timeoutSeconds / 60)))}>{busy ? "Saving…" : "Save"}</Button>
        {command && <Button size="sm" variant="secondary" type="button" disabled={busy} onClick={() => void save("")}>Turn off</Button>}
      </div>
    </form>
  </Card>;
}
