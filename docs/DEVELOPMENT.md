# Developing Agentic Control

How the repository is laid out, how to run its checks, and where the design
lives. To install the platform on a server, see the [README](../README.md#install).

## Names

The product is **Agentic Control**. Inside the system it is still called
`infra-cod`: the CLI (`infra-cod doctor`), the systemd units
(`infra-cod-*.service`), the paths (`/opt/infra-cod`, `/etc/infra-cod`) and the
database (`infra_cod`). Both names mean the same thing.

## Layout

| Path | What it is |
| --- | --- |
| `apps/web` | The panel: Next.js, served as a standalone build behind Caddy. |
| `packages/agentic-design-system` | The design system the panel and the website share. |
| `services/control-plane` | The workers: dispatcher, reconciler, orchestrator, implementation, GitHub App broker, account brokers, model checks. Each is a systemd unit. |
| `services/runtime-supervisor` | The only process that launches agents. It owns the runtime drivers (Codex, Claude Code, OpenCode), their sandboxes and the tool sockets. |
| `services/operations` | Installer support, `infra-cod update` and `rollback`, backups and restore drills, `doctor`, runtime installation and qualification. |
| `services/cli` | The `infra-cod` command. |
| `db/migrations`, `db/tests` | The PostgreSQL schema as numbered migrations, and SQL tests that run inside a rolled-back transaction. |
| `deploy` | `install.sh`, `get.sh`, systemd units, Caddy, AppArmor, tmpfiles. |
| `release`, `scripts` | The release format, its signing key, and the build and verification scripts. |
| `pocs` | The proofs of concept the runtime drivers cite as evidence. See [pocs/README.md](../pocs/README.md). |

## Running the checks

Every suite runs in a Linux container from the committed `HEAD`, so commit
first:

```bash
scripts/run-suites-in-container.sh
```

It runs lint, the unit suites, the installer and update harnesses, and the SQL
and integration suites against a disposable PostgreSQL 17. CI on GitHub runs
the same suites, plus a full install on a clean Ubuntu 24.04 runner.

The panel's type check and lint run on the host:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
```

The release build requires Node 24.20.0 exactly. On another version, build in
a container; [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) has the command.

## Conventions

- **A database change** is a new numbered migration, a test in `db/tests`, and
  an entry in `db/schema-compatibility.json`. A function the panel calls is
  listed in the web role's allowlist (`db/tests/0026`).
- **A refusal** names a reason from the `failure_reasons` vocabulary.
- **A worker's wait** takes the service's stop signal (`waitForPoll`), so a
  restart never has to kill it.
- **Comments say why.** A rule that came from a production incident names it.

## Design documents

Written in English or in Russian, as marked.

| Document | Language | About |
| --- | --- | --- |
| [PRODUCT_SPEC](PRODUCT_SPEC.md) | ru | Concept, roles, scenarios, the product's boundaries |
| [MVP_SPEC](MVP_SPEC.md) | ru | What version 1 contains and how it is accepted |
| [ARCHITECTURE](ARCHITECTURE.md) | ru | Components, workspaces, sessions, locks, recovery |
| [RUNTIME_CONTRACT](RUNTIME_CONTRACT.md) | ru | What a runtime adapter must provide |
| [CAPABILITY_MATRIX](CAPABILITY_MATRIX.md) | ru | Verified capabilities of each runtime |
| [EVENTS](EVENTS.md) | ru | Workflow, events, idempotency, retries |
| [DATA_MODEL](DATA_MODEL.md) | ru | Entities, states and invariants |
| [SECURITY](SECURITY.md) | ru | Authority, credentials, approvals, audit |
| [OPERATIONS](OPERATIONS.md) | ru | The host, processes, backups, updates, recovery |
| [SELF_HOSTED_BASELINE](SELF_HOSTED_BASELINE.md) | ru | The single-host foundation |
| [OPEN_QUESTIONS](OPEN_QUESTIONS.md) | ru | Hypotheses still to validate |
| [RUNTIMES_AND_MODELS_DESIGN](RUNTIMES_AND_MODELS_DESIGN.md) | en | Model catalog, checks and runtime updates |
| [ISSUE_INTAKE_DESIGN](ISSUE_INTAKE_DESIGN.md) | en | GitHub issues as chats |
| [RELEASE_FORMAT](RELEASE_FORMAT.md) | en | The artifact, its manifest and verification |
| [RELEASE_RUNBOOK](RELEASE_RUNBOOK.md) | en | Building, signing and publishing a release |
| [DELIVERY_PIPELINE](DELIVERY_PIPELINE.md) | en | How changes are checked without depending on CI |
| [GIT_WORKFLOW](GIT_WORKFLOW.md) | en | Branches, pull requests, tags |
| [SPEC_CHANGELOG](SPEC_CHANGELOG.md) | en | How the specification changed |

Architecture decisions are in [adr/](adr/README.md). When documents disagree,
an accepted ADR wins.
