# Security Model

## 1. Цели

- Worker не может публиковать изменения или обращаться к production systems.
- Компрометация одного runtime не раскрывает credentials других runtime.
- Опасные действия имеют явную policy и approval.
- Workspace access ограничен проектом.
- Секреты не попадают в prompts, logs, events и artifacts без необходимости.

## 2. Trust boundaries

```text
User browser
  │ authenticated channel
Control Plane
  │ policy + scoped commands
Runtime Supervisor
  ├── Orchestrator environment (privileged only by explicit policy)
  ├── OpenCode environment (worker)
  └── Antigravity environment (worker)

Secret Store and production integrations are separate boundaries.
```

Workspace diagnostics persist only bounded Git metadata (paths, status and
aggregate line counts), never file contents or raw diffs. Browser recovery
requests cannot invoke `chown` directly: the root Runtime Supervisor validates
the claimed operation, quiescent runtime jobs and stale process guard before
restoring the canonical owner or releasing a reconciled lock.

LLM output, repository content, tool output и внешние страницы считаются недоверенными данными и не могут менять policy.

## 3. Матрица полномочий

Названия runtime в таблице отражают начальные profiles. Реальное решение
принимается по assignment role и отдельным policy capabilities. Выбор runtime
как orchestrator сам по себе не выдаёт publishing credentials.

| Возможность | User | Codex | OpenCode | Antigravity |
| --- | ---: | ---: | ---: | ---: |
| Читать project workspace | Да | Да | Да | Да |
| Писать при действующем lock | — | Да | Да | Да |
| Локальные проверки | — | Да | Да | Да |
| Делегировать task | Да | Да | Нет | Нет |
| Завершить assigned implementation | — | — | Да | Да |
| Review/approve code | Да | Да | Нет | Нет |
| Commit | Через Codex | Да | Нет | Нет |
| Push | Approve/policy | Да | Нет | Нет |
| Production database (local PostgreSQL) | Approve/policy | Scoped | Нет | Нет |
| Web-процесс (Caddy → 127.0.0.1:3100) | Approve/policy | Scoped | Нет | Нет |
| Изменять credentials | Да | Нет | Нет | Нет |

Дополнительный orchestrator runtime получает только chat/planning/review scope,
пока отдельно не пройдены publishing capability gate и approval policy.

## 4. Credentials

- Используется secret store или root-readable files вне project tree.
- В БД хранится только `CredentialReference`.
- Runtime получает минимальный набор secrets непосредственно перед запуском.
- Worker environment не наследует control plane environment целиком.
- Secrets имеют scope по project, agent, action и target.
- Rotation не требует изменения task/session records.
- Логи проходят redaction до persistence.
- Private GitHub repository получает отдельный read-only deploy key. В БД
  хранится только project-bound locator и действие `clone`; provisioner
  проверяет точный путь `/etc/infra-cod/github-deploy-keys/<project UUID>`,
  использует pinned GitHub host key и не передаёт credential runtime workers.

### GitHub App connection (7.1C.1)

Private repositories теперь подключаются через owner-scoped GitHub App
installation без ручного deploy key. Deploy-key путь остаётся как fallback
(`credential_mode=deploy_key`).

- GitHub App private key хранится только на VPS в
  `/etc/infra-cod/github-app/private-key.pem` (root:infra-cod-github 0640 или
  root:root 0600), вне repository и database, не читаем runtime worker users
  (`codex-poc`, `opencode`).
- Единственный компонент, читающий ключ и mint-ящий installation tokens —
  `infra-cod-github-app-worker` (dedicated OS user `infra-cod-github`).
- Installation token живёт ≤1 час, mint-ится непосредственно перед clone,
  scope-ится до конкретного repository (`repository_ids`), permissions
  `contents:read` + `metadata:read` и явно отзывается после clone независимо от
  результата.
- Токен не попадает в: PostgreSQL, URL репозитория, durable job
  payload, domain events, audit metadata, логи web/Caddy/VPS, runtime prompt,
  окружение Codex/OpenCode, git config workspace. GIT_ASKPASS helper живёт в
  broker-only temp-директории (0700/0600), не содержит токен в скрипте, удаляется
  в `finally` даже при ошибке. Remote origin canonicalized в
  `https://github.com/owner/repo.git`.
- Login session: одноразовая, owner-scoped, короткоживущая (10 мин), в БД хранится
  только SHA-256 digest state. Callback верифицирует state digest + operator;
  повторное использование / чужой operator отклоняются.
- OAuth authorization code шифруется AES-256-GCM до записи в PostgreSQL. В БД
  находятся только ciphertext/IV/auth tag; plaintext существует только в памяти
  callback до шифрования и broker во время exchange. User access token после
  `/user/installations` явно отзывается и не сохраняется.
- Authorization: server-side ownership checks (operator_id) во всех
  `provider_*` функциях и web-actions; `list_operator_github_repositories` и
  `get_operator_github_connections` фильтруют по operator; create_project
  перепроверяет connection ownership + repository cache + archived guard
  сервером; broker перепроверяет доступ при clone (mint token → GitHub 404 =
  fail closed).
- Disconnect fail closed: новые private clones отклоняются; если clone уже идёт,
  disconnect не завершается до освобождения durable authorization. Existing
  workspace и conversations остаются читаемыми.

### Codex / ChatGPT connection (7.1C.2)

- ChatGPT device authorization выполняется только app-server процессом от
  `codex-poc`; access/refresh tokens записываются только в native
  `/home/codex-poc/.codex`.
- Web-процесс создаёт owner-scoped enrollment и читает только safe status. В
  PostgreSQL временно хранится verification URL и one-time user code, необходимые
  для показа владельцу; они очищаются после completion/failure/expiry/supersede.
- `infra-cod-codex-account-worker` не читает credential files напрямую. Он
  подключается к Runtime Supervisor account-only channel, который разрешает
  только initialize, device-code login/cancel, account read и logout. Thread,
  turn, shell, direct API-key и supplied-token login через этот канал запрещены.
- Verify вызывает native account read с refresh; Disconnect сначала выполняет
  native `account/logout` и только затем фиксирует durable `disconnected`.
  Ошибка logout/verification закрывает connection в `action_required`/`expired`.
- В `provider_connections` сохраняются только account label, plan label,
  verification time, safe boundary metadata и reference
  `codex-home:codex-poc`; raw provider credential запрещён.

Запрещено:

- хранить токены в repository;
- помещать токены в handoff payload;
- копировать auth state из Desktop-профиля;
- показывать секрет в UI после сохранения;
- использовать один универсальный production token для всех runtime.

## 5. Approvals

Approval обязателен по умолчанию для:

- первого push в новый repository/branch policy;
- force push;
- merge в protected branch;
- production database migration;
- destructive database operation;
- production deployment;
- изменение access/permissions;
- credential creation/rotation/deletion;
- удаление или архивирование workspace;
- ручного break-glass lock release при живом owner.

Approval привязывается к action fingerprint: project, target, git SHA, command category и срок действия. Изменение существенных параметров инвалидирует approval.

В реализации fingerprint вычисляется из canonical JSON action context через
SHA-256. Approval проходит состояния `pending → approved/denied → consumed`;
повторное потребление и несовпадающий fingerprint отклоняются. Request,
decision, consumption и operator incident resolution пишутся в append-only audit.

## 6. Workspace isolation

- Canonical path обязан находиться под configured project root.
- Symlink escape запрещён.
- Adapter запускается с project working directory и отдельным OS user/container profile, если возможно.
- Write operation проверяет active fencing token.
- Доступ к соседним project directories запрещён.
- Arbitrary host paths не принимаются из model-generated payload без policy validation.
- Runtime Supervisor socket имеет `root:infra-control 0660`; worker users не
  имеют права подключения.
- Supervisor выбирает workspace только по platform project ID и повторно
  проверяет canonical path после разрешения symlink.
- Runtime executable, Unix user и command flags задаются allowlist-ом сервиса,
  а не клиентским или model-generated payload.
- Runtime environment создаётся через allowlist (`env -i`), без наследования
  control-plane variables.
- Worker terminal tools используют одноразовую capability. `complete_task`,
  `report_blocker` и `request_user_input` сверяются с run/task/agent/fence и
  independently observed native session ID.

## 7. Command execution

- Runtime сохраняет нативный command approval flow, если он существует.
- Control plane может добавлять более строгую внешнюю policy.
- Model-generated command не считается доверенным.
- Production commands отделены от локальных development commands.
- Timeout, output limit и cancellation обязательны.
- Raw shell не используется для доменных операций publish/deploy, если есть структурированный integration API.

## 8. Platform tools

Каждый tool call проверяет:

- authenticated runtime/session;
- active run;
- task assignment;
- expected workflow version;
- project scope;
- workspace ownership;
- action policy;
- idempotency key.

Текст вида «задача выполнена» не эквивалентен `complete_task()`.

## 9. Network

- HTTPS обязателен.
- Control plane и database не публикуются напрямую в интернет.
- Runtime egress по возможности ограничивается разрешёнными providers и integrations.
- Streaming/SSE, если появится, использует тот же auth scope, что API
  (сейчас live-обновления идут polling'ом по обычным route'ам).
- Telegram webhook имеет отдельный secret и ограниченный command surface.

## 10. Audit и privacy

Web control plane принимает только локальную серверную сессию: вход по
username/password (Argon2id), непрозрачный токен в `__Host-`-cookie, в БД —
только его SHA-256 digest. Сессия выдаётся и вращается `SECURITY DEFINER`
функцией, а credential-событие (`auth.login`, `auth.password_changed`,
`auth.session_revoked`) пишет та же функция, что выполнила изменение, — web-слой
не называет actor'а вообще. Операторские действия (`operator.*`) пишутся
`write_session_audit`, которая выводит актора из предъявленного digest'а сессии.

Роль `infra_web` не имеет DML ни на одной authentication-таблице и не может
прочитать `users.password_hash`; доступ к учётным данным идёт только через
функции, проверяющие то, что им передали. Полный список исполняемых функций
закреплён тестом `db/tests/0026` (проверка отказами под `SET ROLE infra_web`, а
не только битом привилегии).

Анонимные страницы перенаправляются на login, API возвращают `401`, чужой
project scope не раскрывается и возвращает not-found semantics. Redirect'ы
строятся от `INFRA_COD_SITE_URL`; в production он обязателен и должен быть
`https://`-origin'ом, а входящий `Host`/`X-Forwarded-Host` как источник origin не
используется. Мутирующие запросы проверяются по `Origin` и `Sec-Fetch-Site`
против того же сконфигурированного origin'а.

Фиксируются:

- login и security settings;
- выдача approvals;
- credential reference changes;
- lock acquisition/release/break-glass;
- delegation и handoff;
- commit/push/deploy outcomes;
- policy denials.

Не требуется сохранять скрытое reasoning модели. Sensitive user input и raw output получают retention/redaction policy.

## 11. Threat scenarios

### Prompt injection из repository

Мера: repository content не меняет platform policy; publish tools требуют actor/policy/approval.

### Worker пытается выполнить push

Мера: отсутствуют credentials и tool permission; audit policy denial.

### Старый процесс пишет после expiry lock

Мера: fencing token и supervisor isolation; проект помечается reconciliation required при сомнении.

### Повтор deployment event

Мера: immutable action fingerprint и idempotency key.

### Секрет попал в output

Мера: redaction pipeline, ограничение retention, security alert и rotation procedure.

## 12. Security acceptance criteria

- Worker process environment не содержит production secrets другого tier'а:
  ни GitHub App client secret, ни pepper/OAuth-ключа web-слоя, ни DB-пароля
  (пароля в контуре нет вообще).
- Попытка path traversal блокируется.
- Stale fencing token отклоняется.
- Повтор publish с тем же key не создаёт второй side effect.
- Approval нельзя переиспользовать для другого SHA или target.
- Security-relevant events доступны в audit timeline.

## 13. Release trust root

Корень доверия release artifact — закреплённый публичный ключ minisign
`release/keys/infra-cod-release.pub`. Его путь пинован в
`release/release-version.json` (`signing.publicKey`, `signing.keyId`), то есть
является частью ревьюимого дерева. Verifier никогда не берёт публичный ключ из
проверяемого artifact'а и никогда из сети: подпись, ключ к которой приходит
вместе с ней, не доказывает ничего.

Цепочка доверия:

```text
infra-cod-release.pub (committed, reviewed)
      │ verifies
      ▼
SHA256SUMS.minisig  ──over──▶  SHA256SUMS  ──over──▶  infra-cod-<version>-linux-x64.tar.gz
                                                              │
                                                              ▼
                                                   FILESUMS.sha256 ──▶ payload
```

Подпись сделана именно над `SHA256SUMS`, а не над tarball'ом. Checksum-файл
связывает точное имя artifact'а с digest'ом, поэтому одна подпись
аутентифицирует и имя, и байты; проверка подписи не требует хешировать весь
архив; и одна подпись покрывает все artifacts, перечисленные в файле. Tarball с верным именем и чужим manifest'ом отвергается: имя файла не
является доказательством до проверки manifest'а внутри.

Порядок проверок — это и есть свойство безопасности. Публичный ключ, затем
подпись над `SHA256SUMS`, затем checksum tarball'а, затем список tar member'ов,
затем распаковка, затем identity manifest'а, затем `FILESUMS.sha256`, затем
symlink closure и, при наличии, runtime smoke. Архив не парсится до проверки
подписи, потому что tar reader — сложный код на недоверенных байтах. Ничего не
распаковывается до проверки списка member'ов, потому что absolute member,
`..`-escape или device/FIFO/socket пишут вне каталога распаковки. Manifest
читается из распакованного дерева, потому что его числа сверяются с уже
записанными файлами, но версия и target сверяются до того, как установщик
воспользуется именем каталога. Если имя artifact'а не найдено в `SHA256SUMS`
точным совпадением, проверка останавливается: «единственный» или «самый новый»
tarball в каталоге не выбирается.

Keyless-проверка, требующая сетевого обращения к transparency service, не
является приемлемой заменой: установка обязана проверяться offline против ключа,
который пришёл вместе с verifier'ом, а не тем же путём, что и проверяемый
release.

Private key существует только offline. Он не коммитится, не копируется в
artifact и не печатается. Publish job получает его из secret store, пишет в
`$RUNNER_TEMP` (не в workspace, чтобы upload не мог его забрать) и удаляет до
публикации. `release/keys/*.key` и `*.minisig` перечислены в `.gitignore`, чтобы
случайная локальная генерация не попала в индекс. PR и push jobs собирают
unsigned candidate и проверяют sign/verify/tamper paths на ephemeral key;
publish job без production-ключа падает fail closed, и unsigned fallback
отсутствует. Агент не создаёт production-ключ: приватная половина должна жить в
secret store, к которому имеет доступ только владелец.

Состав payload определяется allowlist'ом, а не копированием репозитория с
последующим blacklist'ом: blacklist ошибается в опасную сторону, включая по
умолчанию всё, о чём никто не подумал. Запрещены `.env`, `.env.local`, файл с
точным basename `.env.example`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
`initial-credentials`, `.npmrc`, `.yarnrc`, logs, caches, dumps, backups, test
fixtures, `pocs`, `.pnpm-store` и исходный `.git`. Дополнительно builder
подставляет уникальные sentinel-значения в переменные, которые проект реально
читает в production (`INFRA_COD_AUTH_PEPPER`, `INFRA_COD_OAUTH_ENCRYPTION_KEY`,
`GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `DATABASE_URL`,
`NPM_TOKEN`, `INFRA_COD_SESSION_SECRET`), и verifier после распаковки доказывает,
что ни одно из них не встретилось ни в одном файле. Найденный секрет сообщается
только типом и relative path: scanner не печатает само значение, потому что
diagnostic, эхом повторяющий секрет, распространяет его дальше. Manifest
дополнительно проверяется на отсутствие абсолютных build/home путей, private
key, registry credential и branch name.

Distribution blocker для Этапа 10: если repository private, клиент не может
скачать GitHub Release без токена, а встраивать персональный токен в installer
запрещено. Альтернатива — public release bucket/CDN.
