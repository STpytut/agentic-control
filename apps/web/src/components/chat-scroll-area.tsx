"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

const bottomThreshold = 96;

export function ChatScrollArea({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  function updatePosition() {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const nearBottom = distance <= bottomThreshold;
    nearBottomRef.current = nearBottom;
    setShowJump(!nearBottom);
  }

  function jumpToBottom(behavior: ScrollBehavior = "smooth") {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
    nearBottomRef.current = true;
    setShowJump(false);
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => jumpToBottom("auto"));
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") {
      return () => window.cancelAnimationFrame(frame);
    }
    const observer = new ResizeObserver(() => {
      if (nearBottomRef.current) jumpToBottom("auto");
      else updatePosition();
    });
    observer.observe(content);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="relative min-h-0 flex-1">
      <div className="h-full overflow-y-auto overscroll-contain [scrollbar-gutter:stable]" ref={scrollRef} onScroll={updatePosition}>
        <div className="mx-auto min-h-full w-[min(760px,100%)] px-7 pt-7 pb-4 phone:px-4 phone:pt-6 phone:pb-3" ref={contentRef}>{children}</div>
      </div>
      {showJump && <button className="touch-target absolute right-6 bottom-4 z-4 grid h-9 w-9 place-items-center rounded-full border border-line-strong bg-canvas text-ink shadow-popover transition-colors duration-150 hover:border-ink phone:right-4 phone:bottom-3" type="button" onClick={() => jumpToBottom()} aria-label="Scroll to latest message" title="Scroll to latest message">↓</button>}
    </div>
  );
}
