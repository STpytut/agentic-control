# Codex Platform Tools PoC Results

## Test metadata

- Date: 2026-07-16
- Host: Ubuntu 24.04 LTS VPS, Linux `x86_64`
- CLI/app-server: `codex-cli 0.144.5`
- Runtime user: `codex-poc`
- Model: `gpt-5.4`
- Interface: app-server experimental dynamic tools over stdio
- Tool: `platform.delegate_task`

## Result summary

| Capability | Result | Evidence |
| --- | --- | --- |
| Namespace/tool registration | Passed | Thread started with `platform.delegate_task` schema |
| Model tool selection | Passed | Exactly one `item/tool/call` request |
| Thread/turn correlation | Passed | Callback IDs matched the active run |
| Exact argument validation | Passed | Observed arguments matched the task contract |
| Invalid argument rejection | Passed | Negative contract check rejected unknown assignee |
| Command receipt | Passed | Receipt persisted before callback response |
| Idempotency key | Passed | `delegate:task-poc-001:1` |
| Tool result delivery | Passed | Completed dynamic-tool item contained the receipt |
| Agent continuation | Passed | Same turn used returned handoff ID and key |
| Turn completion | Passed | Final status `completed` |

Independent verifier result: 10/10 checks passed.

## Observed callback

```json
{
  "namespace": "platform",
  "tool": "delegate_task",
  "arguments": {
    "task_id": "task-poc-001",
    "assignee": "opencode",
    "objective": "Create a worker proof file",
    "revision_number": 1,
    "acceptance_criteria": [
      "The worker proof file contains WORKER_OK"
    ]
  }
}
```

The callback also contained the exact active `threadId`, `turnId`, and an
opaque `callId`.

## Returned command receipt

```json
{
  "status": "accepted",
  "command": "delegate_task",
  "task_id": "task-poc-001",
  "assignee": "opencode",
  "revision_number": 1,
  "handoff_id": "handoff-poc-001",
  "run_id": "opencode-run-poc-001",
  "idempotency_key": "delegate:task-poc-001:1"
}
```

Codex then created:

```text
PLATFORM_DELEGATE_OK
HANDOFF_ID=handoff-poc-001
IDEMPOTENCY_KEY=delegate:task-poc-001:1
```

## What this proves

- app-server can expose control-plane-owned tools directly to a Codex thread;
- the host receives a structured callback rather than parsing agent text;
- caller context can be bound to the active native thread and turn;
- the host can validate a task contract and return a structured receipt;
- Codex receives the receipt and continues the same turn with its values.

## What this does not prove

- real PostgreSQL transaction/outbox persistence;
- workspace lease acquisition and fencing;
- actual OpenCode process creation or resume;
- duplicate delivery/retry behavior;
- worker `complete_task()` and Codex review resume;
- read resources previously planned as `platform://...` MCP resources.

## Decision

For the Codex app-server adapter, dynamic tools are approved as the MVP command
transport for `delegate_task`, `request_revision`, status commands, and future
publish/deploy requests. They provide native thread/turn correlation and avoid
an additional local MCP process.

The tool handlers remain transport-independent control-plane services. A
separate Platform MCP server can still be added for resources, portability to
other runtime surfaces, or if app-server dynamic tools change. The MVP command
path does not require both transports at once.
