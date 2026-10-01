# Architecture Decision Records

| ADR | Решение | Статус |
| --- | --- | --- |
| [0001](0001-native-runtime-integration.md) | Интегрировать официальные capability-complete native runtime | Accepted |
| [0002](0002-single-writer-workspace.md) | Использовать single-writer workspace в V1 | Accepted |
| [0003](0003-context-boundary.md) | Не управлять внутренним контекстом агентов | Accepted |
| [0004](0004-agent-runtime-provider-model.md) | Разделить Agent, Runtime, Provider и Model | Accepted |
| [0005](0005-event-driven-handoffs.md) | Использовать структурированные event-driven handoff | Accepted |
| [0006](0006-codex-publishing-authority.md) | Ограничить публикацию ролью Codex с approvals | Accepted |
| [0007](0007-postgres-first-control-plane.md) | Начать с PostgreSQL event/outbox вместо тяжёлой orchestration infrastructure | Accepted |
| [0008](0008-codex-platform-tool-transport.md) | Использовать app-server dynamic tools для control-plane команд Codex | Accepted |
| [0009](0009-configurable-agent-roster.md) | Выбирать orchestrator/model и executor roster на уровне project/task | Accepted; partially supersedes 0006 |
| [0010](0010-runtime-instances.md) | Изолированные именованные runtime instances, привязанные к connection и native home | Proposed; Sprint 7.2 design target |
| [0011](0011-self-hosted-access-model.md) | Модель доступа self-hosted установки: 1:1 Linux↔DB роли, `infra_web` без DML, privileged FS только в Runtime Supervisor | Accepted |
| [0012](0012-runtime-provisioning-supply-chain.md) | Цепочка поставки agent-рантаймов: платформенный пакет из npm-реестра, пиннованный ключ подписи, точная версия, root-owned дерево, переключение под fence супервизора | Accepted |
| [0013](0013-every-native-turn-is-a-run.md) | Каждая попытка хода Codex (чат и ревью) — отдельный read-only Run; создаётся триггером, никогда не бывает `lost` | Accepted |
| [0014](0014-conversation-task-session-run.md) | Conversation, Task, NativeSession и Run — разные сущности: разговор линеен, сессия не копируется, порядок разговора — номер в `append_event` | Accepted |
| [0015](0015-review-evidence-and-publish-boundary.md) | Ревью и публикация привязаны к неизменяемому свидетельству: четыре обязательных дайджеста с каноническим алгоритмом, вердикт ссылается на дайджест, `prepare_publish` отвергает сдвинувшееся дерево; push и PR — ручной шаг в 11.1b | Accepted |
| [0016](0016-ingress-mailbox-tool-socket-provenance.md) | Два канала к агенту — ingress разговора создаёт прогон, ящик команд (`input_response`, `steer`, `interrupt`) идёт в живой прогон с квитанцией рантайма; сокет инструментов на прогон, принадлежащий uid рантайма; выбор задания пишется один раз, каждый запуск дописывается | Accepted |
| [0017](0017-roles-are-permission-sets.md) | Роль — набор прав из закрытого словаря (`conversation.hold`, `implementation.execute`, `review.perform`, `publish.request`, `completion.required`); назначение ссылается на определение роли, задача снимает права; публикация всегда за одобрением | Accepted |
| [0018](0018-four-access-dimensions.md) | Runtime, производитель, шлюз доступа и учётные данные — четыре измерения; подключения GitHub и моделей не пересекаются; проверка модели привязана к шлюзу; push и PR выполняет супервизор токеном установки GitHub App | Accepted |
| [0019](0019-provider-usage-probe.md) | Лимиты OpenCode Go читает фиксированная проба от имени пользователя рантайма: ключ не покидает его, адрес — константа, вывод — только числа по закрытой схеме, которую проверяет супервизор; OpenRouter — только расход, баланс не читаем | Accepted |

Новый ADR не переписывает старый: при изменении решения создаётся новый документ, который явно supersedes предыдущий.
