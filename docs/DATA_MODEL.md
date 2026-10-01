# Data Model

## 1. Общие правила

- Внешние native IDs хранятся отдельно от platform IDs.
- Все mutable domain records имеют `version` для optimistic concurrency.
- Время хранится в UTC.
- Secrets хранятся только как references на secret store.
- Events и audit records append-only.
- Удаление проектов в V1 логическое; filesystem cleanup является отдельной подтверждаемой операцией.

## 2. Сущности

### User

- `id`;
- `display_name`;
- `timezone`;
- `created_at`.

V1 допускает одного пользователя, но actor остаётся явным.

### Project

- `id`;
- `owner_id`;
- `name`;
- `slug`;
- `workspace_path`;
- `repository_url`;
- `default_branch`;
- `status`: active/needs_attention/archived (Sprint 7.1E adds
  deleting/deletion_failed/deleted);
- `settings`;
- `version`;
- timestamps.

Sprint 7.1E deletion lifecycle columns (see `0033_project_deletion.sql`):
`deletion_requested_at`, `deletion_not_before` (24h grace by default),
`deleted_at`, `deprovisioned_at`, bounded `deletion_failure_code` /
`deletion_failure_message`, `deletion_attempt_count` and a cleanup
claim/lease pair (`cleanup_leased_by` / `cleanup_leased_until`). The row is
kept as an audit tombstone; owner/version-fenced functions
`request_project_deletion`, `undo_project_deletion`,
`approve_project_delete_now`, `claim_project_cleanup`,
`complete_project_cleanup`, `fail_project_cleanup` and
`retry_project_cleanup` drive the lifecycle. `get_operator_project_deletion_status`
is the owner-scoped tombstone read model.

`workspace_path` после canonicalization обязан находиться внутри разрешённого project root.

### ProviderModelCatalog (Sprint 7.1D, `0027_provider_model_catalog.sql`)

- `id`; `operator_id`; `connection_id` (provider connection);
- identity boundary (unique among rows not `superseded_by` another):
  `connection_id + provider_id + model_id` since 0098; which runtime versions
  list a model is `model_listings`, what a check found is `model_checks` (0099);
- `billing_boundary` (free/go/external_api/chatgpt_subscription);
- `runtime_type`; canonical `provider_id` / `model_id`; `display_name`;
  `provider_badge` / `plan_badge`;
- `reasoning_efforts` / `service_tiers` (bounded arrays);
- `capabilities` (bounded object); `adapter_version` / `runtime_version`;
- `discovery_source` (codex_model_list/opencode_provider_api/manual);
- `status`: discovered/verified/rejected/unavailable — the maintained
  projection of `model_eligibility` since 0099 (`stale` and `verifying` were
  dropped in 0106);
- `discovered_at`, `last_verified_at`, `stale_at`, `last_seen_at`;
- bounded `failure_code` / `failure_message`;
- verification lease pair + `verification_id` (gate identity).

Raw provider responses are never stored: `upsert_catalog_entries` enforces a
strict key allowlist and size bounds. Refresh work is claimed through
`catalog_refresh_jobs` (one active job per connection); gate receipts are
append-only in `model_verification_receipts`. Read models:
`get_operator_model_catalog`, `get_operator_model_catalog_verified`,
`get_operator_catalog_refresh_status`.

### TaskRuntimeSnapshot (Sprint 7.1D, `0028_runtime_selection_snapshots.sql`)

- `task_id` (PK, immutable per task);
- `orchestrator` + `executors` JSON documents: provider/billing boundary,
  canonical model, reasoning effort, service tier, capabilities,
  adapter/runtime version, catalog verification identity/time;
- `source`: catalog (captured from project defaults) or legacy_backfill;
- `captured_from_defaults_version`, `captured_at`.

Project defaults live in `project_runtime_defaults` +
`project_runtime_default_executors` (version-fenced via
`set_project_runtime_defaults`); `capture_task_runtime_snapshot` writes once
and never overwrites. Context/launch reads
(`orchestrator_job_context`, `executor_job_context`,
`resolve_executor_launch_model`) prefer the snapshot so an in-flight task never
reads changed live defaults.

### Agent

Логический участник workflow.

- `id`;
- `name`;
- `role`: architect/reviewer/implementer;
- `runtime_profile_id`;
- `enabled`.

### RuntimeProfile

- `id`;
- `runtime_type`: codex/opencode/antigravity;
- `adapter_version`;
- `runtime_version`;
- `provider_profile_id`;
- `model`;
- `capabilities`;
- `environment_profile`;
- `last_verified_at`.

Sprint 7.1D keeps `runtime_profiles` as the legacy backfill path; verified
`provider_model_catalog` entries become the selectable identity for new
projects/tasks.

### ProjectAgentAssignment

- `id`;
- `project_id`;
- `agent_id`;
- `runtime_profile_id`;
- `assignment_role`: orchestrator/executor — проекция определения роли, которую ведёт триггер 0079; на ней стоит индекс «один оркестратор по умолчанию». Решения её не читают (0080, 0081);
- `role_definition_id` (0079): определение роли — набор прав (ADR-0017);
- `enabled`;
- `is_default` только для orchestrator;
- безопасная `config` без секретов;
- timestamps.

Assignment позволяет выбирать модель независимо от базового Agent, но только
внутри совместимого runtime type. На project может быть только один enabled
default orchestrator.

С 0074 enabled assignment допускается, только если runtime играет роль:
`runtime_plays(runtime_type, assignment_role)` (иначе отказ
`runtime_cannot_play_role` от триггера).

### Runtime roles and capabilities (0074)

Зеркало кода, которое пишут только миграции:

- `runtime_roles(runtime_type, role)` — роли из registry (`runtime-adapters.mjs`);
- `runtime_capabilities(runtime_type, capability)` — что объявляет driver;
- `runtime_role_core(role, capability)` — `ROLE_CORE` из `drivers/capabilities.mjs`.

`runtime_plays(runtime, role)` истинно, когда registry даёт runtime роль и
driver объявляет всё её ядро. Workflow SQL выбирает оркестратора и исполнителя
только так, не по `runtime_type`; имя runtime остаётся идентичностью
(namespace сессии, подключения, словари). Гейт сверяет зеркало с кодом
(`runtime-registry-schema.test.mjs`).

### Role definitions and permissions (0079, ADR-0017)

- `role_permission_vocabulary` — закрытый словарь прав: `conversation.hold`, `implementation.execute`, `review.perform`, `publish.request`, `completion.required`. Расширяется только миграцией.
- `permission_capabilities(permission, capability)` — какие возможности драйвера нужны для права.
- `role_definitions` — именованное версионированное определение. Встроенные (`builtin_key` orchestrator/executor) без владельца, меняются только миграцией; собственные принадлежат владельцу.
- `role_permissions(role_definition_id, permission)` — права определения. Запрещённые сочетания отвергает отложенный триггер.
- `task_role_snapshots(task_id, assignment_id, …, permissions)` — права, с которыми задача получила назначение. Первая запись остаётся навсегда.

`role_holds(role_definition, permission)` (0080) — вопрос, который задают решения рабочего процесса вместо `assignment_role`.

`assignment_may(runtime, role_definition)` истинно, когда драйвер объявляет все возможности всех прав определения; назначение без этого отвергается (`role_permission_unsupported`).

### ProviderProfile

- `id`;
- `provider_type`;
- `display_name`;
- `credential_reference_id`;
- `configuration` без секретов;
- `enabled`.

OpenCode Go, Zen и Ollama являются provider profiles, а не Agents.

### Conversation

- `id`;
- `project_id`;
- `last_sequence` — последний выданный номер события;
- timestamps.

Разговор — линия задач: корневая задача и её follow-up
([ADR-0014](adr/0014-conversation-task-session-run.md)). Создаётся триггером
вместе с корневой задачей; сам по себе не создаётся.

### AgentSession

- `id`;
- `project_id`;
- `agent_id`;
- `runtime_profile_id`;
- `native_session_id` encrypted/opaque;
- `session_namespace` — `runtime_type` профиля, выводится базой;
- `conversation_id`, `role` (`chat`/`executor`) — вместе или никак;
- `purpose` — только описание;
- `status`;
- `last_resumed_at`;
- `metadata`;
- timestamps.

Одна активная сессия на `(conversation_id, role, agent_id)`; один
`native_session_id` — одна строка в своём `session_namespace`.

### Task

- `id`;
- `project_id`;
- `title`;
- `objective`;
- `constraints`;
- `acceptance_criteria`;
- `status`;
- `active_agent_id`;
- `orchestrator_assignment_id`;
- `followup_of_task_id`: nullable self-reference to an immutable terminal source task;
- `conversation_id`: назначается триггером — follow-up наследует разговор источника, иначе новый; не меняется;
- `workflow_version`;
- `created_by`;
- timestamps.

`active_agent_id` — текущий owner workflow stage. Стабильная роль orchestrator
задачи определяется отдельно и не меняется автоматически при handoff.
Follow-up создаётся новой Task в том же Project и том же разговоре: source task
не возвращается из terminal state, assignments и contract копируются, а native
session продолжается без копии — она принадлежит разговору. У задачи не больше
одного follow-up.

### TaskExecutorAssignment

- `task_id`;
- `project_agent_assignment_id`;
- `priority`;
- `enabled`;
- `created_at`.

Task может использовать только executor assignment своего project.

### TaskRun

- `id`;
- `task_id`;
- `session_id`;
- `agent_id`;
- `phase`;
- `status`;
- `native_run_id`;
- `process_ref`;
- `workspace_fencing_token`;
- `started_at`;
- `finished_at`;
- `exit_code`;
- `failure_code`;
- `usage_summary`;
- `version`.

Run бывает двух видов, и различаются они `write_capable`
([ADR-0013](adr/0013-every-native-turn-is-a-run.md)):

- **пишущий** — `implementation` или `revision`, держит workspace lock и fencing
  token;
- **ход оркестратора** — `orchestrator_turn` (чат Codex) или `review_turn`
  (ревью), `write_capable = false`. Создаётся на каждую попытку
  `orchestrator_turn` / `resume_orchestrator` (до 0073 — `codex_chat_turn` /
  `resume_codex`; 0077 переименовал оставшиеся строки); retry — это новый Run, а не
  переиспользованный.

### WorkspaceAccessGrant

Доступ к рабочему каталогу — явный грант, а не побочный эффект открытия канала
(миграция `0060`).

- `id`, `token_sha256` — сам токен выдаётся один раз и в базе не хранится;
- `project_id`, `job_id`, `run_id`, `assignment_id`;
- `mode` — `read_only` для хода оркестратора, `read_write` для пишущего run;
  выводится из вида run, вызывающий его не выбирает;
- `fencing_token` — только для `read_write`, токен замка на момент выдачи;
- `issued_to`, `issued_at`, `expires_at`, `revoked_at`, `revoke_reason`.

Грант не называет ни ОС-аккаунт, ни путь: рантайм определяется через назначение.

### Handoff

- `id`;
- `task_id`;
- `from_agent_id`;
- `to_agent_id`;
- `source_run_id`;
- `target_run_id`;
- `revision_number`;
- `objective`;
- `instructions`;
- `constraints`;
- `acceptance_criteria`;
- `relevant_paths`;
- `workspace_ref`;
- `result_summary`;
- `checks_summary`;
- timestamps.

### DomainEvent

- envelope fields из [Events](EVENTS.md);
- `conversation_id`, `conversation_sequence` — у события задачи всегда, у события
  проекта никогда; номер выдаёт триггер;
- `payload_json`;
- `schema_version`;
- `published_at`.

### OutboxMessage

- `id`;
- `event_id`;
- `destination`;
- `status`;
- `attempt_count`;
- `available_at`;
- `leased_until`;
- `last_error`.

### RuntimeJob activity telemetry

RuntimeJob дополнительно хранит best-effort наблюдаемое состояние запуска:

- `activity_phase`;
- `activity_detail`;
- `started_at`;
- `heartbeat_at`;
- `leased_until`.

Telemetry не является task lifecycle state и не описывает скрытое reasoning
модели. Подтверждённый heartbeat обновляется worker вместе с runtime lease.

### WorkspaceLock

- `project_id` primary key;
- `owner_run_id`;
- `mode`;
- `fencing_token`;
- `lease_expires_at`;
- `heartbeat_at`;
- `version`.

### CheckRun

- `id`;
- `task_run_id`;
- `command`;
- `status`;
- `exit_code`;
- `artifact_ref`;
- timestamps.

Заявленная worker проверка и independently observed check должны различаться полем provenance.

### Approval

- `id`;
- `project_id`;
- `task_id`;
- `action_type`;
- `action_fingerprint`;
- `requested_by`;
- `requested_at`;
- `decided_by`;
- `decision`;
- `decided_at`;
- `expires_at`;
- `reason`.

### CredentialReference

- `id`;
- `provider`;
- `secret_locator`;
- `scope`;
- `allowed_agent_ids`;
- `allowed_actions`;
- timestamps.

### Deployment

- `id`;
- `project_id`;
- `task_id`;
- `git_sha`;
- `target`;
- `status`;
- `approval_id`;
- `external_deployment_id`;
- `url`;
- timestamps.

### Artifact

- `id`;
- `project_id`;
- `run_id`;
- `type`;
- `storage_locator`;
- `content_type`;
- `size_bytes`;
- `sha256`;
- `redaction_status`;
- timestamps.

### AuditEvent

Append-only запись согласно [Events](EVENTS.md).

## 3. Главные связи

```text
User 1─* Project
Project 1─* Conversation
Conversation 1─* Task (линия follow-up)
Conversation 1─* AgentSession
Conversation 1─* DomainEvent (по conversation_sequence)
Project 1─* AgentSession
Project 1─* ProjectAgentAssignment
Project 1─* Task
ProjectAgentAssignment 1─* TaskExecutorAssignment
Task 1─* TaskRun
Task 1─* Handoff
Task 1─0..1 Follow-up Task
AgentSession 1─* TaskRun
Project 1─0..1 WorkspaceLock
TaskRun 1─* CheckRun
Task/Project 1─* Approval
Project 1─* Deployment
Any aggregate 1─* DomainEvent/AuditEvent
```

## 4. Инварианты

1. Один project имеет не более одного действующего write lock.
2. Write-capable active run обязан ссылаться на текущий fencing token.
3. Completed run не возвращается в running.
4. Один idempotency key соответствует одному command payload и result.
5. Publish/deploy привязан к immutable git SHA и approval fingerprint.
6. Worker agent не может быть actor успешного publish/deploy event.
7. Handoff result не изменяет acceptance criteria исходной задачи без новой workflow version.
8. Native session ID никогда не показывается как пользовательский секрет и не используется между runtime types.
9. Task orchestrator и executor roster ссылаются только на enabled assignments своего project.
10. Model выбирается через RuntimeProfile; runtime launch не принимает непроверенный model override от клиента.
11. Каждая попытка оркестраторского хода имеет Run: `runtime_jobs` типа `orchestrator_turn`/`resume_orchestrator` (или прежних `codex_chat_turn`/`resume_codex`) с `attempt_count > 0` обязан иметь `run_id` (CHECK `runtime_jobs_orchestrator_turn_has_run`).
12. `lost` — только у пишущего run, чья аренда workspace истекла. Ход оркестратора с истёкшей арендой — `failed` (`turn_lease_expired`): восстановление замка доверяет `lost` как признаку писателя.
13. Задача не меняет разговор; в разговор входит только follow-up; у задачи не больше одного follow-up (`tasks_followup_is_linear`).
14. События задачи в разговоре пронумерованы `1..last_sequence` без пропусков и повторов (`domain_events_conversation_order`); порядок чата — этот номер.
15. Одна активная сессия на `(conversation_id, role, agent_id)`; `native_session_id` уникален в `session_namespace`. Инвариант 8 теперь держит база: namespace выводится из профиля, чужая сессия закрывается, а не продолжается.
13. Ход оркестратора не берётся в работу, пока пишущий run держит workspace (`held` или `reconciliation_required`): сообщение сохраняется и ждёт.
14. Грант доступа разрешается заново перед каждым действием: аренда job, активный run, замок и fencing token для `read_write`, отсутствие чужого писателя для `read_only`, срок и отзыв. Завершение run отзывает его живой грант в той же транзакции.

## 5. Retention

- Domain events и audit: долгосрочно.
- Task/run metadata: долгосрочно.
- Raw stream: настраиваемый срок, затем compacted artifacts.
- Tool outputs: по размеру и чувствительности.
- Secrets: не попадают в retention pipeline.
- Workspace: до явного архивирования/удаления проекта.
