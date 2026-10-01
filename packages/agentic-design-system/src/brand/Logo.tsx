import { cx } from "../lib/cx";

type LogoMarkProps = {
  className?: string;
  /** Colour of the central node; the rest inherits currentColor. */
  accent?: string;
  title?: string;
};

/**
 * Abstract agent mark: one decision node at the centre, three connected
 * signals around it. Reads at 16px (favicon) and at poster size.
 */
export function LogoMark({ className, accent = "currentColor", title }: LogoMarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M16 16 L16 5.5" />
        <path d="M16 16 L25.1 21.25" />
        <path d="M16 16 L6.9 21.25" />
      </g>
      <g fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="16" cy="4.4" r="2.6" />
        <circle cx="26.1" cy="22" r="2.6" />
        <circle cx="5.9" cy="22" r="2.6" />
      </g>
      <circle cx="16" cy="16" r="3.6" fill={accent} />
    </svg>
  );
}

type LogoProps = {
  /** Product word after "agentic°": "marketing", "lab", "control". */
  product: string;
  /** `md` for marketing headers, `sm` for application sidebars. */
  size?: "sm" | "md";
  className?: string;
  /** Accessible name; defaults to "Agentic <Product>". */
  label?: string;
};

/**
 * Ecosystem lockup: the shared mark plus lowercase "agentic°" and the product
 * word. On a dark subtree the centre node and the degree sign turn accent via
 * --color-accent-text, so there is no tone prop to forget.
 */
export function Logo({ product, size = "md", className, label }: LogoProps) {
  const name = label ?? `Agentic ${product.charAt(0).toUpperCase()}${product.slice(1)}`;
  return (
    <span className={cx("inline-flex items-center gap-2.5 text-ink", className)} aria-label={name} role="img">
      <LogoMark
        className={size === "md" ? "h-[26px] w-[26px] shrink-0" : "h-[22px] w-[22px] shrink-0"}
        accent="var(--color-accent-text)"
      />
      <span
        aria-hidden="true"
        className={cx(
          "font-display leading-none font-medium tracking-[-0.035em] whitespace-nowrap",
          size === "md" ? "text-[1.0625rem]" : "text-[1rem]",
        )}
      >
        agentic<span className="text-accent-text">°</span> {product}
      </span>
    </span>
  );
}
