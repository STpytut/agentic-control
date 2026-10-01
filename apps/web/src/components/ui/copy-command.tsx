"use client";

import { useState } from "react";
import { cx } from "@agentic/design-system";

// A command the operator runs on the server, shown whole and copyable (R9: the
// panel shows the exact command; the CLI acts). The button answers at once —
// "Copied", or "Select and copy" where the clipboard is refused (an http origin,
// a denied permission) — so a click never looks dead. A candidate for
// @agentic/design-system.
export function CopyCommand({ label, command, className }: { label?: string; command: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 2000);
  }
  return <div className={cx("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", className)}>
    {label && <span className="type-meta text-muted">{label}:</span>}
    <code className="type-mono-small min-w-0 rounded-sm bg-ink/5 px-1.5 py-1 [overflow-wrap:anywhere] select-all">{command}</code>
    <button type="button" onClick={copy} aria-label={`Copy: ${command}`}
      className="type-meta min-h-8 rounded-sm px-2 text-muted underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2">
      {state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : "Copy"}
    </button>
    <span role="status" className="sr-only">{state === "copied" ? "Command copied" : state === "failed" ? "Copy was refused; select the command and copy it" : ""}</span>
  </div>;
}
