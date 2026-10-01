# Runtime Supervisor

Root-owned service that exposes a narrow protocol over
`/run/infra-cod/runtime-supervisor.sock`: bounded, numbered JSON frames after a
version handshake (`framing.mjs`, protocol 2).

The client never supplies an executable, Unix user or workspace path. It names a
runtime and one of its driver's surfaces (`drivers/`, RUNTIME_CONTRACT §15), and
the driver decides the rest:

| Request | Carries | Today |
| --- | --- | --- |
| `runtime_open` | a channel the client drives over stdin/stdout | Codex `project` (read-only grant), `account`, `gate` |
| `runtime_run` | a batch run the supervisor drives to its end | OpenCode `task` (read_write grant, fenced), `gate` |
| `runtime_account` | one account operation through a loopback server | OpenCode `account` |

A connection that did not negotiate protocol 2 is refused these. What each
channel's stdin may carry is the driver's `input` rule for that surface.

The orchestrator worker runs as `infra-control`, claims `orchestrator_turn`
and `resume_orchestrator` jobs, and opens the `project` surface of the runtime
the task's orchestrator assignment names. It stores one native session per task
conversation and resumes it for later user messages.

Before a write-capable (`task`) launch the service verifies:

- runtime job is `in_flight` and leased to this supervisor;
- job, project and run IDs match;
- workspace lock is active for the same run and fencing token;
- lease has not expired;
- requested model equals the assigned runtime profile;
- canonical workspace remains under the configured project root.

Runtime subprocesses receive an `env -i` allowlist. Workspace ownership changes
and runtime `runuser` calls exist only in this service.

Socket permissions are `root:infra-control 0660`. Runtime users are not members
of `infra-control` and cannot call the supervisor.

Smoke tests:

```bash
node services/runtime-supervisor/socket-access-smoke.mjs allow
node services/runtime-supervisor/socket-access-smoke.mjs deny
node services/runtime-supervisor/policy-smoke.mjs <project-id>
```
