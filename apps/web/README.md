# infra-cod web

The Next.js control-plane panel. It is one process in the self-hosted stack:

```text
browser ──HTTPS──▶ Caddy ──▶ 127.0.0.1:3100 (this app, standalone)
                                │
                                ▼
                    PostgreSQL 17 over the Unix socket,
                    peer authentication, role `infra_web`
```

It is not deployed to a hosting platform and it does not use a hosted database.
There is no Vercel project, no Supabase project, and no build-time public
configuration: one standalone artifact is installed on whatever domain the
operator runs, and the domain is read at runtime.

## Local development

```bash
pnpm install
npm run web:dev          # from the repository root
```

The panel expects a database. Local development uses the connection URL in
`.env.local`; see the root `.env.example` for the two files Next.js reads and why
they are two.

## Production: the standalone tree

`next.config.ts` sets `output: "standalone"`. The build produces a directory that
runs with nothing but a Node binary, which is what makes `node server.js` possible
without a package manager or a network connection at boot.

Two things the standalone output deliberately does **not** contain, and which the
staging script puts back:

- `public/` and `.next/static` — without them the server starts, renders HTML, and
  404s every asset the HTML references;
- the flattened entry point — the trace root is the monorepo, so the entry point is
  `apps/web/server.js` inside the staged tree, not `server.js` at its top.

```bash
npm run stage:standalone -- --out /tmp/infra-cod-stage
# reads /tmp/infra-cod-stage/receipt.json for the entry point that was produced
```

`scripts/stage-standalone.mjs` builds, materialises the traced tree with its
pnpm symlinks intact, copies the static directories beside the server that reads
them, refuses to stage an environment file or a private key, checks that no
symlink points outside the tree, and writes a receipt naming the entry point. It
is not a release artifact: there is no tarball, no signature and no version
switch.

`npm run test:standalone` starts the staged tree on a random loopback port
against a temporary database and exercises the real production build: `/login`,
the anonymous redirect, the full sign-in and forced-password-change flow, the
static assets the HTML references, a restart that must preserve the session,
SIGTERM with no orphan, and the startup refusals. It also proves the server booted
without any package manager on `PATH`.

## Environment

Read at runtime, from the environment the systemd unit provides:

| Variable | Meaning |
| --- | --- |
| `PGHOST` | `/var/run/postgresql` in production. Explicit because `PrivateTmp=true` gives the unit a private `/tmp`. |
| `PGUSER` | `infra_web`. Set by the unit, never shared. |
| `PGDATABASE` | `infra_cod`. |
| `DATABASE_URL` | Development and CI only. Unset in production, where peer authentication replaces it. |
| `INFRA_COD_SITE_URL` | The panel's public origin. Required in production and must be `https://`. |
| `INFRA_COD_AUTH_PEPPER` | Keys password hashes and the client-address digests. Never regenerate. |
| `GITHUB_OAUTH_CODE_ENCRYPTION_KEY` | Encrypts one-time OAuth codes before they are persisted. |
| `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID` | Not secret; the slug builds the install URL. |
| `INFRA_COD_INSECURE_COOKIES` | Development only. A production build refuses to serve with it. |

`INFRA_COD_SITE_URL` is deliberately **not** `NEXT_PUBLIC_*`. That prefix marks a
value inlined at build time, which would bind one artifact to one domain and force
a rebuild to change it. It is read only on the server, so nothing is lost.

In production the panel refuses to start when the origin is missing or is not
`https://`, rather than deriving it from the request's `Host` header: behind Caddy
that header is attacker-controlled, and a panel that accepted it would accept
cross-origin mutations from anyone who could reach it.

## Authentication

Local operator accounts only. Passwords are Argon2id; sessions are opaque,
server-side and stored as SHA-256 digests; the first sign-in is fenced to a forced
password change. Credential mutation and its `auth.*` audit row are one
`SECURITY DEFINER` function call, and the web role has no DML on any
authentication table — it cannot read a password hash or write a session except
through the functions that validate what they are given. See
`docs/adr/0011-self-hosted-access-model.md`.

## Checks

```bash
npm run lint
npm run typecheck
npm run build
npm run test:standalone     # from the repository root; starts the built server
```

Do not run `npm run check` while `npm run web:dev` is running: Next 16 locks the
project directory and the build will fail rather than wait.
