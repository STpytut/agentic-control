"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

// The last chat the viewer had open, so Settings' "Back to chats" returns to
// it (Stage 12 N7). A per-viewer convenience: without it the link goes to the
// projects, and every access is guarded.
const LAST_CHAT_KEY = "cp.last-chat";

export function RememberChat({ href }: { href: string }) {
  useEffect(() => {
    try { window.localStorage.setItem(LAST_CHAT_KEY, href); } catch {}
  }, [href]);
  return null;
}

export function BackToChats({ className, children }: { className?: string; children: React.ReactNode }) {
  const [href, setHref] = useState("/projects");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LAST_CHAT_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after hydration
      if (stored && stored.startsWith("/projects/")) setHref(stored);
    } catch {}
  }, []);
  return <Link href={href} className={className}>{children}</Link>;
}
