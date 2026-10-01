# План

1. `ops/content/site-store.js`
   - `LEGACY_SITES`: адрес `palitra-love` → `https://palitra-love.ru/` (FR-006); статус, имя и редакторы прежние.
   - После транзакции `palitra_publication_20261001` — транзакция `palitra_domain_url_20261001` (FR-001–FR-005):
     - если отметка есть — выход;
     - `UPDATE managed_sites SET public_url='https://palitra-love.ru/', updated_at=?` с условиями FR-001;
     - `INSERT INTO site_migrations` в той же транзакции.
2. `ops/content/site-store.test.js`
   - Тесты PR435 явно задают адрес поддомена (раньше его давало семя); их проверки не ослаблены.
   - Новые тесты FR-001–FR-007, включая точный оператор отката.
3. Проверки: целевой файл, полный `ops/content/*.test.js` (`--test-concurrency=1`), мутации, `node --check`, `git diff --check`, `gate.py check`, converge.

Схема таблиц не меняется. Новых зависимостей, установок, внешних вызовов, прав и настроек нет. Выпуск делает root.

## Блокер CRM
`websiteUrl` компании хранится в `companies.website_url` CRM и входит в версионированный эталон `company_information` (`ops/crm/company-information.js`, BASE).
- `refresh()` при любом расхождении строки `companies` с последней версией архивирует новую ревизию и помечает поле `confirmed` с `actorId=null` — прямая миграция превратилась бы в «подтверждённый» эталон без действия собственника (против OD-2026-09-15-COMPANY-TRUTH).
- `ops/crm/autoposting.js`: `invalidate()` переводит `scheduled`-публикации компании с другой `profile_revision` в `needs_review` (`PROFILE_CHANGED`); `schedulePrepared()` отказывает 409 `PROFILE_CHANGED`, пока карточка не пересохранена; готовность показывает «Текст написан по прежней версии данных компании».
- Текущее значение `website_url` компании Palitra в production неизвестно (данные production не читались).

Безопасная миграция, не меняющая согласований, не доказана. Штатный путь — сохранение в ЛК → данные компании (версия, автор, причина) в момент, выбранный Владом с учётом черновиков 23–37.
