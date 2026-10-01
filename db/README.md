# PostgreSQL control plane

Первая миграция реализует durable foundation из `DATA_MODEL.md`, `EVENTS.md` и ADR-0002/0007:

- platform IDs отдельно от native runtime IDs;
- идемпотентные mutating commands с проверкой неизменности payload;
- append-only domain events и атомарная запись outbox;
- `SKIP LOCKED` dispatcher lease;
- single-writer workspace lock с монотонным fencing token;
- запрет возврата terminal run в active state.

Вторая миграция добавляет атомарные доменные операции
`request_implementation`, `start_implementation` и
`complete_implementation`. Повтор команды возвращает сохранённый receipt;
dispatcher обязан сначала зарезервировать соответствующий outbox event.

Третья миграция отделяет доставку события от внешнего runtime side effect:

- dispatcher преобразует outbox events в уникальные `runtime_jobs`;
- supervisor отдельно резервирует job и heartbeat-ит job/workspace lease;
- retry и dead-letter состояния хранятся независимо;
- reconciler не повторяет неоднозначный side effect, а переводит workflow в
  `needs_attention`/`reconciliation_required`.

Четвёртая миграция закрепляет function-level `search_path`, чтобы
schema-qualified recovery-вызовы были безопасны и не зависели от клиента.

Пятая миграция добавляет checksum-ledger, capability-bound worker completion
reports, `request_revision()` и отдельные `revision.started` / `revision.completed`.

Шестая и седьмая миграции добавляют approvals, credential references,
append-only audit, worker interaction reports, audited dead-letter resolution,
canonical action fingerprints и native-session continuity guard.

Восьмая миграция добавляет versioned операторские workflow actions:
`approve_task_review()` и `resolve_worker_interaction()`. Ответ на input/blocker
создаёт новый durable handoff с прежними acceptance criteria и возобновляет
сохранённую native OpenCode session через штатный dispatcher/supervisor.

## Запуск

```bash
npm run db:migrate
npm run db:test
```

Runner сверяет SHA-256 уже применённых миграций и блокирует изменённую историю.
Все тесты выполняются внутри транзакций и завершаются через `ROLLBACK`.
