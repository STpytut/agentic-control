"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Logo, cx } from "@agentic/design-system";
import type { SidebarProject } from "@/lib/sidebar-data";
import { chatStatusDot, chatStatusLabel, shortAge } from "@/components/ui/chat-status";
import { DisclosureMenu } from "@/components/ui/disclosure-menu";
import { ProjectMark } from "@/components/ui/project-mark";
import { ProjectDeleteDialog } from "@/components/project-delete-dialog";
import { ProjectArchiveDialog, ProjectRenameDialog } from "@/components/project-menu-dialogs";

const RECENT = 5;
const EXPANDED_KEY = "cp.sidebar.expanded";
const PINNED_KEY = "cp.sidebar.pinned";

// Per-viewer conveniences: which projects are open. The page renders without
// them (the current project open), so every access is guarded.
function readExpanded(): Record<string, boolean> {
  try {
    const value = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? "{}");
    return value && typeof value === "object" ? value as Record<string, boolean> : {};
  } catch { return {}; }
}
function writeExpanded(value: Record<string, boolean>) {
  try { window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(value)); } catch {}
}
// Pinned projects stay at the top, in this viewer's browser only: pinning
// changes no project, so it needs no action.
function readPinned(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(PINNED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}
function writePinned(value: string[]) {
  try { window.localStorage.setItem(PINNED_KEY, JSON.stringify(value)); } catch {}
}

// The repository a project row opens: only a web address, and without `.git`.
function repositoryHref(url: string | null) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return url.replace(/\.git$/i, "");
}

const iconButton = "touch-target grid h-9 w-9 shrink-0 place-items-center rounded-md text-ink/75 transition-colors duration-150 hover:bg-wash hover:text-ink aria-expanded:bg-wash aria-expanded:text-ink phone:h-11 phone:w-11";
const rowLink = "flex min-h-9 min-w-0 items-center gap-2 rounded-md px-2.5 text-[0.8125rem] transition-colors duration-150 phone:min-h-11 phone:text-[0.875rem]";

function SearchIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>;
}
function PlusIcon({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>;
}
// The project row's ⋯ menu (the owner, 2026-09-29, after Claude's): what is
// done to the project itself — open its repository, copy its link, pin,
// rename, archive, delete.
// Its settings are the Project settings button on its pages. A letter runs an
// item while the menu is open.
function ProjectMenu({ project, pinned, onPin, current }: { project: SidebarProject; pinned: boolean; onPin: () => void; current: boolean }) {
  const wrapper = useRef<HTMLSpanElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [copied, setCopied] = useState(false);
  const repository = repositoryHref(project.repositoryUrl);
  const close = () => { const details = wrapper.current?.querySelector("details"); if (details) details.open = false; };
  const item = "touch-target flex min-h-9 w-full items-center justify-between gap-3 rounded-sm px-3 text-left text-[0.875rem] transition-colors duration-150 hover:bg-wash phone:min-h-11";
  const key = (letter: string) => <kbd className="type-meta font-sans text-muted phone:hidden">{letter}</kbd>;
  const actions: Record<string, () => void> = {
    p: () => { onPin(); close(); },
    o: () => { if (repository) window.open(repository, "_blank", "noopener,noreferrer"); close(); },
    l: () => {
      void navigator.clipboard?.writeText(`${window.location.origin}/projects/${project.id}`).then(() => {
        setCopied(true);
        window.setTimeout(() => { setCopied(false); close(); }, 900);
      }, close);
    },
    r: () => { close(); setRenaming(true); },
    a: () => { close(); setArchiving(true); },
    d: () => { close(); setDeleting(true); },
  };
  return <span ref={wrapper} className="shrink-0" onKeyDown={(event) => {
    if (!wrapper.current?.querySelector("details")?.open || event.metaKey || event.ctrlKey || event.altKey) return;
    const run = actions[event.key.toLowerCase()];
    if (run && (event.key.toLowerCase() !== "o" || repository)) { event.preventDefault(); run(); }
  }}>
    <DisclosureMenu summaryClassName={cx(iconButton, "h-8 w-8 text-muted group-open:bg-wash group-open:text-ink phone:h-11 phone:w-11")}
      summary={<><span aria-hidden="true" className="tracking-[1px]">⋯</span><span className="sr-only">{project.name}: more</span></>}>
      <div role="menu" className="absolute top-full right-0 z-40 mt-1 grid w-56 gap-0.5 rounded-lg border border-line bg-canvas p-1.5 shadow-popover">
        {repository && <a role="menuitem" href={repository} target="_blank" rel="noopener noreferrer" className={cx(item, "text-ink")} onClick={close}>Open repository{key("O")}</a>}
        <button type="button" role="menuitem" className={cx(item, "text-ink")} onClick={actions.l}>{copied ? "Link copied" : "Copy link"}{key("L")}</button>
        <span className="my-0.5 border-t border-line" aria-hidden="true"/>
        <button type="button" role="menuitem" className={cx(item, "text-ink")} onClick={actions.p}>{pinned ? "Unpin" : "Pin to top"}{key("P")}</button>
        <button type="button" role="menuitem" className={cx(item, "text-ink")} onClick={actions.r}>Rename…{key("R")}</button>
        <span className="my-0.5 border-t border-line" aria-hidden="true"/>
        <button type="button" role="menuitem" className={cx(item, "text-ink")} onClick={actions.a}>Archive…{key("A")}</button>
        <button type="button" role="menuitem" className={cx(item, "text-danger hover:bg-danger-soft")} onClick={actions.d}>Delete…{key("D")}</button>
      </div>
    </DisclosureMenu>
    <ProjectRenameDialog projectId={project.id} projectName={project.name} projectVersion={project.version} open={renaming} onOpenChange={setRenaming}/>
    <ProjectArchiveDialog projectId={project.id} projectName={project.name} projectVersion={project.version}
      open={archiving} onOpenChange={setArchiving} afterArchive={current ? "/projects" : undefined}/>
    <ProjectDeleteDialog projectId={project.id} projectName={project.name} projectSlug={project.slug} projectVersion={project.version}
      open={deleting} onOpenChange={setDeleting} afterDelete={current ? "/projects" : undefined}/>
  </span>;
}

function GearIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>;
}

// The panel's navigation: projects with their chats under them (Stage 12 N1).
// At desktop widths a fixed column; on a phone the same element is a drawer
// opened from the ☰ in the top bar.
export function AppSidebar({ projects, currentProjectId, activeConversationId, operatorName, settingsActive = false, newChatHref }: {
  projects: SidebarProject[];
  currentProjectId?: string;
  activeConversationId?: string;
  operatorName: string;
  settingsActive?: boolean;
  newChatHref: string;
}) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => currentProjectId ? { [currentProjectId]: true } : {});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [pinned, setPinned] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);

  // What the viewer opened before, then the current project open whatever it said.
  useEffect(() => {
    const stored = readExpanded();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after hydration
    setExpanded((current) => ({ ...current, ...stored, ...(currentProjectId ? { [currentProjectId]: true } : {}) }));
  }, [currentProjectId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after hydration
  useEffect(() => { setPinned(readPinned()); }, []);

  function togglePin(projectId: string) {
    setPinned((current) => {
      const next = current.includes(projectId) ? current.filter((id) => id !== projectId) : [projectId, ...current];
      writePinned(next);
      return next;
    });
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- a navigation closes the drawer
  useEffect(() => { setDrawer(false); }, [pathname]);

  useEffect(() => {
    if (!drawer) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setDrawer(false); menuRef.current?.focus(); } };
    window.addEventListener("keydown", escape);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", escape); };
  }, [drawer]);

  useEffect(() => { if (searching) searchRef.current?.focus(); }, [searching]);

  function toggle(projectId: string) {
    setExpanded((current) => {
      const next = { ...current, [projectId]: !current[projectId] };
      writeExpanded(next);
      return next;
    });
  }

  const needle = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => {
    const ordered = [...projects.filter((project) => pinned.includes(project.id)), ...projects.filter((project) => !pinned.includes(project.id))];
    return needle
      ? ordered.map((project) => ({ ...project, chats: project.chats.filter((chat) => chat.title.toLocaleLowerCase().includes(needle)) }))
          .filter((project) => project.chats.length || project.name.toLocaleLowerCase().includes(needle))
      : ordered;
  }, [projects, needle, pinned]);

  return <>
    {/* The phone's way in: the top bar leaves room for it (.cp-topbar). */}
    <button ref={menuRef} type="button" className="fixed top-1.5 left-1.5 z-30 hidden h-11 w-11 place-items-center rounded-md text-ink transition-colors duration-150 hover:bg-wash phone:grid"
      aria-label="Projects and chats" aria-expanded={drawer} aria-controls="app-sidebar" onClick={() => setDrawer(true)}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    </button>
    {drawer && <button type="button" className="fixed inset-0 z-40 hidden bg-overlay phone:block" aria-label="Close the menu" tabIndex={-1} onClick={() => setDrawer(false)}/>}
    <nav id="app-sidebar" aria-label="Projects and chats"
      className={cx("fixed inset-y-0 left-0 z-30 flex w-[280px] flex-col border-r border-line bg-canvas text-ink",
        "phone:z-50 phone:w-[min(312px,calc(100vw-48px))] phone:shadow-popover phone:transition-transform phone:duration-200",
        drawer ? "phone:translate-x-0" : "phone:-translate-x-full phone:invisible")}
      onClick={(event) => { if ((event.target as HTMLElement).closest("a")) setDrawer(false); }}>
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3.5 pb-2.5 pl-4">
        <Link href={newChatHref} className="flex min-h-9 items-center rounded-sm"><Logo product="control" size="sm"/></Link>
        <span className="flex items-center gap-0.5">
          <button type="button" className={iconButton} aria-label="Search chats" aria-expanded={searching} aria-controls="sidebar-search"
            onClick={() => { setSearching(!searching); if (searching) setQuery(""); }}><SearchIcon/></button>
          <button ref={closeRef} type="button" className={cx(iconButton, "hidden phone:grid")} aria-label="Close" onClick={() => { setDrawer(false); menuRef.current?.focus(); }}>
            <span aria-hidden="true" className="text-[1.125rem] leading-none">×</span>
          </button>
        </span>
      </div>
      {searching && <div className="shrink-0 px-3 pb-2">
        <label htmlFor="sidebar-search" className="sr-only">Search chats</label>
        <input id="sidebar-search" ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") { setQuery(""); setSearching(false); } }}
          placeholder="Search chat titles…" autoComplete="off"
          className="h-9 w-full rounded-md border border-line-strong bg-transparent px-3 text-[0.875rem] text-ink outline-none placeholder:text-muted focus:border-ink phone:h-11"/>
      </div>}
      <div className="shrink-0 px-3 pb-3">
        <Link href={newChatHref} className="touch-target flex h-10 items-center gap-2 rounded-md bg-ink px-3 text-[0.875rem] font-medium text-on-ink transition-colors duration-150 hover:bg-accent hover:text-on-accent phone:h-11">
          <PlusIcon size={16}/>New chat
        </Link>
      </div>
      <p className="type-eyebrow shrink-0 px-5 pt-1 pb-1.5 text-muted">Projects</p>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 pb-2">
        {!projects.length && <div className="px-3 py-3">
          <p className="type-meta text-muted">No projects yet. A project is a repository the team works in; its chats appear here.</p>
        </div>}
        {needle && !filtered.length && <p className="type-meta px-3 py-2 text-muted">No chat title matches “{query.trim()}”.</p>}
        {/* minmax(0,1fr): a track sized to its content grows to a long chat
            title's full nowrap width, and the list scrolled sideways. */}
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
          {filtered.map((project) => {
            const open = needle ? true : Boolean(expanded[project.id]);
            const all = needle || showAll[project.id];
            const chats = all ? project.chats : project.chats.slice(0, RECENT);
            const current = project.id === currentProjectId;
            return <li key={project.id} className="grid grid-cols-[minmax(0,1fr)]">
              {/* The current project is marked on every page of it, a chat open or not:
                  a bar at its edge, its row washed, its name in the heavier weight. */}
              <div className={cx("group relative flex min-h-9 items-center gap-0.5 rounded-md pr-0.5 pl-0.5 phone:min-h-11",
                current && "bg-wash before:absolute before:inset-y-1.5 before:-left-2 before:w-[3px] before:rounded-r-full before:bg-ink")}>
                <button type="button" className="touch-target grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-wash hover:text-ink disabled:opacity-40 phone:h-11 phone:w-11" aria-expanded={open} aria-controls={`sidebar-chats-${project.id}`}
                  aria-label={`${open ? "Collapse" : "Expand"} ${project.name}`} onClick={() => toggle(project.id)} disabled={Boolean(needle)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true" className={cx("transition-transform duration-150", open && "rotate-90")}><path d="m9 6 6 6-6 6"/></svg>
                </button>
                <Link href={`/projects/${project.id}`} className={cx("flex min-h-8 min-w-0 flex-1 items-center gap-2 truncate rounded-sm text-[0.875rem] phone:min-h-11", current ? "font-semibold" : "font-medium")}
                  aria-current={current && !activeConversationId && !settingsActive ? "page" : undefined}>
                  <ProjectMark id={project.id} name={project.name} size={18}/>
                  <span className="truncate">{project.name}</span>
                  {pinned.includes(project.id) && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-muted" role="img" aria-label="Pinned"><path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z"/></svg>}
                </Link>
                {/* Chats that wait for the owner and GitHub issues waiting to be started
                    (0132) are one number: both are something only the owner can move. */}
                {project.attentionCount + project.issuesWaiting > 0 && <span className="type-meta shrink-0 rounded-full bg-warning-soft px-1.5 font-semibold text-warning tabular-nums"
                  title={waitingLabel(project.attentionCount, project.issuesWaiting)}>
                  {project.attentionCount + project.issuesWaiting}<span className="sr-only"> {waitingLabel(project.attentionCount, project.issuesWaiting)}</span>
                </span>}
                <ProjectMenu project={project} pinned={pinned.includes(project.id)} onPin={() => togglePin(project.id)} current={current}/>
                <Link href={`/projects/${project.id}`} className={cx(iconButton, "h-8 w-8 text-muted phone:h-11 phone:w-11")} aria-label={`New chat in ${project.name}`} title="New chat">
                  <PlusIcon/>
                </Link>
              </div>
              {open && <div id={`sidebar-chats-${project.id}`} className="grid grid-cols-[minmax(0,1fr)] gap-px pt-0.5 pb-1.5 pl-[18px]">
                {chats.map((chat) => {
                  const active = chat.conversationId === activeConversationId;
                  return <Link key={chat.conversationId} href={`/projects/${project.id}?task=${chat.taskId}`}
                    aria-current={active ? "page" : undefined}
                    className={cx(rowLink, active ? "bg-ink text-on-ink" : "text-ink hover:bg-wash")}>
                    <span className={cx("h-[7px] w-[7px] shrink-0 rounded-full", active ? "bg-accent" : chatStatusDot(chat.status))} aria-hidden="true"/>
                    <span className="min-w-0 flex-1 truncate" title={chat.title}>{chat.title}</span>
                    <span className="sr-only">, {chatStatusLabel(chat.status)}{chat.needsOperator ? ", needs you" : ""}</span>
                    <span className={cx("type-meta shrink-0 tabular-nums", active ? "text-on-ink/70" : "text-muted")} suppressHydrationWarning>{shortAge(chat.updatedAt)}</span>
                  </Link>;
                })}
                {!project.chats.length && !needle && <p className="type-meta px-2.5 py-1.5 text-muted">No chats yet.</p>}
                {!needle && !all && project.chatCount > RECENT && <button type="button" className={cx(rowLink, "type-meta text-muted hover:bg-wash hover:text-ink")}
                  onClick={() => setShowAll((current) => ({ ...current, [project.id]: true }))}>Show all ({project.chatCount})</button>}
                {!needle && all && project.chatCount > project.chats.length && <Link href={`/projects/${project.id}/chats`} className={cx(rowLink, "type-meta text-muted hover:bg-wash hover:text-ink")}>
                  All {project.chatCount} chats →</Link>}
              </div>}
            </li>;
          })}
        </ul>
        <Link href="/projects/new" className={cx(rowLink, "mt-1.5 text-muted hover:bg-wash hover:text-ink", pathname === "/projects/new" && "bg-wash text-ink")}
          aria-current={pathname === "/projects/new" ? "page" : undefined}>
          <PlusIcon/>New project
        </Link>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-t border-line px-3 py-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink text-[0.75rem] font-medium text-on-ink" aria-hidden="true">{operatorName.slice(0, 2).toUpperCase()}</span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight"><strong className="truncate text-[0.8125rem] font-medium">{operatorName}</strong><small className="type-meta text-muted">Owner</small></span>
        <form method="post" action="/auth/logout"><button type="submit" className={iconButton} aria-label="Sign out" title="Sign out"><span aria-hidden="true">↗</span></button></form>
        <Link href="/settings" aria-label="Settings" title="Settings" aria-current={settingsActive ? "page" : undefined}
          className={cx(iconButton, "border", settingsActive ? "border-ink bg-ink text-on-ink hover:bg-ink hover:text-on-ink" : "border-line")}><GearIcon/></Link>
      </div>
    </nav>
  </>;
}

function waitingLabel(chats: number, issues: number) {
  return [
    chats ? `${chats} ${chats === 1 ? "chat needs" : "chats need"} you` : "",
    issues ? `${issues} GitHub ${issues === 1 ? "issue waits" : "issues wait"} to be started` : "",
  ].filter(Boolean).join(", ");
}
