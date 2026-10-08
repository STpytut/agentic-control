"use client";

import { Checkbox } from "@agentic/design-system";

// M7 (0151): one member's own subagents — Claude Code's Task, Codex's
// multi_agent, OpenCode's task. Off unless the operator allows them: a
// subagent works inside the member's run, with its tools and sandbox, and its
// tokens count as the member's.
export function SubagentSwitch({ memberId, allowed, busy, onChange }: {
  memberId: string; allowed: boolean; busy: string; onChange: (enabled: boolean) => void;
}) {
  return <Checkbox className="mt-2" checked={allowed} disabled={Boolean(busy)}
    onChange={(event) => onChange(event.target.checked)}
    label={busy === `subagents:${memberId}` ? "Saving…" : "Allow subagents"}
    description="The runtime may start its own helper agents inside this member's run. Faster on large code; their tokens count as this member's."/>;
}
