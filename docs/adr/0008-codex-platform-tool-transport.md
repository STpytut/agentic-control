# ADR-0008: Use app-server dynamic tools for Codex control-plane commands

- Status: Accepted
- Date: 2026-07-16

## Context

The baseline specified a Platform MCP for Codex commands such as
`delegate_task()`. The selected interactive Codex interface is app-server,
which can register per-thread dynamic tools and forwards calls to the host as
structured `item/tool/call` requests containing native thread and turn IDs.

The VPS PoC proved exact schema registration, structured callback delivery,
context and argument validation, command receipt persistence, idempotency-key
generation, and continuation of the same Codex turn with the returned result.

## Decision

Use app-server dynamic tools as the Codex-specific command transport in the MVP.
Tool handlers live in the control plane and are independent of the transport.
They must validate active run, actor/runtime role, task state, assignment,
workspace ownership/fencing token, idempotency key, and arguments before a
side effect.

Do not run a second MCP process solely to duplicate the same Codex command
tools. Retain MCP as an optional adapter for read resources, other runtime
surfaces, or a future migration if app-server changes.

## Consequences

- Codex command calls have native thread/turn/call correlation.
- One local stdio app-server connection carries events, approvals, and platform
  tool callbacks.
- Dynamic tool schemas are version-pinned with the app-server CLI version.
- The control plane, not the callback transport, owns durability, outbox,
  retries, leases, authorization, and audit.
- Resources such as `platform://tasks/{id}` remain deferred until a concrete
  resource access flow requires MCP or an equivalent read API.
