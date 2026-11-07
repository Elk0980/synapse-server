# План 227

Владелец — Claude (ветка `claude/plan-caption-to-post`). Чат Лео (`ops/content/people-http.js`, `team-chat*`) не трогается — его ведёт другой исполнитель.

## Переиспользуем
- Чтение плана своей компании в `reel-materials.js` (`planDays` / `planIdea` — по `company_id`), архив идей `media_mentor_idea_archive` (specs/224).
- Лимиты `CAPTION_PLATFORMS` из `autoposting.js`; `autoposting.create` уже принимает `text` и `captions` (`captions()` отклоняет текст длиннее лимита — поэтому длинный текст не передаётся).
- Сохранение плана `PUT /media-mentor/plan` (`savePlan` → `normalizeDays`, серверная `contentRevision` по `variantContent`) — без изменений.
- Кабинет: `content-plan.js` (`full`, `savePlan`), `materials.js` (окно ролика, `publish`), `mentor.vocabulary.captionLimits`.

## Контракты
- `POST /autoposting/reels/:id/publication` → тот же ответ + `planText` (FR-4). Тело запроса прежнее.
- `PUT /media-mentor/plan` — прежний; кабинет отправляет изменённые `variants[*].text`.

## Миграции
Нет.

## Файлы
- Сервер (ручной релиз CRM): `ops/crm/reel-materials.js`.
- Кабинет (автосинк): `sites/synapse/cabinet/content-plan.js/.css`, `materials.js/.css`.
- Тесты: `ops/crm/reel-materials.test.js`, `sites/synapse/cabinet/content-plan.test.cjs`, `materials.test.cjs`; стенд `specs/227-plan-caption-to-post/visual.cjs`.

## Порядок выпуска
CRM и кабинет независимы: кабинет без нового CRM показывает блок текста и прежнюю фразу после «Создать публикацию»; CRM без нового кабинета подставляет текст, кабинет просто не сообщает об этом.
