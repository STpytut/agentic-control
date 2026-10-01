import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "../lib/cx";

type FieldProps = {
  label: string;
  htmlFor: string;
  /** Explains the field where it is not self-evident. */
  hint?: string;
  error?: string;
  /** Rendered after the label, e.g. "(optional)". */
  labelSuffix?: ReactNode;
  children: ReactNode;
  className?: string;
};

/**
 * Label above the control, hint below it, error last — always visible, never
 * a placeholder-only label. Errors use the danger colour plus text.
 */
export function Field({ label, htmlFor, hint, error, labelSuffix, children, className }: FieldProps) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="type-meta mb-1.5 block font-medium text-ink">
        {label}
        {labelSuffix ? <span className="font-normal text-muted"> {labelSuffix}</span> : null}
      </label>
      {children}
      {hint ? (
        <p id={`${htmlFor}-hint`} className="type-meta mt-1.5 text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="type-meta mt-1.5 font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Shared control recipe. Exported for custom controls (comboboxes, date pickers). */
export function controlClasses(invalid = false) {
  return cx(
    "touch-target w-full rounded-md border bg-transparent px-3.5 text-[0.9375rem] text-ink",
    "placeholder:text-muted/70 transition-colors duration-200 focus:outline-none",
    "disabled:cursor-not-allowed disabled:opacity-60",
    invalid ? "border-danger" : "border-line-strong hover:border-ink/45 focus:border-ink",
  );
}

type InvalidProp = { invalid?: boolean };

export function TextInput({ invalid = false, className, ...rest }: InvalidProp & ComponentPropsWithoutRef<"input">) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cx(controlClasses(invalid), "h-10", className)}
      {...rest}
    />
  );
}

export function Textarea({
  invalid = false,
  className,
  rows = 4,
  ...rest
}: InvalidProp & ComponentPropsWithoutRef<"textarea">) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cx(controlClasses(invalid), "py-2.5 leading-relaxed", className)}
      {...rest}
    />
  );
}

export function Select({ invalid = false, className, children, ...rest }: InvalidProp & ComponentPropsWithoutRef<"select">) {
  return (
    <select
      aria-invalid={invalid || undefined}
      className={cx(controlClasses(invalid), "h-10", className)}
      {...rest}
    >
      {children}
    </select>
  );
}

type CheckboxProps = Omit<ComponentPropsWithoutRef<"input">, "type"> & {
  label: ReactNode;
  description?: ReactNode;
};

/** Native checkbox tinted with ink — keeps platform semantics and keyboard handling. */
export function Checkbox({ label, description, className, ...rest }: CheckboxProps) {
  return (
    <label className={cx("flex cursor-pointer items-start gap-3", className)}>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-ink)] disabled:opacity-50"
        {...rest}
      />
      <span>
        <span className="block text-[0.875rem] font-medium">{label}</span>
        {description ? <span className="type-meta block text-muted">{description}</span> : null}
      </span>
    </label>
  );
}
