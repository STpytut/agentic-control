# Migrating a product

The token names are the ones Agentic Marketing and Agentic Lab already use
(`canvas`, `ink`, `muted`, `accent`, `line`, `line-strong`, `ink-dark`,
`line-dark`), so most class names keep working. What changes is where they
come from.

## Common steps

1. Install the package and add `transpilePackages` (see README).
2. Replace the product's `@theme` block, base layer and `.type-*` utilities in
   `globals.css` with `@import "@agentic/design-system/tailwind.css";`.
3. Delete `app/fonts/*` and either rely on `css/fonts.css` or point
   `next/font/local` at the package's `fonts/` directory.
4. Replace local `components/ui/*` and `components/brand/*` with package
   imports, one component at a time; pass `as={Link}` wherever the old
   component used `next/link` internally.
5. Run the product's e2e suite and compare screens.

## Agentic Marketing (site_marc)

| Before | After |
|---|---|
| `<Button size="md">` | `<Button size="lg">` (48px) |
| `<Button size="lg">` | `<Button size="xl">` (56px) |
| `variant="ghost"` (accent fill) | `variant="accent"` |
| `<Logo tone="dark" />` | `<Logo product="marketing" />` inside `data-theme="dark"` |
| `<SectionHeading tone="dark">` | `<SectionHeading>` inside `data-theme="dark"` |
| `Container` | `Container` (default `width="marketing"`) |
| service tags | `Chip` |
| hover highlighter in `ServiceCard` | `className="highlight-accent"` inside a `.group` |
| `scroll-behavior: smooth` on `html` | keep in the product — it is a site choice, not a brand rule |

The footer and contact section can stay on `.on-dark` with constant colours;
move them to `data-theme="dark"` when convenient.

## Agentic Lab (agentic_lab)

| Before | After |
|---|---|
| `type-body` | `type-app-body` (`type-body` is the marketing fluid size) |
| `Button` default `size="sm"` | pass `size="sm"` explicitly — the package default is `md` |
| `<Logo />` | `<Logo product="lab" size="sm" />` |
| `ViewTabs` | `Tabs as={Link}` |
| sidebar links | `NavItem as={Link}` |
| QuickAdd panel | `Menu` + `MenuItem as={Link}` (keep the focus trap in the product) |
| error text in ink | `Field` now uses `text-danger`; invalid borders use `border-danger` |

## Agentic control plane (infra_cod/apps/web)

This app predates the brand: it uses a blue SaaS palette (`--blue #3458d4`,
navy sidebar) and hand-written CSS classes. Migrate in this order:

1. Import the Tailwind entry next to the existing stylesheet; nothing changes yet.
2. Swap the ground and type: `--canvas`/`--ink` → package tokens. Replace
   `--blue` actions with `Button variant="primary"`.
3. Replace the navy sidebar with the 240px paper rail and `NavItem`
   (active = ink fill), the logo with `<Logo product="control" size="sm" />`.
4. Map provisioning pills to `Badge`: ready → `success`, pending/provisioning →
   `warning`, failed → `danger`, queued → `info`, running → `active`.
5. Replace cards with `Card` (drop the shadows), forms with `Field` + controls.
6. Delete the old variables once nothing references them.
