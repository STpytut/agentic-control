# AI Coding Control Plane

Self-hosted платформа для удалённой работы с нативными AI coding agents в постоянных проектных workspace на VPS.

Текущий gap-аудит и порядок завершения MVP: [docs/ROADMAP.md](ROADMAP.md).
Новая рабочая сессия должна начинаться с [docs/PROJECT.md](PROJECT.md).

Репозиторий содержит нормативный комплект требований, исполняемые capability
PoC и первую PostgreSQL-реализацию durable control plane.

## Статус

- Версия ТЗ: `1.0`
- Дата фиксации: `2026-07-14`
- Статус: self-hosted foundation, Этапы 7–8
- Целевая поставка: single-user V1
- Реализация: dispatcher/reconciler, isolated Runtime Supervisor и durable
  workers в коде; web control plane — Next.js `standalone` за Caddy.
- **Database-часть Этапа 2 прошла Ubuntu-приёмку.** Production PostgreSQL setup,
  peer mapping, 46 миграций и зашифрованный backup/restore проверены на Ubuntu
  24.04 и повторно проверены после reboot. До готовой панели на чистом VPS
  остаётся Этап 10: installer должен
  поставить release artifact, Node, systemd units, Caddy и сгенерировать
  локальные credentials.

## Архитектурная формула

```text
browser/phone ──HTTPS──▶ Caddy ──▶ 127.0.0.1:3100 Next standalone
                                          │
                        Unix socket PostgreSQL 17/main (peer auth)
                                          ▲
   workers ───────────────────────────────┘  (свои peer-роли)
   runtime users агентов ───────────────── X  (нет DB-доступа)
```

Caddy — единственный публикуемый наружу процесс и единственный владелец TLS и
сжатия. Панель слушает только loopback. Доступ к базе — peer-аутентификация по
Unix-сокету: OS-пользователь и роль PostgreSQL связаны 1:1, пароля нет нигде.
Полная матрица unit → OS user → PG role и контракт для Этапа 2 —
[`deploy/systemd/README.md`](../deploy/systemd/README.md).

```text
Web UI
        ↓
Deterministic Control Plane
        ↓
Session & Handoff Manager
        ↓
Runtime Adapters
        ↓
Native Codex / OpenCode sessions
        ↓
One persistent project workspace
```

Codex планирует, делегирует, ревьюит и публикует. OpenCode и Antigravity реализуют изменения. Платформа хранит состояние и доставляет события, но не заменяет внутреннюю логику агентов.

## Нормативные документы

| Документ | Назначение |
| --- | --- |
| [Product Spec](PRODUCT_SPEC.md) | Концепция, роли, сценарии, требования и границы продукта |
| [MVP Spec](MVP_SPEC.md) | Состав V1, критерии приёмки и порядок реализации |
| [Architecture](ARCHITECTURE.md) | Компоненты, workspace model, сессии, locks и recovery |
| [Runtime Contract](RUNTIME_CONTRACT.md) | Контракт адаптера и интеграция нативных runtime |
| [Capability Matrix](CAPABILITY_MATRIX.md) | Проверяемая совместимость Desktop, CLI, API и headless runtime |
| [Events](EVENTS.md) | Workflow, события, payload, идемпотентность и retries |
| [Data Model](DATA_MODEL.md) | Сущности, состояния и инварианты хранения |
| [Security](SECURITY.md) | Полномочия, credentials, approvals и аудит |
| [Operations](OPERATIONS.md) | VPS, процессы, наблюдаемость, backup и recovery |
| [Open Questions](OPEN_QUESTIONS.md) | Неподтверждённые гипотезы и решения до реализации |
| [Spec Changelog](SPEC_CHANGELOG.md) | Изменения после исходной фиксации ТЗ |

Архитектурные решения находятся в [`docs/adr`](adr/README.md).

Исполняемые capability PoC находятся в [`pocs`](../pocs):

- [`Codex exec runtime PoC`](../pocs/codex-runtime/RESULTS.md);
- [`Codex app-server interactive PoC`](../pocs/codex-app-server/RESULTS.md);
- [`Codex platform tools PoC`](../pocs/codex-platform-tools/RESULTS.md);
- [`OpenCode runtime PoC`](../pocs/opencode-runtime/RESULTS.md);
- [`Codex → OpenCode handoff PoC`](../pocs/codex-opencode-handoff/RESULTS.md).

PostgreSQL migrations и откатываемые integration tests находятся в [`db`](../db/README.md).

Live UI находится в [`apps/web`](../apps/web) и включает project overview,
workspace lock, task contract, native-session telemetry, events/audit timeline и
операторские действия для review, revision, approval и worker input/blocker.

Production — это self-hosted установка: панель в виде `standalone`-сборки за
Caddy, локальный PostgreSQL по Unix-сокету и те же worker-процессы на том же
хосте. Ни hosted-платформы, ни внешней базы в контуре нет.

```bash
npm run web:dev
npm run web:build
npm run stage:standalone -- --out /tmp/infra-cod-stage   # runtime tree + receipt
npm run test:standalone                                  # smoke реальной сборки
```

## Release-артефакты

Локальная сборка без подписи:

```bash
npm run release:build          # dist/releases/: tarball + SHA256SUMS
```

Сборка требует Node **24.20.0 ровно** и отказывается на любой другой patch-версии
— так же, как и `npm run test:release:artifact`, который её вызывает. На машине с
другим Node артефакт не собрать; используйте `scripts/run-suites-in-container.sh`
или release-workflow. Остальные сюиты на этом не завязаны.

Артефакт проверяется до установки, в порядке «подпись над `SHA256SUMS` → checksum
tarball'а → список tar member'ов»; распаковка идёт только после того, как прошли
все проверки.

```bash
sh release/verify-release.sh --artifact dist/releases/infra-cod-<version>-linux-x64.tar.gz \
  --public-key release/keys/infra-cod-release.pub --require-signature \
  --extract /tmp/infra-cod-verify
```

Формат архива, схему manifest'а и порядок проверок описывает
[`docs/RELEASE_FORMAT.md`](RELEASE_FORMAT.md); контракт проверки и распаковки
для установщика — раздел 19 [`docs/OPERATIONS.md`](OPERATIONS.md).

Production signing key ещё не создан, поэтому `--publish` намеренно падает, а
подписанный artifact может собрать только CI на `ubuntu-24.04`. Локальная сборка
на macOS — unsigned dev-кандидат и не является доказательством работы на Ubuntu.

## Приоритет документов

При противоречии документов действует следующий порядок:

1. принятые ADR;
2. `MVP_SPEC.md` для границ V1;
3. `PRODUCT_SPEC.md` для продуктового поведения;
4. `ARCHITECTURE.md`, `RUNTIME_CONTRACT.md`, `EVENTS.md`, `DATA_MODEL.md`;
5. capability matrix и open questions как рабочие проверочные документы.

## Главные ограничения

- Платформа не реализует собственный agent loop.
- Платформа не управляет внутренним LLM-контекстом агентов.
- В V1 один проект имеет одного активного владельца записи workspace.
- Orchestrator/model и executor roster выбираются из capability-verified runtime profiles.
- Publishing capability отделена от роли orchestrator; в начальной конфигурации она разрешена только одобренному Codex profile.
- Конкретный provider или тариф не является частью доменной идентичности агента.
- Неподтверждённые возможности runtime нельзя считать реализуемыми до прохождения PoC.
