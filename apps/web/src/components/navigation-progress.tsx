"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setPending(false));
    return () => window.cancelAnimationFrame(frame);
  }, [pathname, searchParams]);

  useEffect(() => {
    function navigate(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target || anchor.origin !== window.location.origin) return;
      const next = new URL(anchor.href);
      if (`${next.pathname}${next.search}` === `${window.location.pathname}${window.location.search}`) return;
      setPending(true);
    }
    document.addEventListener("click", navigate);
    return () => document.removeEventListener("click", navigate);
  }, []);

  return (
    <div className={`pointer-events-none fixed inset-x-0 top-0 z-1000 h-0.5 overflow-hidden transition-opacity duration-150 ${pending ? "opacity-100" : "opacity-0"}`} aria-hidden="true">
      <span className="block h-full w-[35%] bg-ink animate-[navigation-progress_1s_ease-in-out_infinite] motion-reduce:animate-none" />
    </div>
  );
}
