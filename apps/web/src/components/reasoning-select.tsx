"use client";

import { Select, cx } from "@agentic/design-system";
import { defaultReasoningLabel, type ReasoningLevel } from "@/lib/reasoning";

// The level select that sits next to a model select (Stage 12): the model's
// own levels, with "Default" — send nothing — first. Renders nothing for a
// model that offers no level, so a row keeps its width for the model.
//
// Built on the design system's Select (40 px high, a full touch target); a
// candidate for the design system as a paired "model + option" control.
const short = (text: string) => (text.length > 44 ? `${text.slice(0, 43)}…` : text);

export function ReasoningSelect({ id, levels, defaultLevel = null, value, onChange, disabled = false, className, label = "Reasoning level" }: {
  id: string; levels: ReasoningLevel[]; defaultLevel?: string | null; value: string;
  onChange: (value: string) => void; disabled?: boolean; className?: string; label?: string;
}) {
  if (!levels.length) return null;
  const known = !value || levels.some((level) => level.level === value);
  // The width is the wrapper's: the Select itself is always full width.
  return <div className={cx("min-w-0", className)}><Select id={id} aria-label={label} value={value} disabled={disabled}
    onChange={(event) => onChange(event.target.value)}>
    <option value="">{defaultReasoningLabel(defaultLevel)}</option>
    {levels.map((level) => <option key={level.level} value={level.level} title={level.description}>
      {level.description ? `${level.level} — ${short(level.description)}` : level.level}
    </option>)}
    {!known && <option value={value} disabled>{value} (no longer offered)</option>}
  </Select></div>;
}
