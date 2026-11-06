# План 182

Владелец: Claude (ветка `claude/autoposting-delete-published`). Разбивка: PR (а) — этот; PR (б) — ВКонтакте `wall.delete` и YouTube `videos.delete` (после решения о доступах).

## Файлы (а)
- `ops/crm/autoposting-unpublish.js` — новый модуль: план целей, выполнение, журнал, маршруты `GET|POST /autoposting/posts/:id/unpublish`, `POST …/unpublish/manual`, `GET /autoposting/unpublish-states`.
- `ops/crm/autoposting-transport.js` — `removePublished` (Telegram `deleteMessage` существующим `call`) и `removeProviderPost`; ключи — существующее шифрованное хранилище каналов.
- `ops/crm/onlypult-provider.js` — `remove`: `GET /posts/{id}` → `DELETE /posts/{id}` (204).
- `ops/crm/server.js` — 3 строки: создание обработчика и вызов перед блоком `/autoposting`.
- `sites/synapse/cabinet/autoposting.js|.css` — зона `#autoposting-unpublish-zone` в редакторе публикации.
- Прокси `ops/content/server.js` не меняется: `/autoposting/*` уже требует `autoposting.edit` для записи.

## Данные
Новые таблицы `autoposting_unpublish_events`, `autoposting_unpublish_locks` (CREATE IF NOT EXISTS). Статусы `autoposting_posts`/`autoposting_deliveries` не меняются: CHECK-ограничения и логика повторной отправки остаются прежними.

## Проверки
`node --test` новых и затронутых модулей; jsdom-тест кнопки и окна; `visual.cjs` в Chrome на 390/1440 px.
