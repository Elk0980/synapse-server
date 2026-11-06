# План

Владелец: Claude · В «Съёмка» (доска №101). Ревью: независимый Claude, приёмка — оркестратор №98.
База `origin/main` 0a618be; PR стопкой (а)→(б)→(в)→(г). Документ не является серверной блокировкой.

## Существующее, что переиспользуем
- План: `GET /content/crm/media-mentor` (CRM `media_mentor_plans`), поля `script/filmingBy/
  productionStatus` из PR 496 читаются, если есть; без них — хук и тема. План не изменяем.
- Настройки: `ctx.settings.content.get()` агента А (`shootingWeekdays`, `deadlineDays`).
- Доступ и сессии: паттерн `telegram-sources.js` (`authStore.getById`, `sessionVersion`, CSRF,
  `autoposting.view/edit`). Хранение — тот же том `ASSETS_DIR`, подкаталог `shooting/<компания>`;
  «Исходники» ограничены 256 МБ на файл и 4 ГиБ на компанию, поэтому для 4K MOV своя сессия.
- Ключ эскизов: `hughProviders.runtimeProviders()` — тот же проверенный резервный OpenAI, что у Хью.

## Файлы (один писатель)
- `ops/content/shooting.js` — маршруты `/content/shooting/*`, таблицы `shooting_uploads`,
  `shooting_reels`; `ops/content/shooting-storage.js` — адаптер хранилища.
- `ops/content/server.js` — 3 строки регистрации (require, создание, `handle`).
- `sites/synapse/cabinet/shooting.js|.css` — экран, `shooting-prompter.js` — суфлёр и «Поделиться»,
  `shooting-upload.js` — клиент загрузки. В `cabinet.html` — только строка в списках ресурсов
  (по Контракту А; если оболочка А ещё не влита — регистрация через `SbCabinet.registerView`).

## API (контракт)
Кабинет (сессия, `?companyCode=`):
- `GET /content/shooting/reels` → `{reels:{[ideaId]:{status,takes,drafts}}, storage}`.
- `GET /content/shooting/reels/:ideaId` → `{reel:{status,board,boardRevision}, uploads[]}`.
- `PUT /content/shooting/reels/:ideaId/board` `{revision, frames}` → CAS, 409 при чужой версии.
- `POST /content/shooting/uploads` `{ideaId, frame|null, kind:'take', name, size, mime, fingerprint}`
  → 201 `{upload:{id, offset, size, status, chunkBytes}}`.
- `GET /content/shooting/uploads/:id` → текущее смещение. `PATCH …/:id` с `Upload-Offset`,
  `Content-Type: application/offset+octet-stream` → `{upload}`. `DELETE …/:id` — отмена/удаление.
- `GET /content/shooting/files/:id` — поток, поддерживает `Range`.
- `POST /content/shooting/reels/:ideaId/sketch` `{frame}` — эскиз (PR г).

Монтажёр (`Authorization: Bearer <ключ>`, без cookie и CSRF, `?companyCode=`):
Монтажёр отдельного API не имеет: Claude-агент монтажа работает через сессию кабинета пользователя с
`autoposting.edit` своей компании — `GET /reels/:ideaId`, `GET /files/:id`, `POST /uploads {kind:'draft'}`,
`PUT /reels/:ideaId/status {status:'editing'|'draft'}`.
Конфиг (необязательный, без ключей): `/data/shooting.json` `{companyQuotaBytes, minFreeBytes, minFreePercent,
sketchDailyLimit, uploadTtlHours (24), maxOpenUploads (12)}`; нет файла — значения по умолчанию.
Резерв диска (№119): после загрузки должно остаться не меньше `minFreeBytes` (по умолчанию 2 ГБ, минимум 512 МБ),
то есть нужно свободно ≥ запас + размер файла; `minFreePercent` по умолчанию 0. Env `SHOOTING_MIN_FREE_MB` важнее файла.

## Проверки
`node --test ops/content/shooting*.test.js`, jsdom `sites/synapse/cabinet/shooting*.test.cjs`,
снимки Playwright 390/1440 с заглушкой API, `python tools/spec-kit/gate.py check`.
