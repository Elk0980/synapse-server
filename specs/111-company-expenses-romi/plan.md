# План

Владелец: Claude — агент аналитики (№92). Разрешённые файлы: ops/crm/company-expenses.js (новый),
ops/crm/server.js (миграция v11, POST/GET /expenses, /dashboard, /summary), sites/synapse/cabinet/analytics.js,
версия ассетов в sites/synapse/cabinet.html, тесты и specs/111-company-expenses-romi.
Существующее: таблица expenses, analyticsData/groupFor, прокси ops/content/server.js. Прокси уже
ограничивает компанию для не-владельца, а расходы позволяет вносить только владельцу. Прокси не меняется.
Миграция v11: ALTER ADD COLUMN company_code и индекс (company_code, spent_at). Номер свободен в main
и в открытых PR на 04.11 (PR 495 использует 12). Откат: старый код колонку игнорирует; снимок рядом с БД.
Проверки: node --test ops/crm/company-expenses.test.js ops/crm/analytics.test.js;
jsdom-тесты sites/synapse/cabinet/*.test.cjs; gate.py check.
Риск конфликта: PR 488/491/495 тоже меняют ops/crm/server.js и версию ассетов. При слиянии нужен rebase.
