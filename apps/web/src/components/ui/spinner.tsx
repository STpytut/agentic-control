import { cx } from "@agentic/design-system";

// A small ring that turns while a request or a check is under way, in the
// current colour. Decorative: the words beside it ("Pinning…", "checking… 18 s")
// carry the state, and it stops under prefers-reduced-motion. Built here on
// the package's tokens; a candidate for @agentic/design-system.
export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx("inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-r-transparent motion-reduce:animate-none", className)}/>;
}
