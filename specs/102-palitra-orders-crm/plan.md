# План

Владелец: Claude, одна ветка, один писатель. Разрешённые файлы: `ops/content/site-order-crm*.js`, `ops/content/site-orders.js` (точечно), `ops/content/server.js` (точечно), `ops/crm/site-order-leads*.js`, `ops/crm/server.js` (точечно), `.github/workflows/project-chat-check.yml` (добавить тест), `specs/102-palitra-orders-crm/`.

## Существующее, что переиспользуется

- content → CRM: `CRM_URL` + служебный `CRM_API_KEY` (как `content-plan-runner`, `people-crm-client`); в `docker-compose.yml` уже передаются сервису content.
- Компания сайта: `clientCompanyConfig(env, CONTENT_COMPANIES).orderSites` (`palitra` → `palitra-love`), сохраняется в `site_orders.company_code` при приёме.
- CRM: `createLead`, `getLead`, `insertStageHistory`, `normalizeContact`, общий `requireApiKey` для всех непубличных маршрутов.

## Изменения

1. content `site-order-crm.js`: миграция/откат колонок `crm_status, crm_attempts, crm_next_attempt_at, crm_lead_id, crm_error, crm_synced_at`; `leadPayload`; фоновая передача `sync/kick/start/stop/status` с экспоненциальной паузой, остановкой на 400/409-mismatch и повтором на 409 `COMPANY_NOT_ACTIVE` и сетевых/5xx.
2. content `site-orders.js`: вызов миграции, отметка pending в транзакции заказа, `onAccepted` после фиксации.
3. content `server.js`: создание синхронизатора, `kick` после заказа, `start/stop` вместе с прочими фоновыми обработчиками.
4. CRM `site-order-leads.js` + маршрут в `server.js` перед `GET /leads`.

## Миграции при выпуске

Автоматические при старте сервисов (ADD COLUMN + индекс), обратимые функциями `revertSiteOrderCrm` / `revertSiteOrderLeads` (DROP INDEX/COLUMN, SQLite ≥ 3.35). Резервная копия обеих БД — по обычному порядку выпуска.

## Проверки

`node --test ops/content/site-order-crm*.test.js ops/crm/site-order-leads.test.js`; полный `node --test --test-concurrency=1 ops/content/*.test.js` и `ops/crm/*.test.js`; `python3 tools/spec-kit/gate.py check`.
