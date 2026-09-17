# Telegram Mini App для общего чата проекта: implementation handoff

Статус: реализовано локально в ветке `codex/palitra-telegram-miniapp` и проверено автотестами (см. §9); в production не опубликовано, у бота не настроено, живая проверка в клиентах Telegram не проводилась. Решения сверены с постановкой Влада и с официальной https://core.telegram.org/bots/webapps на 17.09.2026. Подтверждённый публичный ID бота `@synapse_sb_bot` — `8707527108` (не токен); production-значение `TELEGRAM_BOT_ID` задаёт Хью после CI.

Постановка: Mini App открывается из группы Palitra/Маркетинг по кнопке или ссылке и выглядит как общий чат ЛК — вся история, фото/PDF, задачи с исполнителями, этапами и статусами, та же база и тот же bot outbox. Сообщения Хью приходят только через бота с подписью «Хью, бизнес-ассистент Синапс Бизнес», не с аккаунта Влада. Публичные и личные разделы владельца участникам не открываются. Участники сопоставляются явно по числовому Telegram ID, не по username; реальные участники — Влад, Дарья, Анна, назначенные владельцем. Учитываются тема Telegram, safe areas, BackButton, клавиатура, размеры Android/iOS/Desktop.

## 1. Что переиспользуется без изменений

| Слой | Файл | Что берём |
|---|---|---|
| UI комнаты | `sites/synapse/cabinet/project-chat.js`, `project-chat.css` | Лента, подгрузка истории, композитор, вложения, задачи/этапы/статусы, пометка `ИИ · бизнес-ассистент Синапс Бизнес`, честные состояния Хью (офлайн ПК, лимит, ожидание входа). Кнопки владельца (`[data-pc-owner]`, настройки, участники, retry-ai) скрыты при `access.owner=false`; вкладка «Личный Хью» не рисуется при `identity.role!=='owner'`. |
| API комнаты | `ops/content/project-chat.js` (`handle`, `access`) | `GET /content/project-chat/{code}`, `GET …/messages?before=`, `POST …/messages`, `POST …/attachments`, `GET …/attachments/{id}`, `POST/PATCH …/tasks`, `…/stages`. Доступ: компания + членство в `project_chat_members`, пользователь перечитывается на каждом запросе. |
| Очередь и доставка | `project_chat_outbox`, `ops/chat/project-chat-bridge.js` | Сообщение из Mini App — обычное сообщение комнаты → outbox → бот. Подпись ИИ в группе уже есть (`AI_SIGNATURE`). Mini App к Bot API не обращается. |
| Ответы Хью | `project_chat_ai_jobs`, локальный обработчик | Без изменений: обращение «Хью, …» или режим замены ставит задание; ответ приходит в ту же ленту и в группу через бота. |
| Хостинг | `caddy/Caddyfile`, блок `synapse.synapsebusiness.ru` | `/content/*` уже проксируется в `content:8080`; статика из `/srv/sites/synapse`. Страница Mini App живёт на том же origin, что и API. |

## 2. Точка входа из Telegram
- Из группы: прямая ссылка Main Mini App `https://t.me/synapse_sb_bot?startapp=palitra-love` (после того как владелец настроит Main Mini App у бота) либо именованное приложение по реально существующей настройке. `startapp` — только подсказка кода компании; сервер всё равно проверяет членство.
- Menu Button действует в личном чате с ботом; в группах его не обещаем.
- Сейчас ничего в BotFather и в группу не отправляется; настройка выполняется владельцем на этапе внедрения. Нужные ему шаги перечислены в §10.

## 3. Новые части (минимум)

### 3.1. `sites/synapse/miniapp.html` (новая страница)
- Подключает `https://telegram.org/js/telegram-web-app.js` (официальный скрипт, единственная внешняя зависимость), `cabinet/project-chat.css`, `cabinet/project-chat.js`, свой небольшой `cabinet/miniapp-host.js`.
- `miniapp-host.js` — хост-шим вместо `cabinet.html`: `window.SbCabinet = { registerView }`, затем `views.hugh.render(root, ctx)` с `ctx = { identity, selectedProjectId, currentView: 'hugh', byId, escapeHTML, authHeaders, fetchAsset }` — тот же контракт, что даёт `cabinet.html`. `project-chat.js` не форкается.
- Telegram-специфика в шиме: `Telegram.WebApp.ready()/expand()`, тема через `themeParams` → CSS-переменные `--surface/--text/--muted/--accent/--line`, которыми уже пользуется `project-chat.css`; `safeAreaInset`/`contentSafeAreaInset` → отступы контейнера; `viewportStableHeight` → высота ленты (замена `calc(100dvh - 190px)` для Mini App); при открытой клавиатуре лента остаётся прокручиваемой, композитор — внизу; `BackButton` показывается на экранах привязки/выбора компании и внутри `<dialog>` (закрывает диалог), в корневом экране скрыт. Desktop-клиент: ширина ограничена, проверяются `viewportChanged` и `platform`.
- Вне Telegram (`Telegram.WebApp.initData` пуст) страница честно показывает «Откройте чат из Telegram» и ничего не запрашивает.
- `Cache-Control: no-cache` как у `@cabinet`: добавить `/miniapp.html /cabinet/miniapp-host.js` в матчер Caddyfile.

### 3.2. Правки `sites/synapse/cabinet/project-chat.js` — два узких hook'а
1. `request()`: заголовки хоста `...(state.ctx.authHeaders?.() || {})`. В ЛК `authHeaders` нет — прежнее поведение (cookie + `X-CSRF-Token`).
2. Вложения: `img.src` и `href` не несут bearer, поэтому `attachmentHTML` при наличии `state.ctx.fetchAsset` рендерит заглушку с `data-pc-asset="<url>"`, а после вставки в DOM хост забирает файл через `fetchAsset` → `URL.createObjectURL(blob)` (`img.src` и `href` получают blob-адрес). `fetchAsset` хоста отправляет заголовок только на `/content/project-chat/<открытый проект>/attachments/<id>` того же origin и с `redirect: 'error'`; иной адрес — «Не удалось загрузить файл» без запроса. Object URL хранятся в `state.assets` и освобождаются в `revoke()`, при `onProjectChange`/`mount`, при переходе на личную вкладку и при явном `views.hugh.unmount()` (хост вызывает его при «Назад» и отзыве). Токен не попадает ни в URL, ни в cookie, ни в HTML. Фото/PDF проходят через тот же `readAttachment` и тот же ACL, что и в ЛК.

### 3.3. Модуль `ops/content/project-chat-miniapp.js` и подключение в `server.js`
Маршруты Mini App (без сессии кабинета):
- `POST /content/project-chat-miniapp/session` — тело `{initData}` (лимит 20 КБ; незаверенные подсказки проекта в теле не читаются — проект берётся только из подписанного `start_param` внутри `initData`). Проверяет подпись/TTL/replay (§4), ищет привязку TG id → аккаунт (§6). Ответы: `200 {token, expiresAt, companies:[{code,title}], startParam, identity:{userId, displayName, role:'member'}}` (`startParam` — подписанный проект, если участник состоит в нём, иначе `null`); `403 {state:'unlinked', linkCode, expiresAt, project}`; `403 {state:'no_project'}` — открыто без ссылки проекта или с неизвестным проектом, код не выдаётся; `403 {state:'no_rooms'}`; `401` — невалидная подпись, просроченный/будущий `auth_date`, некорректный `user.id`, дубли параметров; `409 {state:'replayed'}` — те же подписанные данные уже использованы (nonce считается по каноническому data-check-string, а не по сырой строке); `429` — превышен суточный предел новых кодов.
- Ничего для владельческих операций.

Маршруты владельца (только cookie кабинета, `role==='owner'`, CSRF; room-токен не принимается):
- `GET /content/project-chat/{code}/telegram-links` — привязки участников этой комнаты и ожидающие коды **ровно этого проекта** (`company_code` кода = проект из подписанной ссылки, по которой открыт Mini App). Коды других проектов не показываются; один Telegram ID может иметь действующие коды в нескольких проектах, и открытие ссылки другого проекта не возвращает и не меняет чужой код.
- `POST /content/project-chat/{code}/telegram-links` — `{linkCode, userId}`: код должен принадлежать этому проекту (иначе 404), `userId` обязан быть действующим участником этой комнаты (`assigned && isMember`), иначе 400; создаёт привязку, код помечается использованным.
- `DELETE /content/project-chat/{code}/telegram-links/{telegramUserId}` — отвязка; одновременно `link_version` аккаунта увеличивается (§5), и все выданные этому пользователю room-токены становятся недействительными на следующем же запросе.
Эти три суффикса добавляются в список `ownerOnly` в `handle()` рядом с `/members`, `/candidates`, `/settings`, `/retry-ai`.

Таблицы (создаются модулем, как остальные):
```
project_chat_telegram_links(telegram_user_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES auth_users(id),
  linked_by INTEGER NOT NULL, linked_at TEXT NOT NULL)
project_chat_telegram_link_versions(user_id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1)
project_chat_miniapp_link_codes(code TEXT PRIMARY KEY, telegram_user_id TEXT NOT NULL, first_name TEXT NOT NULL,
  company_code TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)
project_chat_miniapp_nonces(nonce TEXT PRIMARY KEY, seen_at TEXT NOT NULL)
```

## 4. Проверка `initData` на сервере: Ed25519, без секрета бота
- Секрет бота в `content` не передаётся ни в каком виде. Используется проверка поля `signature` открытым ключом Telegram.
- Настройки `content`: `TELEGRAM_BOT_ID` (несекретный числовой ID бота; фактическое значение берётся из текущего бота на этапе внедрения, не угадывается) и константа production-ключа `e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d` в коде модуля. Тестовый ключ Telegram и любой небезопасный fallback (пропуск проверки, HMAC по секрету) в production отсутствуют; в тестах ключ подменяется только через явный параметр фабрики, который `server.js` не пробрасывает.
- Алгоритм: разбор `initData` как query-string; отклонить, если какой-либо ключ встречается дважды, если нет `signature`, `auth_date`, `user`; data-check-string = `bot_id + ':WebAppData' + '\n' + все пары key=value, отсортированные по ключу, кроме `hash` и `signature`, разделитель `\n`; `signature` декодируется из base64url (64 байта); `crypto.verify(null, data, publicKey(ed25519), signature)`.
- TTL: `auth_date` не старше 5 минут и не более чем на 60 с в будущем → иначе 401. Replay: `nonce = sha256(initData)` пишется в `project_chat_miniapp_nonces` в той же транзакции, что выдача токена или кода; повтор → 409; записи старше 10 минут удаляются при каждом вызове.
- `user` — JSON: `id` обязан быть положительным безопасным целым, иначе 401; берутся только `id` и `first_name` (≤64 символа). `username`, `photo_url`, `language_code` не читаются и не хранятся.
- Лимит тела `/session` — 16 КБ; всё сверх — 413 до разбора.

## 5. Узкая room-сессия
- `POST /session` выдаёт bearer-токен: HMAC-SHA256 на `SESSION_SECRET` (та же `signature()` из `server.js`, но полезная нагрузка с префиксом и полями `{kind:'room', uid, sessionVersion, linkVersion, telegramUserId, exp, iat}`), `exp` ≤ 12 часов, продления нет.
- `access()` в `project-chat.js` получает второй способ аутентификации `roomSession(request)` по заголовку `Authorization: Bearer`. Cookie `synapse_session` при этом не читается. Проверяются на каждом запросе: подпись и `exp`; `authStore.getById(uid)` и `sessionVersion` (смена пароля обесценивает токен); наличие строки `project_chat_telegram_links` для `telegramUserId` → `uid` и равенство `linkVersion` (отвязка обесценивает токен немедленно); затем компания и членство, как сейчас.
- Роль в room-сессии всегда `member`, даже если `uid` — владелец: `ownerOnly`-маршруты (`/members`, `/candidates`, `/settings`, `/retry-ai`, `/telegram-links`) отвечают 403; снимок отдаёт `access.owner=false`; `runtimeError` в снимке пуст (ветка «только владельцу» смотрит на роль сессии, а не аккаунта).
- CSRF для bearer не нужен (заголовок не отправляется браузером сам); `requireCsrf` пропускается только для этого способа.
- Вне `/content/project-chat/*` room-токен нигде не принимается и не даёт fallback к owner-cookie: `/content/project-chat-runtime/*`, `/content/hugh/*`, `/content/admin/*`, `/content/whoami`, `/content/crm/*` используют `requireSession` (cookie) и не меняются. Обычный браузер владельца с cookie работает как прежде.
- Почему заголовок, а не cookie: в `web.telegram.org` Mini App открывается в iframe, где `SameSite=Lax` cookie не отправляются; токен в памяти страницы одинаково работает во всех клиентах и не создаёт CSRF-поверхности.

## 6. Сопоставление Telegram ID с участником
- Только числовой `user.id`; username и телефон не участвуют. Одна привязка на TG id; несколько TG id на один аккаунт допустимы.
- Неизвестный пользователь **не получает** ни аккаунта, ни членства автоматически. Если Mini App открыт по ссылке проекта (подписанный `start_param`), `/session` отвечает `403 unlinked` с одноразовым кодом этого проекта (6 символов из `[A-HJ-NP-Z2-9]`, TTL 15 минут, хранится с `first_name` и `company_code`). Экран: «Сообщите владельцу код XXXXXX. После привязки закройте и снова откройте чат». Без ссылки проекта — `403 no_project` и экран «Откройте чат по ссылке своего проекта», код не выдаётся.
- Владелец в ЛК, диалог «Участники» комнаты (`membersDialog`): блок «Ожидают привязки Telegram» — `first_name · код`, рядом выбор из **действующих участников этой комнаты**; привязка создаётся только после явного выбора владельцем (`POST …/telegram-links`). Если аккаунта у человека ещё нет, владелец сначала создаёт его обычным путём (`/content/admin/accounts`) и добавляет в участники — Mini App этим не занимается.
- Там же список привязок участников комнаты с кнопкой «Отвязать Telegram» (`DELETE`). Удаление из участников или компании уже закрывает доступ через `access()`.

## 7. Жизненный цикл `initData` и честные экраны
- `initData` статичен на время открытия Mini App и после первого `/session` считается использованным. Повторно отправлять его нельзя ни при 401, ни после привязки.
- Flow: при открытии один запрос `/session`. `200` — комната монтируется на срок токена. `403 unlinked` — экран с кодом; после того как владелец привязал, пользователь **закрывает и заново открывает** Mini App (свежий `initData`). `401`/`409` (просрочено, повтор) и истечение токена в работе — экран «Сессия чата истекла. Закройте и снова откройте чат из Telegram» с кнопкой `Telegram.WebApp.close()`. Автообновления, polling `/session` и повторов нет; опрос снимка комнаты (`schedule`, 5 с) идёт только при действующем токене и останавливается на первом 401.
- Потерянный ответ `/session` (сеть оборвалась после того, как сервер уже записал nonce) требует переоткрытия; доступ никогда не создаётся повтором чужого или своего использованного `initData`.

## 8. Изменения рядом с существующим кодом (сводка)
- `ops/content/project-chat.js`: `roomSession` внутри `access()`; три суффикса `telegram-links` в `handle()` и в `ownerOnly`; `access.owner` и `runtimeError` по роли сессии.
- `ops/content/server.js`: подключение модуля Mini App, маршрут `/content/project-chat-miniapp/session`, `TELEGRAM_BOT_ID` из env.
- `sites/synapse/cabinet/project-chat.js`: `authHeaders` в `request()`, hook `fetchAsset` в `attachmentHTML` + освобождение object URL в `revoke`/`mount`; блок привязок в `membersDialog`.
- `docker-compose.yml`, `.env.example`: `TELEGRAM_BOT_ID` для `content` (несекретный).
- `caddy/Caddyfile`: `no-cache` для страницы Mini App.
- `docs/project-chat.md`: раздел про Mini App.

## 9. Тесты (по существующим файлам)
- `ops/content/project-chat-miniapp.test.js` (новый): фикстура `initData`, подписанная тестовой Ed25519-парой через параметр фабрики; валидный вход; неверная подпись; `auth_date` старше 5 минут и из будущего; дубль параметра; `user.id` не число/отрицательный; тело > 16 КБ; повтор `initData` → 409; непривязанный → 403 с кодом; привязка кодом владельцем к участнику комнаты, попытка привязать не-участника → 400; после привязки старый `initData` → 409; room-токен: `access.owner=false` и `runtimeError=''` для аккаунта владельца, все `ownerOnly` → 403, чужая компания → 403, `GET …/attachments/{id}` по bearer отдаёт файл; `/content/project-chat-runtime/status` и `/content/whoami` по bearer → 401; отвязка → следующий запрос 401; смена пароля → 401; истёкший токен → 401; `startParam` чужой компании не даёт доступа; список pending-кодов одной комнаты не содержит кодов другой компании.
- `ops/content/project-chat-integration.test.js`: один блок на живом `server.js`: `/session` → bearer → снимок комнаты; cookie-маршруты bearer не принимают.
- `sites/synapse/cabinet/project-chat.test.cjs`: монтирование через шим с `authHeaders`/`fetchAsset`: запросы уходят с `Authorization` и без `X-CSRF-Token`; вкладки «Личный Хью» и кнопок владельца нет; пометка ИИ есть; вложение запрашивается `fetch` с заголовком, `img.src` — blob-URL, после `onProjectChange` object URL освобождён.
- `ops/chat/project-chat-bridge.test.js`: без изменений.

## 10. Что делает владелец на этапе внедрения (не сейчас)
1. В `.env` сервера: `TELEGRAM_BOT_ID=8707527108` (публичный ID `@synapse_sb_bot`, подтверждён `getMe`; токен не нужен).
2. В BotFather настраивает Main Mini App (URL `https://synapse.synapsebusiness.ru/miniapp.html`) — тогда работает `https://t.me/synapse_sb_bot?startapp=palitra-love`; при желании Menu Button для личного чата с ботом.
3. Публикует ссылку в группе Palitra/Маркетинг и привязывает Влада, Дарью и Анну по их кодам в диалоге «Участники».
4. Живая проверка на реальных клиентах (Android, iOS, Telegram Desktop, Telegram Web): вход, код привязки, фото и PDF, клавиатура и safe areas, кнопка «Назад», отзыв привязки. Автотесты этого не заменяют.

## 11. Открытые вопросы и риски
1. Старт только после приёмки локального обработчика Хью: Mini App показывает те же состояния (`offline`, `login_pending`), менять их параллельно нельзя.
2. Именованное приложение (`t.me/<bot>/<short_name>`) — только если такая настройка у бота реально существует; иначе Main Mini App.
3. Внешний скрипт `telegram-web-app.js` — единственная внешняя зависимость страницы; версии `Telegram.WebApp` без `safeAreaInset`/`BackButton` должны деградировать без ошибок.
4. Мобильный `input[type=file]` и загрузка 8 МБ по тому же `POST …/attachments` проверяются вручную на реальных клиентах.
5. Выбор компании при нескольких комнатах у одного участника — простой список; `startapp` только подсказка.
