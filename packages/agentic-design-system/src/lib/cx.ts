/** Joins class names, skipping falsy values. Deliberately tiny: the design
 *  system does not depend on clsx or tailwind-merge. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
