import { cx } from "@agentic/design-system";
import { resetText, windowLabel, windowTone, type UsageWindow } from "@/lib/usage";

// One subscription window: its name, the percentage used as a bar and as
// text (never by colour alone), and when it resets. A window whose reset has
// passed since the reading is shown muted, with that said. A candidate for the
// design system: it has a progress meter in neither Figma nor the package.
const fill = { success: "bg-success", warning: "bg-warning", danger: "bg-danger", neutral: "bg-line-strong" } as const;

export function UsageWindowBar({ window, now, compact = false }: { window: UsageWindow; now: number; compact?: boolean }) {
  const tone = windowTone(window);
  const label = windowLabel(window);
  const percent = Math.round(window.usedPercent * 10) / 10;
  return (
    <div className="grid min-w-0 gap-1">
      <div className="type-meta flex min-w-0 items-baseline justify-between gap-2">
        <span className={cx("truncate", compact ? "text-muted" : "font-medium")}>{label}</span>
        <span className={cx("shrink-0 tabular-nums", window.resetPassed && "text-muted")}>{percent} % used</span>
      </div>
      <div
        role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
        aria-valuetext={`${percent} % used, ${resetText(window, now)}`}
        className={cx("h-1.5 w-full overflow-hidden rounded-full bg-wash", compact ? "" : "h-2")}
      >
        <div className={cx("h-full rounded-full", fill[tone])} style={{ width: `${Math.max(percent, percent > 0 ? 2 : 0)}%` }}/>
      </div>
      {!compact && <p className="type-meta m-0 text-muted">{resetText(window, now)}</p>}
    </div>
  );
}
