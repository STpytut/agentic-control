"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import type { ActionTarget } from "@/lib/control-plane";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Textarea, buttonClasses } from "@agentic/design-system";
import { dangerOutlineClasses } from "@/components/ui/danger-button";
import { Notice } from "@/components/ui/notice";

type Props = {
  action: ActionTarget;
  acceptanceCriteria: unknown[];
};

// The card's buttons, sized for the row they share; the sm height grows to a
// thumb's on a coarse pointer (.touch-target).
const primary = buttonClasses({ variant: "primary", size: "sm" });
const secondary = buttonClasses({ variant: "secondary", size: "sm" });
const danger = dangerOutlineClasses;

export function WorkflowActions({ action, acceptanceCriteria }: Props) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"idle" | "revision" | "deny">("idle");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(payload: Record<string, unknown>) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/control-plane/actions", {
        method: "POST",
        headers: controlPlaneActionHeaders(),
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        if (response.status === 409) router.refresh();
        throw new Error(body.error ?? "Action failed");
      }
      const publish = body.result?.publish as { refused?: string } | undefined;
      setNotice(publish?.refused
        ? { ok: false, text: `Approved. The pull request was not requested: ${publish.refused} Publish it from the card when it appears.` }
        : { ok: true, text: payload.publish ? "Approved. The pull request opens once the host has prepared the commit." : "Action recorded. The workflow state has been refreshed." });
      setInput("");
      setMode("idle");
      router.refresh();
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "Action failed" });
    } finally {
      setBusy(false);
    }
  }

  if (action.type === "none") return <div className="type-meta mt-5 rounded-md bg-wash p-3 text-muted">No operator action is currently required.</div>;
  const needsText = action.type === "interaction" || action.type === "incident" || mode !== "idle";

  return (
    <div aria-busy={busy}>
      {needsText && (
        <label className="mt-3 grid gap-1.5">
          <span className="type-meta font-medium">{action.type === "interaction" ? "Your response" : action.type === "incident" ? "Reason" : "Decision details"}</span>
        <Textarea
          className="min-h-[74px] resize-y phone:min-h-24 phone:text-base"
          aria-label={action.type === "interaction" ? "Operator response" : action.type === "incident" ? "Reason" : "Decision details"}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={action.type === "interaction" ? "Type the answer or unblock instructions…" : action.type === "incident" ? "Why — optional for Retry, required to Dismiss…" : mode === "revision" ? "Describe the required changes…" : "Reason for denial…"}
          disabled={busy}
        />
        </label>
      )}
      {notice && <Notice role="status" tone={notice.ok ? "success" : "danger"} className="mt-2.5">{notice.text}</Notice>}
      <div className="mt-4 flex flex-wrap gap-2 [&>*]:flex-1 phone:flex-col phone:[&>*]:w-full phone:[&>*]:flex-none">
        {action.type === "review" && mode === "idle" && <>
          {/* One click for the usual path: approve, and open the pull request
              once the host has prepared the commit (0138). Approving alone
              stays, for a look at the branch before any pull request. */}
          {action.canPublish
            ? <button type="button" className={primary} disabled={busy} onClick={() => submit({ kind: "review_approve", projectId: action.projectId, taskId: action.taskId, taskVersion: action.taskVersion, summary: "Reviewed and accepted from the control-plane UI", publish: true })}>{busy ? "Sending…" : "Approve & open PR"}</button>
            : null}
          <button type="button" className={action.canPublish ? secondary : primary} disabled={busy} onClick={() => submit({ kind: "review_approve", projectId: action.projectId, taskId: action.taskId, taskVersion: action.taskVersion, summary: "Reviewed and accepted from the control-plane UI" })}>{busy ? "Sending…" : action.canPublish ? "Approve only" : "Approve changes"}</button>
          <button type="button" className={secondary} disabled={busy} onClick={() => setMode("revision")}>Request changes</button>
        </>}
        {action.type === "review" && mode === "revision" && <>
          <button type="button" className={primary} disabled={busy || input.trim().length < 3} onClick={() => submit({ kind: "revision", projectId: action.projectId, taskId: action.taskId, taskVersion: action.taskVersion, reviewerAgentId: action.reviewerAgentId, acceptanceCriteria, changes: input })}>{busy ? "Sending…" : "Send to the executor"}</button>
          <button type="button" className={secondary} disabled={busy} onClick={() => { setMode("idle"); setInput(""); }}>Cancel</button>
        </>}
        {action.type === "interaction" && <button type="button" className={primary} disabled={busy || input.trim().length < 2} onClick={() => submit({ kind: "interaction", id: action.id, response: input })}>Respond &amp; resume</button>}
        {/* A dead letter (0072): Retry puts the same job back, Dismiss closes it
            with a reason. Both answer the attempt this card shows. */}
        {action.type === "incident" && <>
          <button type="button" className={primary} disabled={busy} onClick={() => submit({ kind: "dead_letter_retry", id: action.id, attempt: action.attempt ?? 0, note: input })}>Retry</button>
          <button type="button" className={danger} disabled={busy || input.trim().length < 8} onClick={() => submit({ kind: "dead_letter_dismiss", id: action.id, attempt: action.attempt ?? 0, note: input })}>Dismiss</button>
        </>}
        {/* Sprint B P1: publishing is the operator's click, never a model's. */}
        {action.type === "publish" && <button type="button" className={primary} disabled={busy} onClick={() => submit({ kind: "publish_request", id: action.id })}>Publish to GitHub</button>}
        {action.type === "publish_failed" && <button type="button" className={primary} disabled={busy} onClick={() => submit({ kind: "publish_retry", id: action.id, attempt: action.attempt ?? 0 })}>Retry publish</button>}
        {action.type === "approval" && mode === "idle" && <>
          <button type="button" className={primary} disabled={busy} onClick={() => submit({ kind: "approval", id: action.id, decision: "approved", reason: "Approved from the control-plane UI" })}>Approve action</button>
          <button type="button" className={danger} disabled={busy} onClick={() => setMode("deny")}>Deny</button>
        </>}
        {action.type === "approval" && mode === "deny" && <>
          <button type="button" className={danger} disabled={busy || input.trim().length < 3} onClick={() => submit({ kind: "approval", id: action.id, decision: "denied", reason: input })}>Confirm denial</button>
          <button type="button" className={secondary} disabled={busy} onClick={() => { setMode("idle"); setInput(""); }}>Cancel</button>
        </>}
      </div>
    </div>
  );
}
