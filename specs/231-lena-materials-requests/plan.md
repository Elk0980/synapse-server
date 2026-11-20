# План 231

Владелец работы: Claude · разработка (задача доски №280). Ветка `claude/task-280-lena-materials` от `origin/main` 61e271e2.
Разрешённые файлы: `specs/231-lena-materials-requests/*`, `ops/crm/reel-materials.js`, `ops/crm/reel-materials-http.js`, новые `ops/crm/reel-requests.js`, `ops/crm/reel-requests.test.js`, `ops/crm/reel-requests-http.test.js`. `ops/crm/server.js` не меняется: расширение подключается внутри `createReelMaterials`.

## Существующие модули и контракты

- `reel-materials.js` — владелец таблиц `reel_materials`, `reel_versions`, `reel_edits`; `requestEdit` (задача доски + очередь), `createPublication` (черновик автопостинга), `hughLog`.
- `autoposting.js` — `create`, `get` (поля `status`, `approvalRequired`, `approval.approved`, `platformApprovals`), `CAPTION_PLATFORMS` (лимиты подписей).
- `tasks` — доска; задачи создаются той же вставкой, что в `requestEdit`.
- Прокси `ops/content/server.js` пропускает любые пути `/autoposting/…` с проверкой `autoposting.view` (GET) или `autoposting.edit` (остальное) и CSRF, поэтому новые маршруты под `/autoposting/reels/…` доступны браузеру без правок прокси. Первый сегмент `internal` прокси не пропускает.

## Данные (добавочные, без переписывания строк)

- `reel_materials`: колонки `caption`, `decision`, `decision_comment` (по умолчанию пусто).
- `reel_versions`: колонка `segments` (JSON или NULL).
- `reel_material_events`: история полей карточки.
- `reel_requests`: просьбы (вид, текст, параметры, статус, ответ, связи с правкой, публикацией и задачей, ключ идемпотентности в пределах компании).
- `reel_request_events`: история статусов просьбы.

Таблицы и колонки создаются при старте CRM (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` при отсутствии) — как уже сделано для specs/209 и 224. Отдельного скрипта миграции нет.

## Маршруты

Браузер (через прокси `/content/crm`):
- `PATCH /autoposting/reels/:id` — добавлены `caption`, `decision`, `decisionComment`.
- `GET /autoposting/reels/:id` — добавлены `caption`, `decision`, `decisionComment`, `history`, `requests`, у версий `segments`.
- `POST /autoposting/reels/:id/requests` — `{clientRequestId, kind, text?, version?, startMs?, endMs?, date?, platformIds?}`.
- `POST /autoposting/reels/:id/requests/:rid/cancel`.
- `POST /autoposting/reels/:id/live-edit` — `{clientRequestId, baseVersion, segments:[{startMs,endMs,enabled,sound}], comment?}`.

Служебные (ключ сервиса, без личности):
- `GET /internal/reel-materials/requests?companyCode=`.
- `POST /internal/reel-materials/requests/:rid/reply?companyCode=` — `{status, reply}`.
- `POST /internal/reel-materials/reels/:id/versions/:v/segments?companyCode=` — `{segments:[{startMs,endMs,label?}]}`; также необязательное `segments` в существующей загрузке версии.

## Синхронизация статусов

Статус просьбы `redo` и `publish` уточняется при чтении карточки и очереди по состоянию связанной правки или публикации. Фоновых задач и таймеров нет.

## Проверки

`node --test` в `ops/crm`: новые тесты модуля и HTTP на настоящем `server.js`, прежние `reel-materials*`, `content-archive`, `content-stages`, полный набор каталога; `python3 tools/spec-kit/gate.py check`.

## Не сделано в этой работе (и почему)

- Интерфейс кабинета: кнопки отметки, поле подписи, просьбы со статусами, переключатели отрезков, предпросмотр с пропуском выключенных отрезков, проверка на телефоне и ноутбуке. Экран лежит в `sites/synapse/cabinet/`, вне разрешённой области. Сервер готов, контракт описан выше.
- Перенос ответов агента по просьбам в личный чат с Хью: `ops/content/reel-materials-chat.js` принимает только ключи `reel-edit:…`. CRM отдаёт записи `reel-request:…` в `hugh-log`; чтобы они дошли до чата, нужна правка одной проверки ключа в `ops/content`. Для «Переделать» уведомление работает уже сейчас — через существующую запись правки «Исправлено: готова vN».
- Автоматическая нарезка ролика на отрезки: сервер видео не разбирает; отрезки задаёт агент монтажа.
