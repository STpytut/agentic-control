# Codex App Server PoC

Проверяет bidirectional stdio JSON-RPC протокол экспериментального
`codex app-server` на целевой Linux/VPS.

## Возможности

- обязательный `initialize` / `initialized` handshake;
- `thread/start` и `turn/start`;
- структурированные streaming notifications;
- `turn/steer` активного turn с `expectedTurnId`;
- `turn/interrupt` во время foreground command;
- server-initiated approval request и client response;
- применение одобренной операции за границей workspace.

Тест автоматически принимает только два известных approval method:
`item/commandExecution/requestApproval` и
`item/fileChange/requestApproval`. Любой другой server request получает
ошибку `-32601`.

## Запуск

```bash
npm run poc:codex-app-server
npm run poc:codex-app-server:verify
```

По умолчанию используется `gpt-5.4`. Переопределение:

```bash
CODEX_POC_MODEL=<model> npm run poc:codex-app-server
```

Raw JSONL, stderr и итоговый JSON сохраняются в `artifacts/`.

## Ограничения

- app-server помечен как experimental и требует version-pinned schema generation;
- PoC использует локальный stdio transport, а не публичный WebSocket listener;
- approval автоматически принимается только внутри изолированного capability test;
- production client должен показывать запрос пользователю и проверять его решение.
