# План 215 · проверка выхода

Владелец: claude-p4-publish-verify (доска №215). Один писатель на файлы ниже.

## Существующее

- `ops/crm/onlypult-provider.js` — адаптер Onlypult: `publish` (POST /posts), `reconcile` (GET /posts/{id}), `receipt`.
- `ops/crm/autoposting-transport.js` — каналы, ключи, ревизии; обёртка `reconcile`.
- `ops/crm/autoposting.js` — очередь `processDue` (каждые 30 с из server.js), доставки `autoposting_deliveries`, ручная `reconcile`.
- `ops/crm/content-stages.js` — этап идеи по доставкам/отметкам.
- `sites/synapse/cabinet/autoposting.js` — тексты кодов и показ «вышло · сообщество».

## Изменения

1. Адаптер: `receipt.publishedAt`; ошибка после POST помечается `submitted`; `findSubmitted` (GET /posts своего профиля, строгое совпадение); `permalink` (аналитика Onlypult, IG/TikTok); `contentDigest`.
2. Транспорт: `lookupSubmitted`, `postLink` — только чтение, та же ревизия канала.
3. Новый модуль `ops/crm/autoposting-verify.js`: выбор кандидатов (известные, без идентификатора, без ссылки), применение результата, итог карточки.
4. autoposting.js: колонки `provider_submitted_at, provider_content_sha, confirmed_via, provider_published_at, link_checked_at`; в отправке сохраняются время и отпечаток; `submitted` → `needs_review`; фоновая и ручная сверка через verifier; DTO.
5. content-stages: `PROVIDER_PENDING` → publishing/scheduled.
6. Кабинет (`sites/synapse/cabinet/autoposting.js`): текст кода `PROVIDER_UNCONFIRMED`.

## Проверки

Синтетические тесты (`autoposting-verify.test.js`), обновлённые ожидания в `autoposting.test.js` и `autoposting-onlypult-flow.test.js` (решение Влада меняет прежнее правило «статус сервиса ≠ опубликовано»: теперь опубликовано = повторное чтение задания со статусом published), полный ops/crm, тесты кабинета autoposting*, gate.

## Миграции и откат

Только `ALTER TABLE ... ADD COLUMN ... TEXT` при старте CRM. Откат кода совместим: лишние колонки старым кодом не читаются; доставки, уже переведённые в `published`, старый код тоже показывает как опубликованные.
