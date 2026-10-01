import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { cx } from "../lib/cx";

export type ButtonVariant = "primary" | "secondary" | "accent";
export type ButtonSize = "sm" | "md" | "lg" | "xl";

const base =
  "touch-target inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap " +
  "transition-[background-color,color,border-color,transform] duration-200 ease-out " +
  "active:translate-y-px disabled:pointer-events-none disabled:opacity-60 " +
  "aria-disabled:pointer-events-none aria-disabled:opacity-60";

/* Heights are fixed so a button, an input and a select line up in one row.
   sm/md are application controls; lg/xl are marketing CTAs. */
const sizes: Record<ButtonSize, string> = {
  sm: "h-9 px-3.5 text-[0.875rem]",
  md: "h-10 px-4 text-[0.9375rem]",
  lg: "h-12 px-5 text-[0.9375rem]",
  xl: "h-14 px-7 text-base sm:text-[1.0625rem]",
};

/* The brand move: ink controls flip to the accent on hover, and the accent
   control flips to ink. */
const variants: Record<ButtonVariant, string> = {
  primary: "bg-ink text-on-ink hover:bg-accent hover:text-on-accent",
  secondary:
    "border border-line-strong bg-transparent text-ink hover:border-ink hover:bg-ink hover:text-on-ink",
  accent: "bg-accent text-on-accent hover:bg-ink hover:text-accent",
};

export type ButtonStyleProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

/** Class recipe, for elements the components below do not cover. */
export function buttonClasses({ variant = "primary", size = "md" }: ButtonStyleProps = {}) {
  return cx(base, sizes[size], variants[variant]);
}

type ButtonProps = ButtonStyleProps & ComponentPropsWithoutRef<"button"> & { children: ReactNode };

export function Button({ variant, size, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cx(buttonClasses({ variant, size }), className)} {...rest} />;
}

type ButtonLinkProps = ButtonStyleProps &
  ComponentPropsWithoutRef<"a"> & {
    /** Router link component, e.g. `next/link`. Defaults to a plain anchor. */
    as?: ElementType;
    href: string;
    children: ReactNode;
  };

export function ButtonLink({ as: Tag = "a", variant, size, className, ...rest }: ButtonLinkProps) {
  return <Tag className={cx(buttonClasses({ variant, size }), className)} {...rest} />;
}
