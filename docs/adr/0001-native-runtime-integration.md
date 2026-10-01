# ADR-0001: Capability-complete native runtime integration

- Status: Accepted
- Date: 2026-07-14

## Context

Desktop, CLI, server и API поверхности одного продукта могут иметь разные возможности. Простая CLI-обёртка рискует потерять sessions, streaming, tools, approvals, interrupts и resume.

## Decision

Для каждого агента выбирается самый низкоуровневый официальный interface, который проходит capability gate и пригоден для headless remote control.

Выбор не фиксируется заранее словом «CLI»:

- Codex: App Server/API или CLI;
- OpenCode: Server/API или CLI;
- Antigravity: официальный headless runtime/CLI после PoC.

До production adapter обязателен capability audit.

## Consequences

- Реализация начинается с PoC, а не UI.
- Adapter contract остаётся общим, реализации runtime-specific.
- Desktop-only UX не блокирует продукт, если core agent capability доступна headless.
- Antigravity может быть исключён из MVP, если parity не подтверждена.
- Private protocol и извлечение Desktop credentials запрещены без нового ADR/security review.
