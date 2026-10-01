# Open Questions and Validation Backlog

## 1. Блокирующие до MVP

### Runtime capabilities

- Какой официальный Codex interface лучше подходит: App Server или CLI?
- Какие гарантии Codex даёт для resume и structured events?
- Какой официальный OpenCode server/CLI contract стабилен для embedding?
- Поддерживает ли Antigravity официальный headless resume, streaming, input и tools?
- Какие authentication flows разрешены для постоянного VPS?

### Process model

- Runtime processes запускаются непосредственно, под отдельными OS users или в контейнерах?
- Может ли каждый runtime безопасно работать с read-only режимом?
- Как гарантировать fencing для процессов, которые пишут в filesystem напрямую?

### Publishing

- Какие Git branch protections обязательны?
- Требуется ли approval для каждого push или только для protected targets?

### Storage

- Где каждый runtime хранит native session state?
- Какие файлы session state можно backup/restore официально?
- Какой объём raw stream хранить?

## 2. Решить до product UI

- SSE или WebSocket для основного stream/input канала?
- Как отображать raw terminal output вместе со structured events?
- Нужен ли встроенный file viewer в MVP?
- Как показывать разницу между заявленными worker checks и проверками Codex/control plane?
- Какая ручная recovery UX нужна для `needs_attention`?

## 3. После MVP

- Добавлять ли Telegram в V1.1?
- Нужны ли Ollama Cloud и другие provider profiles?
- Нужен ли cost-aware routing?
- Когда переходить к worktrees и parallel writers?
- Нужны ли multi-user roles?
- Нужны ли scheduled tasks/automations?

## 4. Явно закрытые вопросы

- Собственный Context Manager: нет.
- Собственный prompt cache: нет.
- Собственный compaction: нет.
- Полная история одного агента в handoff другому: нет.
- Все агенты имеют publishing credentials: нет.
- Обязательная параллельная работа в V1: нет.
- Go/Zen/Ollama как отдельные Agents: нет, это provider profiles.
- Привязка архитектуры строго к CLI: нет, выбирается capability-complete официальный interface.

## 5. Regression debt (Sprint 7.1)

- **`db/tests/0009_runtime_activity_test.sql` fails on a clean database.**
  The test takes the latest `runtime_jobs` row (`ORDER BY id DESC LIMIT 1`) and
  raises `runtime activity test requires one runtime job fixture` when none
  exists. All DB tests run in transactions and end with `ROLLBACK`, and no
  migration seeds `runtime_jobs`, so on a freshly migrated database this test
  always fails. It passes on the dev/production database because real jobs have
  accumulated there.
  - Impact: `npm run db:test` is not green on a clean database.
  - Requirement (before the final 7.1 merge): clean `npm run db:test` must pass
    fully.
  - Proposed fix: make `0009` self-contained by creating a minimal
    project/task/`domain_events`/`runtime_jobs` fixture inside the test (or seed
    a fixture via a migration), rather than depending on ambient rows.
  - Status: tracked, not yet fixed (out of scope of the `0026` increment).

