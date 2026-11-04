# План

Владелец: Claude — агент аналитики (№92). Разрешённые файлы: ops/crm/server.js (POST /leads, подготовленный запрос
leadFirstTouch), ops/crm/lead-visit-stitch.test.js, specs/112-lead-visit-stitch.
Используется существующее: таблица events (client_id, utm_*, source), индекс events_client_id_idx, deriveSource.
Миграций нет. Откат: вернуть прежний код, данные заявок останутся корректными.
Не зависит от PR 498 (расходы), поэтому ветка идёт от main. При слиянии обоих PR возможен текстовый конфликт в server.js.
Проверки: node --test ops/crm/lead-visit-stitch.test.js ops/crm/analytics.test.js; полный ops/crm; gate.py check.
