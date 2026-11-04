# План

Владелец: Claude, ветка `claude/company-modules-20261104`, один писатель. Разрешённые файлы: `ops/crm/company-modules*.js`, `ops/crm/email-settings.js` (точечно), `ops/crm/server.js` (точечно), `ops/content/server.js` (точечно), `ops/content/crm-permissions.test.js` (подтест), `sites/synapse/cabinet/company-modules*.{js,cjs}`, `sites/synapse/cabinet/clients.{js,css}` (вкладка), `sites/synapse/cabinet.html` (список ресурсов, версия), `.github/workflows/project-chat-check.yml` (тест), `specs/098-company-modules/`.

## Переиспользуется

- Каталог `commercial.catalog()` — источник ключей модулей; прайс не копируется.
- `deal_orders.data.modules[]` (`purchase: planned|purchased`) из `deal-orders.js`.
- `crmIdentity` и общий content-прокси `/content/crm/*` (сессия + CSRF для не-GET), проверка роли как у `/company-email`.
- `email-settings.js` → `LEADS_COMPANY_RECIPIENTS` → `email-notifications.js` — путь писем не меняется, меняется только источник адресов.
- `normalizeRecipientList` — та же проверка адресов (до 5).

## Миграции при выпуске

CRM: `CREATE TABLE IF NOT EXISTS company_modules`, `company_module_audit` + индекс при старте; откат `revertCompanyModules` (DROP). Данных не переносит; до первого включения поведение прежнее.

## Проверки

`node --test ops/crm/company-modules.test.js ops/content/crm-permissions.test.js`, `node --test sites/synapse/cabinet/company-modules.test.cjs` (jsdom), полные `ops/crm/*.test.js`, `ops/content/*.test.js`, `sites/synapse/cabinet/*.test.cjs`, `python3 tools/spec-kit/gate.py check`.
