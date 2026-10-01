# ADR-0002: Single-writer project workspace in V1

- Status: Accepted
- Date: 2026-07-14

## Context

Текущий рабочий процесс последовательный: Codex, затем worker, затем Codex review. Параллельные изменения потребовали бы worktrees, merge orchestration и разрешения конфликтов.

## Decision

В V1 один project workspace имеет не более одного write owner. Ownership защищается durable lease и fencing token.

## Consequences

- Нет автоматических worktrees и параллельных writers в V1.
- Handoff включает передачу lock.
- UI явно показывает owner и причину ожидания.
- Crash recovery обязан reconciliate lock до запуска следующего writer.
- Будущий parallel mode реализуется отдельным ADR поверх explicit worktree model.
