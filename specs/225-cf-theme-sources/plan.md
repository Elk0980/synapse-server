# План 225

Владелец — Claude (ветка `claude/cf-theme-sources`). Область: файлы ниже. Права, ключи, развёртывание не трогаются.

## Переиспользуем
- Хранение рядом с планом и фильтры по `company_id` — как `media_mentor_idea_archive` (specs/224).
- HTTP-слой `media-mentor-http.js`: `companyModuleContext` + повторная проверка `autoposting.edit`, `served(snapshot)`.
- Прокси content уже пропускает `/media-mentor/*` (GET/PUT/POST) с сессией, правом и CSRF — без изменений.

## Контракты
- `GET /media-mentor?companyCode=` → новое поле `ideaLinks: {[ideaId]: {sourcesUrl, montageUrl, updatedAt, updatedByName}}`.
- `PUT /media-mentor/plan/ideas/:ideaId/links?companyCode=` тело `{sourcesUrl?, montageUrl?}` (не переданное поле сохраняется; `''`/`null` очищает) → снимок `/media-mentor`.
- `POST /media-mentor/plan/idea-links?companyCode=` тело `{items:[{ideaId, sourcesUrl?, montageUrl?}]}` (1–200) → снимок + `linksUpdated`.
- Ошибки: 400 (`INVALID_LINK`, `DUPLICATE_IDEA`, лишние поля), 403, 404 `NOT_FOUND`, 405.

## Миграции
Только `CREATE TABLE IF NOT EXISTS` при старте. Откат кода оставляет таблицы неиспользуемыми.

## Файлы
- Сервер (ручной релиз): `ops/crm/media-mentor.js`, `ops/crm/media-mentor-http.js`.
- Кабинет (автосинк): `sites/synapse/cabinet/content-plan.js/.css`, `shooting.js/.css`, `materials.js/.css`.
- Тесты: `ops/crm/media-mentor-http.test.js`, `ops/crm/media-mentor.test.js`, `cabinet/content-plan.test.cjs`, `shooting.test.cjs`, `materials.test.cjs`.

## Порядок выпуска
Сначала CRM, потом кабинет. Кабинет без нового сервера блока ссылок не показывает (нет `ideaLinks`).
