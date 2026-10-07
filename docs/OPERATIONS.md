# Operations

## 1. Целевая среда

V1 разворачивается на одном VPS через Docker Compose или эквивалентный простой supervisor. Горизонтальное масштабирование не является целью V1.

Минимальные сервисы:

- web/API;
- control plane worker/dispatcher;
- runtime supervisor;
- PostgreSQL;
- reverse proxy/TLS;
- secret storage;
- persistent project volume;
- backup job.

## 2. Процессы runtime

- Каждый run имеет platform process reference.
- stdout/stderr собираются потоково с лимитами.
- Graceful stop предшествует kill.
- После crash supervisor не создаёт новый write run до reconciliation lock.
- Resource limits настраиваются по runtime profile.
- Upgrade runtime выполняется с capability smoke test.

## 3. Наблюдаемость

Обязательные metrics:

- active/queued/waiting runs;
- run duration и failure rate;
- active/expired locks;
- event dispatch lag и retries;
- dead-letter count;
- stream reconnect count;
- disk usage project volumes;
- database/storage health;
- usage/token metrics только если надёжно предоставлены runtime.

Structured logs включают correlation/project/task/run IDs, но не prompts, secrets и полный tool output по умолчанию.

## 4. Health checks

- liveness: процесс отвечает;
- readiness: database и dispatcher доступны;
- runtime probe: adapter может определить версию/auth;
- filesystem probe: project volume доступен;
- lock reconciler freshness;
- backup freshness.

Runtime provider outage не должен делать весь control plane `not ready`; UI показывает degraded integration.

## 5. Backup

Резервируются:

- PostgreSQL;
- project repositories и uncommitted workspace state;
- runtime state, необходимый для resume;
- encrypted configuration/secret-store metadata;
- artifacts согласно retention policy.

Наличие remote Git repository не заменяет backup незакоммиченных изменений.

Требования:

- регулярный автоматический backup;
- проверка восстановления;
- шифрование at rest и in transit;
- отдельный retention;
- audit ручного restore.

## 6. Recovery procedure

После restart:

1. восстановить database и volumes;
2. запустить API и dispatcher;
3. запустить reconciler;
4. проверить active processes;
5. expire или подтвердить locks;
6. проверить native sessions;
7. продолжить безопасные outbox deliveries;
8. пометить неопределённые side effects `needs_attention`;
9. уведомить пользователя о восстановленных/заблокированных workflows.

## 7. Updates

- Control plane migrations выполняются до старта новой версии workers.
- Adapter/runtime версии обновляются отдельно.
- Обновление выполняется из проверенного release artifact; контракт проверки и
  распаковки — раздел 19. Установка artifact'а принадлежит Этапу 10.
- Unknown runtime major version блокирует write mode.
- Rollback приложения не должен откатывать уже записанные доменные события.
- Schema migrations обязаны быть backward-compatible в пределах rollout window.

## 8. Capacity

Для V1 основной лимит — дисковое пространство workspace и logs, а не количество web requests. Должны существовать:

- disk thresholds;
- artifact retention;
- log rotation;
- per-run output limits;
- per-project concurrent run limits;
- alert до полного заполнения volume.

## 9. SLO V1

Целевые, не контрактные значения:

- control plane availability: 99% для персонального VPS;
- state recovery после обычного restart: до 5 минут;
- UI stream reconnect: до 10 секунд;
- отсутствие потери acknowledged domain events;
- zero concurrent writer incidents.

## 10. PostgreSQL foundation

Control plane работает на локальном PostgreSQL 17 (cluster `17/main`, порт
5432) на том же хосте. Внешней базы в контуре нет: web, workers, backup,
restore drill и одноразовые команды администратора подключаются к одному
серверу по Unix-сокету.

Доступ — **peer authentication**. Пароля нет нигде: OS-пользователь процесса
связан с ролью PostgreSQL через `pg_ident.conf`, а `pg_hba.conf` содержит
`local all all peer map=infra_cod_map` и явный `reject` для
`host 127.0.0.1/32` и `::1/128`. Поэтому `DATABASE_URL` и `PGPASSWORD` в
production не существуют: URL остаётся только dev/CI override'ом для
`db/tests/*.sql` и integration-тестов.

`/etc/infra-cod/database.env` (root:root 0640) содержит только координаты, общие
для всех клиентов:

```text
PGHOST=/var/run/postgresql
PGDATABASE=infra_cod
```

`PGUSER` в этом файле намеренно **отсутствует** — каждая unit задаёт свою роль,
потому что web, worker, backup, restore drill и health это разные роли, и общий
`PGUSER` сделал бы маппинг декоративным. Полная матрица unit → OS user → PG role
и требования к `pg_ident.conf` — [`deploy/systemd/README.md`](../deploy/systemd/README.md).

`PGHOST` задаётся явно, потому что все units работают с `PrivateTmp=true`:
приватный `/tmp` означает, что сокет по умолчанию (`/tmp/.s.PGSQL.5432`) внутри
unit'а не существует, и откат на него дал бы невнятную ошибку вместо соединения.

Web pool задаёт `search_path=control_plane,public,extensions` при создании
соединения. Control-plane action и его audit-строка — одна транзакция: dispatch
живёт в TypeScript, поэтому соединение кладётся в `AsyncLocalStorage` и его
читают query-хелперы (`apps/web/src/lib/database.ts`, ADR-0011).

Первичная настройка production-кластера и применение миграций:

```bash
sudo deploy/setup-postgresql-production.sh
sudo deploy/run-production-migrations.sh /opt/infra-cod/current
npm run db:test
```

Первый скрипт создаёт `17/main:5432`, production-роли, базу, три системных
peer-аккаунта и управляемые config drop-ins; второй запускает `migrate.mjs` как
`root → infra_migrator`. Legacy-миграция 0038 должна выдать
`pg_read_all_data` роли `infra_backup`, поэтому wrapper временно даёт migrator'у
`ADMIN` без `INHERIT` и `SET` и снимает это членство через trap при любом исходе.
Запуск `migrate.mjs` напрямую в production не является поддержанным install
path: он не может корректно пройти чистую 0038 с ограниченной ролью.

Runner хранит SHA-256 каждой применённой миграции в
`control_plane.schema_migrations`. Изменение применённого файла блокирует
следующий запуск. База со схемой, но без ledger'а отвергается, а не
угадывается — baseline-import из `supabase_migrations` удалён вместе с `0044`.

**Состояние на 2026-09-12:** production setup выполнен на Ubuntu 24.04 с
PostgreSQL 17.11. Семь разрешённых peer-путей, wrong-role/runtime/TCP refusals,
46 миграций, повторный no-op, backup и isolated restore прошли. После reboot оба
кластера вернулись online; peer-матрица и ledger повторно проверены. Установка
всего service stack принадлежит Этапу 10.

## 11. Backup, restore и health

- `infra-cod-backup.timer`: ежедневный PostgreSQL custom dump и filesystem
  archive, объединённые и зашифрованные GPG AES-256. Бэкап снимается ещё и
  перед каждым `infra-cod update`, поэтому хранятся последние 20
  (`INFRA_BACKUP_KEEP`) плюс самый свежий за каждый день в пределах 14 дней
  (`INFRA_BACKUP_RETENTION_DAYS`); остальные удаляются вместе с receipts.
- `infra-cod update` после успешного обновления оставляет 5 последних
  установленных релизов (`INFRA_RELEASES_KEEP`, минимум 2), всегда включая
  живой и цель отката. До rc.121 ни релизы, ни бэкапы по числу не удалялись,
  и на rc.120 диск боевого хоста заполнился: restore drill упал на `createdb`.
- `infra-cod-restore-drill.timer`: еженедельное расшифрование, проверка SHA-256,
  распаковка трёх filesystem sources и `pg_restore` во временную БД.
- `infra-cod-health.timer`: ежеминутный JSON/Prometheus snapshot без сетевого
  listener; critical state завершает oneshot с ошибкой и попадает в journal.

Текущие outputs: `/var/lib/infra-control/observability/health.json` и
`infra_cod.prom`. Backup key хранится вне repository в root-only файле.

Backup использует `/usr/lib/postgresql/17/bin/pg_dump`, задаёт корректный HOME
после `runuser` и сохраняет только принадлежащую приложению схему
`control_plane`; managed platform-схемы (`auth`, `storage`) и platform roles в
архив не включаются. Manifest format 2 фиксирует PostgreSQL server/client versions и
контрольные количества сущностей.

Restore drill выполняется PostgreSQL 17 tools в отдельном локальном cluster
`17/restore` на Unix socket `/var/run/postgresql`, port `5433` (ADR-0011,
решение 4: production занимает пакетный `17/main` на 5432). Перед restore
создаётся `extensions.pgcrypto`, а `pg_restore --no-owner --no-privileges`
проверяет переносимость application schema без воспроизведения platform roles.
Временная база удаляется даже при ошибке. Начальная/idempotent настройка VPS:

```bash
sudo deploy/setup-postgresql-17-restore.sh
sudo systemctl start infra-cod-backup.service
sudo systemctl start infra-cod-restore-drill.service
```

## 12. Dispatcher и reconciler

На development VPS включены:

```bash
systemctl status infra-cod-dispatcher.service
systemctl status infra-cod-reconciler.service
systemctl status infra-cod-runtime-supervisor.service
systemctl status infra-cod-project-provisioner.service
systemctl status infra-cod-orchestrator-worker.service
systemctl status infra-cod-implementation-worker.service
journalctl -u infra-cod-dispatcher.service -u infra-cod-reconciler.service -u infra-cod-orchestrator-worker.service -u infra-cod-implementation-worker.service
```

Unit-файлы находятся в `deploy/systemd`. Оба процесса работают как
`infra-control` и не имеют полномочий менять project filesystem или запускать
runtime users. Dispatcher резервирует outbox короткой lease и создаёт runtime
job. Reconciler обрабатывает истёкшие workspace leases; при неизвестном исходе
side effect он использует `needs_attention`/dead letter, а не автоматический
повтор.

Runtime Supervisor работает как root, но ограничен systemd capability bounding
и ambient set: `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETGID`, `SETUID`.
Остальные capabilities недоступны; `NoNewPrivileges=true`. Socket расположен в
`/run/infra-cod/runtime-supervisor.sock`, принадлежит `root:infra-control` и
имеет mode `0660`.

Orchestrator Worker работает как `infra-control`, арендует `orchestrator_turn` и
`resume_orchestrator`, heartbeat-ит runtime job и не читает project filesystem
напрямую. Read-only workspace доступ выдаёт дочернему runtime process только
Runtime Supervisor. Capability-bound dynamic tools принимают команды только текущего
thread/turn и leased task. Prompts и полные ответы в journal не записываются.

Implementation Worker работает как `infra-control`, арендует только
`implementation_run` от имени configured Runtime Supervisor и передаёт ему
platform IDs, fencing token, выбранную модель и bounded prompt. Только Runtime
Supervisor меняет ownership, запускает `opencode-worker` и финализирует terminal
tool report; executor worker затем подтверждает durable job receipt.

Project Provisioner также работает как отдельный ограниченный root service,
поскольку ему необходимо создать workspace и передать ownership runtime user.
Он обрабатывает только project metadata со статусом provisioning, проверяет что
workspace равен `<PROJECT_WORKSPACE_ROOT>/<project UUID>`, разрешает clone только
из HTTPS GitHub URL и не принимает произвольный filesystem path от browser.
Для private repository в `credential_references` хранится только locator
project-scoped read-only deploy key. Сам ключ расположен в
`/etc/infra-cod/github-deploy-keys/<project UUID>`, доступен provisioner user и
не попадает в workspace или БД. Clone идёт через `ssh.github.com:443` с
`BatchMode`, коротким connect timeout, `HostKeyAlias=github.com` и pinned
`/etc/infra-cod/github_known_hosts`; успешный retry удаляет прежнюю ошибку.

Перед ручным повтором runtime job оператор обязан проверить process state,
workspace diff и native session receipt. Простой expiry lease не доказывает,
что внешний процесс ничего не изменил.

## 13. Web control plane и Caddy

Панель — Next.js `standalone`, запущенный как `infra-cod-web.service` от
пользователя `infra-web` и слушающий только `127.0.0.1:3100`. Наружу её
публикует Caddy, который является единственным процессом с публичными портами и
единственным владельцем TLS, сжатия и HSTS.

```text
браузер/телефон ──HTTPS──▶ Caddy (80/443) ──▶ 127.0.0.1:3100 Next standalone
                                                  │
                                     Unix socket PostgreSQL 17/main,
                                     peer authentication, роль infra_web
```

Entry point — `server.js` внутри `standalone`-дерева; юнит не вызывает `next
start` и не требует package manager во время запуска. Layout и receipt
описывает `scripts/stage-standalone.mjs`, а `npm run test:standalone` запускает
именно эту сборку и проверяет login/redirect/static/restart/SIGTERM.

```bash
systemctl status infra-cod-web.service infra-cod-caddy.service
curl -sI http://127.0.0.1:3100/login          # локально, loopback
ssh -L 3200:127.0.0.1:3100 root@vps           # диагностический туннель
```

### Режимы Caddy

Два отдельных файла, потому что режим должен читаться из конфигурации, а не
угадываться по переменной окружения:

| Файл | Режим | TLS | HSTS |
| --- | --- | --- | --- |
| `deploy/caddy/Caddyfile` | публичный домен | ACME, HTTP→HTTPS | да |
| `deploy/caddy/Caddyfile.local` | clean-room приёмка | нет, только HTTP | нет |

`INFRA_COD_CADDY_CONFIG` в `infra-cod-caddy.service` выбирает файл. Caddy
работает от пользователя `caddy` с единственной capability
`CAP_NET_BIND_SERVICE` — root ему не нужен. Сертификаты и ACME account key
лежат в `StateDirectory=caddy`, access log — в `LogsDirectory=caddy`.

Что Caddy делает и почему именно он:

- `encode zstd gzip` — сжатие принадлежит Caddy; Next собран с
  `compress: false`, потому что видит только проксированный ответ;
- HSTS только в domain-режиме: только Caddy знает, что сертификат реальный и
  HTTPS стабилен. Общие browser headers (`X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options`, `Cross-Origin-Opener-Policy`) ставит
  `apps/web/src/proxy.ts`, и в Caddy они не дублируются;
- `request_body { max_size 5MB }` — верхняя граница тела запроса над
  собственным лимитом приложения;
- `X-Forwarded-*` Caddy ставит сам и по умолчанию игнорирует присланные
  клиентом значения, поэтому `header_up` для них не нужен и не должен
  добавляться: он бы создал впечатление, что защита от подмены живёт в конфиге;
- `Cookie`, `Set-Cookie` и `Authorization` Caddy пишет в access log как
  `REDACTED`; `log_credentials` не включается никогда.

Проверка перед reload (и на каждой установке):

```bash
caddy fmt --diff deploy/caddy/Caddyfile
caddy validate --config deploy/caddy/Caddyfile
systemctl reload infra-cod-caddy.service     # ExecStartPre валидирует снова
```

Смена домена — это правка `INFRA_COD_SITE_URL` в `/etc/infra-cod/web.env` и
соответствующей строки в `caddy.env`, и `systemctl reload` обоих юнитов.
Пересборка standalone **не требуется**: origin читается в рантайме, а не
вшивается на этапе сборки.

`INFRA_COD_SITE_URL` в production обязателен и должен быть `https://`-origin'ом:
панель отказывается стартовать без него, а не выводит origin из входящего
`Host`/`X-Forwarded-Host`. Это же значение — то, против чего проверяется CSRF
origin мутирующих запросов, поэтому оно должно совпадать с тем, что видит
браузер.

Workflow POST routes требуют authenticated owner, same-origin и CSRF-токен; все
credential-мутации и операторские действия пишутся в append-only `audit_events`
той же транзакцией, что и изменение.

## 14. GitHub App credential broker

Phase 7.1C.1 добавляет owner-scoped GitHub App connection и `credential_mode=
github_app` provisioning path. Брокер — отдельный VPS-сервис
`infra-cod-github-app-worker.service`, единственный компонент, имеющий право
читать GitHub App private key и mint installation tokens.

### Architecture

```text
web (infra-web)              VPS broker (infra-cod-github)          GitHub
  operator auth ──action──▶ provider_connections (pending_finalize)
  callback (state digest)        ▶ claim_github_connection_work
                                    JWT from private key ──────────▶ /app/installations/{id}
                                    installation token (scoped) ──▶ /installation/repositories
                                    activate + refresh cache ◀──── safe metadata only
  repository picker ◀──── cache read (owner-scoped)
  create_project (github repo) ──▶ projects (credential_mode=github_app)
                                    ▶ claim_github_app_clone_projects
                                    acquire_github_clone_authorization
                                    mint token (repo-scoped, 1h)
                                    git clone via GIT_ASKPASS (broker-only temp)
                                    sanitize origin, verify no token, chown ◀
                                    revoke token in finally
                                    finalize_github_clone_authorization
                                    complete_github_app_clone / fail_github_app_clone
```

Web-процесс никогда не получает private key, JWT или installation token. В БД
хранятся только safe metadata и canonical `https://github.com/owner/repo.git`
clone URLs. Токен живёт только в broker-only temp-директории на время clone и
удаляется в `finally` даже при ошибке.

**Disconnect fence**: clone-ы защищены через `github_clone_authorizations` —
broker при acquire фиксирует `connection_version`, после mint повторно валидирует
authorization и оставляет его active до завершения clone. Пока существует
непросроченный active authorization, disconnect не завершается и просит повторить
операцию позже. После clone worker отзывает token и переводит authorization в
`consumed`/`revoked`.

**OAuth authorization**: App настроена с "Request user authorization (OAuth)
during installation", но продукт не зависит от повторной установки. Для уже
установленного App кнопка Connect запускает стандартный web application flow;
GitHub возвращает в callback одноразовый `code` и `state`, но не обязан
возвращать `installation_id`.
Callback в web-процессе шифрует code через AES-256-GCM и атомарно
(`consume_session_and_record_github_oauth`) записывает в `github_oauth_codes`
только ciphertext, IV и auth tag. Broker забирает row, расшифровывает его в
памяти и обменивает
code на user access token через `POST /login/oauth/access_token`, вызывает
`GET /user/installations`, проверяет переданный installation id либо безопасно
выбирает единственную доступную installation, и только тогда создаёт connection с
`verified_via='oauth'`, после чего отзывает временный user token через
`DELETE /applications/{client_id}/token`. Состояния row:
`pending → exchanging → completed/failed/expired`. После завершения encrypted
envelope атомарно стирается; plaintext никогда не сохраняется в PostgreSQL.

### Service

```bash
systemctl status infra-cod-github-app-worker.service
journalctl -u infra-cod-github-app-worker.service
sudo -u infra-cod-github node /opt/infra-cod/app/services/control-plane/github-app-worker.mjs once
```

Сервис работает от пользователя `infra-cod-github`, получает только дополнительную
группу `agent-workspace` для доступа к закрытому `/etc/infra-cod` и каталогу
workspaces, а также ambient capabilities `CAP_CHOWN`, `CAP_FOWNER` (нужно для
`chown` workspace в `codex-poc:agent-workspace` после clone). `NoNewPrivileges=true`,
`ProtectSystem=strict`, `ReadOnlyPaths=/etc/infra-cod/github-app`,
`ReadWritePaths=/srv/infra-cod-handoff-poc/workspaces`.

### GitHub App from the panel (Stage 12 G1, recommended)

Руками ничего создавать и копировать не нужно:

1. Settings → Connections → GitHub → **Create GitHub App** (для репозиториев
   организации сначала укажите её имя). Панель отправляет GitHub манифест App:
   private, OAuth при установке, права `metadata: read`, `contents: write`,
   `pull_requests: write`, callback и setup URL — на домен панели.
2. На GitHub нажмите **Create**. GitHub возвращает одноразовый код (живёт час)
   на `/api/control-plane/github/app-manifest`; web шифрует его тем же ключом,
   что и OAuth-коды, и кладёт в `github_app_manifests` (0125).
3. `infra-cod-github-app-worker` обменивает код (`POST /app-manifests/{code}/conversions`):
   private key и client secret пишет в `/var/lib/infra-cod-github/app/`
   (`StateDirectory`, 0700, только пользователь `infra-cod-github`), в БД —
   только id, slug и client id. Секреты App не проходят через web и БД.
4. Панель сама открывает установку App: выберите **All repositories** — тогда
   любой ваш репозиторий, в том числе созданный позже, выбирается в форме проекта.
5. Дать App доступ к другим репозиториям позже: Settings → Connections →
   **Repository access**; по возвращении панель перечитывает список.

Если в `/etc/infra-cod/github-app.env` задан `GITHUB_APP_ID`, используется App
из env (ручная настройка ниже) — панель не предлагает создать второй.
Проект, созданный по URL репозитория, который App уже видит, становится
`github_app`-проектом автоматически; иначе он может клонировать, но не публиковать.

### GitHub App setup by hand (fallback)

Везде ниже `<domain>` — это домен вашей установки: тот же, что в
`INFRA_COD_SITE_URL` (`/etc/infra-cod/web.env`) и в `INFRA_COD_DOMAIN`
(`/etc/infra-cod/caddy.env`). Callback обязан указывать на него: GitHub
возвращает `code` именно туда, и адрес, не совпадающий с origin панели,
отвергается CSRF-проверкой. Например, `panel.example.com`.

1. Создайте GitHub App (owner account → Settings → Developer settings →
   GitHub Apps → New GitHub App). Name, homepage `https://<domain>`.
2. Setup URL и OAuth callback URL:
   `https://<domain>/api/control-plane/github/callback`. Включите
   **Request user authorization (OAuth) during installation** — broker проверяет
   installation через `/user/installations`, поэтому flow без `code` отклоняется.
3. Permissions → Repository permissions: `Metadata = Read-only`,
   `Contents = Read and write`, `Pull requests = Read and write` (publish пушит
   ветку и открывает PR). Не запрашивать Administration, Actions write,
   Organization administration.
4. Subscribe to events: none required for the minimal clone-only flow.
5. Где установить: All repositories или выбранные — App видит только их.
6. Сгенерируйте private key (.pem). Установите на VPS:
   ```bash
   sudo install -d -m 0750 -o root -g infra-cod-github /etc/infra-cod/github-app
   sudo install -m 0640 -o root -g infra-cod-github <app-private-key>.pem /etc/infra-cod/github-app/private-key.pem
   ```
   Файл не должен быть читаем для `codex-poc`/`opencode` runtime users.
7. `/etc/infra-cod/github-app.env`:
   ```
   GITHUB_APP_ID=<numeric app id>
   GITHUB_APP_SLUG=<app slug>
   GITHUB_APP_CLIENT_ID=<oauth client id>
   GITHUB_APP_CLIENT_SECRET=<oauth client secret>
   GITHUB_OAUTH_CODE_ENCRYPTION_KEY=<64 hex characters>
   GITHUB_APP_PRIVATE_KEY_PATH=/etc/infra-cod/github-app/private-key.pem
   ```
8. Web env: `GITHUB_APP_SLUG=<same slug>`, `GITHUB_APP_CLIENT_ID=<same client id>`
   и `GITHUB_OAUTH_CODE_ENCRYPTION_KEY=<same 64-hex key>`. Client secret и private
   key в web env не добавлять.
9. `systemctl enable --now infra-cod-github-app-worker.service`.

### Rotation / reconnect / disconnect

- **Rotate private key**: сгенерируйте новый .pem в GitHub, замените файл
  (`install -m 0640 -o root -g infra-cod-github`), `systemctl restart
  infra-cod-github-app-worker`. В БД ничего менять не нужно — `native_credential_reference`
  указывает на label, а не на конкретный ключ.
- **Reconnect**: Settings → Reconnect → открывает GitHub install URL → callback
  upsert-ит существующую connection в `pending_finalize` → broker re-verifies.
- **Disconnect**: Settings → Disconnect → `disconnect_github_connection` ставит
  `disconnected`. Если clone уже выполняется, disconnect fail-closed и его нужно
  повторить после завершения clone. Локальный disconnect НЕ отзывает installation на стороне GitHub;
  UI не должен претворяться, что отозвал. Новые private clones fail closed
  (`GitHub connection is required to clone this private repository.`); existing
  workspace и conversations остаются читаемыми. Чтобы отозвать installation на
  GitHub — отдельно в GitHub App settings.

### Diagnostics: revoked / expired installation

- Broker при `GET /app/installations/{id}` 404 вызывает
  `fail_github_connection(code='installation_not_found')` → connection
  `expired`. UI показывает `Expired` + `The GitHub App installation was removed.
  Reconnect to continue.`
- Verify button ставит `verify_requested_at`; broker re-verifies и refresh-ит
  cache. 401 → `bad_credentials` (проверить private key / app id). 403 →
  `forbidden` (проверить permissions/selection).

### Fallback to deploy key

`credential_mode=deploy_key` (legacy) остаётся рабочим: `project-provisioner`
клонирует через SSH deploy key на порту 443, как раньше. В Create project это
вкладка `Manual URL (advanced / legacy deploy-key path)`. Существующие
deploy-key проекты не требуют backfill connection ID и продолжают работать.

### Rollback

- Миграция `0022_github_app_connections.sql` добавляет таблицы и колонки +
  backfill `credential_mode`. Откат: в транзакции `DROP` новые таблицы и
  `ALTER TABLE projects DROP COLUMN` новые колонки. Перед rollback остановите
  `infra-cod-github-app-worker` и переведите github_app-проекты в
  `credential_mode='deploy_key'` (или `needs_attention`), иначе provisioner их не
  поднимет. Миграционный ledger (`schema_migrations`) требует удалить строку
  `0022` только после физического отката.
- Откат сервиса: `systemctl disable --now infra-cod-github-app-worker.service`.
  Web-действия `github_*` возвращают понятную ошибку; UI показывает
  `Connect GitHub` (нерабочий без broker).

### Security token scan (acceptance)

Уникальный fake token проверяется на отсутствие в: БД-таблицах, событиях,
командах, audit, `.git/config`, workspace, логах, error responses, runtime env.

```bash
# DB scan (rollback-safe): npm run db:test:github-app-security
# JS + git config + askpass cleanup: npm run test:github-app
```

Брокер ред-актит токен во всех сообщениях (`redactSecrets`), GIT_ASKPASS helper
не содержит токен (читает из sibling-файла 0600), origin canonicalized в
`https://github.com/owner/repo.git`, `projects.repository_url` имеет CHECK
запрещающий `@`, `provider_installation_repositories.clone_url` валидируется
regex.

## 15. Codex account credential broker

Phase 7.1C.2 connects a ChatGPT subscription through the official Codex
app-server device-code flow. Install migration
`0025_codex_account_connections.sql`, deploy the account worker unit, then
restart Runtime Supervisor so the account-only channel is available:

```bash
systemctl daemon-reload
systemctl restart infra-cod-runtime-supervisor.service
systemctl enable --now infra-cod-codex-account-worker.service
systemctl status infra-cod-codex-account-worker.service
journalctl -u infra-cod-codex-account-worker.service
```

Flow:

```text
Settings → start_codex_device_login → pending session
  → account broker → Runtime Supervisor account-only channel
  → codex-poc app-server account/login/start(chatgptDeviceCode)
  ← verification URL + one-time user code (safe presentation metadata)
  → account/login/completed → account/read
  → connected metadata; presentation fields scrubbed
```

The worker service runs as `infra-control` and cannot read
`/home/codex-poc/.codex`. Runtime Supervisor starts the account app-server as
`codex-poc` and its systemd boundary already grants write access only to that
native credential directory. No ChatGPT token is copied to the worker, database,
web environment, events or logs.

Diagnostics:

```bash
npm run test:codex-account
npm run db:test:codex-account
systemctl status infra-cod-runtime-supervisor.service infra-cod-codex-account-worker.service
```

- `pending_finalize` without a visible code: inspect both units; the broker may
  be unable to start app-server or the installed CLI may not support
  `chatgptDeviceCode`.
- `expired`: request Reconnect; codes are bounded to 15 minutes and are not
  reusable.
- Verify ending in `expired`: the native credential store is no longer
  authenticated; Reconnect.
- Disconnect is asynchronous. Durable state changes to `disconnected` only
  after app-server confirms native logout.

Rollback: stop/disable `infra-cod-codex-account-worker`, remove the Settings
surface, and physically revert migration 0025 before deleting its ledger row.
Do not delete `/home/codex-poc/.codex` as part of database rollback; native
credential removal must go through Settings Disconnect or an explicit operator
credential-revocation procedure.

## 16. OpenCode account credential broker

Sprint 7.1C.3 adds OpenCode Free (builtin, no secret) and Go (one-time encrypted
API-key enrollment). 11.2 adds OpenRouter as the `external_api` boundary,
enrolled exactly as Go is: the connection's boundary names the provider the
account worker signs the key in to (`go` → `opencode-go`, `external_api` →
`openrouter`), and the catalog of that provider leaves out models that cannot
call tools. The full server runbook is
[`7_1C_3_SERVER_HANDOFF.md`](7_1C_3_SERVER_HANDOFF.md); summary:

- `0026_opencode_connections.sql` adds `provider_connections.billing_boundary`
  (free/go/external_api), `auth_method='native'` for Free, per-boundary unique
  indexes, and `provider_secret_enrollments` (ciphertext/iv/tag/key-wrap,
  digest, expiry, scrub on completion/failure/expiry/supersede). No plaintext
  key ever enters PostgreSQL.
- The browser encrypts the Go API key with the VPS broker **public** key
  (RSA-OAEP-wrapped AES-256-GCM); only ciphertext reaches the web process or
PostgreSQL.
- `infra-cod-opencode-account-worker.service` (user `infra-control`) claims
  enrollments and connection work, decrypts with
  `/etc/infra-cod/opencode/broker-private.pem`, drives the official `opencode`
  auth flow through the Supervisor's `runtime_account` request (OpenCode's
  `account` surface, a loopback `opencode serve`), then
  scrubs all buffers.
- Free is always available and does not depend on Go; Disconnect of Go does not
  break Free (rollback-only test `db/tests/0021`).
- PoC gate: `pocs/opencode-account/run-poc.sh` must confirm the exact
  `opencode` auth/catalog flags before production use of the worker.

Diagnostics:

```bash
systemctl status infra-cod-opencode-account-worker.service infra-cod-runtime-supervisor.service
journalctl -u infra-cod-opencode-account-worker.service
npm run test:opencode-account
npm run db:test:opencode-connections
```

## 16a. Telegram notifications (0140, rc.128)

The panel sends the operator a Telegram message when a task needs their
approval, an agent asks a question, a job is dead-lettered, a pull request
opens, or a publish fails or is refused. Each message links to the chat.

- The operator makes a bot with @BotFather and pastes its token in
  **Settings → Notifications**. The browser encrypts it with the OpenCode broker
  **public** key (the same envelope as OpenCode keys); only the envelope reaches
  PostgreSQL (`telegram_connections.token_envelope`), and `infra_web` cannot
  read it back.
- `infra-cod-telegram-notifier.service` (user `infra-control`, which alone
  reads `/etc/infra-cod/opencode/broker-private.pem`) checks the token with
  `getMe`, shows a one-time `t.me/<bot>?start=<code>` link, links the chat that
  sends that `/start`, and sends `notification_outbox`. A failed send is retried
  five times with a growing pause; the token is redacted from every error.
- Messages are queued only for an owner with Telegram set up; Disconnect drops
  the envelope and anything still unsent.
- The approval message carries buttons (0142): **Approve & open PR** (for a
  GitHub App repository), **Approve only**, and **Open chat**. Each press is a
  one-time token bound to the task's version, accepted only from the linked
  chat, and decided by `approve_task_review` exactly as the panel decides it.
  A press after the task moved on is answered, not applied. Request changes
  stays in the panel.

Diagnostics:

```bash
systemctl status infra-cod-telegram-notifier.service
journalctl -u infra-cod-telegram-notifier.service
sudo -u postgres psql -d infra_cod -c "SELECT status, kind, attempts, last_error, created_at FROM control_plane.notification_outbox ORDER BY id DESC LIMIT 10;"
```

## 16b. Off-site backups (0141, rc.129)

The daily backup is gpg-encrypted on the host. With a bucket set in
**Settings → Backups**, `infra-cod-offsite-backup.service` (started by the
backup on success) uploads that encrypted file and its receipt to an
S3-compatible bucket — Cloudflare R2 by default — checks it is there at full
size, and keeps the newest 14. The bucket's secret key is stored only as the
broker envelope the browser made. The health snapshot raises
`offsite_backup_stale` (critical, sent to Telegram) when no copy has reached
the bucket in 36 hours.

**Keep the backup passphrase off this host.** The copies are useless without
`/etc/infra-cod/backup.passphrase`; if the host is lost, so is the copy of the
passphrase on it. Put it in a password manager once:

```bash
sudo cat /etc/infra-cod/backup.passphrase
```

Restoring on a new host, before it has a database to read the bucket from:

```bash
export OFFSITE_ENDPOINT=https://<account id>.r2.cloudflarestorage.com OFFSITE_BUCKET=<bucket> \
  OFFSITE_ACCESS_KEY_ID=<key id> OFFSITE_SECRET_ACCESS_KEY=<secret>
node /opt/infra-cod/current/services/operations/offsite-backup.mjs list
node /opt/infra-cod/current/services/operations/offsite-backup.mjs fetch <file>.tar.gpg /root/restore
```

then restore from `/root/restore` as from a local backup, with the passphrase
put back at `/etc/infra-cod/backup.passphrase`.

Diagnostics:

```bash
systemctl status infra-cod-offsite-backup.service
journalctl -u infra-cod-offsite-backup.service
sudo node /opt/infra-cod/current/services/operations/offsite-backup.mjs list
```

## 17. Model catalog, capability gate and runtime selection (7.1D)

Sprint 7.1D is implemented on branch `codex/sprint-7.1-finish`; the planned
production runbook is [`7_1D_7_1E_SERVER_HANDOFF.md`](7_1D_7_1E_SERVER_HANDOFF.md).
Summary (after deployment):

- `0027_provider_model_catalog.sql`: `provider_model_catalog` caches only
  normalized bounded model metadata with an identity boundary of
  (connection, provider, model, adapter/runtime version). Raw provider
  responses are rejected by a key allowlist. Statuses:
  discovered → verifying → verified | rejected, plus stale/unavailable.
  `catalog_refresh_jobs` provides idempotent per-connection refresh claims;
  `model_verification_receipts` are append-only gate receipts.
- Discovery: Codex `model/list` over the account-only Supervisor channel;
  OpenCode `provider_list` over the ephemeral authenticated localhost server
  (Free `opencode`, Go `opencode-go`). Go discovery fails closed when the
  connection is disconnected/revoked.
- `infra-cod-catalog-refresh-worker.service` runs the periodic + manual
  refresh; `infra-cod-catalog-gate-worker.service` runs the capability smoke in
  `RUNTIME_GATE_WORKSPACE_ROOT=/srv/infra-cod-handoff-poc/gate-smoke` and never
  touches production workspaces.
- `0028_runtime_selection_snapshots.sql`: project runtime defaults +
  immutable per-task snapshots. Changing defaults only affects new tasks;
  in-flight tasks keep their snapshot (`orchestrator_job_context`,
  `executor_job_context`, `resolve_executor_launch_model` prefer it).
- Only `verified` catalog entries are selectable in the UI.

Diagnostics:

```bash
systemctl status infra-cod-catalog-refresh-worker.service infra-cod-catalog-gate-worker.service
journalctl -u infra-cod-catalog-refresh-worker.service -u infra-cod-catalog-gate-worker.service
npm run db:test:provider-catalog
npm run db:test:runtime-snapshots
# Health snapshot includes catalog_refresh_* / catalog_*_entries metrics:
cat /var/lib/infra-control/observability/health.json | jq '.database | {catalog_refresh_failed,catalog_unavailable_entries,catalog_verified_entries}'
```

## 18. Project deletion and deprovisioning (7.1E)

Sprint 7.1E is implemented on branch `codex/sprint-7.1-finish`; the planned
production runbook is [`7_1D_7_1E_SERVER_HANDOFF.md`](7_1D_7_1E_SERVER_HANDOFF.md).
Summary (after deployment):

- `0033_project_deletion.sql`: owner-only, version-fenced deletion request with
  a 24-hour grace window; `Undo` before cleanup claim; `Delete now` needs a
  second explicit approval and skips only the timer. The project row remains a
  tombstone (audit history stays attributable).
- `infra-cod-project-deprovision-worker.service` stops active work worker-first
  (interrupt → receipts → bounded Supervisor fallback), proves canonical
  workspace containment under `PROJECT_WORKSPACE_ROOT` (rejects `/`, the root,
  home, empty paths, glob and symlink escapes), removes only that workspace and
  project-scoped deploy keys, re-verifies absence and only then sets
  `deprovisioned_at` + `deleted`. Partial failures are retryable
  `deletion_failed`. Remote repositories, provider connections and shared
  Codex/OpenCode homes are never touched.
- Deleting/deleted projects are hidden from normal navigation; an operations
  view lists tombstones.

Diagnostics:

```bash
systemctl status infra-cod-project-deprovision-worker.service
journalctl -u infra-cod-project-deprovision-worker.service
npm run db:test:project-deletion
# Tombstones:
psql "$DATABASE_URL" -X -qAt -c "SELECT get_operator_project_deletion_status('<owner-id>')"
```

## 19. Release artifact: verification and extraction (Stage 9)

Этап 9 поставляет приложение как три файла: tarball
`infra-cod-<version>-linux-x64.tar.gz`, `SHA256SUMS` и подпись
`SHA256SUMS.minisig`. Локальная сборка без подписи кладёт их в
`dist/releases/`. Формат архива, схему manifest'а и правила нормализации
описывает [`RELEASE_FORMAT.md`](RELEASE_FORMAT.md); здесь только контракт
проверки и распаковки перед установкой.

Проверять artifact нужно **до** любой установки и в том порядке, в котором его
выполняют сами команды: подпись над `SHA256SUMS`, затем checksum tarball'а,
затем список tar member'ов, и только потом распаковка. Распаковка
непроверенного архива в `/opt` запрещена. Имя файла не считается доказательством
до проверки manifest'а внутри: tarball с верным именем и чужим manifest'ом
отвергается.

Две команды, и они не заменяют друг друга. `release/verify-release.sh` — это
pre-install gate на POSIX shell: он не требует Node, потому что Node на хосте
появится только на Этапе 10, и использует лишь `sha256sum`, системный `tar` и
`minisign`. `scripts/verify-release.mjs` лежит внутри самого artifact'а, поэтому
ему можно доверять только после того, как shell gate прошёл; установщик
запускает его на распакованном дереве пинованным Node.

```bash
# 1. Pre-install gate: подпись, checksum, список member'ов, распаковка.
sh release/verify-release.sh --artifact infra-cod-<version>-linux-x64.tar.gz \
  --public-key release/keys/infra-cod-release.pub --require-signature \
  --extract /tmp/infra-cod-verify

# 2. Глубокая проверка уже распакованного дерева доверенным verifier'ом.
node scripts/verify-release.mjs --artifact infra-cod-<version>-linux-x64.tar.gz \
  --public-key release/keys/infra-cod-release.pub --require-signature \
  --version <version> --channel rc --smoke --json
```

Форма вывода shell gate — по одной строке на пройденную проверку:

```text
signature verified over SHA256SUMS
checksum verified: ef0465f726dc7617ab993ab4e8cfd4b9a0f9935e1551ec9f1f9ad2ed139d1483
archive members are safe: 2329 entries under infra-cod-0.0.0-dev+bcb77940beee/
extracted to /tmp/infra-cod-verify/infra-cod-0.0.0-dev+bcb77940beee
manifest version matches: 0.0.0-dev+bcb77940beee
pre-install verification passed: infra-cod-0.0.0-dev+bcb77940beee-darwin-arm64.tar.gz
```

Числа и версия в примере — macOS dev-сборка от 2026-09-11 (см.
`RELEASE_FORMAT.md`, раздел 11), а не Ubuntu. Строка про подпись относится к
подписанному релизу; сама эта dev-сборка unsigned.
`scripts/verify-release.mjs --json` печатает один JSON-объект со схемой
`infra-cod/release-verification/1`, включая `artifact`, `sha256`, `signed`,
`keyId`, `version`, `channel`, `target`, `gitSha`, `migrations`, `payload` и
`smoke`.

Что означает отказ:

| Сообщение | Причина и что делать |
| --- | --- |
| `the artifact does not match its checksum: SHA256SUMS says X, the file hashes to Y` | Байты tarball'а не совпадают с подписанным digest'ом. Файл повреждён или подменён; скачать заново, не «обновлять» `SHA256SUMS`. |
| `<name> is not listed in the checksum file (...). Refusing to guess which entry describes this artifact.` | Имя artifact'а не найдено в `SHA256SUMS` точным совпадением. Проверка не выбирает «единственный» или «самый новый» tarball в каталоге. |
| `the manifest says version X but Y was requested` / `manifest version is "X", requested "Y"` | Artifact принадлежит другой версии, чем запрошена. Не переименовывать файл: имя не меняет manifest. |
| `no signature at <path> and --require-signature was given; an unsigned artifact is not a release` | Рядом нет `SHA256SUMS.minisig`, либо подпись не передана. Без production-подписи artifact не является релизом; `--require-signature` можно снять только для локальной dev-сборки. |
| `the signature at <path> does not verify against <public key>` | Подпись сделана не тем ключом или `SHA256SUMS` изменён после подписи. Проверить, что pinned public key — тот, что закоммичен. |
| `a signature exists at <path> but --public-key was not given; a signature nobody has a key for verifies nothing` | Подпись без ключа ничего не доказывает; передать закреплённый публичный ключ. |

`--extract <dir>` распаковывает ровно один верхнеуровневый каталог в
`<dir>/infra-cod-<version>/` и только после того, как прошли все проверки.
Каталог создаётся, если его нет; существующий файл на этом пути отвергается.
Явно указанный каталог остаётся на диске, временный (без `--extract`) удаляется
после глубокой проверки.

Этап 9 не устанавливает artifact: он не создаёт OS-пользователей, не пишет
systemd units и не генерирует `/etc/infra-cod/*`. Это граница Этапа 10. Здесь
описан только контракт «проверить и распаковать», которому установщик обязан
следовать.

## 20. Installer (Stage 10)

`deploy/install.sh` устанавливает проверенный artifact на чистый Ubuntu 24.04
x86-64. Он идемпотентен: повторный запуск с тем же artifact'ом и теми же
параметрами ничего не ломает и не перегенерирует секреты.

```bash
sudo ./deploy/install.sh \
  --artifact infra-cod-<version>-linux-x64.tar.gz \
  --checksums SHA256SUMS \
  --signature SHA256SUMS.minisig \
  --public-key release/keys/infra-cod-release.pub \
  --domain panel.example.com \
  --acme-email ops@example.com
```

Bootstrap оператора получает `INFRA_COD_AUTH_PEPPER` из `.generated-secrets`, и
установщик сверяет его с `web.env` перед запуском: Argon2id без pepper'а
отказывается хешировать, а хеш, сделанный с другим pepper'ом, панель никогда не
сможет проверить.

После установки становится доступна команда `infra-cod` — root-owned shim
`/usr/local/bin/infra-cod`, который запускает CLI из текущего релиза пинованным
Node. Именно её нужно использовать: `sudo infra-cod doctor --json`.

Режимы: `--check` (только preflight), `--dry-run` (preflight и план, без
изменений), `--resume` (продолжить прерванную установку), `--json` (машинный
receipt), `--help`.

Проверка портов использует `ss -H`: без `-H` `ss` печатает заголовок колонок
даже когда фильтр ничего не нашёл, и проверка «есть ли вывод» истинна на
свободном порту. Первый реальный прогон на Ubuntu упал именно на этом —
`port 80 in use: unknown` на простаивающем хосте. То же касается doctor'а и CI.

Preflight разделён надвое. Сначала проверяется то, что установкой пакетов не
исправить — root, Ubuntu 24.04, x86-64, память, диск, занятые порты. Только
потом ставятся недостающие пакеты и проверяются инструменты. Непригодная машина
отвергается до того, как на ней что-либо изменено.

**`--json` пишет на stdout только receipt.** Все логи, включая
`Installation complete`, уходят на stderr, поэтому
`install.sh --json | jq .` — контракт, а не удача.

### Порядок и состояние

Блоки: 4 artifact → 5 пользователи и группы → 6 каталоги и ключи → 7 env-файлы →
8 PostgreSQL → 9 systemd/tmpfiles/Caddy → 10 bootstrap оператора → 11 переключение
`current` и старт.

`/etc/infra-cod/.install-state` (0600) хранит одну строку:
`block step version artifact-digest config-digest`. `--resume` пропускает блок
только если совпали **и** маркер, **и** фактическое состояние на диске: удалённый
`/etc/infra-cod` при уцелевшем state-файле приводит к повторному выполнению
блока, а не к его пропуску. Если digest artifact'а или параметры (`--domain`,
`--acme-email`) отличаются от записанных, сохранённое состояние игнорируется
целиком — иначе `--resume` пропустил бы ровно те блоки, которые эти значения и
записывают.

Установленный релиз той же версии не принимается на веру: перед no-op дерево
перепроверяется по своему `FILESUMS.sha256`, и повреждённое заменяется. Evidence
проверяет содержимое, а не имена: блок 11 сравнивает `current` именно с
устанавливаемым релизом и требует активный `infra-cod.target`; блок 9 сверяет
каждый unit, tmpfiles-файл и Caddyfile побайтово с релизом, поэтому
отредактированный вручную unit — повод выполнить блок заново; блок 7 сверяет
pepper и OAuth-ключ в `web.env` с `.generated-secrets`, потому что «непустое
значение» — это ровно то, чем является чужой pepper; блок 10 спрашивает базу, а
не наличие файла `initial-credentials`, который оператор обязан удалить после
подтверждения.

### Что обновляется при повторном запуске

Сгенерированные секреты (`INFRA_COD_AUTH_PEPPER`, OAuth-ключ, backup-passphrase,
broker-ключи) пишутся один раз и никогда не переписываются: смена pepper'а
обесценила бы все хранимые хеши паролей. Конфигурация — наоборот: запуск с другим
`--domain` меняет `INFRA_COD_SITE_URL` в `web.env` и `INFRA_COD_DOMAIN` /
`INFRA_COD_ACME_EMAIL` в `caddy.env`.

Env-файлы собираются целиком во временном файле рядом и ставятся одним
`mv`. Ключи, которых установщик не касается (например заполненный оператором
`GITHUB_APP_CLIENT_SECRET`), сохраняются; обязательные — проверяются на
единственность и непустоту до подмены. Пустой `web.env` после прерывания
восстанавливается следующим запуском.

Публичный ключ OpenCode-брокера передаётся панели как путь
(`OPENCODE_BROKER_PUBLIC_KEY_PATH`), потому что PEM многострочный, а
`EnvironmentFile` systemd многострочные значения не поддерживает. Панель читает
обе формы — см. `apps/web/src/lib/opencode-broker-key.ts`.

### Потеря секретов

Решение принимается по самим секретам, а не по маркеру. `.secrets-generated` —
нулевой файл и самый хрупкий артефакт набора; пока он был признаком, его потеря
означала, что следующий запуск молча выпустит новый pepper, новую
backup-passphrase и новый broker-ключ поверх работающей установки. Теперь
наличие **любого** из постоянных секретов означает «установка уже была», а
маркер лишь восстанавливается.

Повторный запуск проверяет каждый секрет:

Если `/etc/infra-cod` пуст целиком, установщик спрашивает базу — и «не смог
выяснить» никогда не означает «там пусто». Неотвечающий кластер, несуществующая
или неинспектируемая база — отказ. Отсутствие psql означает, что PostgreSQL
здесь не ставили (его ставит блок 8), пустая или немигрированная база — чистый
хост. Если база есть и в ней есть пользователи — установщик **отказывается** и
не генерирует ничего. Стёртый или неподмонтированный `/etc`
не оставляет секретов, а свежий pepper в такой ситуации выглядит чистой
установкой ровно до момента, когда оператор не может войти: хранимые хеши
посолены ключом, который только что заменили.

* `.generated-secrets` (pepper, OAuth-ключ), `backup.passphrase` и
  `opencode/broker-private.pem` **не восстанавливаются**. Перегенерация молча
  обесценила бы хранимые хеши паролей, существующие бэкапы и сохранённые
  OpenCode-учётки. Установщик останавливается и называет, чего не хватает.
* `opencode/broker-public.pem` восстанавливается из приватной половины — и
  заменяется, если не является её публичной половиной. Чужой публичный ключ
  проходит все проверки существования и прав, после чего ни одна
  OpenCode-учётка, зашифрованная под него, не расшифровывается. Doctor проверяет
  соответствие пары отдельно (`secrets.broker_keypair`).
* Права и владельцы всех секретов применяются заново на каждом запуске — это и
  есть путь починки, когда doctor ругается на режим файла.

### Caddy

Установщик пинует и путь, и версию: проверяется ровно `/usr/bin/caddy` (именно
его запускает unit) и ровно `v2.9.1`. Чужой `caddy` в `PATH` больше не
засчитывается.

`caddy validate` вызывается с `--envfile /etc/infra-cod/caddy.env` — тем самым
файлом, который загружает systemd. Без него `{$INFRA_COD_ACME_EMAIL}` не
раскрывается и adapter падает на `parsing caddyfile tokens for 'email': wrong
argument count`.

### Замена релиза

Каталог, на который указывает `current`, не трогается никогда. Переименовать
живое дерево в сторону и на его место поставить новое — это две операции, и
между ними пути не существует: машина, умершая в этом окне, возвращается с
`current`, указывающим в никуда. Атомарно меняться позволено только симлинку,
поэтому релиз, которому пришлось бы заменить живое дерево, ставится **рядом** с
ним под именем `<version>.rN`, а блок 11 переводит `current` на него. В любой
момент — до, во время и после — `current` разрешается в полный релиз.
Вытесненный каталог удаляется только после того, как симлинк переведён и панель
ответила.

Каталог релиза записывается в state-файл отдельно от версии: они больше не
одно и то же, и resume, восстанавливающий путь из версии, указал бы на
заменённое дерево.

### Порядок первого запуска

Блок 11 держит детерминированную последовательность: `current` переключается →
стартует target → **ожидание, пока все long-running сервисы станут active** →
backup → restore drill → health. Health отчитывается обо всём стеке, поэтому его
запуск во время старта остальных даёт отказ, описывающий тайминг, а не
установку. По той же причине health-таймер использует `OnActiveSec=2m`, а не
`OnBootSec=2m`: на давно загруженной машине второй дедлайн уже в прошлом и
таймер срабатывает немедленно.

Список сервисов берётся из `Wants=` в `infra-cod.target` — одного источника.
`services/operations/unit-contract.mjs` сверяется с ним тестом, и health, doctor
и acceptance читают контракт вместо собственных копий. Раньше списков было пять,
и они разошлись: health не следил за caddy и project-provisioner и спрашивал
`postgresql.service` — Debian-метаюнит, который неактивен, пока PostgreSQL 17
работает под `postgresql@17-main.service`.

### Каталоги для mount namespace

`ReadWritePaths`/`ReadOnlyPaths` резолвятся systemd **до** `ExecStart`, при
построении namespace юнита. Отсутствующий путь — не предупреждение, а
`status=226/NAMESPACE`, и юнит не запускается вообще. Поэтому
`/home/codex-poc/.codex`, `/home/opencode-worker/.local`,
`/home/opencode-worker/.config/opencode/tools` и `/etc/infra-cod/github-app`
создаются через `deploy/tmpfiles.d`, а не только установщиком: так они
возвращаются после любой чистки. Doctor проверяет их наличие и владельца, а тест
сверяет каждый путь из unit-файлов с записями tmpfiles.

### Финальный гейт

После старта установщик запускает `infra-cod doctor --json`. Любой critical
завершает установку с ошибкой; warning'и печатаются и не блокируют. Critical —
это, в частности, несовпадение установленного дерева с `FILESUMS.sha256`,
нечитаемый `deploy/install-manifest.json` (иначе пины Node и Caddy молча
перестают проверяться), 5xx от `/login`, неверный владелец или режим у любого
секрета, `initial-credentials`
не как root-owned regular file 0600, недоступный migration ledger, отсутствие
`git`, Caddy или Node не той версии, пропавший supervisor-socket при живом
supervisor'е и потерянное членство в группах `opencode-worker` /
`agent-workspace`. Проверяются все три сокета supervisor'а, а не один.

### Что установщик не ставит

Codex и OpenCode CLI. Решение записано в `deploy/install-manifest.json`
(`agentRuntimes`): это credential-bearing инструменты с собственным циклом
релизов, и пин их SHA-256 привязал бы релиз infra-cod к заведомо устаревшей
сборке вендора.

Важно, что именно это означает сегодня. **Ничто в репозитории их не
устанавливает.** Runtime supervisor только запускает `codex` и `opencode` из
фиксированного `PATH` (`/usr/local/bin:/opt/node/bin:/usr/bin:/bin`; пинованный
Node в нём с rc.120, чтобы агент мог запустить тесты проекта), поэтому на хосте без них
панель поднимется, а первая агентская задача упадёт с `ENOENT`. Установку
выполняет оператор; автоматизация — работа Stage 11 onboarding.

Чтобы это не всплывало на первой задаче, `infra-cod doctor` печатает
`runtime.agent_cli.codex` и `runtime.agent_cli.opencode` как warning с явной
формулировкой, а acceptance-workflow проверяет, что обе проверки присутствуют.
Всё, что нужно workspace'у до запуска агента — `git`, пинованный Node, Caddy,
PostgreSQL 17 и набор unit'ов — установщик гарантирует.

### Проверка без VPS

`npm run test:installer` прогоняет настоящий `install.sh` в песочнице
(`INFRA_COD_INSTALL_PREFIX`) со stub'ами systemd, apt, useradd и psql: чистая
установка, повтор, `--resume` после каждого блока, дрейф конфигурации, fault
injection и JSON-only stdout. Это часть `npm run check`.

Stub Caddy в стенде не возвращает 0 безусловно: он раскрывает `{$VAR}`
плейсхолдеры так же, как настоящий adapter, и отказывает без `--envfile`. Stub
`getent`/`usermod` ведут реальный список членов групп. Иначе стенд подтверждал
бы то, чего на машине нет.

Чего стенд **не** проверяет: trust chain (`minisign`, `sha256sum -c` внутри
gate'а застаблены — их проверяет `test:release` на настоящем артефакте),
поведение apt/PGDG и реальный systemd. Полная приёмка — workflow
`installer-acceptance` на `ubuntu-24.04`; до его зелёного прогона Stage 10 не
считается принятым.

## 21. Выпуск релиза

Почему схема устроена именно так — [`RELEASE_FORMAT.md`](RELEASE_FORMAT.md) §12.
Здесь только порядок действий.

### 21.1. Один раз: ключ подписи

Ключ создаёт владелец и только владелец. Приватная половина не должна
существовать нигде, кроме вашего офлайн-хранилища: ни в репозитории, ни в
переписке, ни в истории команд агента.

```bash
minisign -G -W -p release/keys/infra-cod-release.pub -s /secure/offline/infra-cod-release.key
```

`-W` обязателен. Релизный путь читает только незашифрованный ключ — зашифрованному
нужен scrypt из libsodium, и он отвергается с явной ошибкой, а не поддерживается
наполовину. Он же избавляет CI от промпта пароля.

Дальше три вещи, и все три — одним коммитом:

1. `release/keys/infra-cod-release.pub` — в репозиторий. Публичный ключ
   коммитится потому, что он часть ревьюенного дерева: проверяющий никогда не
   узнаёт ключ из того, что проверяет.
2. `release/release-version.json` → `signing.keyId` — id из строки комментария
   публичного ключа. **Пока там `null`, проверка принимает любой ключ, которым
   подписали.** Это ровно та разница между «подпись есть» и «подпись наша», и
   заполнить поле нужно до первого тега, а не после.
3. GitHub → Settings → Secrets and variables → Actions → новый secret
   `MINISIGN_SECRET_KEY` — содержимое файла ключа целиком.

Приватный ключ не может попасть в git случайно: `release/keys/*.key` и `*.minisig`
в `.gitignore`.

### 21.2. Каждый релиз: тег

Тег — не настройка, а команда «выпусти этот коммит». Один релиз — один тег.

```bash
git checkout main && git pull
git status --porcelain        # обязано быть пусто
git tag v0.1.0
git push origin v0.1.0
```

**Этот путь требует GitHub Actions, и сейчас он недоступен.** Аккаунт упёрся в
потолок 2000 минут/мес, и все пятнадцать кандидатов Stage 11.1 были собраны,
подписаны и доставлены руками. Порядок ручного выпуска —
[RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md); почему логика переезжает из YAML в
скрипты — [DELIVERY_PIPELINE.md](DELIVERY_PIPELINE.md). Ниже — путь через
Actions, который остаётся верным описанием того, что делает `release.yml`, когда
минуты есть.

Дальше `release.yml` делает всё сам и отказывается при любом расхождении: дерево
обязано быть чистым, тег — указывать ровно на HEAD, версия — совпадать с тегом.
Затем `npm run check`, сборка **дважды** со сверкой digest'ов, подпись, повторная
проверка против закоммиченного публичного ключа, offline-smoke в сетевом
namespace, загрузка, отдельный job перепроверяет уже выложенные байты, и только
после этого публикуется GitHub Release.

Первый раз пройдите весь путь вхолостую: Actions → release → **Run workflow** →
`dry_run: true`. Выполняется всё, включая подпись, но без публикации.

Публикуются ровно три файла:

```
infra-cod-<version>-linux-x64.tar.gz
SHA256SUMS
SHA256SUMS.minisig
```

### 21.3. Установка на другой машине

Требования хоста: Ubuntu 24.04 x86-64, root, ≥4 ГБ RAM (на 2 ГБ проверки моделей не получают памяти), ≥10 ГБ свободного диска,
свободные порты 80/443/3100 и **A-запись домена на IP этой машины до запуска** —
без неё Caddy не получит сертификат.

Нужны две группы файлов, и это не оплошность, а часть схемы. Артефакт приходит из
релиза, а публичный ключ и скрипты — из ревьюенного репозитория:

```bash
# скрипты и ключ — из репозитория на том же теге
git clone --depth 1 --branch v0.1.0 https://github.com/STpytut/agentic-control.git
cd agentic-control

# артефакт — из релиза
gh release download v0.1.0 --dir /tmp/rel

# проверка хоста, ничего не меняет
sudo ./deploy/install.sh --check --domain panel.example.com --acme-email you@example.com

sudo ./deploy/install.sh \
  --artifact /tmp/rel/infra-cod-0.1.0-linux-x64.tar.gz \
  --checksums /tmp/rel/SHA256SUMS \
  --signature /tmp/rel/SHA256SUMS.minisig \
  --public-key release/keys/infra-cod-release.pub \
  --domain panel.example.com \
  --acme-email you@example.com
```

`install.sh` требует, чтобы рядом с ним лежали `verify-release.sh` и
`install-manifest.json` — в репозитории они там и лежат.

Учётные данные владельца: `/etc/infra-cod/initial-credentials` (`0600 root:root`).
После первой смены пароля — `infra-cod admin ack-credentials`.

### 21.4. Обновление уже работающей машины

Обновление выполняет `infra-cod update` — единственный координатор обновления.
Повторный запуск установщика им не является и никогда не был: миграции могли
примениться, пока старые workers ещё читают схему, а `systemctl start` на уже
активном target'е не перезапускает ни одного процесса. Порядок, гарантии и
проверки — в §22.

```bash
sudo infra-cod update \
  --artifact /tmp/rel/infra-cod-0.2.0-linux-x64.tar.gz \
  --checksums /tmp/rel/SHA256SUMS \
  --signature /tmp/rel/SHA256SUMS.minisig \
  --public-key release/keys/infra-cod-release.pub \
  --yes
```

Автообновления по-прежнему нет: версия на хосте — только та, которую оператор
явно проверил и установил.

## 22. Обновление, откат и восстановление (Stage 11.0)

### 22.1. Что именно проверяется

Успехом считается не код ответа, а то, что *работающие процессы* — это те,
которые установили. systemd резолвит `WorkingDirectory=/opt/infra-cod/current/...`
в момент exec'а, поэтому рабочий каталог живого процесса — это реальный каталог
релиза; координатор читает его из `/proc/<pid>/cwd` для каждого сервиса из
unit-контракта. Процесс, оставшийся на старом дереве, и процесс, который не
запустился, — это две разные ошибки, и в отчёте они разные.

Не все юниты работают из дерева релиза: `infra-cod-dispatcher` и
`infra-cod-reconciler` имеют `WorkingDirectory=/var/lib/infra-control`, и их cwd
про код ничего не говорит. Для них доказательство другое: процесс обязан
пере-exec'нуться *после* переключения симлинка — сравниваются MainPID и
`ExecMainStartTimestampMonotonic` со снимком, снятым до switch'а. Switch и
restart происходят под одним host-lock'ом, поэтому новый exec резолвил уже новый
`current`. Список `WorkingDirectory` читается из unit-файлов релиза, а не зашит.

Кроме этого проверяются: ответ панели на `http://127.0.0.1:3100/login` (GET, не
HEAD), версия, которую печатает установленный `infra-cod version`, `Result` всех
активность таймеров, свежесть backup-receipt'а и `doctor --json` без critical.

Health-снимок не читается, а **запускается**: `Result` oneshot'а — это вердикт
того запуска, который был последним, и после неудачного обновления это вердикт
самого сбоя. На первой репетиции откат, только что вернувший рабочий хост, был
объявлен нездоровым из-за записи, сделанной посреди аварии; через минуту таймер
прогнал снимок заново, и тот прошёл. Backup и restore drill по состоянию юнита не
судятся вовсе — у них есть receipt'ы, которых обновление требует до того, как
что-то трогает.

Аутентифицированная поверхность проверяется настолько, насколько это честно для
команды без учётных данных: `/projects` обязан отвечать редиректом, а
`/api/control-plane/snapshot` — 401. Это ловит и пропавшие маршруты, и снятую
авторизацию, но это **не** вход в панель. Реальный логин — шаг оператора в
приёмке на VPS (§22.6), и координатор его не имитирует.

### 22.1a. Перед обновлением: ничто другое не должно перестраивать хост

Хостовой lock разводит операции infra-cod между собой и ничего не знает про apt.
На первой же репетиции этого не хватило: посреди обновления проснулись
`unattended-upgrades`, обновили пакеты, перезапустили PostgreSQL и `ssh.service`
— и оборвали сессию, в которой шло обновление. Оно упало безопасно и откатилось,
но начинать в такое нельзя.

Поэтому `infra-cod update` берёт frontend-замок dpkg **так же, как его берёт
apt** — эксклюзивным `fcntl`-замком — и держит его всё окно: обновление, resume
и откат. Удержание замка тут не хитрость: это документированный способ, которым
одна пакетная операция не пускает другую, а обновление, перезапускающее все
сервисы хоста, и есть пакетная операция по сути.

Из юнитов проверяются `apt-daily.service` и `apt-daily-upgrade.service` — это и
есть периодические запуски, и они oneshot, то есть активны только пока работают.
`unattended-upgrades.service` **не** проверяется: вопреки имени это «Unattended
Upgrades Shutdown», который ждёт сигнала выключения и висит `active (running)`
всю жизнь машины. Он был в списке — и отказал в обновлении на первом же стоковом
Ubuntu-хосте; проверка, закрытая всегда, это не защита, а отказ в обслуживании с
обоснованием.

Занятость определяется по `/proc/locks`, а не по коду возврата утилиты. Первая
версия этой проверки звала `flock(1)`, который берёт BSD-замок: на Linux он с
`fcntl`-замком apt **не исключается вовсе**, так что проверка не могла увидеть
занятый замок ни при каких условиях. Вторая ошибка была в том, что проверка
делалась однократно и сразу отпускала: истинность в одну секунду ничего не
говорит о следующих минутах — а именно в них всё и произошло.

Два следствия для оператора:

1. Запускайте обновление **отвязанным от SSH-сессии** — перезапуск sshd иначе
   убивает его на середине:

```bash
sudo systemd-run --unit=infra-cod-update --collect --pipe \
  infra-cod update --artifact ... --checksums ... --signature ... --public-key ... --yes
```

2. На время окна обновления имеет смысл остановить автоматические апгрейды
   (`systemctl stop unattended-upgrades.service`) и вернуть их после.

### 22.2. Порядок

1. Хостовой lock — тот же файл `flock`, что берёт `install.sh`.
2. Проверка подписанного артефакта гейтом *текущего* релиза, затем глубоким
   верификатором из самого артефакта.
3. Снимок состояния: версия, ledger миграций, что реально выполняется.
4. Свежий backup и успешный restore drill — оба receipt'а перечитываются.
5. Drain: dispatcher останавливается, in-flight работа ждёт `--drain-timeout`
   (по умолчанию 300 с). Прервать остаток можно только явным
   `--interrupt-active`; иначе обновление отменяется и dispatcher снова
   запускается.
6. Новое дерево разворачивается *рядом* с живым; каталог, на который указывает
   `current`, не переписывается никогда.
7. Решение о совместимости — из контракта входящего релиза
   (`database.compatibility`, см. `db/schema-compatibility.json`). Неизвестная
   совместимость считается несовместимостью.
8. При несовместимой миграции `infra-cod.target` останавливается до миграции.
9. Миграции применяет runner нового релиза; уже задеплоенные миграции не
   редактируются и не перештампуются.
10. Юниты и tmpfiles ставятся из нового релиза, `current` переключается атомарно,
    `daemon-reload`, затем **restart**, а не `start`.
11. Проверка из §22.1.
12. Receipt в `/etc/infra-cod/release-receipts/` (актор, версии, граница схемы,
    digest артефакта, шаги). Предыдущий релиз остаётся на диске.
13. При ошибке — откат на предыдущий релиз, если схема это позволяет; иначе
    `database_restore_required`.

### 22.3. Откат

```bash
sudo infra-cod releases list
sudo infra-cod rollback --to 0.1.0 --yes
```

`rollback` отказывается, если база ушла дальше, чем целевой релиз умеет читать:
переключение симлинка в этом случае — не откат, а старый код поверх новой схемы.
Ответ в этом случае один — восстановление из backup'а, снятого перед
обновлением; его имя записано в receipt'е обновления.

### 22.4. Прерванный запуск

Каждый изменяющий шаг пишет свою фазу в `/etc/infra-cod/.update-state` до того,
как начинается следующий, поэтому машина после потери питания может сказать, где
остановилась. Обычный `infra-cod update` в этом случае отказывается работать и
называет фазу; `--resume` продолжает, `--abandon` удаляет запись.

### 22.5. Что решает, можно ли откатиться

Совместимость проверяется по фактически достигнутой границе схемы, а не по
решению, принятому до миграции. Вопрос всегда один: «может ли релиз, на который
мы возвращаемся, прочитать схему, которая применена *сейчас*». Ledger читается в
момент отката, сравнивается с набором миграций целевого релиза, и разница
оценивается по контракту релиза, который эти миграции принёс.

Это важно в обе стороны: миграция, упавшая до применения, ledger не сдвинула — и
тогда откат это откат, а не restore; а запуск, возобновлённый после уже
применённой несовместимой миграции, не имеет «pending» миграций — и это не
означает, что старый релиз переживёт схему. Ledger, который не читается, — это
fail closed.

Receipt описывает то обновление, которое произошло, а не состояние хоста в
момент записи. Исходная граница схемы сохраняется в durable state на фазе
`staged` — после применённой миграции её больше нигде на хосте не видно, и
возобновлённый запуск, пересчитавший ledger заново, раньше писал «0051 → 0051,
applied: [], rollback разрешён» для обновления, которое на самом деле накатило
несовместимую 0051 поверх 0050. `applicationRollbackSafe` в receipt'е теперь
вычисляется тем же вопросом, что задаёт сама команда `rollback`, поэтому receipt
не может разрешить откат, который координатор откажется выполнять.

Проверка не начинается, пока systemd не довёл перезапуск. `systemctl restart
infra-cod.target` возвращает управление по завершении задания самого target'а, а
его члены перезапускаются своими заданиями — они ещё в полёте. На первом реальном
хосте это стоило корректному обновлению вердикта «провал»: у двух воркеров
`MainPID` указывал на уже убитый процесс, и `/proc/<pid>/cwd` не читался.
Координатор теперь ждёт `active` по каждому долгоживущему юниту и перечитывает
доказательство, пока оно не перестанет меняться; вердикт выносится по последнему
чтению, поэтому сервис, который действительно не вернулся, по-прежнему валит
обновление.

### 22.6. Приёмка на VPS

Код не заменяет репетицию. До закрытия гейта 11.0 на реальном хосте должны быть
пройдены: A→B, отказ B и откат на A, перезагрузка после каждого, вход в панель
под оператором и восстановление production-like backup'а в restore-кластер.

### 22.7. Чего координатор не делает

Он не переустанавливает то, что уже доказано: проверка артефакта — это
`deploy/verify-release.sh` и верификатор внутри артефакта, миграции —
`deploy/run-production-migrations.sh`, список юнитов — `unit-contract.mjs`.
Это координатор, а не второй установщик.

## 23. Рантаймы агентов (Stage 11.1)

`infra-cod runtime` ставит Codex и OpenCode из npm-реестра — как HTTP-источника
и ничего больше. Решения и их основания: [ADR-0012](adr/0012-runtime-provisioning-supply-chain.md).

### 23.1. Установка

```bash
sudo infra-cod runtime install codex --version 0.154.0
```

Версия обязана быть точной; диапазоны и `latest` отказываются. Порядок:
подпись реестра пиннованным ключом → сверка координат с запрошенными → sha512 по
`integrity` → проверка листинга архива (типы записей, цели ссылок, отсутствие
ссылок за пределы пакета и ссылок на то, чего в архиве нет) → распаковка →
`root:root` → smoke-тест от имени рантайм-пользователя через `runuser` →
атомарное переключение `/usr/local/bin/<name>`.

Флаги:

| флаг | когда нужен |
| --- | --- |
| `--wait <seconds>` | у рантайм-пользователя есть работающие процессы и их стоит подождать |
| `--accept-unmanaged-updates` | у рантайма нет подтверждённого способа выключить самообновление (сегодня — OpenCode) |

Без второго флага установка такого рантайма **отказывается**, а не
предупреждает. Флага «прервать работающие сессии» нет: подмена дерева их не
останавливает, а меняет то, с чем они работают в чужом workspace.

### 23.2. Что можно прочитать

* `infra-cod runtime list` — версия, четыре состояния готовности по отдельности
  и колонка `SELF-UPDATE UNMANAGED`.
* `infra-cod doctor` — `runtime.agent_cli.<name>`, `runtime.auth.<name>`,
  `runtime.self_update.<name>`. Проба выполняется от рантайм-пользователя; если
  этот процесс так не может, честный ответ — «вопрос не был задан», а не ответ,
  который дал бы root.
* `/etc/infra-cod/runtimes.json` — происхождение: версия, digest, источник,
  актор, результаты проверок. Учётных данных там нет; вывод auth-пробы не
  попадает ни сюда, ни в отчёты.

### 23.3. Удаление

```bash
sudo infra-cod runtime remove codex --version 0.153.0
```

Активный **каталог** удалить нельзя — именно каталог, а не номер версии: после
переустановки того же номера из пересобранного пакета на диске лежат два
неизменяемых дерева, и `remove --version` убирает те из них, на которые никто не
ссылается. Каталоги берутся из записи, а не выводятся из имени.

### 23.4. Что гарантируется при сбое

* На время переключения супервизор перестаёт допускать новые запуски **этого**
  рантайма и ждёт, пока уже открытые закончатся сами. Ничего не прерывается,
  второй рантайм не затрагивается. Unit не останавливается: он общий, и его
  остановка завершила бы все каналы — установка Codex убила бы живую сессию
  OpenCode.
* Допуск возвращается в любом случае. Если вернуть его не удалось, команда
  завершается ошибкой: хост, на котором нельзя стартовать сессию, не должен
  выглядеть успешно установленным.
* `reconcile --apply` работает под тем же fence: путь восстановления не имеет
  более слабых гарантий, чем то, что он восстанавливает.
* Границы durability: intent-файл, inventory и каталог symlink проходят `fsync`.
  `write`+`rename` без него атомарен только относительно смерти процесса и
  ничего не обещает при потере питания.
* Перед переключением пишется `/etc/infra-cod/runtime-switch.<name>.json` с той
  записью, которую предстоит внести. Если запись не удалась и ссылку вернуть не
  получилось (или машина остановилась между двумя шагами), этот файл — то, по
  чему `runtime verify` видит расхождение, а `runtime reconcile <name> --apply`
  его устраняет. `verify` теперь сравнивает цель symlink с
  `entry.active.directory`, а не только перепроверяет то, что названо в записи.
* `/usr/local/bin/<name>` заменяется, только если это отсутствующий путь или
  symlink внутрь `/opt/infra-cod/runtimes`. Чужой бинарь с тем же именем — отказ,
  а не молчаливая перезапись.
* Нечитаемый `config.toml` — отказ. «Нет файла» и «файл есть, но прочитать
  нельзя» различаются по коду возврата; раньше второе давало пустую строку, из
  которой конфиг собирался заново и затирал исходный.

* Ссылка и `runtimes.json` меняются как одна операция: если запись не удалась,
  ссылка возвращается на прежнюю версию, и запись с хостом снова совпадают.
* Если `pgrep` не смог ответить (exit ≠ 0 и ≠ 1, нет binary, ошибка `/proc`),
  установка останавливается. «Не знаю» — это не «никого нет».
* Ветка «эта версия уже установлена» не короче остальных: тот же smoke-тест, та
  же политика самообновления, та же проверка простоя. Обойти гейт можно не
  только убрав его, но и оставив дорогу мимо.
* Конфигурация рантайма не передаётся через argv: `/proc/<pid>/cmdline` читают
  все локальные пользователи. Содержимое идёт через stdin, файл создаётся с
  режимом `0600`.

### 23.5. Прогон сюит в одноразовом контейнере

```bash
scripts/run-suites-in-container.sh test:unit test:runtime test:update
```

В контейнер уходит `git archive HEAD` — только отслеживаемые файлы
зафиксированного коммита. Ни рабочего каталога, ни `.env.local`, ни `.git`, ни
host `node_modules`; при появлении чего-либо похожего на ключ или env-файл запуск
отказывается. Сеть выдаётся одной фазе, которая не видит исходников (ставит Node
и зависимости по lockfile), и отбирается у той, которая их видит
(`--network none`; loopback для локального реестра харнесса остаётся). Node
берётся тот, который installer ставит на production-хост.

## 24. Локальная консоль оператора (Stage 11.7, read-only)

```bash
sudo infra-cod console                       # units, doctor, releases, runtimes, credentials
sudo infra-cod console logs --unit infra-cod-web --lines 200
sudo infra-cod console releases --json
```

Команда для SSH-сессии, не маршрут панели: через Caddy она недоступна, и
`infra-web` от неё ничего не получает. Она только показывает — каждый факт
читается оттуда, где он уже записан:

* `units` — юниты из `unit-contract.mjs` (сервисы, oneshot'ы, таймеры,
  `infra-cod.target`, `postgresql@17-main.service`) и их состояние по
  `systemctl show`. Завершившийся oneshot — `inactive`, и это не проблема:
  для него смотрится `Result=success`, как в `doctor`.
* `doctor` — отчёт `infra-cod doctor --json` как есть; проверки не
  переписываются.
* `logs --unit <unit>` — `journalctl -u` только для юнита из контракта; чужое
  имя — отказ со списком. Выдача ограничена по строкам (по умолчанию 200, не
  больше 2000) и по байтам (256 KiB, с конца), токены, ключи, пароли и адреса
  почты вырезаны той же редакцией, что и в журналах воркеров.
* `releases` — установленные деревья по их `manifest.json` (версия и git sha, а
  не имя каталога), `current`, из какого дерева выполняется каждый сервис
  (`/proc/<pid>/cwd`), последние receipts и прерванное обновление из
  `.update-state`, если оно есть.
* `runtimes` — то же, что `infra-cod runtime list`, плюс все установленные
  версии из `runtimes.json`.
* `credentials` — есть ли ещё `/etc/infra-cod/initial-credentials` и что о нём
  говорит `initial_credentials_status()`. Файл не открывается, пароль и его хеш
  не показываются никогда. Ответ базы нужен роль (`PGUSER`), как и `admin`;
  без неё раздел честно пишет `database: unavailable`.

Изменений консоль не делает: там, где они нужны, она печатает точную команду
(`infra-cod update --resume`, `rollback --to`, `runtime install`,
`admin ack-credentials --if-retired`). `--json` есть у каждого раздела.
