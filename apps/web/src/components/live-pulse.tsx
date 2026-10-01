"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const VISIBLE_MS = 3_000;

// Every signed-in page refreshes itself when what it shows has changed (the
// owner, 2026-09-29): it asks for the operator's fingerprint (lib/pulse.ts)
// every few seconds while the tab is visible, at once when it becomes visible
// again, and refreshes the server-rendered page when the fingerprint moved.
// router.refresh() keeps every client component's state — a half-typed message,
// an open dialog — and replaces only what the server rendered.
export function LivePulse() {
  const router = useRouter();
  const last = useRef<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (busy.current || document.visibilityState !== "visible") return;
      busy.current = true;
      try {
        const response = await fetch("/api/control-plane/pulse", { cache: "no-store" });
        if (!response.ok) return;
        const { pulse } = await response.json() as { pulse?: string };
        if (cancelled || !pulse) return;
        if (last.current !== null && last.current !== pulse) router.refresh();
        last.current = pulse;
      } catch {
        // Offline for a moment: the next tick asks again.
      } finally {
        busy.current = false;
      }
    }
    void check();
    const timer = window.setInterval(() => void check(), VISIBLE_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [router]);
  return null;
}
