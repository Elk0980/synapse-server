# План 142-rules-enforcement

Владелец: Claude — сторож доски (код). Разрешённые файлы: `ops/crm/task-rules.js` (новый),
`ops/crm/task-watchdog.js`, `ops/crm/task-coordination.js`, `ops/tasks-mcp/server.js`,
`ops/tasks-mcp/tools.js`, тесты `ops/crm/*.test.js`, `ops/tasks-mcp/*.test.js`, `specs/142-rules-enforcement/`.

## Существующие модули
- `task-watchdog.js` — сторож (режим, principal, доказательства стадий, сводка, таблицы `task_watchdog_*`).
- `task-coordination.js` — карточки, MCP-инструменты (`task_create`, `task_update`, `task_comment`,
  `session_start`), `saveAsync`/`toolAsync` вызывают `watchdog.prepare` до транзакции.
- `tasks-mcp/server.js` — считает `rules_revision` из карты и обязательных документов, отдаёт в `session_start`.

## Контракты
- Новый модуль `task-rules.js`: `createTaskRules(db,{now,principal,mode})` → `seen(args)`, `beforeCreate(args,actor)`,
  `beforeUpdate(row,{before,after,status},actor)`, `summary(since)`, `lines(summary)`; чистые функции
  `parseAnchor`, `anchorStatus`, `verifiedEvidenceProblems`, `descriptionProblems`.
- Сторож создаёт `rules` в своём режиме и отдаёт `watchdog.rules`; `snapshot().rules`, строки в `digest().text`.
- Координация: проверка правил до `watchdog.prepare` (без якоря не ходим в GitHub), один раз на операцию
  (`rulesChecked` WeakSet), также в `save` (кабинет, `session_end`) и `selfStatus` (done).
- tasks-mcp: `session_start` → CRM получает `{...args, rules_revision, rules_version}`.
- Таблицы: `task_watchdog_rules_log(id, task_id, tool, rule, reason, mode, created_at)`; ключи в
  `task_watchdog_settings`. Без миграций существующих строк.

## Проверки
`node --test ops/crm/*.test.js`, `node --test ops/tasks-mcp/*.test.js` (серийно: `--test-concurrency=1`,
параллельный запуск стендов даёт гонки портов).
