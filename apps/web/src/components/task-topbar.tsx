"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "@agentic/design-system";
import { DisclosureMenu } from "@/components/ui/disclosure-menu";

// The task's title in the top bar: one line cut with an ellipsis, the whole
// text in `title` and, on a click, in a panel under it.
export function TaskTitle({ title, note }: { title: string; note?: string }) {
  return <DisclosureMenu className="min-w-0 flex-1" summaryClassName="flex min-h-8 min-w-0 items-center rounded-sm"
    summary={<h1 className="min-w-0 truncate text-[0.9375rem] font-medium text-ink" title={title}>{title}</h1>}>
    <div className="absolute top-full left-0 z-40 mt-3 w-[min(560px,calc(100vw-28px))] rounded-lg border border-line bg-canvas p-3.5 text-ink shadow-popover phone:fixed phone:inset-x-3.5 phone:top-[57px] phone:mt-2 phone:w-auto">
      <p className="type-app-body [overflow-wrap:anywhere]">{title}</p>
      {note && <p className="type-meta mt-1 text-muted">{note}</p>}
    </div>
  </DisclosureMenu>;
}

// The task's actions in the top bar. On a phone they fold into a "⋯" menu;
// each action renders once, at every width.
export function TaskTopbarActions({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function outside(event: PointerEvent) { if (!ref.current?.contains(event.target as Node)) setOpen(false); }
    function escape(event: KeyboardEvent) { if (event.key === "Escape") setOpen(false); }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);

  return <div ref={ref} className="relative flex items-center" onClick={(event) => { if ((event.target as HTMLElement).closest("a")) setOpen(false); }}>
    <button type="button" className="touch-target hidden h-9 w-9 place-items-center rounded-md text-ink/75 transition-colors duration-150 hover:bg-wash hover:text-ink aria-expanded:bg-wash aria-expanded:text-ink phone:grid" aria-label="Task actions" aria-expanded={open} onClick={() => setOpen(!open)}><span aria-hidden="true">⋯</span></button>
    <div className={cx("flex items-center gap-2 phone:absolute phone:top-full phone:right-0 phone:z-40 phone:mt-2 phone:w-[min(300px,calc(100vw-28px))] phone:flex-col phone:items-stretch phone:gap-1 phone:rounded-lg phone:border phone:border-line phone:bg-canvas phone:p-1.5 phone:shadow-popover", !open && "phone:hidden")}>{children}</div>
  </div>;
}
