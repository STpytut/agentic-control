# OpenCode worker interaction tools PoC

Target-VPS test for the two non-completion terminal worker paths:

- global `report_blocker` custom tool → `implementation.blocked`;
- global `request_user_input` custom tool → `run.input_requested`;
- both calls use the capability-bound worker gateway;
- both runs resume the same native OpenCode session;
- supervisor finalizes only after process exit;
- run becomes `blocked`, task becomes `needs_attention`, lock is released;
- each result has an append-only audit event.

Latest verified session: `ses_091a10551ffe6EFNenhtYagM1k`.

```bash
npm run poc:worker-interactions
```
