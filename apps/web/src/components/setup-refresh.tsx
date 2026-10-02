"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// The first-run steps read the server again while a step finishes by itself —
// the models' checks after an agent signs in.
export function SetupRefresh({ everyMs = 5000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), everyMs);
    return () => window.clearInterval(timer);
  }, [router, everyMs]);
  return null;
}
