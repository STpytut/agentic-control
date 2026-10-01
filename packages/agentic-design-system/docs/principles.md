# Principles

Rules distilled from Agentic Marketing and Agentic Lab. They are what makes a
new product read as part of the family — keep them unless you have a reason
you can write down.

## Colour

- **Paper, ink, one accent.** `canvas #f4f3ef` is the ground, `ink #111111` the
  type and the primary control. `accent #c8ff3d` is the only saturated colour
  in the brand.
- **The accent is a fill, never body text on paper.** It fails contrast there.
  Use it for the primary-button hover, the attention badge, text selection and
  the centre node of the mark. On dark surfaces it may be text (`accent-text`).
- **The signature interaction:** ink controls flip to the accent on hover; the
  accent control flips to ink.
- **Status colours are for status only** — `success`, `warning`, `danger`,
  `info`, each with a `*-soft` fill. They are muted on purpose so the accent
  stays the loudest thing on screen. Status is never carried by colour alone:
  every badge has a text label.
- **Dark is a surface, not a separate brand.** Use `data-theme="dark"` for
  footers, contact sections and dense operational panels.

## Type

- **Space Grotesk 500 for headings, Inter for everything else.** Headings never
  go bolder than 500; hierarchy comes from size and tracking (−0.025em to −0.03em).
- **Two scales, on purpose.** Marketing type is fluid (`type-h1` … `type-small`)
  and tightly leaded (0.98). Application type is fixed (`type-page-title` …
  `type-meta`) and looser (1.1–1.5) — dense screens need predictable sizes.
- **Eyebrows** (`type-eyebrow`, 12px, +0.14em, uppercase) introduce sections.
  In marketing they sit on a hairline rule.
- **Machine text is monospace.** JetBrains Mono, through `type-mono-body`,
  `type-mono-small`, `type-mono-id` and `type-mono-code`, carries identifiers,
  logs, JSON, tool arguments and token counts — anything a machine wrote or a
  person will compare character by character. `type-id` (EXP-042) is part of
  that family, with tabular numerals.
- Mono sits two steps below the sans body (13px against 15px): monospace reads
  larger at the same nominal size.
- Keep measure short: `max-w-[46ch]` for leads, `max-w-[60ch]` for body.

## Surfaces and depth

- **Hairlines, not shadows.** Cards are `border-line` on `canvas`. Only floating
  layers (menus, popovers, the consent banner) get `shadow-popover`.
- **Shape grammar.** A radius is a token, never a number that looked right:
  controls `md 10`, cards and popovers `lg 14`, badges and menu items `sm 8`,
  skeleton bars `xs 6`. The audit enforces this on every component; the only
  exemption is geometry the platform owns, such as the native checkbox, and it
  has to be named `(native shape)` to be skipped.
- Empty states use a dashed `line-strong` border and operational copy that says
  what to do next — never "Nothing here yet".

## Layout

- Marketing: 1280px column, gutters 20 / 32 / 64, sections 80–128px apart.
- Application: 240px sidebar rail, 60px sticky top bar (hairline and
  translucent canvas, nothing more), 1440px main column.
- Controls share heights so they align in a row: 36 (`sm`) and 40 (`md`) in
  applications, 48 and 56 for marketing CTAs.

## Motion

- One curve: `cubic-bezier(0.16, 1, 0.3, 1)`. 150ms for colour-only changes,
  200ms for controls, 350ms for underline reveals, 700ms for scroll reveals.
- Buttons press down 1px (`active:translate-y-px`); nothing lifts on hover.
- Everything honours `prefers-reduced-motion`.

## Accessibility

- Every colour pair used for text meets WCAG AA. Status foregrounds are ≥ 5:1
  on paper and on their soft fill; ≥ 8:1 on dark.
- Focus is always visible: 2px ink ring, 3px offset; accent on dark.
- **Touch targets grow, but only where a finger is used.** 36px and 40px
  controls are right for a mouse and too small for a thumb, so `.touch-target`
  raises them to 44px under `@media (pointer: coarse)`. Desktop layouts are
  untouched. Every interactive component in the package already carries it.
- Labels sit above fields and are always visible; errors are text, announced
  with `role="alert"`.
- The first tab stop in an application shell is "Skip to content".
