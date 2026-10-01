# ADR-0006: Codex is the only agent publishing authority

- Status: Partially superseded by ADR-0009
- Date: 2026-07-14

## Context

Workers нужны для реализации, но не должны иметь возможность обойти review и опубликовать изменения.

## Decision

В исходной V1-конфигурации только одобренный Codex runtime profile получает
policy scope для commit/push, GitHub, Supabase, Vercel и deployment.
ADR-0009 отделяет эту capability от роли orchestrator: выбор другого
orchestrator не передаёт ему publishing scope автоматически. Пользовательские
approvals применяются к опасным и production side effects.

## Consequences

- OpenCode и Antigravity запускаются без publishing credentials.
- `complete_task()` переводит работу на review, а не публикует её.
- Publish/deploy привязан к immutable git SHA и approval.
- Компрометация worker имеет ограниченный blast radius.
- Пользователь сохраняет право запретить публикацию.
