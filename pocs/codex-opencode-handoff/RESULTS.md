# Asynchronous Codex → OpenCode Handoff Results

## Test metadata

- Date: 2026-07-17 (Europe/Athens)
- Host: Ubuntu 24.04 LTS VPS
- Database: PostgreSQL 16.14, `infra_cod`
- Dispatcher/reconciler identity: `infra-control`
- Runtime Supervisor: root-owned systemd service with bounded capabilities
- Codex: `codex-cli 0.144.5`, model `gpt-5.4`, user `codex-poc`
- OpenCode: `opencode 1.18.3`, free model, user `opencode-worker`
- Workspace: isolated UUID directory under `/srv/infra-cod-handoff-poc/workspaces`

## Result

Independent verifier: **24/24 checks passed**.

The final run was executed while the permanent systemd dispatcher and
reconciler were active. The harness and service could race for an outbox event,
while the unique `(source_event_id, job_type)` constraint still guaranteed one
runtime job.

| Area | Evidence |
| --- | --- |
| Fast command receipt | Codex received `accepted` before OpenCode started |
| Non-blocking delegation | First Codex turn completed before worker completion |
| Durable routing | outbox produced `start_implementation` runtime job |
| Lease lifecycle | runtime job and workspace lock heartbeat succeeded |
| Real worker | OpenCode wrote the artifact and called `complete_task` twice |
| Durable completion | both reports finalized after process exit; locks released |
| Structured revision | Codex called `request_revision`; revision events persisted |
| Session continuity | both OpenCode runs used the same native session |
| Delivery cleanup | four runtime jobs completed, no outbox lease remained in flight |

Native identifiers from the final run:

- Codex thread: `019f6e60-3cb4-71b1-8656-11a1c182a0a7`
- Delegation turn: `019f6e60-3f70-77c0-88e0-4240197149e6`
- Revision turn: `019f6e60-ad2e-79a1-844e-32ef6eb77e93`
- Final review turn: `019f6e61-25c1-7e40-ab0d-728cf4a26c77`
- OpenCode session (both runs): `ses_0919f8cfdffeh3ruI87LsqhIKQ`
- Initial run: `650d41e7-4f75-4360-9b3d-6856af76fa8b`
- Revision run: `4116d639-cfb2-4251-8ba2-be98778d06cd`

## Proven asynchronous flow

```text
Codex delegation turn
  → platform.delegate_task
  → DelegateTask + implementation.requested/outbox (transaction)
  ← accepted command receipt
  → CODEX_DELEGATION_ACCEPTED
  → first Codex turn completes

dispatcher
  → claim outbox with SKIP LOCKED
  → create unique start_implementation runtime job
  → acknowledge outbox

runtime supervisor
  → claim job
  → create run + acquire fencing token
  → heartbeat job and workspace lease
  → run OpenCode under isolated OS user
  → OpenCode calls capability-bound complete_task
  → supervisor waits for process exit
  → CompleteImplementation transaction
  → release workspace lease
  → complete start job

dispatcher
  → route implementation.completed
  → create resume_codex runtime job

runtime supervisor
  → start a second turn in the original Codex thread
  → acknowledge resume job after native turn receipt
  → Codex calls request_revision
  → OpenCode resumes the same native session
  → revision.started → complete_task → revision.completed
  → Codex reads revised output
  → CODEX_REVIEW_OK
```

All seven outbox messages finished as `published`, each with one attempt. All
four runtime jobs finished as `completed`, each with one attempt.

## Crash and recovery tests

`db/tests/0003_dispatcher_reconciler_test.sql` additionally proved:

- duplicate dispatcher routing cannot create a duplicate runtime job;
- repeated DB start returns the original run/fencing receipt;
- job and workspace heartbeats extend only active matching leases;
- expired writer becomes `lost`;
- task and project become `needs_attention`;
- workspace becomes `reconciliation_required` while retaining its stale token;
- ambiguous external job moves to `dead_letter` instead of being replayed.

All SQL integration tests finish with `ROLLBACK`.

## Runtime Supervisor security evidence

The final E2E contains no direct `runuser`, `chown`, `chmod` or runtime spawn in
the harness. Codex stdio and OpenCode batch execution went through the Unix
socket supervisor. The start and resume jobs were leased to
`vps-runtime-supervisor-1`.

Independent negative tests proved:

- `infra-control` can ping the socket;
- `opencode-worker` receives `EACCES`;
- a `workspace-write` Codex thread sent through a read-only channel is rejected;
- systemd retains only the six required capabilities while
  `NoNewPrivileges=1` remains active.

The verifier also uses an exact standalone review line. A model response that
mentions `CODEX_REVIEW_OK` while refusing verification is treated as failure.

## Running services

The VPS now has enabled systemd services:

```text
infra-cod-dispatcher.service  active
infra-cod-reconciler.service  active
infra-cod-runtime-supervisor.service  active
```

Dispatcher and reconciler run as `infra-control`, use only the PostgreSQL Unix
socket and have a 256 MB memory cap. Runtime Supervisor runs as root with a
closed protocol, bounded capabilities and a 1 GB cap. All three use
`NoNewPrivileges`, filesystem protection and task limits. No
warning-or-higher journal entries were present after the final E2E.

## Remaining production work

1. Add PostgreSQL backup/restore verification, metrics and alerts.
2. Add API endpoints and UI projections over commands, tasks, runs and jobs.
3. Add `report_blocker` and `request_user_input` worker tools.

## Decision

The handoff no longer depends on an open Codex tool callback. PostgreSQL outbox
and runtime jobs provide the durable boundary, and Codex resumes from a
completion event in a separate native turn. The next vertical slice is
the control-plane API and security/recovery operational hardening.
