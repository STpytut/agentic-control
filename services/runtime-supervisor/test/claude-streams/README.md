Recorded `claude -p --output-format stream-json --verbose` streams, Claude Code
2.1.270, model `haiku`, from the runtime PoC (`pocs/claude-runtime/fixtures`,
branch `poc/claude-runtime`), redacted there: home paths as `$HOME`, no e-mail,
no key. The driver tests read them as the shapes the driver parses.

| File | What it shows |
| --- | --- |
| stream-orchestrator-mcp.jsonl | an orchestrator turn: init, reads, one `mcp__platform__delegate_task`, result `DONE` |
| stream-resume.jsonl | a resumed session answering from the first turn |
| stream-exit-auth.jsonl | signed out: `assistant.error=authentication_failed`, `is_error` |
| stream-exit-model.jsonl | an unknown model: `model_not_found`, `api_error_status` 404 |
