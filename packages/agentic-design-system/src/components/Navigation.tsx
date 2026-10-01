import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { cx } from "../lib/cx";

type LinkLike = {
  /** Router link component, e.g. `next/link`. Defaults to a plain anchor. */
  as?: ElementType;
};

type TabItem = { key: string; label: ReactNode; href: string };

/** Underlined tab row. Server-renderable: the active view is a URL parameter, not client state. */
export function Tabs({
  tabs,
  current,
  as: Tag = "a",
  label = "View",
  className,
}: LinkLike & { tabs: TabItem[]; current: string; label?: string; className?: string }) {
  return (
    <nav className={cx("flex gap-6 border-b border-line", className)} aria-label={label}>
      {tabs.map((tab) => {
        const active = tab.key === current;
        return (
          <Tag
            key={tab.key}
            href={tab.href}
            aria-current={active ? "true" : undefined}
            className={cx(
              "touch-target -mb-px flex items-end border-b-2 pb-3 text-[0.9375rem] transition-colors duration-150",
              active ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {tab.label}
          </Tag>
        );
      })}
    </nav>
  );
}

type NavItemProps = LinkLike &
  ComponentPropsWithoutRef<"a"> & {
    href: string;
    active?: boolean;
    icon?: ReactNode;
    children: ReactNode;
  };

/** Sidebar entry. The ink fill marks the current page — the one dark surface
 *  an application uses by default. */
export function NavItem({ as: Tag = "a", href, active = false, icon, className, children, ...rest }: NavItemProps) {
  return (
    <Tag
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "touch-target flex items-center gap-2.5 rounded-md px-3 py-2 text-[0.9375rem] transition-colors duration-150",
        active ? "bg-ink font-medium text-on-ink" : "text-ink/75 hover:bg-wash hover:text-ink",
        className,
      )}
      {...rest}
    >
      {icon ? <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">{icon}</span> : null}
      {children}
    </Tag>
  );
}

/** Floating panel for menus and popovers. Behaviour (open state, focus trap)
 *  stays in the product; this is the surface and its items. */
export function Menu({ className, ...rest }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      role="menu"
      className={cx("min-w-[200px] rounded-lg border border-line bg-canvas p-1.5 shadow-popover", className)}
      {...rest}
    />
  );
}

export function MenuItem({ as: Tag = "a", className, ...rest }: LinkLike & ComponentPropsWithoutRef<"a">) {
  return (
    <Tag
      role="menuitem"
      className={cx(
        "touch-target flex w-full items-center rounded-sm px-3 py-2 text-left text-[0.9375rem] text-ink/85 hover:bg-wash hover:text-ink",
        className,
      )}
      {...rest}
    />
  );
}

/** Small outlined tag, e.g. the capability list under a marketing service. */
export function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cx("type-small inline-flex rounded-sm border border-line px-3 py-1.5 text-ink/80", className)}>
      {children}
    </span>
  );
}

/** Hairline divider with an optional centred label ("or"). */
export function Divider({ label, className }: { label?: string; className?: string }) {
  if (!label) return <hr className={cx("border-0 border-t border-line", className)} />;
  return (
    <div className={cx("flex items-center gap-3 text-muted", className)} role="separator">
      <span className="h-px flex-1 bg-line" />
      <span className="type-meta">{label}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
