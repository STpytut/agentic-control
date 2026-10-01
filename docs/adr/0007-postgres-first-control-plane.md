# ADR-0007: PostgreSQL-first durable control plane

- Status: Accepted
- Date: 2026-07-14

## Context

Kafka, RabbitMQ и Temporal увеличивают операционную сложность персонального single-VPS продукта. При этом workflow нуждается в durable events, retries и recovery.

## Decision

Использовать PostgreSQL как источник истины, event/outbox store и начальную job queue. Дополнительный Redis/BullMQ допустим после измерения нагрузки, но не заменяет durable domain state.

## Consequences

- State transition и outbox event записываются одной транзакцией.
- Dispatcher использует leases/`SKIP LOCKED` или эквивалент.
- Consumers остаются idempotent.
- Эксплуатация V1 проще.
- Переход к специализированной orchestration infrastructure возможен позднее без изменения event contracts.
