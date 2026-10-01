# ADR-0003: Native runtime owns internal context

- Status: Accepted
- Date: 2026-07-14

## Context

Была рассмотрена идея отдельного Context Manager для cache keys, prompt assembly, compaction, project memory и file selection. Это дублирует native harness и противоречит цели сохранить возможности агентов.

## Decision

Внутренним контекстом полностью управляет native runtime:

- conversation history;
- prompt caching;
- compaction;
- working memory;
- file retrieval;
- tool-result retention.

Платформа реализует только Session & Handoff Manager:

- хранит native session references;
- выполняет resume;
- передаёт task contract и result summary;
- хранит task/event state;
- показывает доступную usage telemetry.

## Consequences

- Компонент `Context Manager` запрещён текущей архитектурой.
- Платформа не формирует стабильные provider prompt prefixes и cache namespaces.
- Отсутствие cache metrics не блокирует MVP.
- Handoff остаётся коротким и структурированным, но не подменяет native context.
- Project instruction files могут существовать как пользовательские repository artifacts, но не как обязательная самописная memory subsystem.
