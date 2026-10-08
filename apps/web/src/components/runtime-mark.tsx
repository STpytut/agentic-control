import { runtimeLabel } from "@/lib/runtime-labels";

// Who is speaking, at a glance: each runtime's mark in its vendor's colour —
// Claude Code in Anthropic's clay, Codex in OpenAI's green, OpenCode in blue.
// Drawn here as simple glyphs of our own, not the vendors' logos. A runtime
// the panel does not know keeps the monogram on ink.
const MARKS: Record<string, { background: string; glyph: React.ReactNode }> = {
  claude: {
    background: "#D97757",
    // A spark: Claude's mark is a burst of rays; this is eight plain ones.
    glyph: <g stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <path d="M8 2.2v3.1M8 10.7v3.1M2.2 8h3.1M10.7 8h3.1M3.9 3.9l2.2 2.2M9.9 9.9l2.2 2.2M12.1 3.9 9.9 6.1M6.1 9.9l-2.2 2.2"/>
    </g>,
  },
  codex: {
    background: "#10A37F",
    // A prompt: Codex works in the terminal.
    glyph: <g fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3.5 5 3 3-3 3M8.5 11.5h4"/>
    </g>,
  },
  opencode: {
    background: "#3B6FE0",
    // Braces: an open coding agent.
    glyph: <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3c-1.5 0-2 .6-2 1.8v1.4c0 .9-.5 1.5-1.4 1.8.9.3 1.4.9 1.4 1.8v1.4C4 12.4 4.5 13 6 13M10 3c1.5 0 2 .6 2 1.8v1.4c0 .9.5 1.5 1.4 1.8-.9.3-1.4.9-1.4 1.8v1.4c0 1.2-.5 1.8-2 1.8"/>
    </g>,
  },
};

export function RuntimeMark({ runtime, fallback, size = "md" }: { runtime?: string | null; fallback?: string; size?: "md" | "sm" }) {
  const mark = runtime ? MARKS[runtime] : undefined;
  const box = size === "sm" ? "h-6 w-6" : "h-8 w-8";
  if (!mark) {
    const letter = (fallback?.trim()[0] ?? (runtime ? runtimeLabel(runtime)[0] : "") ?? "?").toUpperCase() || "?";
    return <span aria-hidden className={`grid ${box} shrink-0 place-items-center rounded-sm bg-ink text-[0.6875rem] font-medium text-on-ink`}>{letter}</span>;
  }
  return <span role="img" aria-label={runtimeLabel(runtime ?? "")} title={runtimeLabel(runtime ?? "")}
    className={`grid ${box} shrink-0 place-items-center rounded-sm text-white`} style={{ background: mark.background }}>
    <svg viewBox="0 0 16 16" className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden>{mark.glyph}</svg>
  </span>;
}
