import type { ComponentPropsWithoutRef, ElementType } from "react";
import { cx } from "../lib/cx";

type CardProps = ComponentPropsWithoutRef<"div"> & {
  as?: ElementType;
  /** Interactive cards darken their hairline on hover instead of lifting. */
  interactive?: boolean;
};

/** Hairline-bordered surface. No drop shadow — hierarchy comes from borders and spacing. */
export function Card({ as: Tag = "div", interactive = false, className, ...rest }: CardProps) {
  return (
    <Tag
      className={cx(
        "rounded-lg border border-line bg-canvas p-4 sm:p-5",
        interactive && "transition-colors duration-200 hover:border-line-strong",
        className,
      )}
      {...rest}
    />
  );
}
