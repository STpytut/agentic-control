import type { ReactNode } from "react";
import { cx } from "../lib/cx";

export type BadgeTone =
  | "neutral"
  | "active"
  | "attention"
  | "success"
  | "warning"
  | "danger"
  | "info";

const base =
  "type-meta inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 whitespace-nowrap";

const tones: Record<BadgeTone, string> = {
  neutral: "border border-line text-ink/75",
  active: "bg-ink text-on-ink",
  attention: "border border-ink/30 bg-accent text-on-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

type BadgeProps = {
  tone?: BadgeTone;
  /** Leading dot in the current colour — for live states like "running". */
  dot?: boolean;
  className?: string;
  children: ReactNode;
};

/**
 * Status marker. The label is always text: status is never communicated by
 * colour alone.
 */
export function Badge({ tone = "neutral", dot = false, className, children }: BadgeProps) {
  return (
    <span className={cx(base, tones[tone], className)}>
      {dot ? <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
