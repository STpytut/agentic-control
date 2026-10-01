# Codex Platform Tools PoC

Проверяет структурированный platform-owned tool callback через
`codex app-server` dynamic tools.

Сценарий:

1. thread получает namespace `platform` с tool `delegate_task`;
2. Codex вызывает tool с зафиксированным task contract;
3. host проверяет thread/turn context и точные аргументы;
4. host записывает command receipt с idempotency key;
5. результат возвращается Codex через ответ на `item/tool/call`;
6. Codex продолжает тот же turn и использует receipt в итоговом файле.

Запуск:

```bash
npm run poc:codex-platform-tools
npm run poc:codex-platform-tools:verify
```

Это transport/contract PoC. Он пока не создаёт реальную запись в PostgreSQL,
outbox event, workspace lease или OpenCode run.
