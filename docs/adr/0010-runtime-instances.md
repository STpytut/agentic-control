# ADR-0010: Isolated named runtime instances bound to connections and native homes

## Status

**Proposed** for the Sprint 7.2 design target. Review 2026-07-31 closed the
first round (changes required → revised v2), the second round (v3: launch
snapshot, scope stdio, delete lifecycle, per-provider 1:1), and the third round
(v4: `launch_snapshot` includes `launch_config`/`environment_policy`, harness
spawns `systemd-run --scope --pipe` and owns the pipes, real cwd via
`--working-directory`, connection `FOR UPDATE` in the 1:1 trigger). Companion
document: [`SPRINT_7_2_DESIGN.md`](../SPRINT_7_2_DESIGN.md). It becomes
**Accepted** only after the review is cleared and the PoCs in section 20
(including the launch-harness PoC in section 20.4) and the acceptance matrix in
section 19 pass. No migration, production code or UI is written before then.

## Context

Today the platform runs one Codex connection per owner
(`provider_connections_one_codex_per_operator`), one native home
(`/home/codex-poc`), one chat worker that processes jobs sequentially, and a
Runtime Supervisor that hardcodes two runtime OS users (`codex-poc`,
`opencode-worker`) and two homes. `runtime_profiles` are capability templates but
own no home, connection, lifecycle or quotas. Sprint 7.2 must let one VPS
safely serve several independent Codex instances (later other verified runtimes)
without replacing the internal planner, context manager, session model or tool
loop of Codex itself.

## Decision

Introduce a named, owner-scoped **runtime instance** as the operational unit that
binds a capability-verified **runtime profile** to a **provider connection**, a
**native home**, a launch policy and resource limits. The Runtime Supervisor
resolves every launch, session, interrupt, usage receipt and stop by
`runtime_instance_id` from trusted database state; web and workers never pass a
binary, OS user, home path, environment, credential path or unrestricted CLI
arguments.

The instance/isolation model is:

```text
provider_connection
        ↓
runtime_instance → runtime_profile        (provenance; launch из frozen launch_snapshot)
        ↓
project_agent_assignment → task snapshots (orchestrator + per-executor)
        ↓
agent_session
        ↓
task_run → runtime_job → native process   (transient systemd scope, stdio через --pipe)
```

Key rules:

- **Connection is the authentication boundary; the instance is the operational
  unit.** A connection is home-scoped: its native credential store lives in one
  native home. Verify/Reconnect/Disconnect address exactly one home through the
  instance that owns it. The connection may be `pending` while the instance is
  being provisioned; `create_runtime_instance` creates the draft instance and its
  pending connection atomically, resolving the provisioning cycle.
- **Connection → instance is 1:1 for all adapters in 7.2** (enforced by a
  per-provider trigger, not a global unique index); Codex keeps 1:1 permanently
  (home-scoped credentials), other adapters may relax to 1:N through a capability
  after the shared-credential-store PoC. The declared structural 1:N is future
  scope, made explicit to avoid contradiction. The 1:1 check serializes on the
  connection row (`FOR UPDATE`) so concurrent creates cannot both pass, and a
  concurrent DB test is mandatory.
- **One OS user per Codex instance, with a short immutable identity.** New
  instances get a dedicated system user `icx-<12 hex>` (derived from the instance
  id, not from the user-editable slug) and a home under the root-owned
  `/var/lib/infra-cod/instances/<id>`. This preserves the security goal
  "компрометация одного runtime не раскрывает credentials других runtime" and
  stays within Linux user-name limits. The legacy `codex-poc`/`/home/codex-poc`
  identity becomes the first (default) instance and keeps working unchanged.
- **OS-level provisioning is a separate narrow privileged unit.**
  `infra-cod-instance-provisioner.service` (root, without `ProtectSystem=strict`)
  performs `useradd`/home creation and deprovisioning idempotently from the
  instance id; the main Supervisor keeps `ProtectSystem=strict` and never runs
  `useradd`.
- **Launch is deterministic through a frozen `launch_snapshot`.** Because the
  `runtime_profiles` row itself is mutable (capability refresh like migration
  0016), the instance freezes the full launch contract in `launch_snapshot` at
  first `ready`: `model`, `runtime_type`, `adapter_version`, `runtime_version`,
  `capabilities`, `environment_profile`, `launch_config` and
  `environment_policy` — there are no separate live launch-policy columns. The
  Supervisor launches from it. Edits to `runtime_profiles` cannot change an
  already-created task, run or native session. Resource budgets are the one
  live field, sourced solely from `budget_policy` (applied per new run).
  `busy` is not stored: it is derived from active jobs.
- **Executors are snapshotted per task.** `tasks.orchestrator_runtime_instance_id`
  and `task_executor_snapshots` freeze instance/profile/catalog per selected
  executor by value, so mutating project assignments or Settings cannot change an
  already-created task or native session.
- **Instance ID is a snapshot field** on `tasks`, `task_runs`, `agent_sessions`
  and `runtime_jobs`; `project_agent_assignments.runtime_instance_id` is the only
  live reference.
- **Read-only turns do not chown the project workspace.** Today
  `open_codex_app_server` transfers workspace ownership to `codex-poc` before
  every read-only open; two instances would thrash ownership. Read-only access
  uses the shared `agent-workspace` group (`g+rX`); the single-writer fence is
  untouched and future write-capable instances still use per-run ownership
  transfer under the existing workspace lock.
- **Supervisor becomes the single admission point for process-level limits.**
  Database claims enforce per-instance `max_parallel_runs` and connection caps
  atomically; the root Supervisor enforces VPS-wide and runtime-type caps against
  its own global channel/scope state, and a bounded pool of worker replicas
  provides parallel turns.
- **Resource limits are enforceable, not declarative.** Each run starts in its
  own transient systemd **scope** with connected stdio
  (`systemd-run --scope --pipe --collect`, verified by the launch-harness PoC in
  section 20.4; the harness owns the pipes because `--pipe` binds them to the
  spawning process), with `MemoryMax` (sole source `budget_policy.memory_max_bytes`)/
  `MemorySwapMax=0`/`TasksMax`; the real working directory is set by
  `--working-directory` and spawn `cwd` (not `PWD` alone). Instance homes live
  on a volume with real project quotas (hard ENOSPC). `ReadWritePaths` and `du`
  preflight are not treated as quotas.
- **Stop is worker-first, Supervisor escalation is a fallback.** The worker owns
  the app-server stream (`threadId`/`turnId`): it sends `turn/interrupt`, waits
  for the interrupted receipt, finalizes durable state, then asks the Supervisor
  to close the channel. The Supervisor escalates to SIGTERM/SIGKILL only if the
  worker does not finalize in time.
- **Home/OS identity/connection stay exclusive until confirmed deprovision.**
  Delete moves the instance to `deleting` (`deleted_at`), the provisioner
  physically removes user/home and revokes credentials, and only after
  `deprovisioned_at` is set does the identity become reusable; a failed cleanup
  leaves the instance in `deprovision_failed` with the identity still reserved.
- **Alternative model/reasoning fields are not accepted from clients**; they come
  from the verified profile snapshot. **Instance homes are never supplied by the
  web request**: the database stores a reference (`codex-home:<id>`) and an OS
  user/home set by the provisioner; the Supervisor canonicalizes and verifies
  them against the allowlisted roots.

## Alternatives considered and rejected

1. **Instance as a thin alias over `provider_connections` (no new table).**
   Rejected: connections are authentication state, not operational state; they
   lack profile binding, launch policy, quotas, run accounting and the
   lifecycle needed for admission and UI. The brief requires "разница между
   connection и instance".
2. **Single runtime OS user with root-owned allowlisted instance
   subdirectories.**
   Rejected for Codex: a shared UID lets instance A read instance B's native
   credential store, violating the credential-isolation security goal. Kept as a
   documented option for adapters that prove a shared credential store is safe.
3. **Supervisor accepts explicit `user`, `HOME`, `CODEX_HOME`, env and CLI args
   from workers/web.**
   Rejected: reintroduces path injection and confused-deputy risk; contradicts
   `RUNTIME_CONTRACT.md` and `SECURITY.md` §6. The Supervisor always derives the
   launch tuple from `runtime_instance_id`.
4. **Extending the Supervisor with OS provisioning (`useradd`).**
   Rejected: the Supervisor unit runs `ProtectSystem=strict` and cannot write
   `/etc/passwd`/`/etc/shadow`. A separate narrow privileged provisioner unit
   owns `useradd`/home creation with an idempotency and rollback contract.
5. **One long-lived app-server per instance serving many turns.**
   Rejected for the first increment: the current durable-turn model opens one
   read-only app-server process per claimed job and resumes the native thread.
   Keeping per-job processes (each in its own transient scope) bounds blast
   radius and makes Stop per-run natural. A persistent per-instance process can
   be revisited after the concurrency PoC.
6. **In-process bounded concurrency inside a single chat worker.**
   Rejected as the primary mechanism: a worker pool (systemd template replicas)
   gives crash isolation between turns, keeps each worker single-job, and relies
   on the existing `SKIP LOCKED` claims. In-process parallelism can be layered
   later without schema changes.

## Consequences

- New `runtime_instances` table (frozen `launch_snapshot`,
  `deleting`/`deprovision_failed`/`deleted`, `deleted_at`/`deprovisioned_at`),
  per-task executor snapshots, instance-bound login sessions, and snapshot
  columns on assignments/tasks/runs/sessions/jobs.
- The unique `one_codex_per_operator` index is relaxed; connection→instance 1:1
  is enforced by a per-provider trigger for all adapters in 7.2, and
  home/OS identity stay exclusive until `deprovisioned_at`.
- Supervisor protocol gains instance-bound launch/stop; launches read
  `launch_snapshot` and run in transient `systemd-run --scope --pipe` scopes;
  read-only opens stop changing ownership; a separate
  `infra-cod-instance-provisioner` unit handles OS provisioning/deprovisioning.
- Chat/executor workers claim with instance admission; systemd units become
  templated replicas; each run gets a transient scope with real cgroup limits.
- Backup enumerates instance homes dynamically; restore keeps them encrypted and
  out of any plaintext path.
- Settings gains a Runtime Instances surface and instance pickers in project and
  task assignment; connection cards remain the authentication surface.
- The existing Codex → OpenCode → Codex flow, single-writer fence and
  no-plaintext-secret boundary are preserved; the default instance is a pure
  backfill of today's `codex-poc`.
