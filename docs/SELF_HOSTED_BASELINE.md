# Self-hosted foundation: зелёный baseline

Зафиксирован на `feat/self-hosted-foundation` после Этапа 5.
Каждый последующий этап обязан воспроизвести этот результат.

## Команда

```bash
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH"
export DATABASE_URL="postgresql://$(whoami)@localhost:5432/infra_cod"
npm run check
```

Node **24** — то, что объявлено в `engines`. На Node 26 всё тоже проходит, но
pnpm печатает `Unsupported engine`, и это не та конфигурация, которую надо
считать проверенной.

`check` = `lint` → `typecheck` → `test:unit` → `test:integration` → `db:test`.

## Результат

| Проверка | Результат |
| --- | --- |
| `npm run check` | exit 0 |
| `test:unit` | 57 passed, 0 failed |
| `test:integration` | 11 passed, 0 failed, 0 skipped |
| `db:test` | 26 файлов, exit 0 |
| `lint` | чисто |
| `typecheck` | чисто |
| `pnpm --dir apps/web build` | проходит |
| `db:migrate` на пустом кластере | `{"status":"current","migrations":34}` |
| `db:migrate` повторно | тот же вывод (идемпотентно) |

## Что нужно знать при чтении вывода

- **`test:integration` самоскипается без `DATABASE_URL`** и отчитывается об
  успехе, ничего не проверив. CI обязан гейтить его на наличии базы, иначе
  конкурентные тесты launch-admission и deprovision-safety молча исчезнут из
  регрессионной сети.
- **Четыре DB-теста проходят молча.** `0009_runtime_activity`,
  `0010_operator_identity`, `0012_runtime_parity` и
  `0013_workspace_visibility_recovery` утверждают через `RAISE EXCEPTION`, но не
  печатают NOTICE об успехе, поэтому в выводе видно 24 явных «assertions
  passed» из 26 файлов. Это стилистическая непоследовательность, а не пробел.
- **Локальная dev-среда — не production.** Здесь одна суперпользовательская
  роль и TCP на localhost. Модель доступа production (peer auth, четыре роли,
  1:1 маппинг OS-пользователей) описана в
  [ADR-0011](adr/0011-self-hosted-access-model.md). Сами **привилегии** ролей
  проверяются здесь полноценно — `db/tests/0026` выполняет утверждения из-под
  `SET ROLE infra_web` и `SET ROLE infra_worker`. Linux-специфична только
  **аутентификация**: `pg_ident.conf` и peer-маппинг на macOS не
  воспроизводятся и проверяются на Ubuntu.

## Статус этапов

Этап 5 — **async-конверсия завершена; production connection model ждёт Этапа 2.**
Все сервисы работают через `pg.Pool`, но два места всё ещё предполагают
парольную аутентификацию и меняются вместе с переходом на peer:

- [`services/operations/backup.mjs`](../services/operations/backup.mjs) запускает
  `pg_dump` через `runuser -u infra-control`. Под peer это станет `pg_dump` от
  root с `PGUSER=infra_backup`. Менять сейчас нельзя — сломается текущий VPS.
- `deploy/systemd/*` ещё не несут `PGUSER`/`PGHOST`; они появятся вместе с
  `pg_ident.conf` из [ADR-0011](adr/0011-self-hosted-access-model.md).

Мёртвый `CONTROL_PLANE_OS_USER` из юнита web уже убран: его читал только
`psql-client.mjs`, которого больше нет.

Этап 2 сам имеет предпосылку — подэтап провижининга, описанный в ADR-0011
(«Решение 3 нельзя применить одним изменением `User=`»).
