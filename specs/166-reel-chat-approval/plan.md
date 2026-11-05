# План

Владелец: claude-reel-chat-approval (доска №166). Worktree `/home/claude/wt/reel-chat`, ветка `claude/reel-chat-approval` от `origin/main` 91ce4b37.

## Что уже есть и переиспользуется (одна функция — одно место)
| Нужно | Где уже сделано | Как используется |
|---|---|---|
| Рилсы, версии, правки → задача доски | `ops/crm/reel-materials.js` (`get`, `createPublication`, `requestEdit`) | черновик публикации версии; «Нужны правки» = `requestEdit` (kind `request`) |
| Согласование версии по площадкам, возврат на доработку, история | `ops/crm/autoposting.js` (`approve`, `submitReview`, `update`, `get`) | «Согласовано» = `approve`; статус «кто/когда» = `approval`/`platformApprovals` публикации |
| Публикация и итоги по площадкам | `autoposting.processDue` + `autoposting-transport.js` / `onlypult-provider.js` → `autoposting_deliveries` (status, url, external_id, provider_post_id, provider_status, error_code), `autoposting_publication_receipts` | сообщение с итогами читает только эти записи |
| Общий чат компании | `ops/content/team-chat.js`, таблица `team_chat_messages`, комната `common`; клиент `sites/synapse/cabinet/chats.js` | карточка и итоги — сообщения этой комнаты |
| Перенос данных CRM → чат | образец `ops/content/reel-materials-chat.js` (content забирает из CRM служебным ключом; CRM content не вызывает) | тот же приём: content читает служебный маршрут CRM |
| Хранилище видео/скриншотов | `POST/GET /content/publishing-assets` | без изменений |

## Новое (минимум)
- `ops/crm/reel-chat-approval.js` — таблица `reel_chat_approvals` (запрос: компания, ролик, версия, публикация, `content_revision` на момент отправки, площадки, подпись/файл-снимок, отправитель, решение «нужны правки» с правкой/задачей, `closed_at`) и функции `send`, `approve`, `changes`, `get`, `updates`. Статус карточки вычисляется из публикации (одно место правды согласования).
- Маршруты — в существующем `ops/crm/reel-materials-http.js` (тот же обработчик `/autoposting/reels…`):

| Метод | Путь | Право (proxy и CRM) |
|---|---|---|
| POST | `/autoposting/reels/:id/chat-approvals` `{clientRequestId,version,platformIds,text?}` | `autoposting.edit` |
| GET | `/autoposting/reels/:id/chat-approvals/:aid` | `autoposting.view` |
| POST | `/autoposting/reels/:id/chat-approvals/:aid/approve` `{}` | владелец или `autoposting.approve` |
| POST | `/autoposting/reels/:id/chat-approvals/:aid/changes` `{comment,startMs?,endMs?,durationMs?,screenshotUrl?}` | `autoposting.edit` |
| GET | `/internal/reel-materials/chat-approvals[?companyCode]` | только ключ сервиса без личности |

- Content proxy (`ops/content/server.js`): одна строка — проверка `autoposting.approve` для `.../chat-approvals/:aid/approve` рядом с существующей для `/autoposting/posts/:id/approve`; CSRF и `autoposting.edit/view` уже применяются ко всему `/autoposting`.
- `ops/content/reel-chat-approval.js` — синхронизация: читает служебный маршрут CRM, пишет/обновляет карточку (`kind='reel-approval'`, `client_id=reel-approval:<id>`, автор — отправитель, `payload` JSON) и сообщение итогов (`kind='reel-published'`), таблица `reel_chat_notices` исключает повтор по паре площадка+итог. Аддитивная колонка `team_chat_messages.payload`. Запуск: после ответа CRM на запись `/autoposting/reels/…/chat-approvals…` и `/autoposting/posts/…` (сразу), перед чтением комнаты `common` (не чаще 10 с на компанию), фоном раз в 60 с (unref, остановка при завершении). Без комнат чата или без ключа CRM — пропуск без ошибки.
- Кабинет: `sites/synapse/cabinet/reel-chat.js|css` — карточка и сообщение итогов, окно «Нужны правки» (текст, кадр из плеера через canvas или свой файл → `publishing-assets`). `chats.js` — только ветка отрисовки по `kind` и переиспользование узлов сообщений (плеер не пересоздаётся опросом раз в 5 с). `materials.js` — кнопка и форма «Отправить на согласование в чат», переход в «Чаты» (`chats?room=common`); общий `sb.openPostingDraft` вместо локальной копии открытия черновика. `cabinet.html` — два имени в списках `shellAssets/shellStyles`.

## Граница публикации
Чат ничего не публикует. После «Согласовано» публикацию ставит в план человек в «Постинге» существующим `schedule`, отправку выполняет существующий `processDue`. Автопубликация без человека есть только `approveAndSchedule` для palitra-love и требует даты — для рилсов из «Материалов» даты нет, поэтому карточка показывает «Согласовано — ждёт публикации», после постановки — «В плане на …». У редактора в карточке есть кнопка «Открыть в «Постинге»».

## Ссылки на публикации — что реально отдаётся
- Прямой Telegram (`sendVideo/sendMessage`) и прямой ВКонтакте (`wall.post`) возвращают ID, транспорт строит ссылку `t.me/<канал>/<id>` (только у публичного канала) и `vk.com/wall<id>` — она сохраняется в `autoposting_deliveries.url`.
- Onlypult: проверенный 05.11.2026 контракт `https://onlypult.com/dev/openapi.yaml` (info.version 1.0.0): схема Post — id, status, content, title, profile_ids, publish_at, published_at, media, poll, error, is_story/is_reels/is_shorts, created_at, updated_at; поля ссылки нет. Адаптер ставит `PROVIDER_LINK_UNAVAILABLE`. Ссылки есть только в аналитике (`/analytics/{id}/posts` → `url`), но связи «задание публикации → запись аналитики» контракт не даёт; подбор по времени или тексту был бы догадкой и не делается. Поэтому для Onlypult: «опубликовано, ссылка недоступна» + ID задания Onlypult.
- Подтверждение владельца «опубликовано вне кабинета» (`receipts`) — проверенная ссылка, показывается с пометкой.

## Миграции
Аддитивно: `CREATE TABLE IF NOT EXISTS reel_chat_approvals` (CRM), `reel_chat_notices` и `ALTER TABLE team_chat_messages ADD COLUMN payload TEXT` (content). Откат кода оставляет таблицы/колонку неиспользуемыми.

## Проверки
- `node --test ops/crm/reel-chat-approval.test.js ops/crm/reel-chat-approval-http.test.js ops/content/reel-chat-approval.test.js`
- `node --test sites/synapse/cabinet/reel-chat.test.cjs sites/synapse/cabinet/chats.test.cjs sites/synapse/cabinet/materials*.test.cjs`
- Регрессия: `ops/crm/reel-materials*.test.js`, `ops/crm/autoposting*.test.js`, `ops/content/team-chat*.test.js`, `ops/content/reel-materials-chat.test.js`, `ops/content/people-http.test.js`, связанные proxy-тесты content.
- Playwright 390×844 / 1440×900 на стенде (настоящие `chats.js`, `reel-chat.js/css`, `materials.js`, заглушка `ctx.api`, синтетический ролик ffmpeg).

## Параллельная работа
Ветка `claude/chats-native-layout` меняет раскладку чатов. В `chats.js` правка точечная (ветка отрисовки), стили карточки — в отдельном `reel-chat.css`. Если та ветка вмержится раньше — rebase и перенос только своего patch.
