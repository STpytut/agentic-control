import type { ElementType, ReactNode } from "react";
import { cx } from "../lib/cx";

type ContainerProps = {
  as?: ElementType;
  /** `marketing` is the 1280px column with generous gutters; `app` the 1440px work area. */
  width?: "marketing" | "app";
  children: ReactNode;
  className?: string;
};

export function Container({ as: Tag = "div", width = "marketing", children, className }: ContainerProps) {
  return (
    <Tag
      className={cx(
        "mx-auto w-full",
        width === "marketing" ? "max-w-[1280px] px-5 sm:px-8 lg:px-16" : "max-w-[1440px] px-4 sm:px-6",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

type PageHeaderProps = {
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
};

/** Application page title block: eyebrow, title, description, one primary action. */
export function PageHeader({ title, eyebrow, description, action, className }: PageHeaderProps) {
  return (
    <header className={cx("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="type-eyebrow mb-2 text-muted">{eyebrow}</p> : null}
        <h1 className="type-page-title">{title}</h1>
        {description ? <p className="type-app-body mt-3 max-w-[60ch] text-muted">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

type SectionHeadingProps = {
  eyebrow?: string;
  title: ReactNode;
  intro?: ReactNode;
  id?: string;
  className?: string;
};

/** Marketing section opener: eyebrow with a hairline rule, display title, intro.
 *  Inside a `data-theme="dark"` subtree the colours follow automatically. */
export function SectionHeading({ eyebrow, title, intro, id, className }: SectionHeadingProps) {
  return (
    <div className={className}>
      {eyebrow ? (
        <div className="mb-8 flex items-center gap-4">
          <span className="type-eyebrow text-muted">{eyebrow}</span>
          <span className="h-px flex-1 bg-line" aria-hidden="true" />
        </div>
      ) : null}
      <h2 id={id} className="type-h2 max-w-[16ch]">
        {title}
      </h2>
      {intro ? <p className="type-body-lg mt-6 max-w-[46ch] text-muted">{intro}</p> : null}
    </div>
  );
}

type EmptyStateProps = {
  title: string;
  /** Operational copy: say what to do next, never "Nothing here yet". */
  description: string;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cx("rounded-lg border border-dashed border-line-strong px-6 py-10 text-center", className)}>
      <h2 className="type-card-title">{title}</h2>
      <p className="type-app-body mx-auto mt-2 max-w-[52ch] text-muted">{description}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

/**
 * Reserved space while a screen loads: a page header followed by a list, so
 * the layout does not shift when real content arrives.
 */
export function Skeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-8", className)} aria-hidden="true">
      <div className="flex flex-col gap-3">
        <div className="h-3 w-28 rounded-xs bg-skeleton" />
        <div className="h-9 w-64 rounded-sm bg-skeleton" />
      </div>
      <div className="flex flex-col">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="border-b border-line py-4">
            <div className="h-4 w-full max-w-[28rem] rounded-xs bg-skeleton" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A single loading bar, for inline placeholders. */
export function SkeletonLine({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx("h-4 rounded-xs bg-skeleton", className)} />;
}
