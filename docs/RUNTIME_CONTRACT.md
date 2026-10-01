# Runtime Contract

## 1. Назначение

Runtime Adapter изолирует control plane от различий Codex, OpenCode и Antigravity, сохраняя их нативные возможности. Адаптер не реализует собственное рассуждение, tool loop, prompt cache или memory.

## 2. Выбор интеграционной поверхности

Для каждого агента выбирается наиболее низкоуровневый официальный interface, который проходит capability gate:

- Codex: официальный App Server/API или CLI;
- OpenCode: официальный server/API или CLI;
- Antigravity: официальный headless runtime/CLI, если подтверждён.

Desktop automation не используется как серверный runtime, если официальный headless interface покрывает требования. Desktop-only UX может воспроизводиться в presentation layer, но не считается agent capability.

## 3. Базовый интерфейс

```ts
interface AgentRuntimeAdapter {
  readonly runtimeType: string;

  probe(input: ProbeInput): Promise<CapabilityReport>;

  createSession(input: CreateSessionInput): Promise<NativeSessionRef>;

  resumeSession(input: ResumeSessionInput): Promise<NativeSessionRef>;

  startRun(input: StartRunInput): Promise<RunHandle>;

  sendInput(input: SendInputInput): Promise<CommandReceipt>;

  interrupt(input: InterruptInput): Promise<CommandReceipt>;

  stop(input: StopInput): Promise<CommandReceipt>;

  getRunStatus(input: GetRunStatusInput): Promise<RuntimeRunStatus>;

  stream(input: StreamInput): AsyncIterable<RuntimeEvent>;

  getUsage?(input: GetUsageInput): Promise<UsageReport>;
}
```

Фактический язык реализации может отличаться; семантика обязательна.

## 4. Входные данные run

```ts
type StartRunInput = {
  platformRunId: string;
  nativeSessionId: string;
  projectId: string;
  workspacePath: string;
  workspaceFencingToken?: number;
  mode: "read_write" | "read_only";
  message: string;
  environmentProfile: string;
  providerProfile?: string;
  model?: string;
};
```

Adapter получает готовый handoff message либо пользовательский input. Он не дополняет его скрытой project memory, кроме минимальных технических инструкций конкретного runtime.

## 5. Нормализованные статусы

- `queued`;
- `starting`;
- `running`;
- `waiting_for_input`;
- `completed`;
- `failed`;
- `interrupted`;
- `cancelled`;
- `lost`;
- `needs_attention`.

Adapter обязан сохранять raw runtime status для диагностики.

Долгий run публикует bounded activity phases (`starting_runtime`,
`opening_session`, `running_turn`, `finalizing`) и heartbeat. Presentation layer
может показывать только эти подтверждённые фазы и не должна генерировать
фиктивные сообщения о внутренних шагах модели.

## 6. Нормализованные события

Минимум:

- `runtime.session.created`;
- `runtime.session.resumed`;
- `runtime.run.started`;
- `runtime.output.delta`;
- `runtime.message.completed`;
- `runtime.tool.started`;
- `runtime.tool.completed`;
- `runtime.input.requested`;
- `runtime.usage.reported`;
- `runtime.run.completed`;
- `runtime.run.failed`;
- `runtime.run.interrupted`.

Если runtime не предоставляет структурированное событие, adapter может выдать `runtime.raw`, но не должен делать ненадёжный парсинг свободного текста основанием для side effect.

## 7. Сессии

- Native session ID хранится opaque.
- Resume обязан использовать официальный механизм runtime.
- Если runtime не поддерживает resume, это фиксируется capability matrix и не маскируется созданием новой сессии.
- Новая сессия не должна называться resume.
- История native session не копируется в БД платформы как замена runtime history.

### 7.1. Orchestrator chat delivery

- transport определяется выбранным capability-verified orchestrator adapter;
- текущий Codex transport: `codex app-server --listen stdio://` через Runtime Supervisor;
- новый task: `thread/start`, следующий ввод: `thread/resume`;
- thread sandbox: только `read-only`, approval policy: `never`. Это песочница
  команд Codex, а не свойство каталога: grant хода (`read_only`) лишь не пускает
  писателя, а чтобы Codex мог читать дерево, супервизор передаёт его учётной
  записи владение. Поэтому инструкции хода не называют рабочий каталог read-only
  (WP-7, §16);
- `clientUserMessageId` равен immutable source event ID;
- native thread ID фиксируется до `turn/start`, чтобы retry мог продолжить уже
  созданную сессию;
- ответ принимается только после `turn/completed` со статусом `completed` и
  сохраняется из structured `agentMessage`, а не из свободного stdout.
- runtime profile берётся из immutable task orchestrator assignment, а не из
  временного `active_agent_id` и не из произвольной строки клиента.

## 8. Input и интерактивность

Adapter должен различать:

- дополнительное сообщение пользователя;
- ответ на структурированный runtime request;
- interrupt;
- platform handoff command.

Свободный текст агента не должен автоматически интерпретироваться как `delegate_task`, `complete_task` или publish request. Для этого используются tools/API contracts.

С Stage 11.1b (WP-9) первые и последние два пункта — разные каналы: новое
сообщение и хэндофф идут через ingress разговора и создают новый прогон, ответ,
steer и interrupt — команды в ящик идущего прогона (§17).

## 9. Worker integration contract

Минимальные platform tools для implementation agents:

```ts
complete_task({ changed_files, summary, checks, notes? })

report_blocker({
  task_id,
  reason,
  attempted?,
  requested_action?
})

request_user_input({
  task_id,
  question,
  sensitivity?
})
```

Task/run/agent/fencing context не принимается от модели: supervisor передаёт
одноразовую capability, а gateway связывает её с уже проверенным runtime job.
Транспорт — сокет этого прогона, принадлежащий аккаунту его рантайма (§18).
Tool сохраняет immutable completion report; доменная completion и освобождение
workspace lock происходят только после выхода worker process. Между ними
супервизор записывает свидетельство ревью (§16) — пока прогон ещё держит каталог
и его fencing-токен; прогон, база которого записана, без свидетельства не
завершается.

## 10. Platform tools для Codex

В MVP command transport — app-server dynamic tools, зарегистрированные на
Codex thread. Вызовы приходят control plane как структурированные
`item/tool/call` requests с native `threadId`, `turnId` и `callId`.

Handlers не зависят от transport и обязаны валидировать active run, task state,
assignment, workspace ownership/fencing token, idempotency key и arguments.
Отдельный Platform MCP не дублирует command tools в MVP, но может быть добавлен
для ресурсов или других runtime surfaces. См. [ADR-0008](adr/0008-codex-platform-tool-transport.md).

Минимальные tools:

- `delegate_task()`;
- `request_revision()`;
- `get_task_status()`;
- `get_agent_status()`;
- `get_run_status()`;
- `run_checks()`;
- `request_publish()`;
- `request_deploy()`;
- `notify_user()`.

Deferred MCP/equivalent read resources:

- `platform://projects`;
- `platform://projects/{id}`;
- `platform://tasks/{id}`;
- `platform://runs/{id}`;
- `platform://events?task_id=...`.

Platform tools не заменяют filesystem, shell, GitHub и другие native Codex
tools.

## 11. Authentication

Допустимы только официальные способы headless authentication. Adapter не должен:

- читать cookies или токены Desktop-приложений;
- копировать секреты из пользовательского профиля без явной настройки;
- логировать access/refresh tokens;
- передавать worker credentials другого runtime.

## 12. Capability gate

Adapter допускается в production после автоматизированного smoke test:

1. `probe` подтверждает версию и auth;
2. создаётся тестовая session;
3. выполняется run в sandbox workspace;
4. проверяется stream;
5. проверяется input request/response, если поддерживается;
6. выполняется interrupt;
7. процесс перезапускается;
8. проверяется resume;
9. подтверждается отсутствие publishing secrets;
10. результаты записываются в capability matrix.

## 13. Версионирование

Каждый adapter объявляет:

- adapter version;
- runtime version range;
- protocol version;
- capability flags;
- дату последней проверки.

Неизвестная major runtime version блокирует write-capable запуск до повторного smoke test либо явного override пользователя.

## 14. Реестр адаптеров — источник, а не одна из копий

С Stage 11.1b (WP-5a) всё, что установка знает о рантайме, объявлено в
[`services/operations/runtime-adapters.mjs`](../services/operations/runtime-adapters.mjs):
Unix-пользователь и домашний каталог, каталоги состояния с правами (`sandboxPaths`),
что входит в бэкап (`backup`), роль (`orchestrator`/`executor`), какие runtime jobs
он обслуживает и под каким provider записываются его подключения (`dispatch`),
его собственные unit-ы (`units`), имя в панели (`display`). Пути, которые не
принадлежат рантайму, — корень workspaces, gate-smoke, каталоги GitHub, fence —
объявлены отдельно в
[`installation-layout.mjs`](../services/operations/installation-layout.mjs): у
установки один корень проектов, и два дескриптора не могут объявить два.

Код, который может импортировать реестр, импортирует его: `unit-contract.mjs`
выводит из него пути песочницы, backup, supervisor и воркеры — значения по
умолчанию. Копии, которые импортировать не могут, сравниваются тестами:

| Копия | Чем сравнивается |
| --- | --- |
| CHECK-и и функции-валидаторы в схеме | `runtime-registry-schema.test.mjs` по мигрированной базе |
| `apps/web/src/lib/runtime-labels.ts` | `runtime-registry.test.mjs` |
| `deploy/tmpfiles.d`, `deploy/install.sh`, unit-ы | `runtime-registry.test.mjs`, `unit-contract.test.mjs` |
| литералы путей в `services/` | `runtime-registry.test.mjs`: вне двух объявлений их нет |

`antigravity` схема принимает с 0001, а установка не поставляет: имя объявлено в
`RESERVED_RUNTIME_NAMES` с причиной, чтобы сравнение было точным в обе стороны.

**Как добавить рантайм.** Добавить дескриптор и прогнать тесты: оба теста
с вымышленным третьим рантаймом перечисляют каждое место, которое о нём ещё не
знает, — это и есть список работы. Поведение (как рантайм подключается и
запускается) в дескриптор не входит: это runtime driver, §15. Тест с вымышленным
рантаймом называет и отсутствие драйвера.

## 15. Runtime driver — как рантайм ведут, а не как его ставят

С Stage 11.1b (WP-5b) у каждого дескриптора есть драйвер в
[`services/runtime-supervisor/drivers/`](../services/runtime-supervisor/drivers/).
Дескриптор отвечает, как рантайм установлен; драйвер — как им управляют. Семь
членов обязательны для любого драйвера: `sessions`, `run`, `stream`, `input`,
`interrupt`, `toolBridge`, `normalizeEvent`. Интерфейс §3 остаётся семантикой;
драйвер — её реализация для одного рантайма.

**Поверхности.** Драйвер объявляет, на каких поверхностях рантайм запускается, и
как супервизор их несёт:

| Транспорт | Что это | Запрос протокола 2 |
| --- | --- | --- |
| `channel` | процесс, которым клиент управляет через stdin/stdout | `runtime_open` |
| `batch` | запуск, который супервизор доводит до конца | `runtime_run` |
| `local_server` | loopback-сервер на одну операцию с аккаунтом | `runtime_account` |

Поверхность называет, откуда рабочий каталог (`grant` — по непрозрачному grant,
`home` — домашний каталог рантайма, `gate` — scratch под корнем gate) и какую
возможность она задействует. Клиент и супервизор отказывают поверхности, которой
у драйвера нет или которую он несёт иначе; вендорских методов у клиента и
вендорских веток у супервизора больше нет.

**Возможности.** Словарь закрыт
([`capabilities.mjs`](../services/runtime-supervisor/drivers/capabilities.mjs)).
Ядро по роли обязательно:

| Роль | Ядро |
| --- | --- |
| orchestrator | `sessions.create`, `sessions.resume`, `run.read_only`, `stream.structured`, `interrupt`, `tools.platform`, `events.raw` |
| executor | `sessions.create`, `sessions.resume`, `run.workspace_write`, `stream.structured`, `interrupt`, `tools.worker_report`, `events.raw` |

Драйвер без любой части ядра своей роли отвергается при загрузке модуля — до того,
как супервизор начнёт слушать и воркер возьмёт задачу, — с именем недостающей
возможности; так же отвергается возможность, объявленная членом, которого нет.
Всё сверх ядра — необязательные возможности, объявленные и доступные по имени
(`usage.report`, `account.*`, `catalog.models`, `gate.smoke`): абстракция не
должна срезать то, что рантайм умеет.

**Сырые события.** Каждое нативное событие хранится рядом с нормализованным:
нормализованное несёт `native_type`, событие без нормализованной формы не
теряется — это нативное расширение, которое панель может пропустить. Сырой поток
OpenCode возвращается целиком (ограниченный, 4 MiB); сессия Codex держит каждое
JSON-RPC сообщение.

**Пара версий.** Драйвер проверен на одной точной паре адаптер/рантайм
(`verified`: Codex 0.154.0, OpenCode 1.18.31) и для каждой объявленной
возможности называет доказательство. Другая версия рантайма — `unverified`, пока
доказательство не получено снова: `check:runtime-adapters` без аргументов
проверяет пары по реальному реестру, `doctor` сообщает
`runtime.driver_verified.<name>`, handshake и каждый запуск возвращают
`capability_verification`. Это сообщение, не отказ: §13 блокирует только
неизвестную major-версию.

**Как добавить рантайм.** Дескриптор (§14), драйвер с ядром своей роли и
доказательством на точной паре, строка в `NATIVE_SAMPLES` теста драйверов. Тесты
перечисляют, чего не хватает.

## 16. Свидетельство ревью и граница публикации

С Stage 11.1b (WP-7, миграция `0069`, [ADR-0015](adr/0015-review-evidence-and-publish-boundary.md))
ревью и публикация говорят об одном дереве, и это проверяемо.

**Что пишет супервизор.** Перед запуском исполнителя — `HEAD`, от которого он
начинает (`record_review_base`); первый прогон задачи фиксирует базу для всех
последующих. После отчёта исполнителя и до принятия завершения — свидетельство
(`record_review_evidence`) под fencing-токеном прогона: `base_commit_sha`,
`head_commit_sha`, `worktree_digest`, `patch_digest` (все обязательны), ограниченный
дифф и diffstat с метаданными усечения, и две колонки проверок —
`executor_reported_checks` (из отчёта исполнителя) и `platform_verified_checks`
(что платформа проверила сама, не запуская код проекта). git при этом выполняется
от учётной записи-владельца каталога, никогда от root. Алгоритмы дайджестов —
`infra-cod-worktree-v1` и `infra-cod-patch-v1`, спецификация в ADR-0015.

**Ход ревью.** `resume_orchestrator` (прежде `resume_codex`) получает свидетельство прогона, о котором он
(`deliver_review_evidence`), и доставка записывается на прогон хода. Текст хода
несёт четыре дайджеста и обе колонки проверок, подписанные раздельно.

**Вердикт.** `request_revision` хода и `approve_task_review` оператора — строки
`review_verdicts`, ссылающиеся на `(evidence_id, evidence_digest)` одним внешним
ключом. Одобрение без свидетельства отвергается (`review_evidence_missing`);
вердикт на свидетельство, которое уже не текущее, — `review_evidence_stale`.

**Граница публикации.** Одобрение создаёт `publish_preparations`; супервизор
пересчитывает четыре дайджеста из каталога и передаёт их `prepare_publish`,
которая отвергает сдвинувшееся дерево или патч (`review_evidence_digest_moved`),
незакоммиченное одобренное дерево (`publish_worktree_uncommitted`) и свидетельство
с непрошедшей проверкой платформы (`review_evidence_unverified`). Отказ записывается
на строке с причиной из словаря `failure_reasons`. Результат — `prepared` с
`head_commit_sha`.

**Что остаётся ручным.** Push и PR в 11.1b делает оператор — по SHA из
подготовленной строки. Publish job, publish intent и квитанции push/PR — не часть
этого контракта ([план](STAGE_11_1B_PLAN.md) §5).

## 17. Ingress разговора и ящик команд прогона

С Stage 11.1b (WP-9a, миграция `0070`, [ADR-0016](adr/0016-ingress-mailbox-tool-socket-provenance.md))
к агенту ведут два канала.

**Ingress создаёт прогон.** Сообщение оркестратору (`orchestrator_message`),
хэндофф (`handoff`) и resume после ответа оператора (`resume`) — записи
`conversation_ingress` с `conversation_sequence` своего события. Задание берётся в
работу, только когда ни один другой прогон разговора не идёт и ни одна более
ранняя запись не ждёт. Сообщение, набранное во время прогона, становится новым
прогоном после него; в идущий прогон оно не попадает. Dead letter разговор не
держит. Панель показывает ожидание как «Waiting for the current run».

**Ящик — команды идущему прогону.** `run_commands`: `run_id + sequence +
command_kind + idempotency_key`, виды `input_response`, `steer`, `interrupt`,
состояния `pending → delivering → acknowledged | outcome_unknown | failed`.

| Правило | Где держится |
| --- | --- |
| одна команда на ключ: тот же ключ — та же команда, другой payload под ним — `run_command_idempotency_conflict` | `request_run_command` |
| доставляет держатель аренды задания, по одной, в порядке `sequence` | `claim_run_command` |
| `acknowledged` — только с `native_receipt`, ответом рантайма | `acknowledge_run_command`, CHECK |
| могла дойти, ответа нет — `outcome_unknown`; известно, что не дошла, — `failed` | `finish_run_command`, `run-mailbox.mjs` |
| прогон кончился: `pending` → `failed` (`run_command_run_ended`), `delivering` → `outcome_unknown` | триггеры на `task_runs` и `runtime_jobs` |
| завершённая команда не меняется | триггер, `run_command_immutable` |

Какая возможность драйвера нужна виду: `interrupt` → `interrupt`, `steer` →
`input.steer`, `input_response` → `input.respond`. Вид, которого драйвер не
объявляет, завершается `run_command_unsupported`: команда никогда не становится
новым промптом, потому что это заменило бы сессию агента (§7). Ни Codex, ни
OpenCode сейчас не объявляют `input.steer` и `input.respond`; ответ на вопрос
исполнителя — явный interrupt + native resume: ingress вида `resume`, новый
прогон в той же сессии.

**Квитанции.** Codex: ответ app-server на `turn/interrupt` (`mechanism:
protocol`, `thread_id`, `turn_id`, `response`); ход затем завершается со
статусом `interrupted`. OpenCode: SIGTERM всем процессам cgroup прогона, SIGKILL
через 5 с, квитанция — как процесс завершился (`mechanism: cgroup`, `cgroup`,
`exit_code`, `exit_signal`, `escalated_to`, `leftover_processes_killed` — если
что-то пережило выход рантайма и было убито вместе с cgroup; §23). Квитанция
пишется до того, как прогон финализируется. До спринта C сигнал шёл группе
процессов (`mechanism: process_group`); такие квитанции остались у старых
команд.

**«Stop run».** `request_runtime_interrupt` пишет interrupt в ящик (ключ —
задание: повторное нажатие — та же команда), ставит `interrupt_requested_at`
(его опрашивают воркеры предыдущего релиза) и отвергает задание, чей записанный
драйвер не объявляет `interrupt` (§19). Прерывание до старта прогона хранится на
задании и становится командой прогона при старте.

## 18. Транспорт инструментов исполнителя — сокет на прогон

С Stage 11.1b (WP-9b) вместо одного `worker-tools.sock` группы `opencode-worker`
у каждого прогона свой `/run/infra-cod/worker-tools/<run id>/tools.sock`
(`WORKER_TOOL_SOCKET_ROOT`): каталоги root 0711, сокет — аккаунта рантайма
прогона, группа root, 0600. Путь передаётся рантайму в
`INFRA_WORKER_TOOL_SOCKET`, как и раньше.

| Отказ | Причина |
| --- | --- |
| другой uid | `EACCES` от ядра, до первого байта |
| capability другого прогона | `worker_capability_foreign` |
| принятый терминальный отчёт предъявлен снова | `worker_capability_spent` (отвергнутый отчёт capability не расходует) |
| владелец или режим сокета изменены после создания | `worker_tool_socket_tampered` |

Сокет удаляется, как бы прогон ни кончился, вместе с открытыми соединениями.
Сокеты, оставшиеся от умершего супервизора, убираются при старте и раз в минуту;
`doctor` проверяет корень (`systemd.socket.worker-tools`) и называет сокеты без
слушателя (`systemd.socket.worker-tools.stale`). Выбран сокет, принадлежащий
uid, а не `SO_PEERCRED`: у Node нет API для учётных данных пира без нативного
модуля (ADR-0016).

## 19. Происхождение запуска

С Stage 11.1b (WP-9c, миграция `0071`) задание записывает, что выбрано, а каждый
запуск — что запустилось.

- **`runtime_job_selections`** — пишется первым запуском задания, ретраи его
  используют. Назначение, режим доступа и grant база берёт из grant прогона,
  рантайм — из назначения, сессию — из прогона; запускающий сообщает только
  версии адаптера и рантайма, верификацию и объявленные драйвером возможности
  (`provenance.mjs`). Другое назначение, рантайм или режим —
  `runtime_selection_changed`; сменившаяся между попытками версия замещает выбор
  строкой, которая называет прежнюю и что изменилось.
- **`runtime_dispatch_attempts`** — строка на каждый реальный запуск (у
  исполнителя — и на каждый финализатор): драйвер, исполняемый файл, версии,
  верификация, прогон, сессия, grant и режим, воркер; `native_result` — один раз,
  в конце.

Панель читает происхождение: «Stop run» — `runtime_job_can_interrupt(job)`, тот же
ответ, что у `request_runtime_interrupt`, — не `runtime_profiles`; usage —
`conversation_runtime_usage`; хэндофф назван по агентам хэндоффа и рантайму,
который запуск выполнил. Задания, запущенные до `0071`, имеют выбор с `source =
'backfill'` без версий и возможностей.

## 20. Рантайм, удалённый во время диспетчеризации, и путь назад из dead letter

С Stage 11.1b (пункт приёмки 11.1 3.8 и prework C2, миграция `0072`).

**Что считается удалением.** База узнаёт о рантаймах одной записью — upsert
`runtime_health`, который раз в минуту пишет root-таймер health-снимка из
readiness `infra-cod runtime list`. `runtime remove` активной версии запрещён,
поэтому с диспетчеризацией может встретиться то, что снимок сообщает:
рантайм не установлен (`runtime_not_provisioned`) или без рабочей учётной
записи (`runtime_not_authenticated`). Устаревший или отсутствующий снимок и
рантайм, который снимок не смог прочитать, — это «не знаю»: создание задачи
такое отвергает (`0054`), запуск — нет, его рассудит сам запуск.

**Запуск спрашивает.** `record_runtime_dispatch` читает строку снимка под share
lock до того, как что-либо записать. Удаление, записанное раньше, запуск ждёт и
видит — отказ с причиной, попытка не дописывается, а супервизор, который пишет
её до сокета и spawn, не открывает сокет и ничего не запускает. Удаление,
записанное позже, ждёт коммита запуска и встречает уже процесс.

**Ретрай спрашивает.** `retry_runtime_job` не возвращает в очередь задание,
чей рантайм снимок называет удалённым: оно заканчивается сразу с этой причиной,
не сжигая попытки. Исчерпанные попытки — `runtime_attempts_exhausted`.

**Конец задания заканчивает то, что оно держит** (`end_runtime_job`): прогон —
`failed` с причиной; lock воркспейса освобождается под fencing token прогона;
grants уходят с прогоном; попытка, результата которой супервизор не записал,
закрывается как `not_reported`; задача — `needs_attention`; разговор получает
`runtime_job.dead_lettered` с объяснением из словаря. Если lease lock'а уже
истёк (задание подобрано после смерти воркера), lock не освобождается —
держатель может ещё писать: он оставляется так, как оставил бы reconciler,
`reconciliation_required`, а прогон — `lost`.

**Причина.** У каждого dead letter есть `runtime_jobs.failure_reason` из словаря
(CHECK). Писатели, которые его не называют (reconciler, удаление проекта),
получают его от триггера по `last_error`: `workspace_lease_expired`,
`project_deletion_cancelled`, иначе `runtime_attempts_exhausted`.

**Путь назад** — два действия оператора, оба отвечают на одну смерть одного
задания (`attempt_count`, который показывала карточка), оба идемпотентны и оба
пишут в `runtime_job_recoveries` кто, почему и от чего задание умерло;
запись не редактируется.

- `retry_dead_letter_job` возвращает *то же* задание в очередь (двойной клик не
  создаёт второго) с полным бюджетом попыток (`attempt_base`). Отказы по
  причине: рантайм всё ещё удалён (сначала восстановить), задача закрыта или
  одобрена (`dead_letter_task_closed`), задача ушла дальше этого задания
  (`dead_letter_superseded`), воркспейс держит другой прогон или он ждёт
  reconciliation (`dead_letter_workspace_busy`). Выбор задания (§19)
  переиспользуется, если снимок сообщает ту же версию рантайма, и замещается
  строкой с обеими версиями, если другую. Реализация начинает новый прогон под
  новым lock; её событие старта получает свой ключ.
- `dismiss_dead_letter_job` закрывает задание без повтора с причиной оператора
  (не короче 8 символов), как это делал `resolve_runtime_job_incident`.

Панель: карточка dead letter показывает причину словами словаря и кнопки
**Retry** и **Dismiss**. `infra_web` исполняет только эти две функции (обе
SECURITY DEFINER и сами проверяют владельца); на таблицу и вспомогательную
функцию прав нет. Health-снимок перестаёт быть `degraded` из-за
`dead_letters_present`, когда каждый dead letter повторён или закрыт.

## 21. Подключение модели, отозванное во время диспетчеризации

Со спринта B Stage 11.4 (пакет A4, миграция `0084`; ADR-0018).

**Что считается отзывом.** Снимок задачи фиксирует модель и подключение, через
которое к ней ходят (`connection_id` записи каталога). Подключение отозвано,
если его строки нет, его статус не `connected` (`disconnected`, `expired`,
`action_required`, `pending_finalize`) или оператор попросил его отключить, а
брокер ещё не успел: решение оператора принято в момент просьбы. Задача без
снимка из каталога (модель профиля рантайма, до `0028`) подключения не называет
и не спрашивается.

**Кто спрашивает.** `revoked_model_access(job)` читает строку подключения под
share lock; любой отзыв — это UPDATE этой строки, поэтому диспетчеризация и
отзыв упорядочены и не перемежаются. Спрашивают четыре места:

- `claim_executor_jobs` и `claim_orchestrator_jobs` забирают задания по одному.
  Задание с отозванным подключением забирается и тут же завершается в той же
  транзакции с причиной `model_access_revoked`: прогон хода закрыт, ревью
  переведено в `reviewing`, как ждёт повтор, — и воркеру оно не отдаётся.
- `record_runtime_dispatch` отказывает запуску с той же причиной до сокета и spawn.
- `retry_runtime_job` завершает такое задание вместо повтора — и отказанный
  запуск, и процесс, упавший оттого, что учётные данные ушли у него из-под ног.
- `retry_dead_letter_job` не возвращает задание в очередь, пока подключение
  отозвано: сначала подключить заново.

Итог в любом порядке событий один: задание в `dead_letter` с причиной, прогон
закрыт, блокировка workspace освобождена, грантов нет, задача в
`needs_attention` (для реализации), разговор задачи говорит, почему работа
остановилась. Доказательство — `model-access-revocation.test.mjs`: оба окна
(до claim и между claim и запуском), каждое в обоих порядках, и мутации,
показывающие, что держит результат share lock и каждая из проверок.

## 22. Путь публикации

Со спринта B Stage 11.4 (пакет P1, миграция `0085`; поправка к ADR-0015).

| Шаг | Кто | Что делает | Отказ |
| --- | --- | --- | --- |
| запрос | оператор (`request_publish`) | намерение на подготовленный коммит одобренной задачи | `publish_not_prepared`, `publish_unsupported_repository`, `publish_connection_unavailable` |
| claim | брокер GitHub (`claim_publish_intent`) | намерение и авторизация на подключение проекта | подключение не `connected` → `publish_connection_unavailable` в claim |
| токен | брокер | токен установки на один репозиторий, `contents`/`pull_requests: write`, на эту операцию | `publish_token_unavailable` |
| экспорт | супервизор (`export_publish_commit` по сокету брокера) | `pack-objects` одобренного коммита от владельца каталога в `/run/infra-cod/publish-exports/<intent>.pack` (`root:infra-cod-github 0440`) | `publish_head_moved`, `publish_export_failed` |
| push | брокер | scratch-репозиторий, `index-pack`, `git push <sha>:refs/heads/infra-cod/<task>` без force, хуков и credential helper | `publish_push_rejected`, `publish_push_failed` |
| квитанция push | брокер (`record_publish_push`) | ref и коммит, событие `publish.pushed` | — |
| PR | брокер | `POST /repos/{repo}/pulls`, или открытый PR этой ветки | `publish_pull_request_failed` |
| завершение | брокер (`complete_publish_intent`) | номер и URL, событие `publish.pull_request_opened`, аудит `task.published` | — |

Отказ на любом шаге — `fail_publish_intent` с причиной, авторизация отозвана,
экспорт удалён, токен отозван. Повтор — `retry_publish_intent` из панели на ту же
попытку, которую показала карточка. Доказательство — `publish-path.test.mjs`:
настоящий git smart HTTP (`git http-backend` за сервером, проверяющим токен как
GitHub), стаб REST API для PR, настоящая база.

## 23. Cgroup на прогон: как прогон останавливают и как узнают, что он жив

Со спринта C Stage 11 (пакет K1, решение C4). До него супервизор запускал
рантайм отделённым (`detached`) и останавливал прогон как группу процессов:
`kill(-pgid)`. PoC Claude Code на VPS показал границу этого способа: рантайм
запускает shell-инструменты в собственных группах процессов; SIGTERM
срабатывал только потому, что обработчик самого рантайма прибирал за собой, а
SIGKILL группе оставлял `bash` и `sleep` живыми, и отложенный
`sleep 5 && touch marker` ложился уже после того, как прогон был объявлен
остановленным. Группу процессов покидают одним `setsid`; cgroup без права
записи в cgroup-файловую систему покинуть нельзя, а у аккаунтов рантаймов его
нет.

**Механизм — лист под делегированным поддеревом юнита**, не transient scope
(`services/runtime-supervisor/run-cgroup.mjs`):

| Что | Как |
| --- | --- |
| юнит | `Delegate=yes` в `infra-cod-runtime-supervisor.service` — единственное изменение юнита; поддерево `/sys/fs/cgroup/system.slice/infra-cod-runtime-supervisor.service/` принадлежит супервизору |
| лист | `<вид>-<uuid>`: `task-<run id>` (прогон исполнителя), `turn-<run id>` (read-only ход оркестратора), `channel-<channel id>` (канал: проект, аккаунт, gate), `gate-<uuid>` (пакетный smoke gate), `account-<uuid>` (loopback-сервер и CLI аккаунта) |
| вход | запускается `/bin/sh`, который пишет `$$` в `cgroup.procs` листа и делает `exec runuser …`: рантайм попадает в cgroup до сброса привилегий и до первого fork, окна нет. Ошибка записи — выход 79, прогон отвергнут, а не запущен вне cgroup. Landlock-обёртка read-only запуска идёт после `runuser`, внутри cgroup |
| остановка | SIGTERM каждому процессу из `cgroup.procs`, прежний grace (2 с; 3 с у аккаунтов), затем `cgroup.kill` — SIGKILL всем членам атомарно, включая тех, кто форкается в этот момент, — и ожидание `cgroup.events: populated 0`. «Остановлен» говорится только после этого; член, переживший SIGKILL, — ошибка, а не «stopped» |
| конец прогона | после выхода рантайма лист освобождается: что в нём осталось — тот самый инструмент, переживший рантайм, — убивается через `cgroup.kill`, считается (`run_cgroup.leftovers_killed`), лист удаляется |
| `process_ref` | `runtime-supervisor:<pid>:<лист>`; `<pid>` остался для человека и приёмки, живость спрашивают у листа |
| живость | `writerAlive` (`deprovision-safety.mjs`): лист есть и `populated 1` — жив; листа нет или пуст — прогон окончен; лист не читается или ref не разобран — **жив** (fail-closed: дальше удаляли бы каталог под пишущим). Ref без листа — записи прошлого релиза — по pid, как раньше; те прогоны кончились с рестартом того супервизора |
| deprovision | фазы 3–4 сигналят cgroup по `process_ref`; свежий скан пишущих — `assertNoLiveWriters` с ответом cgroup |
| старт | `prepare` делает и удаляет пробный лист — без `Delegate=yes` или на cgroup v1 супервизор не стартует, а не запускает прогоны, которые не сможет убить; `sweep` убивает и удаляет листы, оставшиеся от прежнего процесса |

Почему не transient scope (`systemd-run --scope` / `StartTransientUnit`):
scope — сосед юнита, а не его часть. Рестарт супервизора перестал бы
заканчивать его прогоны (на это опирается приёмка каждого обновления:
«процессы — в cgroup юнита»), `TasksMax` и `MemoryMax` юнита перестали бы их
ограничивать, каждый рестарт искал бы scope через D-Bus, а gate в контейнере не
может ни создать scope, ни проверить логику. Лист — это mkdir, запись pid,
чтение `cgroup.events`, запись `cgroup.kill`, rmdir: под существующей
песочницей юнита (root, `ProtectSystem=strict` оставляет `/sys` записываемым),
без D-Bus, и проверяемо против каталога. Бюджет памяти K3 читает
`memory.current` листа или переносит сам супервизор в лист и включает
контроллер — обе операции внутри того же поддерева.

`runuser` без `-l`: `pam_systemd` не в его PAM-стеке, login-сессии нет, и
процесс не переезжает в `session-N.scope`. Проверка на хосте:
`cat /proc/<pid рантайма>/cgroup` называет лист; `systemd-cgls -u
infra-cod-runtime-supervisor.service` показывает листы прогонов.

**Где cgroup недоступен.** Контейнер gate монтирует cgroup-файловую систему
только для чтения. Единственно там end-to-end сюита запускает супервизор с
`RUNTIME_RUN_ISOLATION=process_group` — изоляцией прошлого релиза, с pid-only
`process_ref` и квитанцией `mechanism: process_group`; супервизор пишет об
этом в журнал при старте, а юнит эту переменную не ставит (тест контракта
юнитов). `RUNTIME_CGROUP_ROOT` переопределяет корень поддерева, если он не
`/proc/self/cgroup` супервизора.

Доказательство — `run-cgroup.test.mjs`: против эмуляции cgroup над каталогом с
настоящими pid (везде, где идёт gate) и против ядра (где cgroup v2 доступен на
запись: привилегированный контейнер, делегированное поддерево) — дерево, чей
потомок уходит в свою сессию и откладывает побочный эффект: `kill(-pgid)` его
пропускает, cgroup — нет.

## 24. Готовность проекта там, где оператор действует

Со спринта C Stage 11.5 (пакет U1, миграция `0088`; критерий приёмки 6,
половина панели).

**Четыре вопроса, порознь.** Для каждого включённого назначения проекта база
отвечает отдельно: рантайм установлен, рантайм вошёл в учётную запись (оба — из
снимка `runtime_health`, тем же чтением, что `runtime_undispatchable_reason`,
включая правило «устаревший или молчащий снимок — не знаю»), модель проверена
(запись каталога по умолчанию для этого назначения в статусе `verified`),
подключение подключено (правило `revoked_model_access`: строка есть, статус
`connected`, брокеру не заказан `disconnect`). Состояние — `ready`, `missing`
или `unknown`; `blocked_by` называет первое недостающее в порядке, в котором
оператор чинит: рантайм → вход → подключение → модель (подключение раньше
модели, потому что истёкшее подключение уводит свои записи каталога в
`unavailable`, и первое действие — подключить заново, что и назвал бы запуск:
`model_access_revoked`). У каждой причины — действие: команда на сервере или
экран панели.

**Одно чтение, не копия.** `runtime_undispatchable_reason` и
`revoked_model_access` переопределены поверх двух примитивов —
`runtime_health_reading` и `connection_revoked`, с теми же share lock'ами (§20,
§21), — и `dispatch_prerequisites` построен на них же. Панель и
диспетчеризация читают одно условие.

**Кто спрашивает.**

- `project_readiness(project, owner)` — единственная функция `infra_web`,
  SECURITY DEFINER, проверяет владельца сама: панель показывает четыре
  состояния на каждое назначение в контексте разговора и в настройках проекта,
  композер отказывается отправлять и говорит почему, карточка задачи называет
  исполнителя, которому нельзя делегировать, до делегирования.
- `capture_task_runtime_snapshot` — ворота каждого создателя задачи — спрашивает
  каждое условие по имени до того, как разрешить записи; отказ несёт ту причину,
  что показала панель (`runtime_readiness_unknown`, `runtime_not_provisioned`,
  `runtime_not_authenticated`, `model_access_revoked`, `model_not_verified`), а
  не свёрнутое `catalog_entry_unavailable`.
- `record_task_chat_message` спрашивает то же об оркестраторе задачи до того,
  как начать ход; ответ на открытый запрос ввода — не ход, и не спрашивается.

Выбор без записи каталога (проект без умолчаний, задача с backfill-снимком) не
отвергается: создание задачи такой проект пропускает, запуск о подключении не
спрашивает (§21); состояния рантайма при этом показываются.

Доказательство — `db/tests/0054_project_readiness_test.sql`: для каждого
недостающего условия функция готовности, создание задачи и сообщение в чат
называют одну причину; готовый проект не тронут; исполнитель, который не готов,
показан на своей строке и блокирует только задачу, которая его привяжет;
владелец проверяется.

## 25. Команда проекта в панели

Со спринта C Stage 11.5 (пакет U2, миграция `0089`; критерий 10; ADR-0017).

Вкладка **Team** проекта читает `project_team`: назначения с ролью, рантаймом и
моделью; встроенные роли с правами и возможностями рантайма, которые эти права
требуют; модели, которые можно выбрать для каждой роли, и сколько остальных
удержано и почему (подключение не подключено, модель не проверена, рантайм не
играет роль или не имеет нужной возможности).

Изменения — три функции, каждая проверяет владельца и версию команды
(`project_runtime_defaults.version`), повышает её и пишет аудит
`project.team_changed`:

| Функция | Что делает | Отказ |
| --- | --- | --- |
| `add_project_executor` | новый исполнитель на проверенной модели, последний по порядку, его модель — последняя по умолчанию | `team_model_in_use`, `runtime_cannot_play_role`, `catalog_entry_unavailable`, не больше восьми |
| `change_project_assignment_model` | другая модель того же рантайма для оркестратора или одного исполнителя, на его месте | другая модель рантайма → `runtime_default_not_assigned` с подсказкой «добавь исполнителя и убери этого»; `team_model_in_use` |
| `disable_project_executor` | исполнитель выходит из команды вместе со своей моделью, остальные сохраняют свои | `team_last_executor`, `team_assignment_in_use` (открытая задача) |

Исполнители и модели по умолчанию сопоставляются по порядку (как читают
`capture_task_runtime_snapshot` и `project_readiness`), и каждая функция этот
порядок сохраняет. Запущенные задачи держат свой снимок; изменение действует на
новые. Роли — только встроенные (решение C1).

## 26. Оператор закрывает задачу

Задача заканчивалась только своим процессом: одобрена, опубликована, провалена.
Брошенный разговор оставался открытым навсегда и держал своих исполнителей —
`disable_project_executor` (§25) такого не убирает. `close_task` (0090) — выход
для оператора: проверяет владельца и версию задачи, которую показала панель,
пишет аудит `task.closed` и событие `task.cancelled` в разговор.

| Состояние задачи | Что делает `close_task` |
| --- | --- |
| задание в полёте или открытый прогон | отказ `task_work_in_flight`: сначала Stop run |
| одобрена, публикуется, завершена, провалена, уже закрыта | отказ `task_already_closed` |
| любое другое открытое | статус `cancelled`; ожидающие задания заканчиваются с `task_closed`, их и прежние мёртвые письма отмечены обработанными; ожидающие одобрения истекают |

`cancelled` все читатели уже считают закрытым: композер предлагает связанное
продолжение, повтор мёртвого письма отказывает (`dead_letter_task_closed`),
команда задачу больше не считает. В панели — кнопка «Close task» в заголовке
открытой задачи, с подтверждением на странице.

## 27. Claude Code как оркестратор

Третий рантайм (sprint C K2, решения C2 и C3), только в роли оркестратора.

| Что | Как |
| --- | --- |
| Установка | `infra-cod runtime install claude --version 2.1.270`: платформенный пакет без скриптов, подпись реестра и sha512; пользователь `claude-worker` создаёт обновление (`sysusers.d`, координатор с rc.63), дом и `~/.claude.json` — tmpfiles |
| Автообновление | переменные `DISABLE_AUTOUPDATER=1`, `DISABLE_UPDATES=1` на каждом запуске и пробе; бинарник принадлежит root |
| Вход | `infra-cod runtime login claude` на терминале хоста, от имени `claude-worker`; учётные данные не проходят через процесс, панель и базу; `authenticated` — наличие `~/.claude/.credentials.json` (`test -s`, файл не читается) |
| Подключение | карточка Settings → `connect_claude_connection`, отказ пока хост не сообщает рантайм установленным и вошедшим (`runtime_readiness_unknown`, `runtime_not_provisioned`, `claude_not_signed_in`); `disconnect_claude_connection` делает все его модели отозванными для диспетчера (§0084) |
| Модели | алиасы `haiku`, `sonnet`, `opus` (`claude_aliases`), по одному через гейт; квитанция гейта хранит модель, в которую разрешился алиас |
| Ход оркестратора | `claude -p … --output-format stream-json`: `--tools Read,Glob,Grep`, `--permission-mode dontAsk`, `--setting-sources user`, `--strict-mcp-config`, MCP-сервер `platform` (мост к сокету прогона), первая реплика `--session-id <выбран супервизором>`, дальше `--resume` |
| Чтение своего состояния | запрещено: `--disallowedTools "Read(~/.claude/**),Read(~/.claude.json)"` на всех поверхностях. На rc.67 `Read` хода вернул маркер, лежащий рядом с учётными данными подписки; с правилом Read, Grep и Glob получают отказ (проверено на хосте тем же маркером). Ядро здесь не помогает: сам `claude` обязан читать эти файлы |
| Остановка | cgroup прогона (§23) |
| Исполнитель | отказ: Bash модели читает учётные данные подписки (PoC, проба 10) |

## 28. Память: запуск ждёт, а не падает под OOM

Каждый запуск рантайма (канал, ход, прогон исполнителя, гейт, операция аккаунта) сначала спрашивает у супервизора место в памяти (`runtime-capacity.mjs`, sprint C K3):

| Предел | Как считается |
| --- | --- |
| хост | `MemAvailable` минус резерв `RUNTIME_MEMORY_RESERVE_MB` (512) |
| юнит | `memory.max` минус `memory.current` cgroup супервизора (`MemoryMax=1G` считает все листья прогонов) минус 64 МБ |
| рост | запуски, допущенные за последние 45 с, считаются по оценке, пока не выросли |

Оценка на прогон — `memoryEstimateMb` рантайма в реестре (Codex 350, OpenCode 600, Claude Code 350 — по замерам rc.66). Не помещается — отказ `runtime_capacity` до того, как что-либо создано:

- ход оркестратора возвращается в очередь (`defer_runtime_job`, 0092), попытка не тратится, панель пишет «Waiting for memory on the host»;
- исполнитель уже держит рабочий каталог и ждёт в воркере до 15 минут, продлевая аренду;
- гейт, обновление каталога и операции аккаунта повторяют запрос в пределах своей аренды.

Каждый прогон записывает, сколько взял: `native_result.memory` — пик RSS процессов его листа (замер раз в 2 с), число процессов и минимум `MemAvailable` хоста; гейт кладёт пик в квитанцию проверки. `RUNTIME_MEMORY_ADMISSION=off` выключает проверку.
