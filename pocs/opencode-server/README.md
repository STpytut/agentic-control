# OpenCode server parity PoC

This target-VPS PoC verifies the official localhost HTTP/SSE integration surface
used by an interactive OpenCode adapter:

- authenticated localhost-only server health and SSE connection;
- asynchronous prompt delivery and structured session events;
- permission request/reply before a guarded shell command;
- abort of an active command without its delayed side effect;
- active `question.asked` input, reply and continuation in the same session.

The runner must execute as root on the target VPS. It creates a temporary
workspace owned by `opencode-worker`, starts `opencode serve` in an isolated
process group, uses a random HTTP Basic password and deletes both test sessions
before terminating the server. No server port or test workspace survives the
run.

```bash
npm run poc:opencode-server
npm run poc:opencode-server:verify
```

The default model is `opencode/north-mini-code-free`. Override it with
`OPENCODE_POC_MODEL=<provider/model>`.
