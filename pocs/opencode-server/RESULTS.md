# OpenCode server parity PoC results

## Test metadata

- Date: 2026-07-21
- Host: target Ubuntu 24.04 VPS, Linux `x86_64`
- Runtime: OpenCode `1.18.3`, isolated Unix user `opencode-worker`
- Model: `opencode/north-mini-code-free`
- Interface: authenticated localhost-only `opencode serve` HTTP/SSE

## Result

| Capability | Result | Evidence |
| --- | --- | --- |
| Protected local server | Passed | Random HTTP Basic password; `/global/health` returned version 1.18.3 |
| SSE stream | Passed | `server.connected`, session, message, tool and status events |
| Async structured activity | Passed | `message.part.delta` and `message.part.updated` observed |
| Permission response | Passed | `permission.asked` followed by accepted one-shot reply |
| Abort active run | Passed | Server abort returned true and prevented the delayed marker file |
| Active input | Passed | `question.asked`, reply `PARITY_OK`, same-session `INPUT_ACCEPTED:PARITY_OK` |
| Cleanup | Passed | Both test sessions, temporary workspace, listener and process group removed |

All six capability assertions passed. The committed runner is reproducible with
`npm run poc:opencode-server`; `npm run poc:opencode-server:verify` validates the
latest receipt.

## Adapter decision

The official HTTP/SSE server surface is approved for an interactive adapter.
Sprint 0/1 keeps the already hardened batch worker/tool gateway in production,
adds bounded normalized activity and capability-gated process-group interrupt,
and retains durable input-request → operator-response → native-session-resume.
Moving the worker tool gateway into a long-lived server process is an optional
adapter refactor, not an MVP gate.
