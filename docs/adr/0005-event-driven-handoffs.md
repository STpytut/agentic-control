# ADR-0005: Structured event-driven handoffs

- Status: Accepted
- Date: 2026-07-14

## Context

Парсинг свободного текста вроде «пусть OpenCode продолжит» ненадёжен и не даёт audit, retries и recovery.

## Decision

Делегирование и завершение выполняются структурированными tools/commands:

- `delegate_task()`;
- `complete_task()`;
- `request_revision()`;
- `report_blocker()`;
- `request_user_input()`.

Control plane фиксирует доменные события и передаёт управление через durable workflow.

## Consequences

- Свободный текст не запускает side effects.
- События имеют schema version, idempotency и correlation.
- At-least-once delivery требует idempotent consumers.
- Система может восстанавливаться после рестарта и строить timeline.
- Codex принимает интеллектуальные решения; event bus только доставляет факты и команды.
