# Proofs of concept

Before a runtime capability became part of the product, it was proved in a
small, separate program against the real CLI: does `codex exec --json` resume a
session, does the app-server protocol carry a platform tool call, can one agent
hand work to another through the database. Each directory holds the program, a
`RESULTS.md` with what was observed, and a verifier.

The runtime drivers (`services/runtime-supervisor/drivers`) cite these results
as the evidence for the capabilities they declare. They are kept for that: they
are not part of the product and are not run by its suites.

| Directory | What it proved |
| --- | --- |
| `codex-runtime` | `codex exec --json`: a non-interactive run and its resume |
| `codex-app-server` | Codex's app-server: two-way JSON-RPC over stdio |
| `codex-platform-tools` | A structured, platform-owned tool call from Codex |
| `codex-opencode-handoff` | Codex delegating to OpenCode through the control plane, on the target host |
| `opencode-runtime` | `opencode run --format json` |
| `opencode-server` | OpenCode's localhost HTTP/SSE surface |
| `opencode-account` | OpenCode's sign-in and model catalog interfaces |
| `worker-interactions` | An executor that blocks or asks the owner a question, instead of finishing |

Claude Code's proof of concept ran on the production host and recorded host
details, so it is not published. Its recorded event streams, redacted, are in
`services/runtime-supervisor/test/claude-streams`, where the driver's tests read
them.

Several READMEs and results here are written in Russian.
