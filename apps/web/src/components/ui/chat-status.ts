// A chat's status is its newest task's (ADR-0014). One mapping from that word
// to the dot the sidebar and the lists draw beside the title; the word itself
// is always there too (in the dot's label and the chat's top bar).
const dots: Record<string, string> = {
  draft: "bg-info",
  planning: "bg-info",
  ready: "bg-info",
  implementation_requested: "bg-info",
  implementing: "bg-info",
  revising: "bg-info",
  awaiting_review: "bg-warning",
  reviewing: "bg-warning",
  changes_requested: "bg-warning",
  needs_attention: "bg-danger",
  failed: "bg-danger",
  approved: "bg-success",
  publishing: "bg-success",
  deployed: "bg-success",
  completed: "bg-success",
  cancelled: "bg-ink/30",
};

export function chatStatusDot(status: string) {
  return dots[status] ?? "bg-ink/40";
}

export function chatStatusLabel(status: string) {
  return status === "cancelled" ? "archived" : status.replaceAll("_", " ");
}

// "now", "5m", "3h", "2d": the sidebar's compact age.
export function shortAge(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
