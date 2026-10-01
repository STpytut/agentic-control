"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { cx } from "@agentic/design-system";

// A <details> used as a small menu: the native element keeps the open state,
// the keyboard and the semantics; this closes it when the route changes, on a
// click outside it and on Escape. A candidate for @agentic/design-system (its
// Menu is the surface only and leaves this behaviour to the product).
export function DisclosureMenu({ summary, summaryClassName, className, current, children }: { summary: ReactNode; summaryClassName?: string; className?: string; current?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();

  useEffect(() => { if (ref.current) ref.current.open = false; }, [pathname]);

  useEffect(() => {
    function outside(event: PointerEvent) {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false;
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);

  return <details ref={ref} className={cx("group relative", className)}>
    <summary className={cx("list-none [&::-webkit-details-marker]:hidden", summaryClassName)} aria-current={current ? "page" : undefined}>{summary}</summary>
    {children}
  </details>;
}
