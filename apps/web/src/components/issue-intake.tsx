"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Checkbox, Field, TextInput } from "@agentic/design-system";
import { Notice } from "@/components/ui/notice";
import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { formatTimestamp } from "@/lib/format-timestamp";
import type { IssueIntake, WaitingIssue } from "@/lib/product-data";

// GitHub issues as chats (0132, docs/ISSUE_INTAKE_DESIGN.md I1).

async function postAction(body: Record<string, unknown>) {
  const response = await fetch("/api/control-plane/actions", {
    method: "POST", headers: controlPlaneActionHeaders(), body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error ?? "The request was not accepted");
  return data.result as Record<string, unknown>;
}

// Project settings → GitHub issues: on or off, and the label that marks an issue.
export function IssueIntakeSettings({ projectId, intake }: { projectId: string; intake: IssueIntake }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(intake.enabled);
  const [label, setLabel] = useState(intake.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = enabled !== intake.enabled || label.trim() !== intake.label;

  async function save() {
    setBusy(true); setError("");
    try {
      await postAction({ kind: "issue_intake_set", projectId, enabled, label: label.trim() });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The settings were not saved");
    } finally {
      setBusy(false);
    }
  }

  if (!intake.available) {
    return <Notice tone="info">Issues are read through the GitHub App. This project&apos;s repository is not connected through it.</Notice>;
  }

  return <div className="grid max-w-[820px] gap-4">
    <Card className="grid gap-4">
      <Checkbox label="Take work from GitHub issues" checked={enabled} onChange={() => setEnabled(!enabled)}
        description={`An open issue in ${intake.repository} carrying the label waits here until you start it as a chat.`}/>
      <Field label="Label" htmlFor="issue-intake-label" hint="Only issues with this label are read.">
        <TextInput id="issue-intake-label" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={50} className="max-w-[18rem]"/>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={busy || !changed || !label.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>
        {error && <span role="alert" className="type-meta text-danger">{error}</span>}
      </div>
    </Card>
    <Notice tone="info">
      Only issues opened by the repository&apos;s owner, a member or a collaborator are offered: an issue&apos;s text reaches an agent
      that writes to this project. Nothing starts until you press Start.
    </Notice>
    {intake.enabled && <p className="type-meta m-0 text-muted">
      {intake.polledAt ? `Last read ${formatTimestamp(intake.polledAt)}.` : "Not read yet — the first read happens within a minute."}
      {intake.ignored > 0 && ` ${intake.ignored} ${intake.ignored === 1 ? "issue was" : "issues were"} ignored: written by someone without access to the repository.`}
    </p>}
    {intake.error && <Notice tone="warning">{intake.error}</Notice>}
  </div>;
}

// The project's start page: issues waiting to be started as chats.
export function WaitingIssues({ issues }: { issues: WaitingIssue[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  if (!issues.length) return null;

  async function act(kind: "issue_start" | "issue_dismiss", issue: WaitingIssue) {
    setBusy(`${kind}:${issue.id}`); setError("");
    try {
      const result = await postAction({ kind, linkId: issue.id });
      if (kind === "issue_start" && typeof result?.task_id === "string" && typeof result?.project_id === "string") {
        router.push(`/projects/${result.project_id}?task=${result.task_id}`);
      } else {
        router.refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request was not accepted");
    } finally {
      setBusy("");
    }
  }

  return <Card className="grid gap-3">
    <div className="flex items-center gap-2"><p className="type-eyebrow m-0 text-muted">From GitHub</p><Badge tone="attention">{issues.length} waiting</Badge></div>
    <ul className="m-0 grid list-none gap-0 divide-y divide-line p-0">
      {issues.map((issue) => <li key={issue.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
        <span className="min-w-0 flex-1">
          <a href={issue.url} target="_blank" rel="noreferrer" className="type-app-body font-medium underline-offset-4 hover:underline [overflow-wrap:anywhere]">#{issue.number} {issue.title}</a>
          <span className="type-meta block text-muted">by {issue.author}</span>
        </span>
        <span className="flex shrink-0 gap-2">
          <Button size="sm" disabled={Boolean(busy)} onClick={() => void act("issue_start", issue)}>{busy === `issue_start:${issue.id}` ? "Starting…" : "Start"}</Button>
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void act("issue_dismiss", issue)}>Dismiss</Button>
        </span>
      </li>)}
    </ul>
    {error && <p role="alert" className="type-meta m-0 text-danger">{error}</p>}
  </Card>;
}
