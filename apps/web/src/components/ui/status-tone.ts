import type { BadgeTone } from "@agentic/design-system";

// One mapping from the panel's state words to the package's Badge tones, so a
// state reads the same on every screen (docs/migration.md, control plane §4).
// Status is never colour alone: the Badge always carries the word itself.
const tones: Record<string, BadgeTone> = {
  ready: "success",
  active: "success",
  completed: "success",
  approved: "success",
  deployed: "success",
  pending: "warning",
  provisioning: "warning",
  needs_attention: "warning",
  deleting: "warning",
  failed: "danger",
  cancelled: "danger",
  deletion_failed: "danger",
  queued: "info",
  running: "active",
};

export function statusTone(status: string): BadgeTone {
  return tones[status] ?? "neutral";
}
