import { cx } from "@agentic/design-system";

// A project's mark: its first letter on a colour of its own, the same wherever
// the project is named — the sidebar, a top bar, the start screen — so which
// project a page belongs to reads at a glance (the owner, 2026-09-29). The
// colour comes from the id, not the name, so a rename keeps it.
export function projectHue(id: string) {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function ProjectMark({ id, name, size = 20, className }: { id: string; name: string; size?: number; className?: string }) {
  const letter = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?";
  return <span aria-hidden="true" className={cx("grid shrink-0 place-items-center rounded-[6px] font-display font-semibold text-white", className)}
    style={{ width: size, height: size, fontSize: Math.round(size * 0.55), background: `hsl(${projectHue(id)} 42% 42%)` }}>
    {letter}
  </span>;
}
