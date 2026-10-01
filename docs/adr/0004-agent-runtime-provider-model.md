# ADR-0004: Separate Agent, Runtime, Provider and Model

- Status: Accepted
- Date: 2026-07-14

## Context

Один OpenCode runtime может использовать Go, Zen, Ollama или другого provider. Тариф и модель меняются быстрее, чем роль агента и workflow.

## Decision

Использовать отдельные сущности:

- Agent — логическая роль в workflow;
- Runtime — исполняющий harness/interface;
- ProviderProfile — источник моделей и credentials;
- Model — выбранная модель/alias.

## Consequences

- OpenCode Go — стартовый provider profile, не отдельный agent.
- Zen не включён по умолчанию.
- Ollama Cloud может добавляться без нового runtime adapter, если поддерживается OpenCode.
- Routing может выбирать provider/model, не меняя task protocol.
- Цены и тарифные лимиты не фиксируются в нормативном ТЗ.
