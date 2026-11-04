# План

Владелец: Claude — агент аналитики (№92). Разрешённые файлы: ops/crm/server.js (POST /leads, подготовленный запрос
leadFirstTouch), ops/crm/lead-visit-stitch.test.js, specs/112-lead-visit-stitch.
Используется существующее: таблица events (client_id, utm_*, source), индекс events_client_id_idx, deriveSource.
Миграций нет. Откат: вернуть прежний код, данные заявок останутся корректными.
В ветку влита claude/lead-public-response (PR 500, №97): тот же участок ответа POST /leads. Сливать после PR 500.
От PR 498 не зависит. Если сливать оба, возможен текстовый конфликт в server.js.
Проверки: node --test ops/crm/lead-visit-stitch.test.js ops/crm/analytics.test.js; полный ops/crm; gate.py check.
