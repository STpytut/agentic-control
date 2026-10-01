"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "@agentic/design-system";

// The chat's context panel (Stage 12 N3): three tabs — Team, Changes,
// Activity — each one compact view. Open or closed is a per-viewer
// convenience in localStorage; until the viewer chooses, it is open from
// 1280 px and closed below, by CSS, so the page renders right without it. On a
// phone the same element is a bottom sheet.
export type PanelTab = "team" | "changes" | "activity";
const OPEN_KEY = "cp.chat-panel.open";

type PanelState = { open: boolean | null; tab: PanelTab; toggle: () => void; close: () => void; show: (tab: PanelTab) => void };
const PanelContext = createContext<PanelState | null>(null);

function usePanel() {
  const state = useContext(PanelContext);
  if (!state) throw new Error("the chat panel's controls sit inside ChatPanelProvider");
  return state;
}

function wide() {
  return typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches;
}

export function ChatPanelProvider({ children }: { children: ReactNode }) {
  // null: not chosen — the CSS default applies.
  const [open, setOpen] = useState<boolean | null>(null);
  const [tab, setTab] = useState<PanelTab>("team");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(OPEN_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after hydration
      if (stored === "true" || stored === "false") setOpen(stored === "true");
    } catch {}
  }, []);

  function remember(value: boolean) {
    setOpen(value);
    // A phone's sheet is closed after use; only a wide screen's choice is kept.
    if (window.matchMedia("(max-width: 760px)").matches) return;
    try { window.localStorage.setItem(OPEN_KEY, String(value)); } catch {}
  }

  const state: PanelState = {
    open, tab,
    toggle: () => remember(!(open ?? wide())),
    close: () => remember(false),
    show: (next) => { setTab(next); remember(true); },
  };
  return <PanelContext.Provider value={state}>{children}</PanelContext.Provider>;
}

// The top bar's button: a side panel's icon on a wide screen, a sheet's on a phone.
export function PanelToggle() {
  const { open, toggle } = usePanel();
  return <button type="button" onClick={toggle} aria-controls="chat-context" aria-expanded={open ?? undefined}
    aria-label={open === false ? "Show the context panel" : open ? "Hide the context panel" : "Toggle the context panel"}
    title="Team, changes and activity"
    className="touch-target grid h-9 w-9 shrink-0 place-items-center rounded-md border border-line-strong text-ink transition-colors duration-150 hover:border-ink phone:h-11 phone:w-11 phone:border-0">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="phone:hidden"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="hidden phone:block"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/></svg>
  </button>;
}

// "View changes" on the step card: the panel, on its Changes tab.
export function ShowPanelTab({ tab, children }: { tab: PanelTab; children: ReactNode }) {
  const { show } = usePanel();
  return <button type="button" onClick={() => show(tab)} aria-controls="chat-context"
    className="touch-target inline-flex h-9 items-center rounded-md border border-line-strong px-3 text-[0.875rem] font-medium whitespace-nowrap text-ink transition-colors duration-150 hover:border-ink hover:bg-ink hover:text-on-ink">
    {children}
  </button>;
}

const TABS: Array<{ id: PanelTab; label: string }> = [{ id: "team", label: "Team" }, { id: "changes", label: "Changes" }, { id: "activity", label: "Activity" }];

export function ChatPanel({ team, changes, activity }: { team: ReactNode; changes: ReactNode; activity: ReactNode }) {
  const { open, tab, show, close } = usePanel();
  const tabRefs = useRef<Record<PanelTab, HTMLButtonElement | null>>({ team: null, changes: null, activity: null });
  const content = { team, changes, activity };

  // Escape closes the phone's sheet.
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && window.matchMedia("(max-width: 760px)").matches) close(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, close]);

  function keys(event: React.KeyboardEvent, index: number) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length].id;
    show(next);
    tabRefs.current[next]?.focus();
  }

  return <>
    {open && <button type="button" tabIndex={-1} aria-label="Close the panel" onClick={close} className="fixed inset-0 z-40 hidden bg-overlay phone:block"/>}
    <aside id="chat-context" aria-label="Chat context"
      className={cx("min-h-0 w-[320px] shrink-0 flex-col border-l border-line bg-canvas",
        open === null ? "hidden min-[1280px]:flex" : open ? "flex" : "hidden",
        "phone:fixed phone:inset-x-0 phone:bottom-0 phone:z-50 phone:max-h-[82dvh] phone:w-auto phone:rounded-t-[16px] phone:border-l-0 phone:pb-[env(safe-area-inset-bottom)] phone:shadow-popover",
        open ? "phone:flex" : "phone:hidden")}>
      <div className="hidden justify-center pt-2.5 phone:flex" aria-hidden="true"><span className="h-1 w-10 rounded-full bg-line-strong"/></div>
      <div role="tablist" aria-label="Chat context" className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-3 phone:h-14 phone:border-b-0">
        {TABS.map((item, index) => <button key={item.id} ref={(element) => { tabRefs.current[item.id] = element; }} type="button" role="tab" id={`chat-context-tab-${item.id}`}
          aria-selected={tab === item.id} aria-controls={`chat-context-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
          onClick={() => show(item.id)} onKeyDown={(event) => keys(event, index)}
          className={cx("touch-target h-8 rounded-md px-3 text-[0.8125rem] font-medium transition-colors duration-150 phone:h-10", tab === item.id ? "bg-ink text-on-ink" : "text-ink/75 hover:bg-wash hover:text-ink")}>{item.label}</button>)}
      </div>
      {TABS.map((item) => <div key={item.id} role="tabpanel" id={`chat-context-panel-${item.id}`} aria-labelledby={`chat-context-tab-${item.id}`} hidden={tab !== item.id}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {content[item.id]}
      </div>)}
    </aside>
  </>;
}
