import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "@agentic/design-system";

// A settings side menu (Stage 12 N6, N7): each page its own URL. At desktop
// widths a column beside the page; on a phone the same links wrap above it.
export type SettingsMenuItem = { href: string; label: string; current: boolean; badge?: ReactNode };

export function SettingsMenu({ label, items, className }: { label: string; items: SettingsMenuItem[]; className?: string }) {
  return <nav aria-label={label} className={className}>
    <ul className="m-0 grid list-none gap-0.5 p-0 phone:flex phone:flex-wrap phone:gap-1.5">
      {items.map((item) => <li key={item.href}>
        <Link href={item.href} aria-current={item.current ? "page" : undefined}
          className={cx("touch-target flex min-h-10 items-center gap-2 rounded-md px-3 text-[0.875rem] transition-colors duration-150 phone:min-h-11 phone:border phone:border-line",
            item.current ? "bg-ink font-medium text-on-ink phone:border-ink" : "text-ink/80 hover:bg-wash hover:text-ink")}>
          <span className="flex-1">{item.label}</span>
          {item.badge}
        </Link>
      </li>)}
    </ul>
  </nav>;
}

// The page beside the menu: its title, an optional description and action.
export function SettingsPageHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div className="min-w-0">
      <h1 className="type-page-title m-0 text-[2.125rem] leading-tight phone:text-[1.75rem]">{title}</h1>
      {description && <p className="type-app-body mt-2 mb-0 max-w-[68ch] text-muted">{description}</p>}
    </div>
    {action}
  </div>;
}
