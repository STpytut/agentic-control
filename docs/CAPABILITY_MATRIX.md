# Runtime Capability Matrix

## 1. Статус документа

Этот файл — проверочный реестр, а не описание желаемого поведения. Значения `предположительно` должны быть заменены доказательствами из PoC до реализации write-capable adapter.

## 2. Матрица на момент последней проверки

| Capability | Codex | OpenCode | Claude Code | Antigravity | Gate |
| --- | --- | --- | --- | --- | --- |
| Официальный headless interface | `codex exec` stable и app-server experimental подтверждены на VPS | `opencode run` и localhost-only `opencode serve` HTTP API подтверждены на VPS | `claude -p --output-format stream-json --verbose` подтверждён на VPS (2.1.270, пин в root-owned prefix) | Требует проверки | Обязателен |
| Запуск на VPS | Подтверждён на Ubuntu 24.04 после настройки Bubblewrap/AppArmor | Подтверждён на Ubuntu 24.04 отдельным Unix user | Подтверждён на Ubuntu 24.04 отдельным Unix user `claude-poc`, без доступа к БД; под Landlock read-only launch с writable `~/.claude`, `~/.claude.json` | Требует PoC | Обязателен |
| Programmatic input | Start, resume и mid-turn `turn/steer` подтверждены | Start и следующий input через explicit session resume подтверждены | Start (`--session-id`) и resume (`--resume`) из нового процесса подтверждены; mid-turn steering не подтверждён | Требует PoC | Обязателен |
| Structured streaming | Exec JSONL и app-server `thread/turn/item` notifications подтверждены | Raw JSON и authenticated server SSE events подтверждены; production сохраняет bounded normalized events | stream-json подтверждён; bounded parser и fixtures в `pocs/claude-runtime` | Требует PoC | Обязателен |
| Persistent native session | Подтверждено локально и на VPS | Подтверждено на VPS | Подтверждено на VPS (`~/.claude/projects/<cwd>/<id>.jsonl`) | Требует PoC | Обязателен |
| Resume после process restart | Подтверждено с тем же thread ID и memory continuity | Подтверждено с тем же session ID и memory continuity | Подтверждено, в том числе после перезагрузки хоста (тот же session ID, memory continuity) | Требует PoC | Обязателен |
| Interrupt/cancel | `turn/interrupt` подтверждён и подключён к capability-gated product action | Server abort предотвратил delayed side effect; production batch process-group interrupt подключён к тому же action | SIGTERM останавливает side effect; SIGKILL оставляет tool-процессы в своих process groups — нужен kill по cgroup (sprint C K1) | Требует PoC | Обязателен |
| Interactive input request | Следующее chat-сообщение/resume поддержано; mid-turn elicitation не включён и не показывается | Native `question.asked` → reply → same-session continuation подтверждён; production использует durable request/response/resume | Не проверялось | Требует PoC | Желателен; обязателен для parity |
| Structured tool calls | App-server dynamic `platform.delegate_task` и `platform.request_revision` подтверждены | Глобальный custom `complete_task` через capability-bound Unix socket подтверждён | MCP `delegate_task` / `complete_task` через per-run capability socket подтверждены на VPS | Требует PoC | Обязателен для orchestration |
| MCP или эквивалент | Dynamic tools подтверждены как command equivalent; MCP resources deferred | Требует PoC | `--mcp-config` + `--strict-mcp-config`; `--permission-prompt-tool` отдаёт решения по Bash платформе | Требует PoC | По выбранному integration contract |
| Usage telemetry | Не гарантируется | Не гарантируется | `result.usage`, `total_cost_usd`, `rate_limit_event` | Не гарантируется | Не блокирует MVP |
| Prompt/cache telemetry | Не гарантируется | Не гарантируется | Не проверялось | Не гарантируется | Не блокирует MVP |
| Официальная headless auth | ChatGPT device authorization подтверждён на VPS | OpenAI/ChatGPT headless device auth подтверждён; Go не настроен | Subscription login (`claude auth login` от runtime user) подтверждён на VPS; файл учётных данных читается Bash модели. `setup-token` и API key не проверены | Требует PoC | Обязателен |
| External UI поверх runtime | Product activity/interrupt поверх app-server подтверждены | Product activity, interrupt и durable input response доступны по capability flags | Не проверялось | Требует PoC | Обязателен |

## 3. Desktop parity audit

Для каждой используемой Desktop-функции заполнить:

| Desktop feature | Нужна продукту? | Headless equivalent | API/event | Ограничение | Решение |
| --- | ---: | --- | --- | --- | --- |
| Несколько sessions | Да | Native session per task/agent purpose | Control-plane session records | One active purpose per agent/project | Implemented |
| Resume | Да | Explicit native session ID | Codex thread resume / OpenCode `--session` | Version-pinned adapters | Implemented |
| Tool approvals | Да | Runtime request plus platform policy | App-server approval / OpenCode permission API | Production side effects remain platform-approved | Capability verified |
| Streaming | Да | Structured runtime events | JSONL/app-server/SSE → bounded activity events | Raw diagnostics are not chat events | Implemented |
| Worktrees | Нет для V1 | Не требуется | — |  | Out of scope |
| Visual project manager | Нет | Собственный UI | Platform API |  | Presentation layer |
| Automations/schedules | После V1 | TBD | TBD |  | Deferred |
| Built-in browser/preview | Не является core agent capability | TBD | TBD |  | Deferred/alternative |

## 4. Шаблон отчёта PoC

```yaml
runtime: codex
runtime_version: ""
adapter_prototype: ""
tested_at: ""
host:
  os: ""
  architecture: ""
authentication:
  method: ""
  official: false
capabilities:
  create_session: failed
  send_input: failed
  stream: failed
  interrupt: failed
  resume_after_restart: failed
  structured_tools: failed
evidence:
  commands: []
  logs_artifact: ""
known_gaps: []
decision: blocked
```

## 5. Решение по runtime

Возможные outcomes:

- `approved_for_mvp` — все обязательные capabilities подтверждены;
- `approved_with_limitations` — ограничения отражены в продукте и не ломают критический flow;
- `deferred` — адаптер переносится после MVP;
- `blocked` — официальный поддерживаемый способ отсутствует.

Нельзя обходить `blocked` через чтение cookies, private protocols или эмуляцию Desktop UI без отдельного архитектурного и security review.

## 6. Начальные решения

- MVP обязан поддерживать Codex и OpenCode.
- Antigravity — условный scope после PoC.
- Claude Code (2026-09-27, VPS PoC): `approved_with_limitations` для роли оркестратора на subscription login; исполнитель `deferred`, пока Bash модели читает учётные данные подписки; kill только по cgroup.
- OpenCode Go — стартовый provider profile.
- Zen не включается по умолчанию.
- Ollama Cloud рассматривается как будущий provider profile, а не новая runtime/agent сущность.
- Цены и тарифные лимиты не фиксируются в нормативной архитектуре.

## 7. Codex audit log

### 2026-07-16 — `codex exec` target-VPS pass

- CLI: local `0.142.5`, Ubuntu VPS `0.144.5`.
- Auth: local saved login и официальный ChatGPT device flow на VPS.
- Test model: `gpt-5.4`.
- `codex exec --json`: passed.
- Native thread ID extraction: passed.
- Workspace-write turn: passed.
- Resume конкретного thread после завершения процесса: passed.
- Conversation continuity без чтения тестового файла: passed.
- Write-capable resume: passed через explicit config overrides.
- Current default `gpt-5.6-sol`: blocked на этой версии CLI; требуется upgrade/version gate.
- Interrupt, active-turn steering и approvals не покрывались exec PoC; позднее
  подтверждены отдельным app-server PoC ниже.
- Ubuntu 24.04 VPS execution и headless auth provisioning: passed.
- Linux sandbox prerequisite: system `bubblewrap` plus the Ubuntu 24.04
  `bwrap-userns-restrict` AppArmor profile; verified without disabling the
  global user-namespace restriction.

Подробности и воспроизводимые команды: [`../pocs/codex-runtime/RESULTS.md`](../pocs/codex-runtime/RESULTS.md).

### 2026-07-16 — `codex app-server` interactive pass

- CLI/app-server: `0.144.5` на Ubuntu 24.04 VPS.
- stdio initialization and structured streaming: passed.
- Mid-turn `turn/steer` с проверкой фактического результата: passed.
- `turn/interrupt` foreground command и предотвращение side effect: passed.
- Server-initiated command approval и client decision: passed.
- Обнаружен обязательный ordering contract: после `turn/start` response нужно
  дождаться matching `turn/started` перед `turn/steer`.
- App-server остаётся experimental: обязателен version pin, generated schema и
  capability smoke test при upgrade.
- Tool user-input elicitation, dynamic platform tools и WebSocket transport:
  pending.

Подробности: [`../pocs/codex-app-server/RESULTS.md`](../pocs/codex-app-server/RESULTS.md).

### 2026-07-16 — Codex platform tool callback pass

- App-server dynamic namespace/tool registration: passed.
- Exactly one structured `platform.delegate_task` callback: passed.
- Native thread/turn context validation: passed.
- Exact task contract and negative input validation: passed.
- Durable test receipt and idempotency key generation: passed.
- Tool result delivery and same-turn continuation: passed.
- PostgreSQL/outbox, lease fencing and real OpenCode dispatch: pending.
- Decision: dynamic tools are the Codex MVP command transport; separate MCP is
  optional for resources/other surfaces. See [ADR-0008](adr/0008-codex-platform-tool-transport.md).

Подробности: [`../pocs/codex-platform-tools/RESULTS.md`](../pocs/codex-platform-tools/RESULTS.md).

### 2026-07-16 — OpenCode batch runtime pass

- CLI: `opencode 1.18.3` on Ubuntu 24.04 VPS.
- Isolated Unix user: `opencode-worker`.
- Official OpenAI/ChatGPT headless auth: passed.
- Free model: `opencode/north-mini-code-free`; reported cost `0`.
- JSON streaming, native session ID and structured tool events: passed.
- Workspace write and explicit session resume in a new process: passed.
- Memory continuity without reading the first output file: passed.
- Required launch invariant: `cwd` and `PWD` must both equal the canonical
  workspace.
- HTTP server/SSE, abort and permission response: pending.

Подробности: [`../pocs/opencode-runtime/RESULTS.md`](../pocs/opencode-runtime/RESULTS.md).

### 2026-07-21 — OpenCode server parity pass

- CLI/server: `opencode 1.18.3` на Ubuntu 24.04 VPS, isolated `opencode-worker`.
- Random-password HTTP Basic auth и localhost-only listener: passed.
- `/event` SSE, structured message/tool/session events и async prompt: passed.
- Permission request/reply перед guarded shell command: passed.
- `/session/:id/abort` остановил active command до delayed filesystem side effect: passed.
- `question.asked` → operator reply → ответ в той же active session: passed.
- Production decision: server API approved; current hardened batch adapter сохраняется,
  получает bounded activity и process-group interrupt. Durable input request/resume
  остаётся product contract до отдельного перехода worker tool gateway на server mode.

Подробности: [`../pocs/opencode-server/RESULTS.md`](../pocs/opencode-server/RESULTS.md).

### 2026-07-16 — Codex → OpenCode → Codex E2E handoff pass

- Structured Codex `platform.delegate_task`: passed.
- Exact task/caller context validation: passed.
- Real runtime isolation: `codex-poc` and `opencode-worker` Unix users.
- Shared workspace ownership transfer: UID `1000 → 1001 → 1000`.
- Real OpenCode free-model process and native session: passed.
- Worker artifact verification and structured receipt: passed.
- Receipt delivery to the same Codex turn and review of actual output: passed.
- Independent verifier: 24/24.
- Durable outbox, async dispatch, lease heartbeat/fencing и retry/reconciliation: passed.
- OpenCode `complete_task` report принимается через отдельный Unix socket и
  финализируется supervisor только после выхода worker process: passed.
- Codex `request_revision`, revision events и повторный OpenCode run в той же
  native session: passed.

Подробности: [`../pocs/codex-opencode-handoff/RESULTS.md`](../pocs/codex-opencode-handoff/RESULTS.md).

### 2026-09-27 — Claude Code VPS pass

- CLI `2.1.270` из registry (подпись и sha512 проверены), root-owned prefix `/opt/claude-poc/2.1.270`, `claude update` отказывает.
- User `claude-poc`: без доп. групп, peer auth в PostgreSQL отказывает, prefix read-only.
- Subscription login (`claude auth login` от runtime user, Max): stream, resume из нового процесса и после перезагрузки хоста, MCP `delegate_task`/`complete_task`, permission prompt с отказом Bash, auth failure и unknown model: passed.
- Landlock read-only launch: runtime стартует, запись в workspace отказана: passed.
- Ресурсы: ~200 MB RSS на прогон; 4 параллельных прогона ~790 MB, `MemAvailable` ≥ 2.4 GB рядом с продуктом.
- Ограничения: SIGKILL оставляет tool-процессы (свои process groups); `~/.claude/.credentials.json` читается Bash модели.
- Decision: оркестратор `approved_with_limitations`, исполнитель `deferred`.

Подробности: ветка `poc/claude-runtime`, `pocs/claude-runtime/RESULTS.md` §7.

### 2026-09-27 — Claude Code в продукте (sprint C K2, rc.64)

- Адаптер `claude` в реестре: пользователь `claude-worker`, состояние `~/.claude` и `~/.claude.json`, пакет `@anthropic-ai/claude-code-linux-x64`, исполняемый `package/claude`; автообновление выключено окружением (`DISABLE_AUTOUPDATER`, `DISABLE_UPDATES`) на каждом запуске и пробе.
- Драйвер `drivers/claude.mjs` (адаптер 1.0.0 / runtime 2.1.270): поверхности `project` (read-only batch под Landlock, `--tools Read,Glob,Grep`, `dontAsk`, `--setting-sources user`, `--strict-mcp-config`) и `gate`; сессия выбирается супервизором (`--session-id`), продолжается `--resume`; команды платформы — MCP-мост `claude-mcp/platform-bridge.mjs` к сокету прогона; interrupt — cgroup.
- Роли: только оркестратор (0091: `runtime_roles` без `(claude, executor)`; назначение исполнителем отказывает `runtime_cannot_play_role`).
- Вход: `infra-cod runtime login claude` на хосте (C3); панель подключает подписку, когда хост сообщает рантайм вошедшим. Модели — алиасы `haiku`/`sonnet`/`opus`, каждый проверяется гейтом, который записывает точную модель.
- Приёмка на хосте: задача с оркестратором Claude и исполнителем OpenCode до PR — pending.
