# Codex Runtime PoC Results

## Test metadata

Local baseline:

- Date: 2026-07-16
- Host: macOS local development environment
- CLI: `codex-cli 0.142.5`
- Authentication: saved ChatGPT login

Target VPS validation:

- Date: 2026-07-16
- Host: Ubuntu 24.04 LTS, Linux `x86_64`, kernel `6.8.0-124-generic`
- CLI: `codex-cli 0.144.5`
- Node.js: `18.19.1`
- Authentication: official ChatGPT device authorization under unprivileged user `codex-poc`

Both runs used model `gpt-5.4`, stable `codex exec --json`, and the
`workspace-write` policy.

## Result summary

| Capability | Result | Evidence |
| --- | --- | --- |
| CLI discovery/version | Passed | `codex --version` |
| Official saved auth | Passed locally and on VPS | VPS: `Logged in using ChatGPT` after `codex login --device-auth` |
| Non-interactive start | Passed | exit code 0 |
| JSONL streaming | Passed | `thread.started`, `turn.started`, `item.*`, `turn.completed` |
| Native session/thread ID | Passed | VPS: `019f6c87-9e06-74c2-9582-2b12a8ca8cff` |
| Workspace write | Passed | `workspace/codex-poc-phase-one.txt` |
| Resume after process exit | Passed | same thread ID in new process |
| Conversation continuity | Passed | remembered `ATHENA-ORBIT-7319` without reading phase-one file |
| Write-capable resume | Passed | `workspace/codex-poc-phase-two.txt` |
| Mid-turn external input | Not tested | Requires app-server `turn/steer` PoC |
| Interrupt active turn | Not tested | Requires app-server or long-running exec test |
| Approval request/response | Not tested | Requires app-server client PoC |
| Linux/VPS | Passed | Ubuntu 24.04 target VPS, unprivileged runtime user |
| Headless auth provisioning | Passed | Official device-code flow |

## Start evidence

Command shape:

```bash
codex exec \
  --json \
  --ignore-user-config \
  --model gpt-5.4 \
  --sandbox workspace-write \
  '<prompt>'
```

Observed:

```text
thread.started
turn.started
item.started/item.completed
turn.completed
exit code 0
```

Created file:

```text
CODEX_POC_PHASE_ONE_OK
MEMORY_TOKEN=ATHENA-ORBIT-7319
```

## Resume evidence

Command shape:

```bash
codex exec resume \
  --json \
  --ignore-user-config \
  --model gpt-5.4 \
  -c 'sandbox_mode="workspace-write"' \
  -c 'approval_policy="never"' \
  019f6c87-9e06-74c2-9582-2b12a8ca8cff \
  '<prompt>'
```

Observed:

- новый OS process;
- тот же thread ID;
- remembered token из предыдущего turn;
- успешная запись второго файла;
- `turn.completed` и exit code 0.

Created file:

```text
CODEX_POC_RESUME_OK
MEMORY_TOKEN=ATHENA-ORBIT-7319
```

## Discovered integration constraints

### 1. CLI/config version mismatch

Пользовательская конфигурация выбирала `gpt-5.6-sol`, но установленный CLI сообщил, что эта модель требует более новой версии. Adapter обязан проверять совместимость CLI/runtime/model до write-capable run.

PoC использует `--ignore-user-config` и явную модель, чтобы получить воспроизводимое окружение. При этом локальные plugin warnings всё ещё появлялись в stderr и должны считаться диагностикой, а не protocol output.

### 2. Resume sandbox is not inherited as expected

`codex exec resume` не имеет отдельного `--sandbox` flag. При `--ignore-user-config` первый resume оказался read-only, хотя исходный run был workspace-write.

Для write-capable resume потребовались явные overrides:

```text
sandbox_mode="workspace-write"
approval_policy="never"
```

Будущий adapter не должен предполагать, что permissions исходного turn автоматически применятся к resume.

### 3. Session persistence writes outside project workspace

Codex сохраняет native state в `CODEX_HOME` (`~/.codex` по умолчанию). Внешняя sandbox policy control plane должна разрешать это state directory отдельно от project workspace.

### 4. Ubuntu 24.04 requires system Bubblewrap/AppArmor setup

Первый VPS run создал thread и завершил turn, но не смог записать файл. Raw
diagnostic:

```text
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

Обычная запись от пользователя `codex-poc` в тот же каталог работала, поэтому
причиной были не filesystem permissions, а Linux sandbox. На хосте отсутствовал
системный `bubblewrap`, а `kernel.apparmor_restrict_unprivileged_userns` был
включён.

Исправление без глобального отключения AppArmor:

```bash
apt-get install -y bubblewrap apparmor-profiles apparmor-utils
install -m 0644 \
  /usr/share/apparmor/extra-profiles/bwrap-userns-restrict \
  /etc/apparmor.d/bwrap-userns-restrict
apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

После загрузки узкого профиля повторные start и resume прошли полностью. Этот
setup должен войти в provisioning и smoke test целевой VPS image.

## Decision

`codex exec --json` одобрен на целевой Linux/VPS как стабильный интерфейс для
batch jobs и первоначального vertical slice.

Интерактивный PoC на `codex app-server` завершён: bidirectional JSON-RPC,
`turn/steer`, `turn/interrupt` и approvals подтверждены на целевой VPS. См.
[`../codex-app-server/RESULTS.md`](../codex-app-server/RESULTS.md).
