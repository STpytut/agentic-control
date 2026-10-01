# Events and Workflow Protocol

## 1. Принципы

- Команда выражает намерение выполнить действие.
- Событие фиксирует уже произошедший факт.
- События неизменяемы.
- Доставка at-least-once; consumers обязаны быть идемпотентными.
- Свободный текст runtime не создаёт доменное событие без структурированного tool call или подтверждённого adapter signal.
- State transition и outbox event сохраняются одной транзакцией.

## 2. Event envelope

```json
{
  "id": "evt_01...",
  "type": "implementation.completed",
  "version": 1,
  "project_id": "prj_...",
  "task_id": "tsk_...",
  "run_id": "run_...",
  "actor": {
    "type": "agent",
    "id": "agt_opencode"
  },
  "causation_id": "cmd_...",
  "correlation_id": "tsk_...",
  "idempotency_key": "...",
  "occurred_at": "2026-07-14T00:00:00Z",
  "conversation_id": "cnv_...",
  "conversation_sequence": 42,
  "payload": {}
}
```

`conversation_id` и `conversation_sequence` есть у каждого события задачи и
отсутствуют у событий проекта. Номер выдаёт база при вставке — следующий в
разговоре задачи, без пропусков; переданные значения игнорируются. Порядок
разговора — этот номер, а не `occurred_at`: часы писателя показывают, когда он
начал писать, а не когда разговор получил событие
([ADR-0014](adr/0014-conversation-task-session-run.md)).

Payload не содержит secrets и больших бинарных outputs. Для них используется artifact reference.

## 3. Команды

- `CreateTask`;
- `CreateFollowupTask`;
- `StartPlanning`;
- `DelegateTask`;
- `StartImplementation`;
- `CompleteImplementation`;
- `ReportBlocker`;
- `RequestUserInput`;
- `SubmitUserInput`;
- `StartReview`;
- `RequestRevision`;
- `ApproveTask`;
- `RequestPublish`;
- `ApprovePublish`;
- `StartPublish`;
- `RequestDeploy`;
- `ApproveDeploy`;
- `CancelRun`;
- `CancelTask`.

Каждая mutating API command принимает idempotency key.

## 4. Доменные события

### Chat

- `chat.user_message`;
- `chat.agent_message`.

`chat.user_message` маршрутизируется в уникальный runtime job по стабильной
task orchestrator assignment. Это `orchestrator_turn` (до 0073 — `codex_chat_turn`; с 0077 старое имя не
принимается и не хранится) для оркестратора любого runtime, который играет эту роль. Временный active executor не меняет
маршрут чата. `chat.agent_message` фиксирует completed native turn и повторно
оркестратору не маршрутизируется.

Сообщение, отправленное из `approved`, `deployed` или `completed` task, сначала
выполняет `CreateFollowupTask`. Новый `planning` task получает собственный
`chat.user_message`, ссылку `followup_of_task_id`, прежние assignments и тот же
разговор. Session rows не копируются: сессия принадлежит разговору, и follow-up
продолжает ту же строку. Terminal source не меняет status/version; создание
фиксируется audit action `task.followup_created`. У задачи не больше одного
follow-up (`followup_exists`): разговор — линия.

Граница пользовательской переписки — Conversation, а не Task. Web читает
события разговора по `conversation_sequence` и направляет новые сообщения в
последний task разговора.

### Task

- `task.created`;
- `task.cancelled`;
- `task.failed`;
- `task.needs_attention`;
- `task.completed`.

### Planning

- `plan.started`;
- `plan.completed`.

### Implementation

- `implementation.requested`;
- `implementation.started`;
- `implementation.completed`;
- `implementation.blocked`.

### Review и revision

- `review.started`;
- `review.completed`;
- `changes.requested`;
- `revision.started`;
- `revision.completed`;
- `task.approved`.

### Publish и deployment

- `publish.requested`;
- `publish.approval_requested`;
- `publish.approved`;
- `publish.started`;
- `publish.completed`;
- `publish.failed`;
- `deployment.requested`;
- `deployment.approval_requested`;
- `deployment.approved`;
- `deployment.started`;
- `deployment.completed`;
- `deployment.failed`.

### Run и session

- `session.created`;
- `session.resumed`;
- `run.queued`;
- `run.started`;
- `run.input_requested`;
- `run.input_received`;
- `run.interrupted`;
- `run.completed`;
- `run.failed`;
- `run.lost`.

### Workspace

- `workspace.lock_requested`;
- `workspace.lock_acquired`;
- `workspace.lock_renewed`;
- `workspace.lock_released`;
- `workspace.lock_expired`;
- `workspace.reconciliation_required`.

## 5. State machine Task

```text
draft
  → planning
  → ready
  → implementation_requested
  → implementing
  → awaiting_review
  → reviewing
      ├→ changes_requested → revising → awaiting_review
      └→ approved → publishing → deployed/completed

Любое активное состояние:
  → failed
  → cancelled
  → needs_attention
```

Публикация не обязательна для завершения локальной задачи; task может завершиться как `approved`/`completed` без deployment.

## 6. Делегирование

`delegate_task()` должно:

1. проверить, что caller — разрешённая Codex session или пользователь;
2. проверить task state;
3. проверить assignee/runtime availability;
4. записать handoff contract;
5. сохранить `implementation.requested` в outbox;
6. вернуть command receipt.

Dispatcher:

1. получает событие;
2. атомарно резервирует обработку;
3. получает workspace lease;
4. создаёт/resume worker session;
5. создаёт run;
6. отправляет handoff input;
7. фиксирует `implementation.started`.

## 7. Completion

`complete_task()` принимается только если:

- run активен;
- agent совпадает с assignee;
- fencing token актуален;
- task находится в implementation/revision state.

Completion не означает автоматическое одобрение. Он переводит task в `awaiting_review` и инициирует resume Codex.

## 8. Идемпотентность

Примеры ключей:

- `delegate:{task_id}:{revision_number}`;
- `complete:{run_id}`;
- `review:{task_id}:{implementation_version}`;
- `publish:{task_id}:{git_sha}`;
- `deploy:{project_id}:{git_sha}:{target}`.

Повторная команда с тем же key возвращает прежний result. Команда с тем же key и другим payload отклоняется.

## 9. Retry policy

Автоматически повторяются:

- временная ошибка доставки;
- получение статуса;
- resume stream;
- idempotent session lookup;
- lock heartbeat.

Не повторяются без reconciliation:

- отправка нового сообщения, если receipt неизвестен;
- commit;
- push;
- migration;
- deployment;
- credential mutation.

После лимита попыток событие переходит в dead-letter/`needs_attention` и показывается пользователю.

## 10. Ordering и concurrency

- Внутри task используется monotonic workflow version.
- Команда указывает expected version; stale command отклоняется.
- Run stream имеет собственный sequence.
- Нет глобальной гарантии порядка между разными проектами.
- Один project writer обеспечивается lock, а не предположением о порядке событий.
- ходы оркестратора (`orchestrator_turn`, прежде `codex_chat_turn`) выполняются последовательно внутри task; более поздний job
  ожидает completion или dead-letter всех ранних chat jobs этого task.

## 11. Audit

Audit event хранит:

- actor;
- action;
- target;
- policy decision;
- approval reference;
- before/after state reference;
- outcome;
- timestamp;
- correlation ID.

Raw reasoning модели не требуется и не должно сохраняться как audit.
