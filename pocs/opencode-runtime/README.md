# OpenCode Runtime PoC

Проверяет официальный non-interactive интерфейс `opencode run --format json`
на целевой VPS.

## Проверяемые возможности

- headless start;
- raw JSON event stream;
- native session ID;
- tool use и запись в workspace;
- resume конкретной session после завершения процесса;
- conversation memory continuity;
- usage/cost telemetry, если runtime её сообщает.

По умолчанию используется доступная бесплатная модель
`opencode/north-mini-code-free`. Переопределение:

```bash
OPENCODE_POC_MODEL=<provider/model> npm run poc:opencode:start
```

Запуск:

```bash
npm run poc:opencode:start
npm run poc:opencode:resume
npm run poc:opencode:verify
```

`--auto` применяется только внутри отдельного Unix user и изолированного
capability-test workspace. Production adapter должен обрабатывать permissions
через OpenCode server API и собственную policy, а не включать глобальный auto
approve.

Этот PoC не проверяет HTTP server/SSE, abort и permission response endpoints;
они относятся к следующему OpenCode server PoC.
