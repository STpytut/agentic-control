import type { ComponentPropsWithoutRef } from "react";
import { cx } from "@agentic/design-system";

// A block message inside a form or a card: an error, a confirmation, a note.
// Built here on the package's status tokens because the package has no such
// component (a candidate for @agentic/design-system). It carries no role of its
// own: the caller keeps whatever role="alert"/"status" the message had, so an
// element that was not announced before is not announced now.
export type NoticeTone = "danger" | "success" | "info" | "warning";

const tones: Record<NoticeTone, string> = {
  danger: "bg-danger-soft text-danger",
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
};

export function Notice({ tone = "danger", className, ...rest }: { tone?: NoticeTone } & ComponentPropsWithoutRef<"div">) {
  return <div className={cx("type-meta rounded-md px-3.5 py-2.5", tones[tone], className)} {...rest}/>;
}
