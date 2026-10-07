# Production unit contract

What each unit runs as, which PostgreSQL role it authenticates as, what it may
write, and what it must be able to reach. This is the document Stage 2
(`setup-postgresql-production.sh`) and the Stage 10 installer have to satisfy; it
is also what the static check in `services/control-plane/test/systemd-contract.test.mjs`
enforces, so a unit that drifts from it fails a test rather than a deploy.

The PostgreSQL part of this contract was executed on Ubuntu 24.04 on 2026-09-12:
`17/main:5432`, every positive and negative peer mapping, all 46 migrations, a
second no-op migration run, and the encrypted backup/isolated restore drill
passed. The unit files themselves have not yet been installed by Stage 10, so
that result proves the database boundary, not the complete service stack.

## The rule

Production authenticates by **peer** over the Unix socket. There is no password
and no connection string anywhere: the OS user a process runs as is mapped to the
database role it may become in `pg_ident.conf`, and `pg_hba.conf` carries
`local all all peer map=infra_cod_map` plus an explicit `reject` for
`host 127.0.0.1/32` and `::1/128`. A process cannot pick a role that is not
mapped to its OS user, which is what makes the web/worker boundary real rather
than declarative.

`root` is the one application OS account that appears more than once, and it does not weaken
the rule: root can already `su` to any user, so a mapping grants it nothing it
did not have. The boundary that matters is between the two *unprivileged* peers —
the panel cannot become a worker, and a runtime agent user cannot reach the
database at all.

## Matrix

| Unit | OS user | `PGUSER` | DB access | Writable paths (beyond systemd-managed dirs) | Sockets | Secrets read | Depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `infra-cod-web.service` | `infra-web` | `infra_web` | EXECUTE on the audited function surface + column-limited SELECT; no DML on any auth table | `StateDirectory=infra-web`, `CacheDirectory=infra-web` | — | `/etc/infra-cod/web.env` (root:infra-web 0640) | `postgresql@17-main`, `network-online` |
| `infra-cod-dispatcher.service` | `infra-control` | `infra_worker` | full DML (`infra_worker`) | none | — | `database.env` | `postgresql@17-main` |
| `infra-cod-reconciler.service` | `infra-control` | `infra_worker` | full DML | none | — | `database.env` | `postgresql@17-main` |
| `infra-cod-orchestrator-worker.service` | `infra-control` | `infra_worker` | full DML | none | runtime supervisor (in) | `database.env` | `postgresql@17-main`, supervisor |
| `infra-cod-implementation-worker.service` | `infra-control` | `infra_worker` | full DML | none | runtime supervisor (in) | `database.env` | `postgresql@17-main`, supervisor |
| `infra-cod-codex-account-worker.service` | `infra-control` | `infra_worker` | full DML | none | runtime supervisor (in) | `database.env` | `postgresql@17-main`, supervisor |
| `infra-cod-opencode-account-worker.service` | `infra-control` | `infra_worker` | full DML | none | runtime supervisor (in) | `database.env`, `/etc/infra-cod/opencode/broker-private.pem` (read) | `postgresql@17-main`, supervisor |
| `infra-cod-telegram-notifier.service` (0140: sends the operator's Telegram messages; the broker's user because the bot token arrives as a broker envelope) | `infra-control` | `infra_worker` | its notifier functions only: the connections it serves and the outbox | none | — | `database.env`, `caddy.env` (for `INFRA_COD_DOMAIN`), `/etc/infra-cod/opencode/broker-private.pem` (read) | `postgresql@17-main`, `network-online` |
| `infra-cod-catalog-refresh-worker.service` | `infra-control` | `infra_worker` | full DML | none | — | `database.env` | `postgresql@17-main` |
| `infra-cod-catalog-gate-worker.service` (the model check lane since Stage 12 W6: `LISTEN model_checks`, one check at a time) | `infra-control` | `infra_worker` | full DML; its own `LISTEN` connection | `/srv/infra-cod/gate-smoke` | runtime supervisor (in) | `database.env` | `postgresql@17-main`, supervisor |
| `infra-cod-project-provisioner.service` | `infra-control` | `infra_worker` | full DML | **none** — it coordinates only | runtime supervisor (in) | `database.env` | `postgresql@17-main`, supervisor |
| `infra-cod-project-deprovision-worker.service` | `infra-control` | `infra_worker` | full DML | none | runtime supervisor (in) | `database.env` | `postgresql@17-main`, supervisor |
| `infra-cod-github-app-worker.service` | `infra-cod-github` | `infra_worker` | full DML | `/srv/infra-cod/workspaces` (clone staging) | github broker (own), runtime supervisor (in) | `database.env`, `github-app.env`, `/etc/infra-cod/github-app/private-key.pem` (read) | `postgresql@17-main`, supervisor |
| `infra-cod-runtime-supervisor.service` | `root` | `infra_worker` | full DML (workspace operations, leases) | workspaces, gate-smoke, `/home/codex-worker/.codex`, `/home/opencode-worker/.local`, `/etc/infra-cod/github-deploy-keys`; its own cgroup subtree (`Delegate=yes`), one leaf per run | creates all three supervisor sockets | `database.env` | `postgresql@17-main` |
| `infra-cod-offsite-backup.service` (0141: started by the backup on success; uploads the encrypted backup to the owner's bucket) | `root` | `infra_worker` | its upload functions only | none (reads `/var/lib/infra-cod-backups`) | — | `database.env`, `/etc/infra-cod/opencode/broker-private.pem` (read) | `postgresql@17-main`, `network-online` |
| `infra-cod-backup.service` | `root` | `infra_backup` | `pg_dump` of `control_plane` + read models, read as `infra_backup` | `/var/lib/infra-cod-backups` | — | `database.env`, `/etc/infra-cod/backup.passphrase` (read) | `postgresql@17-main` |
| `infra-cod-restore-drill.service` | `root`, dropping to `infra-control` for its clients | `infra_control` | owns and inspects the throwaway database in the restore cluster only | `/var/lib/infra-cod-backups` | — | backup passphrase (read) | `postgresql@17-restore`, backup |
| `infra-cod-health.service` | `root` | `infra_worker` | credential status + retirement records, alerts | `/var/lib/infra-control/observability`, `/etc/infra-cod` (retirement only) | — | `database.env` | `postgresql@17-main` |
| `infra-cod-runtime-watch.service` | `root` | `infra_worker` | `record_runtime_watch` only | none | — | `database.env`; reads `/etc/infra-cod/runtimes.json`; the npm registry over HTTPS (metadata only) | `postgresql@17-main` |
| `infra-cod-runtime-probation.service` | `root` | `infra_worker` | `runtime_probation_verdict`, `end_runtime_probation`, `record_runtime_activation` | none | — | `database.env`; `/etc/infra-cod/runtimes.json`, `/usr/local/bin`, the runtime trees and homes (a rollback's switch and smoke test); the supervisor's fence socket | `postgresql@17-main`, `infra-cod-runtime-supervisor` |
| `infra-cod-caddy.service` | `caddy` | — | none | `StateDirectory=caddy` (ACME keys, certs), `LogsDirectory=caddy` (access log) | — | `/etc/infra-cod/caddy.env` (root:caddy 0640) | `network-online`, web |
| `codex-worker`, `opencode-worker`, future `claude-*` | runtime users | — | **no database access of any kind** | their own runtime directories | worker-tools socket (in) | provider credentials only | supervisor |

`PGUSER` for every one of these is set in the unit file, never in
`/etc/infra-cod/database.env`. That file carries only `PGHOST` and `PGDATABASE`.
Putting a role in the shared file would collapse the mapping: every client would
inherit whichever role the file named, and the peer check would still pass.

## Peer authentication: one configuration per cluster

`pg_hba.conf` and `pg_ident.conf` belong to a **cluster**, not to the host. The
production cluster and the restore cluster therefore have separate maps, and the
same OS user name can mean different things in each without either configuration
knowing about the other. Writing one map for both is how an earlier revision of
this document broke every production worker: it replaced
`infra-control → infra_worker` with `infra-control → infra_control`, which is a
role that exists only in the restore cluster.

### `17/main` — production (Stage 2)

```text
# pg_ident.conf:  local all all peer map=infra_cod_map
# MAPNAME        SYSTEM-USERNAME     PG-USERNAME
infra_cod_map    infra-web           infra_web
infra_cod_map    infra-control       infra_worker
infra_cod_map    infra-cod-github    infra_worker
infra_cod_map    postgres            postgres
infra_cod_map    root                infra_migrator
infra_cod_map    root                infra_worker
infra_cod_map    root                infra_backup
```

- **`infra-control  infra_worker`** is the one that carries almost the whole
  control plane: the dispatcher, the reconciler, the project provisioner, the
  deprovision worker, the chat/executor/account workers and the catalog workers
  all run as `infra-control` with `PGUSER=infra_worker`. There is no
  `infra_control` role in this cluster.
- **`root  infra_migrator`** is `migrate.mjs`, `infra-cod admin` and the one-shot
  install steps. `infra_migrator` owns the `control_plane` schema and everything
  the migrations create, so it is the role that can both apply DDL and run the
  administrative functions. Per ADR-0011 it is a production role; the
  administration commands do **not** use `infra_control`.
- **`root  infra_worker`** is the Runtime Supervisor: it has to be root to `chown`
  workspaces between runtime users and to create group-owned sockets, and it writes
  `workspace_operations`. `root infra_backup` is the backup's `pg_dump` and
  `psql`, which run in the root process on purpose (see below).
- **`infra-cod-github  infra_worker`** is correct despite the different name: the
  broker is a control-plane worker, not a distinct privilege tier. Its separation
  from the other workers is filesystem reach (workspace staging, the App private
  key), not database reach.
- **`postgres  postgres`** preserves the cluster owner's local administration
  path after the catch-all peer rule is installed. It grants no capability the
  OS account does not already have: `postgres` owns the cluster files and server
  process. Application units never run as this account.

There is deliberately **no `infra-control  infra_backup` mapping**. `backup.mjs`
runs its `pg_dump` and `psql` in the root process — no `runuser` — so the only
route to `infra_backup` is the root account. Mapping the unprivileged
`infra-control` account to it would hand a worker-tier user the backup role and
make the 1:1 rule decorative.

### `17/restore` — the isolated drill (created by `deploy/setup-postgresql-17-restore.sh`)

```text
# pg_ident.conf:  local all all peer map=infra_cod_restore_map
# MAPNAME                SYSTEM-USERNAME   PG-USERNAME
infra_cod_restore_map    infra-control     infra_control
infra_cod_restore_map    postgres          postgres
```

`infra_control` is a restore-cluster role: the drill's `createdb`, `psql` and
`pg_restore` clients drop to the `infra-control` OS user and assume it, and it owns
the throwaway database and its `extensions` schema.

The drill switches accounts mid-run, and the role has to switch with them: the
version query, `createdb`, the extension install and `dropdb` run as `postgres`,
while `pg_restore` and the verification read run as `infra-control`. Because
`runuser --preserve-environment` keeps the unit's `PGUSER`, each invocation pins
its role in both `-U` and `PGUSER` through
`services/operations/restore-accounts.mjs`, and an OS account with no mapping is a
hard error. Without that, a client started as `postgres` would ask for
`infra_control` and be refused by this map. It holds nothing in `17/main`,
so no fifth production role appears. `deploy/setup-postgresql-17-restore.sh` writes
this `pg_ident.conf`, points the restore cluster's `pg_hba.conf` at
`infra_cod_restore_map`, reloads the cluster and verifies through
`pg_hba_file_rules` and `pg_ident_file_mappings` that the reload took effect.

Each unprivileged OS user maps to exactly one role *within a cluster*. The one
account that appears more than once is `root`, and that does not weaken the rule:
root can already `su` to any user, so a mapping grants it nothing new. What the
rule protects is the boundary between the two unprivileged peers — the panel
cannot become a worker — and the absence of any database access for runtime agent
users.

`deploy/setup-postgresql-production.sh` creates these peers and validates all
seven allowed paths plus wrong-role, runtime-user and TCP refusals. The separate
`deploy/run-production-migrations.sh` temporarily gives `infra_migrator` the
non-inheritable ADMIN capability required by legacy migration 0038, then always
removes it; `infra_backup` retains `pg_read_all_data` for `pg_dump`.

## Group memberships the units assume

`infra-control` must be a member of:

- `infra-control` — to open the runtime supervisor socket (mode 0660,
  root:infra-control);
- `opencode-worker` — it was given to open the shared worker-tools socket
  (mode 0660, root:opencode-worker). Since WP-9b that socket does not exist:
  each run has its own under `/run/infra-cod/worker-tools/<run id>/tools.sock`,
  owned by the run's runtime account, mode 0600, and nobody else — this group
  included — can connect to it. The membership is still created and checked;
  whether anything else needs it is recorded as open in the WP-9 acceptance.

`infra-cod-github` must be a member of `agent-workspace` so a cloned workspace can
be handed to the runtime users, and of `infra-cod-github` for its own broker
socket. These are installer-created groups; a unit that names a supplementary
group the installer did not create fails to start with a clear error rather than
running under-privileged.

## Firewall

Published: SSH (restricted to the operator's source addresses), 80/tcp and
443/tcp. **3100 is never published** — the panel binds `127.0.0.1` only, and Caddy
is the sole publisher. A clean-room check of this is part of the Ubuntu matrix in
`docs/PROJECT.md`.

## What is checked, and what is not

Checked without systemd, by `services/control-plane/test/systemd-contract.test.mjs`:

- no unit uses a variable in a directive systemd does not expand
  (`WorkingDirectory`, `RootDirectory`, `StateDirectory`, `RuntimeDirectory`) or
  as the executable of an `ExecStart`;
- every service is a member of the target and every unit the target names exists,
  with timer-driven oneshots deliberately not started by the target;
- every timer carries `PartOf=infra-cod.target`;
- each DB client declares exactly one role, the shared env names none, and no unit
  carries `DATABASE_URL` or `PGPASSWORD`;
- the web unit's `ExecStart` is the standalone server on `127.0.0.1:3100`;
- the provisioner has no writable path, the backup reaches the database as
  `infra_backup` from root without `runuser`, and the restore drill depends on
  `postgresql@17-restore` and asks for `infra_control`.

Still not claimed:

- **No `systemd-analyze verify` has run.** There is no systemd on the machine these
  tests run on. The static checks above catch the mistakes that are checkable
  statically; they are not a substitute for the real parser, which is an Ubuntu
  prerequisite.
- The peer mapping above has been exercised on Ubuntu 24.04 against PostgreSQL
  17.11 before and after a host reboot. Both `17/main` and `17/restore` returned
  online, and all allowed and refused paths were rechecked.
- Stage 2 creates `infra-web`, `infra-control` and `infra-cod-github`, because
  their existence is required to prove its peer map. The installer creates
  `caddy`, `agent-workspace`, `opencode-worker` and the runtime accounts.
- `deploy/setup-postgresql-17-restore.sh` created `17/restore:5433` on the Ubuntu
  acceptance host; a real encrypted production dump was restored, compared and
  its throwaway database removed.
