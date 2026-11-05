# №68 — серверная личность комментария

Цель: доставить существующий auth stamp PR485 выпускающему агенту №55 без нового механизма авторизации.

- FR-001: task_comment.comment и task_get.comments[] содержат одинаковое добавочное поле identity.
- FR-002: identity = {source:'task-watchdog',verified:true,principal:{kind,key,id}} только по записи task_watchdog_comment_auth, совпадающей по comment_id И task_id. kind сохраняет серверную роль (claude/agent/release/vlad/person), key — agent:<id> либо person:<id>, id — положительное безопасное целое.
- FR-003: без корректного stamp identity = {source:'task-watchdog',verified:false}; principal отсутствует. Запрещён backfill по author, registry kind либо клиентским аргументам.
- FR-004: существующие API-поля, сортировка и пагинация сохраняются; observe не блокирует legacy. Отозванный/чужой grant не аттестует новые комментарии; историческая личность сохраняется.
- FR-005: подписи, внутренние ключи и подписанные claims не экспортируются и не логируются.
- FR-006: потребитель №55 проверяет серверный source/verified, закреплённый principal key/id/роль, реестр Claude и exact SHA; Влад подтверждает как person:<закреплённый id>. Свободный author недостаточен.

Приёмка: настоящий локальный cabinet/MCP → comment → task_get, legacy, подделки name/kind/agentId, отзыв/чужой grant, неверные comment/task IDs; далее issuer admission exact SHA после согласования DTO с владельцем PR481. До этого №68 не закрывать.

Ограничения: один PR ≤500 строк; tools.js, авторизация, права, ключи, миграции, production не меняются. Без merge/deploy; ревью Claude.
