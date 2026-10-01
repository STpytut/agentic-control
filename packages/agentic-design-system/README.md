# Agentic design system

Tokens, CSS and React components shared by every Agentic product —
Agentic Marketing, Agentic Lab and whatever ships next. The brand is deliberately quiet: a warm paper ground, ink type,
hairlines instead of shadows, and one loud accent (`#c8ff3d`) used sparingly.

- **Figma library:** [Agentic Design System](https://www.figma.com/design/y4oi3UylkaIMLWuDmCi5a4)
- **Principles:** [docs/principles.md](docs/principles.md) — read before designing a new screen
- **Migrating a product:** [docs/migration.md](docs/migration.md)

## What is in the box

```
tokens/tokens.json        single source of truth (edit this)
tokens/tokens.flat.json   generated: one row per token, with its Figma name
css/index.css             Tailwind v4 entry  → @agentic/design-system/tailwind.css
css/tokens.css            generated: the same variables as plain CSS
css/fonts.css             @font-face for the self-hosted variable fonts
css/base.css              element defaults (body, headings, focus, selection)
css/utilities.css         link-underline, highlight-accent, reveal
fonts/                    Inter + Space Grotesk + JetBrains Mono variable woff2
src/                      React components (TypeScript source)
site/                     the design-system site: foundations, components, patterns
```

## Use it in a product (Next.js + Tailwind v4)

```bash
npm install github:STpytut/ads             # or: file:../agentic-design-system
```

```js
// next.config.mjs — the package ships TypeScript source
export default { transpilePackages: ["@agentic/design-system"] };
```

```css
/* app/globals.css */
@import "tailwindcss";
@import "@agentic/design-system/tailwind.css";
```

That is the whole setup. The entry registers its own `@source`, so classes used
inside the components are generated without extra configuration.

```tsx
import Link from "next/link";
import { Button, ButtonLink, Badge, Card, Field, TextInput, Logo } from "@agentic/design-system";

<Logo product="lab" size="sm" />
<ButtonLink as={Link} href="/experiments/new">New experiment</ButtonLink>
<Badge tone="danger" dot>Failed</Badge>
```

Router links are passed with `as={Link}`; the package has no Next.js dependency.

### Fonts

`css/fonts.css` serves the fonts from the package. If you prefer `next/font`,
load the same files and expose `--font-body` / `--font-heading` on `<html>` —
the theme picks those up first:

```ts
const body = localFont({ src: "../node_modules/@agentic/design-system/fonts/Inter-Variable.woff2", variable: "--font-body", weight: "100 900" });
const heading = localFont({ src: "../node_modules/@agentic/design-system/fonts/SpaceGrotesk-Variable.woff2", variable: "--font-heading", weight: "300 700" });
```

### Without Tailwind

```css
@import "@agentic/design-system/fonts.css";
@import "@agentic/design-system/tokens.css";
@import "@agentic/design-system/base.css";
@import "@agentic/design-system/utilities.css";
```

You get every `--color-*`, `--radius-*`, `--space-*`, `--size-*` variable, the
dark scope and the `.type-*` classes. The React components need Tailwind.

### Machine text

Identifiers, logs, JSON, tool arguments and token counts use JetBrains Mono
through `--font-mono` and the `.type-mono-*` classes. The file is only fetched
by a page that actually renders monospace, so a marketing page never pays for
it. `.type-id` is machine text too — an identifier should not read as prose.

## Dark surfaces

Any subtree switches palette with one attribute. Components need no `tone` prop:

```html
<footer data-theme="dark">…</footer>
```

In Figma, the file is on a Starter plan (one mode per collection), so dark
values live next to the light ones as `on-dark/*` variables. Their code syntax
points at the same CSS variable — inside `[data-theme="dark"]` it resolves to
the dark value.

## Tokens

| Group | Examples | Tailwind |
|---|---|---|
| Colour | `canvas` `ink` `muted` `accent` `line` `line-strong` `wash` `inverse` | `bg-canvas text-ink border-line` |
| Status | `success` `warning` `danger` `info` + `*-soft` fills | `bg-danger-soft text-danger` |
| Radius | `xs 6` `sm 8` `md 10` `lg 14` | `rounded-md` |
| Type | marketing `type-h1…type-small` (fluid), app `type-page-title…type-id` (fixed), machine `type-mono-body/small/id/code`, `type-eyebrow` | classes |
| Motion | `ease-out` `duration-fast/base/slow/reveal` | `ease-out duration-200` |
| Shadow | `popover` only | `shadow-popover` |

Change a token:

1. edit `tokens/tokens.json`;
2. `npm run build:tokens` (CI runs `npm run check`, which fails on stale output);
3. update the matching variable in Figma — every variable's description and
   code syntax name the CSS variable it mirrors.

## Components

| Component | Notes |
|---|---|
| `Button`, `ButtonLink`, `buttonClasses()` | `primary` `secondary` `accent` × `sm 36` `md 40` `lg 48` `xl 56` |
| `Badge` | `neutral` `active` `attention` `success` `warning` `danger` `info`, optional `dot` |
| `Card` | hairline surface, `interactive` darkens the border |
| `Field`, `TextInput`, `Textarea`, `Select`, `Checkbox`, `controlClasses()` | label above, hint below, error last |
| `PageHeader`, `SectionHeading`, `Container`, `EmptyState` | app and marketing page structure |
| `Tabs`, `NavItem`, `Menu`, `MenuItem`, `Chip`, `Divider` | navigation and small parts |
| `Skeleton`, `SkeletonLine` | loading placeholders |
| `Logo`, `LogoMark`, `DataGraphic` | brand |
| `Reveal` | scroll reveal, off under reduced motion |

Behaviour that depends on a product (focus traps, open state, routing) stays in
the product; the package owns the look.

## The site

```bash
npm run site        # → site/dist/index.html
```

A static page with no client JavaScript: foundations, every component with what
to use it for and what not to, and the patterns worth repeating. It imports the
real components and reads `tokens/tokens.flat.json`, so it cannot describe a
system other than the one that ships — and building it exercises the Tailwind
entry, which is how a broken `@source`, `@theme` or import shows up before a
product finds it.

If the page and a product disagree, the package is right and the page is a bug.
