# Asynchronous Codex → OpenCode Handoff PoC

End-to-end capability test on the target VPS:

1. Codex calls structured `platform.delegate_task`;
2. control plane validates the active thread/turn and task contract;
3. PostgreSQL atomically persists the command, handoff, event and outbox;
4. Codex receives `accepted` and completes the delegation turn;
5. dispatcher creates a unique `start_implementation` runtime job;
6. Runtime Supervisor validates job/project/model/fence, transfers ownership
   and runs OpenCode under its isolated OS user;
7. OpenCode calls global `complete_task`; supervisor finalizes it only after
   process exit, releases the lease and creates `resume_codex`;
8. Codex calls `request_revision`, and OpenCode resumes the same native session;
9. the second `complete_task` emits `revision.completed` and Codex performs the
   final review in a third native turn.

Runtime launch and ownership transfer go through the dedicated Unix socket at
`/run/infra-cod/runtime-supervisor.sock`. The harness contains no direct
`runuser`, `chown`, `chmod` or runtime spawn.

```bash
npm run poc:handoff
npm run poc:handoff:verify
```

The worker tool socket is capability-bound: model-supplied task/run/agent IDs
are not trusted. The harness verifies both artifacts and persisted reports.
