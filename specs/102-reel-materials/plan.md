# План

Владелец: Claude · Г Материалы. Worktree `/home/claude/wt/g-materials`, ветка `claude/night98-materials`.

## Модули и файлы
- PR (а) сервер: `ops/crm/reel-materials.js` (хранилище, EDL, задачи), `ops/crm/reel-materials-http.js` (маршруты), тесты. В `ops/crm/server.js` — две точечные вставки регистрации.
- PR (б) кабинет: `sites/synapse/cabinet/materials.js|css` — «Материалы» и маски площадок; точечная правка «Постинга» (кнопка «Создать публикацию» → «Материалы», маска в предпросмотре).
- PR (в) кабинет: `sites/synapse/cabinet/reel-editor.js|css` — упрощённый редактор и «Хью, измени…».
- Регистрация экранов: `window.SynapseModules.register('materials' | 'posting', …)` (КОНТРАКТ А каркаса); до его выхода — запасной `SbCabinet.registerView`.

## Маршруты (браузер через `/content/crm`, proxy уже требует autoposting.* и CSRF)
| Метод | Путь | Право |
|---|---|---|
| GET | `/autoposting/reels?companyCode&from&to&platform` | view |
| POST | `/autoposting/reels` `{title,mediaUrl,releaseDate,platforms,durationMs,sha256}` или `{postId}` | edit |
| GET / PATCH | `/autoposting/reels/:id` | view / edit |
| POST | `/autoposting/reels/:id/edits` `{clientRequestId,baseVersion,kind:'edl'|'request',edl?,comment?,startMs?,endMs?}` | edit |
| POST | `/autoposting/reels/:id/edits/:editId/cancel` | edit |
| POST | `/autoposting/reels/:id/publication` `{version,platformIds,title?}` | edit |

## API агента монтажа (CRM, `x-api-key`, без `x-synapse-crm-identity`)
1. `GET /internal/reel-materials/queue[?companyCode=]` → `{edits:[{id,companyCode,reelId,title,kind,edl,comment,startMs,endMs,status,taskId,base:{version,mediaUrl,sha256,durationMs}}]}`.
2. `POST /internal/reel-materials/edits/:id/claim?companyCode=` → правка `in_progress`, задача доски `in_progress`.
3. Монтаж ffmpeg по EDL (порядок клипов = порядок массива; `inMs/outMs` от исходной версии; звук отдельной дорожкой с `gain`/`muted`; титры по времени результата до ускорения; `coverMs` — кадр обложки; `speed` — общий множитель). Проверка `python3 tools/reels-check/check.py … --profile reel --project <код> --json`; ролик с ✘ не загружается.
4. Загрузка файла в хранилище публикаций компании (`POST /content/publishing-assets?companyCode=`, MP4/WebM) — получить `url` и `sha256`.
5. `POST /internal/reel-materials/reels/:reelId/versions?companyCode=` `{mediaUrl,sha256,durationMs,editId,note}` (заголовок `x-agent-name` необязателен) → новая версия vN, правка `done`; ответ содержит `hughChat` — текст «Исправлено…» для личного чата пользователя с Хью (точка `hugh-chat` агента Д).
6. Комментарий к задаче доски с отчётом reels-check (R31: проверяющий не автор монтажа).

## Миграции
Аддитивные таблицы `reel_materials`, `reel_versions`, `reel_edits` (CREATE IF NOT EXISTS). Откат кода оставляет таблицы.
