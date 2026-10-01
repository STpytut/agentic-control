# Product Spec

## 1. Назначение

Разработать self-hosted платформу для постоянной удалённой работы с несколькими AI coding agents через единый веб-интерфейс и, после основного web workflow, Telegram.

Платформа разворачивается на VPS, хранит проектные директории и нативные сессии агентов и становится постоянной средой разработки, доступной с MacBook и телефона.

## 2. Проблема

Текущий процесс требует вручную открывать один проект в нескольких приложениях, переключаться между агентами, пересказывать задачу и контролировать, кто в данный момент изменяет файлы. Сессии и интеграции зависят от конкретного устройства.

Нужно сохранить возможности каждого агента, но объединить:

- проекты;
- нативные сессии;
- передачу задач;
- поток вывода;
- состояние workflow;
- review и публикацию;
- доступ к GitHub;
- удалённое управление.

## 3. Продуктовая концепция

Платформа является слоем управления непрерывным AI-assisted development workflow.

Она не является:

- новым универсальным coding agent;
- новым IDE общего назначения;
- swarm-системой;
- заменой Codex, OpenCode или Antigravity;
- системой управления внутренним prompt/context агентов;
- простой stateless-обёрткой над CLI.

Основной workflow:

```text
планирование → реализация → ревью → доработка при необходимости → публикация
```

## 4. Пользователи и режим V1

V1 проектируется как персональная single-user система. Multi-user tenancy, командные роли и биллинг не входят в V1, но идентификаторы владельца не должны блокировать будущую миграцию.

Основной пользователь:

- создаёт или подключает проекты;
- общается с активным агентом;
- наблюдает stream и состояние задачи;
- вручную вмешивается в workflow;
- подтверждает опасные действия;
- просматривает diff, проверки и историю;
- получает уведомления.

## 5. Роли агентов

Workflow role не привязана навсегда к названию runtime. Project хранит default
orchestrator и разрешённый executor roster; каждая assignment отдельно выбирает
Agent и capability-verified RuntimeProfile (`runtime + provider + model`). Task
наследует defaults и может зафиксировать собственный orchestrator/model и
подмножество executors. Текущий active agent может меняться при handoff, не
меняя стабильного orchestrator задачи.

### 5.1. Codex

Роли:

- architect;
- planner;
- reviewer;
- orchestrator;
- release manager.

Полномочия:

- полный доступ к workspace;
- анализ и планирование;
- создание task contract и acceptance criteria;
- выбор исполнителя и provider profile;
- делегирование;
- review фактического git diff;
- запрос доработки;
- финальные исправления;
- запуск проверок;
- commit и push;
- работа с GitHub;
- доступ к разрешённым GitHub-интеграциям;
- инициирование deployment.

В исходной конфигурации Codex является default orchestrator и единственным
runtime, который прошёл persistent-chat gate. Возможность финальной публикации
выдаётся отдельной policy capability и не следует автоматически из роли
orchestrator. Сейчас такую capability может получить только одобренный Codex
profile. Пользовательское подтверждение применяется согласно [Security](SECURITY.md).

### 5.2. OpenCode

Роль: основной implementation agent.

Задачи:

- реализация функций;
- исправление ошибок;
- рефакторинг;
- написание тестов;
- изменение файлов;
- локальные команды и проверки.

OpenCode по умолчанию не получает publishing credentials и production-доступ.

Стартовый provider profile: OpenCode Go. Это конфигурация развёртывания, а не отдельный тип агента. Zen, Ollama Cloud, локальная Ollama и другие providers могут добавляться позднее без изменения доменной модели.

### 5.3. Antigravity

Роль: альтернативный implementation agent, особенно для UI, исследовательских и сложных автономных задач.

Ограничения публикации аналогичны OpenCode.

Включение Antigravity в MVP зависит от capability PoC. Если официальный headless runtime не обеспечивает обязательные возможности, адаптер переносится после V1 без блокировки Codex + OpenCode workflow.

## 6. Роль платформы

Платформа — детерминированный control plane. Она отвечает за:

- проекты и workspace;
- запуск и мониторинг процессов;
- связь проекта с native session ID;
- resume существующих сессий;
- task и run state;
- события и handoff;
- workspace lock;
- streaming в UI;
- interrupts и пользовательский ввод;
- уведомления;
- credentials isolation;
- approvals;
- audit trail;
- восстановление после рестартов;
- usage telemetry, если runtime её предоставляет.

Платформа не решает:

- что именно реализовывать;
- достаточно ли хорош код;
- какой файл должен прочитать агент;
- как агент строит внутренний prompt;
- когда runtime выполняет compaction;
- как runtime использует prompt cache.

Решение о задаче и качестве реализации принимает Codex либо пользователь.

## 7. Основные пользовательские сценарии

### 7.1. Подключить проект

Пользователь может:

- клонировать существующий GitHub repository;
- создать пустой проект;
- подключить существующую директорию.

При создании задаются имя, repository, default branch, workspace path, default
orchestrator, его model/runtime profile, executor roster и интеграции.

Project является обязательным верхним уровнем продукта. Task нельзя создать вне
выбранного project. После команды создания control plane сначала фиксирует
metadata и audit event, затем VPS provisioner создаёт или клонирует filesystem
workspace. До завершения provisioning project не принимает новые tasks.

### 7.2. Работать с нативной сессией

Пользователь выбирает проект, orchestrator/model и исполнителей, отправляет сообщение, видит поток событий и может:

- отправить дополнительный ввод;
- ответить на вопрос агента;
- прервать run;
- возобновить сохранённую сессию;
- переключиться на другого агента через handoff.

Основной рабочий интерфейс project — persistent chat. Первое сообщение в новом
диалоге создаёт task внутри выбранного project; последующие сообщения являются
durable input этого task и его native orchestrator session. Структурированные task
contract, handoff, checks, approvals и events отображаются в разговоре как
system cards, но не заменяют обычный диалог пользователя с orchestrator.

### 7.3. Делегировать реализацию

Orchestrator вызывает структурированный tool `delegate_task()`. Платформа
проверяет, что выбранный worker входит в task executor roster, создаёт handoff,
получает workspace lock и запускает или возобновляет его native session.

### 7.4. Завершить реализацию

Worker вызывает `complete_task()` с кратким summary и заявленными проверками.
Платформа фиксирует результат, освобождает lock и возобновляет сохранённого
orchestrator для review текущего workspace и git diff.

### 7.5. Запросить доработку

Orchestrator формирует structured revision request. Worker возобновляет свою сессию, исправляет замечания и повторно возвращает результат.

### 7.6. Опубликовать

После одобрения orchestrator с отдельной publishing capability может подготовить
commit, push и deployment. Внешние необратимые или production-действия требуют
предусмотренного approval.

### 7.7. Вмешаться вручную

Автоматический workflow не лишает пользователя контроля. Пользователь может:

- остановить run;
- изменить assignee;
- вернуть задачу orchestrator;
- отменить workflow;
- ответить на blocker;
- запретить публикацию.

## 8. Функциональные требования

### 8.1. Projects

- список проектов и статусов;
- создание, подключение и архивирование;
- просмотр workspace и git state;
- настройка разрешённых runtime и integrations.
- выбор default orchestrator/runtime profile и executor roster.

### 8.2. Tasks

- создание задачи вручную или orchestrator;
- task-level override orchestrator model и подмножества executors;
- objective, instructions, constraints и acceptance criteria;
- assignee и активная фаза;
- история runs, handoffs, checks и approvals;
- отмена и повторный запуск без потери аудита.

### 8.3. Sessions и Runs

- несколько сохранённых native sessions на проект;
- одна основная project session на роль/agent по умолчанию;
- явное различие session и отдельного run;
- stream в реальном времени;
- send input, interrupt, resume;
- статус ожидания пользовательского ввода.

### 8.4. Workspace

- единая файловая система проекта;
- single-writer lock в V1;
- git status и diff;
- запрет скрытого переключения на другой workspace;
- явное отображение владельца lock.

### 8.5. Integrations

- Git/GitHub;
- Platform tools для Codex через app-server dynamic tool transport; MCP при
  необходимости для read resources/других surfaces;
- Telegram после стабильного web workflow.

### 8.6. UI

Обязательные экраны:

1. Projects.
2. Project chat — основная рабочая поверхность.
3. Project overview — сводка остальных разделов выбранного project.
4. Tasks и task workflow.
5. Native agent run/terminal stream.
6. Diff и checks.
7. Sessions.
8. Events/audit timeline.
9. Settings, integrations и credentials references.

## 9. Нефункциональные требования

- Восстановление управляемого состояния после рестарта control plane.
- Идемпотентная обработка событий и команд.
- Отсутствие двух активных writers для одного workspace.
- Неизменяемый audit trail критических действий.
- Streaming без необходимости ждать завершения процесса.
- Секреты не сохраняются в event payload, логах и handoff summary.
- Нативные возможности runtime не должны намеренно урезаться адаптером.
- Отказ одного runtime не должен повреждать состояние проекта.
- UI должен явно различать подтверждённое состояние и best-effort telemetry.

## 10. Метрики успеха V1

- Полный сценарий Codex → OpenCode → Codex выполняется без ручного копирования контекста.
- После рестарта пользователь может продолжить native session и workflow.
- Ни один worker не может выполнить push или production deployment.
- Пользователь видит текущего владельца workspace и причину ожидания.
- Каждое делегирование, завершение, review и публикация отражены в timeline.
- Основной workflow доступен с мобильного браузера.
- Внутренний context management остаётся ответственностью runtime.

## 11. Не входит в V1

- параллельная запись нескольких агентов в один проект;
- автоматические worktrees;
- multi-agent swarm;
- собственный model router на основе качества или стоимости;
- собственный prompt cache;
- собственный compaction или project memory engine;
- полноценная IDE и редактор кода;
- multi-user collaboration;
- marketplace агентов;
- Kubernetes, Kafka или Temporal без подтверждённой необходимости;
- автоматическая публикация без установленной политики approvals.
