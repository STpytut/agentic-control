"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, TextInput } from "@agentic/design-system";
import { controlPlaneActionHeaders } from "@/lib/csrf-client";

// rc.145 (0153): ask Codex to review an open pull request of the project's
// GitHub repository. The review is posted in this chat; nothing goes to
// GitHub unless the owner publishes it from there.
export function PrReviewRequest({ projectId, taskId }: { projectId: string; taskId: string }) {
  const router = useRouter();
  const [number, setNumber] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");
  const value = Number(number.replace(/^#/, ""));
  const valid = Number.isInteger(value) && value > 0;
  async function request() {
    setState("sending");
    try {
      const response = await fetch("/api/control-plane/actions", { method: "POST", headers: controlPlaneActionHeaders(),
        body: JSON.stringify({ kind: "pr_review_request", projectId, taskId, prNumber: value }) });
      const answer = await response.json();
      if (response.ok && answer.ok) { setState("sent"); setNumber(""); router.refresh(); }
      else { setError(String(answer.error ?? "The review was not requested")); setState("error"); }
    } catch {
      setError("The review was not requested");
      setState("error");
    }
  }
  return <section aria-labelledby="pr-review-title" className="grid gap-2 rounded-lg border border-line px-3.5 py-3">
    <strong id="pr-review-title" className="type-meta font-semibold">Review a pull request</strong>
    <p className="type-meta text-muted">Codex reviews an open pull request of this repository. The review appears in this chat; you choose whether to post it on GitHub.</p>
    <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (valid) void request(); }}>
      {/* The design system's control is full width; its wrapper sets the width. */}
      <div className="w-24 shrink-0"><TextInput aria-label="Pull request number" inputMode="numeric" placeholder="#12" value={number}
        disabled={state === "sending"} onChange={(event) => { setNumber(event.target.value.trim()); setState("idle"); }}/></div>
      <Button type="submit" variant="secondary" size="sm" disabled={!valid || state === "sending"}>{state === "sending" ? "Asking…" : "Review"}</Button>
    </form>
    {state === "sent" && <p className="type-meta text-muted">Requested. Codex starts within a minute; follow it in the chat.</p>}
    {state === "error" && <p className="type-meta text-danger">{error}</p>}
  </section>;
}
