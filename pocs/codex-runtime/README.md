# Codex Runtime PoC

Проверяет стабильный non-interactive интерфейс `codex exec --json` до перехода к экспериментальному app-server.

## Требования

- установленный `codex`;
- выполненный `codex login`;
- Node.js 18+;
- Git repository;
- сетевой доступ к Codex.

На Ubuntu 24.04 для `workspace-write` установите системный Bubblewrap и его
AppArmor-профиль по инструкции из [`RESULTS.md`](RESULTS.md). Без этого Codex
может создать сессию, но sandboxed tools завершатся ошибкой настройки loopback.

## Проверяемые возможности

- запуск Codex без TUI;
- JSONL streaming;
- получение native thread/session ID;
- изменение файла в `workspace-write` sandbox;
- сохранение session;
- resume конкретной session;
- структурированный итоговый отчёт.

## Запуск

```bash
npm run poc:codex:start
```

PoC по умолчанию изолирован от пользовательского `config.toml` и использует
`gpt-5.4`, совместимый с проверяемой локальной версией CLI. Модель можно
переопределить:

```bash
CODEX_POC_MODEL=<model> npm run poc:codex:start
```

Команда выводит JSON-резюме и сохраняет:

- `artifacts/latest-start.json`;
- `artifacts/latest-session-id.txt`;
- `artifacts/start-*.jsonl`;
- `artifacts/start-*.stderr.log`.

Продолжение последней тестовой сессии:

```bash
npm run poc:codex:resume
```

`codex exec resume` не предоставляет отдельный флаг `--sandbox`, поэтому PoC
явно передаёт `sandbox_mode="workspace-write"` и
`approval_policy="never"` через config overrides. Это относится только к
изолированному тестовому workspace.

Можно передать собственный prompt:

```bash
node pocs/codex-runtime/run-exec.mjs start "Inspect the workspace and report its files"
node pocs/codex-runtime/run-exec.mjs resume "Continue the previous task"
```

Проверка последних результатов:

```bash
npm run poc:codex:verify
```

## Критерии успеха

### Start

- exit code `0`;
- присутствуют `thread.started`, `turn.started`, `turn.completed`;
- получен `thread_id`;
- создан `workspace/codex-poc-phase-one.txt`.

### Resume

- exit code `0`;
- `thread.started.thread_id` совпадает с сохранённым ID;
- присутствует `turn.completed`;
- создан `workspace/codex-poc-phase-two.txt`.

## Ограничение

Этот PoC не доказывает полную пригодность `app-server`, bidirectional input во время активного turn или обработку approvals. Они проверяются следующими отдельными PoC.
