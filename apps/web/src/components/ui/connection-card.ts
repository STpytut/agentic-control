import type { BadgeTone } from "@agentic/design-system";

// The shared anatomy of a provider connection card on /settings (GitHub, Codex,
// OpenCode, Claude Code): a heading with the connection's status, the facts
// the broker recorded, the credential boundary, the actions and a footnote.
// Class recipes rather than a component, so each card keeps its own markup and
// handlers exactly as they were.
export const connection = {
  heading: "flex items-start justify-between gap-4 phone:flex-col phone:gap-2",
  owner: "type-meta mt-1.5 text-muted",
  meta: "mt-4 grid grid-cols-2 gap-x-5 gap-y-3 phone:grid-cols-1",
  metaItem: "grid gap-0.5",
  metaTerm: "type-eyebrow text-muted",
  metaValue: "type-meta m-0 [overflow-wrap:anywhere]",
  boundary: "mt-4",
  boundaryLabel: "type-eyebrow text-muted",
  boundaryList: "mt-1.5 grid list-none divide-y divide-line border-y border-line p-0",
  boundaryItem: "flex items-baseline justify-between gap-3 py-2",
  boundaryName: "type-meta font-medium",
  boundaryNote: "type-meta text-right font-medium text-success",
  actions: "mt-4 flex flex-wrap items-center gap-2 phone:[&>button]:flex-1",
  footnote: "type-meta mt-3.5 text-muted",
};

// A connection's status word, in the status palette.
const tones: Record<string, BadgeTone> = {
  connected: "success",
  pending_finalize: "info",
  action_required: "warning",
  expired: "danger",
  disconnected: "neutral",
};

export function connectionTone(status: string | undefined): BadgeTone {
  return tones[status ?? "disconnected"] ?? "neutral";
}
