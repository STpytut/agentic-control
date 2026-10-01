# MVP Spec

## 1. Цель MVP

Подтвердить, что нативные coding-agent sessions можно безопасно объединить в один последовательный workflow на VPS без существенной потери возможностей.

MVP считается успешным, когда пользователь выполняет полный цикл:

```text
задача → configured orchestrator planning → selected executor implementation → orchestrator review → commit/push
```

после чего система восстанавливает состояние после контролируемого рестарта.

## 2. Pre-MVP: обязательный capability gate

До разработки основного UI выполняются независимые PoC для каждого runtime.

Каждый PoC должен подтвердить:

1. headless запуск на целевой VPS;
2. создание native session;
3. программную передачу сообщения;
4. потоковый вывод;
5. дополнительный ввод в активный run;
6. interrupt;
7. завершение и exit status;
8. сохранение native session ID;
9. resume после перезапуска процесса;
10. способ аутентификации без извлечения секретов из Desktop-приложения.

Codex и OpenCode обязаны пройти gate для MVP. Antigravity может быть перенесён в V1.1, если его headless parity не подтверждена.

## 3. Состав MVP

### Projects

- создать или клонировать проект;
- хранить project metadata;
- открыть project workspace;
- показать git branch, status и diff summary.
- выбрать default orchestrator/model и executor roster.

### Runtime integration

- Codex adapter;
- OpenCode adapter;
- native sessions и resume;
- streaming;
- send input и interrupt;
- нормализованные run statuses.

### Workspace

- один filesystem workspace на проект;
- durable single-writer lock;
- lock owner и lease;
- запрет второго writer;
- ручное освобождение только через безопасную recovery-процедуру.

### Tasks и handoff

- создать task;
- orchestrator `delegate_task()`;
- worker `complete_task()`;
- orchestrator review;
- `request_revision()`;
- status timeline;
- краткий структурированный handoff без истории чужой сессии.

### Security

- worker не получает publishing credentials;
- publishing credentials выдаются отдельной policy capability, а не роли;
- production actions требуют approval;
- audit критических действий;
- секреты не попадают в БД как открытый текст.

### UI

- projects list;
- project page;
- task page;
- live run stream;
- diff/checks;
- input requested state;
- events timeline;
- mobile responsive layout.

### Recovery

- восстановление незавершённых tasks;
- reconciliation процессов и записей runs;
- повторная обработка событий без повторного запуска уже выполненного side effect;
- отображение `needs_attention`, если автоматическое восстановление невозможно.

## 4. Необязательное для первого релиза

- Antigravity adapter;
- Telegram bot;
- Ollama Cloud и дополнительные provider profiles;
- автоматический выбор worker/provider;
- автоматический deployment из панели;
- расширенный редактор diff;
- push notifications.

Эти возможности добавляются после стабильного вертикального workflow.

## 5. Критический acceptance flow

1. Пользователь создаёт проект и подключает repository.
2. Платформа создаёт или возобновляет session выбранного orchestrator.
3. Пользователь формулирует задачу.
4. Orchestrator создаёт task contract и вызывает `delegate_task()` для выбранного executor.
5. Платформа атомарно создаёт handoff, назначает run и передаёт lock.
6. OpenCode изменяет workspace, запускает локальные проверки и вызывает `complete_task()`.
7. Платформа фиксирует completion, освобождает worker lock и возобновляет orchestrator.
8. Orchestrator проверяет реальный diff и либо вызывает `request_revision()`, либо одобряет.
9. При наличии publishing capability orchestrator готовит публикацию; пользователь подтверждает production side effect.
10. Платформа сохраняет полный audit trail.

## 6. Критерии приёмки

- Нельзя одновременно получить два действующих write lease на один project workspace.
- Повторная доставка `implementation.completed` не создаёт второй Codex review run.
- После рестарта сервер восстанавливает task state и может resume обе native sessions.
- Handoff содержит task contract, result summary, checks и ссылки на workspace state, но не содержит полную историю другой сессии.
- Orchestrator видит фактический git diff, а не доверяет только worker summary.
- OpenCode не может прочитать publishing credentials из своего окружения.
- Все опасные side effects имеют actor, timestamp, approval и outcome.
- Отсутствие usage/cache telemetry у runtime не ломает workflow.

## 7. Этапы реализации

### Этап 0. Capability audit

Результат: заполненная capability matrix, прототипы запуска и решение по каждому адаптеру.

### Этап 1. Runtime foundation

Результат: Codex и OpenCode запускаются, стримят события, принимают input и возобновляются.

### Этап 2. Project control plane

Результат: projects, sessions, runs, event store и workspace lock без UI-полировки.

Статус: **завершён 2026-07-17**. PostgreSQL хранит проекты, runtime profiles,
agent sessions, tasks/runs, append-only events/outbox/jobs и fencing locks;
dispatcher, reconciler и checksum migration ledger проверены интеграционными тестами.

### Этап 3. Manual handoff vertical slice

Результат: пользователь вручную переключает ownership между Codex и OpenCode, сохраняя sessions.

### Этап 4. Structured orchestration

Результат: `delegate_task()`, `complete_task()` и `request_revision()` работают
через app-server dynamic tool/worker contracts; handlers остаются
transport-independent, а MCP не обязателен для Codex command path.

Статус: **завершён 2026-07-17**. Живой VPS E2E подтвердил
`delegate_task → complete_task → request_revision → complete_task` с двумя
write-runs, отдельными revision events и одной сохранённой OpenCode session.

### Этап 5. Security и recovery

Результат: approvals, credential isolation, reconciliation, retries и audit.

Статус: **завершён 2026-07-17** для V1 control-plane scope. Реализованы
canonical action fingerprints и одноразовые approvals, credential references
без секретов, append-only audit, операторское разрешение dead-letter incidents,
зашифрованный backup/restore drill, health/metrics alerts и структурированные
worker `report_blocker` / `request_user_input`.

### Этап 6. Product UI

Результат: устойчивый web и mobile workflow.

Статус: **завершён 2026-07-21**. Реализованы project-first/chat-first navigation,
создание и provisioning project, native task chat, live activity, workspace и
handoff verification, interrupt, review, input/blocker, approval и recovery
actions. Responsive/accessibility acceptance, target-VPS restart и транзакционные
failure/recovery drills пройдены без ручного копирования текста между агентами.

Project/task UI уже позволяет выбрать capability-verified orchestrator runtime
profile/model и executor roster; текущий Codex app-server остаётся единственным
orchestrator adapter, прошедшим обязательный gate.

История закрывающих спринтов этапов 0–6 ведётся в [ROADMAP.md](ROADMAP.md).
Live agent activity сохраняет отдельные task, run и heartbeat states; telemetry
не изображает скрытое reasoning модели.

### Этап 7. Optional integrations

Antigravity, Telegram и дополнительные providers добавляются только после прохождения собственных gates.

## 8. Definition of Done

MVP готов, когда критический acceptance flow проходит на чистом VPS, повторяется после рестарта, имеет автоматизированные проверки инвариантов и не требует ручного копирования текста между агентами.
