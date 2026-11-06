# План

Владелец: Claude, пакет G (ветка claude/cf-stages-server). Выпуск и слияние — Root/оркестратор, вручную.

## Существующие модули и контракты

- `ops/crm/media-mentor.js` — план (media_mentor_plans), решения по версиям; `normalizeDays` строго проверяет поля идеи → отбрасывание вычисленных полей (FR-9).
- `ops/crm/media-mentor-http.js` — `GET /media-mentor`; новая необязательная зависимость `stages`.
- `ops/crm/reel-materials.js` / `-http.js` — ролики, версии (`addVersion`), правки; добавлены `ideaId`, `offPlan`.
- `ops/crm/autoposting.js`, `media-mentor-plan-link.js` — только чтение таблиц (posts, deliveries, publication_receipts, variant_transfers). Охрана отправки planLink не меняется: связь ролика с идеей хранится отдельно и отправку не ограничивает.
- `ops/content/shooting.js` — новые `facts()/factsHeader()` (только чтение своей компании).
- `ops/content/server.js` — 6 строк в прокси CRM: удалить браузерный `x-synapse-shooting-facts`, для `GET /media-mentor` добавить свой (тот же приём, что `x-synapse-content-approvers`).
- `ops/crm/server.js` — 2 строки подключения (`stages`, `mentor: () => mediaMentor`).

## Новое

`ops/crm/content-stages.js` — чистое вычисление этапа по фактам, без записи.

## Миграция данных

Добавочная, выполняется при старте CRM: `ALTER TABLE reel_materials ADD COLUMN idea_id TEXT` (если нет) и `CREATE INDEX IF NOT EXISTS reel_materials_idea ON reel_materials(company_id,idea_id) WHERE idea_id IS NOT NULL`. Старые строки — `idea_id NULL`. Откат кода безопасен: старый код колонку не читает.

## Проверки

node --test content-stages, reel-materials*, media-mentor*, shooting, content-stages-proxy; полные наборы ops/crm и ops/content; gate check.

## Выпуск (Root)

Перезапуск сервисов `crm` и `content` (docker compose), CRM первым (миграция колонки), затем content. Статика кабинета не меняется.
