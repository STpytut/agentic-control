import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "@agentic/design-system";

// The destructive action. The package's Button has primary, secondary and
// accent only; this repeats its base and md size on the danger token (a
// candidate for @agentic/design-system). Like Button, it defaults to
// type="button": a submit button says so.
const base =
  "touch-target inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-[0.9375rem] font-medium whitespace-nowrap " +
  "bg-danger text-canvas transition-[background-color,color,transform] duration-200 ease-out hover:bg-ink hover:text-on-ink " +
  "active:translate-y-px disabled:pointer-events-none disabled:opacity-60";

export function DangerButton({ className, type = "button", ...rest }: ComponentPropsWithoutRef<"button"> & { children: ReactNode }) {
  return <button type={type} className={cx(base, className)} {...rest}/>;
}

// A quieter destructive action: text in the danger colour on a hairline, the
// height of Button size="sm" so it lines up beside one — for a trigger that
// opens a confirmation, or a destructive choice among secondary ones.
export const dangerOutlineClasses =
  "touch-target inline-flex h-9 items-center justify-center rounded-md border border-danger/40 px-3.5 text-[0.875rem] font-medium text-danger whitespace-nowrap " +
  "transition-colors duration-150 hover:border-danger hover:bg-danger-soft disabled:pointer-events-none disabled:opacity-60";
