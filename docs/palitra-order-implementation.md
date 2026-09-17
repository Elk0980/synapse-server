# Palitra Love: контракт патча 2 — корзина → сохранённая заявка → уведомление Дарье в Telegram

Дата: 17.09.2026. Автор: Claude (по поручению Хью). Решение Влада: заявки с сайта приходят
**Дарье (Трафик) в Telegram**, почта не нужна; получатель настраивается после ответа Влада с
точным Telegram ID — здесь не угадывается. Онлайн-оплаты нет; оплату и доставку согласует
менеджер (утверждено Владом). Статус: **backend реализован локально** (ветка
`codex/palitra-site-align`: `ops/content/site-orders.js`, стыки в `server.js`/`project-chat.js`,
Caddy `/api/orders`) и проверен автотестами (§9); ни одно сообщение в Telegram не отправлялось,
получатель не настроен. Фронтенд (§7) — отдельная работа по контракту §4 и §11. CRM-зеркало (§8)
в объём не входит.

## 1. Выбор пути (альтернативы проверены по коду)

| Вариант | Что есть | Почему нет / да |
| --- | --- | --- |
| A. CRM `POST /leads` как хранилище (`ops/crm/server.js:2889-2949`) | публичный маршрут, `companyCode`, email-уведомления | **Нет**: дедуп по `companyCode+normalized_contact` без окна времени (`:591-592`) — повторный заказ с тем же телефоном не создаётся и его состав теряется; товаров как структуры нет; уведомление только почтой (`email-notifications.js`), получатель Palitra пуст |
| B. chat `client_notifications` / `client_chats` (`ops/chat/server.js:118-127, 620-642`) | очередь текстов в Telegram, привязка группы к компании | **Нет**: привязка `client_chats.palitra` — групповой чат, а не личный получатель; очередь не имеет «неизвестного результата» (при обрыве после отправки — повтор = дубль); публичного входа с сайта у chat нет, пришлось бы дублировать хранилище заказов |
| C. Общий проектный чат Palitra (`project_chat_rooms.telegram_chat_id`) | outbox уже доставляется | **Нет**: это общий рабочий чат — контакты клиентов туда не публикуем |
| **D. content хранит заказ + свой outbox; chat доставляет через уже существующий мост** | `ops/content/project-chat.js` `pendingTelegram/acknowledgeTelegram` (`:409-439`), `ops/chat/project-chat-bridge.js` `delivery/queueAck/flushAck/drainOutbox` (`:162-307`) с идемпотентностью частей и состоянием `uncertain` | **Да**: токен бота остаётся только в chat; content уже компания-скоуп для Palitra (`SITES`, `CONTENT_COMPANIES.palitra='palitra-love'`, live-прайс `palitra/price`, owner-маршруты ЛК); мост уже опрашивает `/content/internal/project-chat/outbox` по `CHAT_API_KEY` и умеет «не повторять вслепую» |

Итог: **D**. CRM не трогается (опционально — зеркальная заявка позже, см. §8). Отдельной платформы нет.

## 2. Компоненты и точные точки переиспользования

- **Caddy** (`caddy/Caddyfile:449-481`, блок `palitra-love.synapsebusiness.ru`, позже тот же блок для
  `palitra-love.ru`): добавить перед SPA-fallback
  `@orders { path /api/orders  method POST }  handle @orders { rewrite * /public-orders/palitra  reverse_proxy content:8080 }`
  — по образцу `@palitra_price` (`:459-466`). Сайт = Caddy определяет `site`, клиент не выбирает компанию.
- **content** (`ops/content/server.js`): новый публичный обработчик `parts[0]==='public-orders'`
  рядом с `public-content` (`:937-944`, до `/content/*`-авторизации), только `POST`, `SITES.has(parts[1])`;
  компания — `CONTENT_COMPANIES[site]`. Хранилище — новый модуль `ops/content/site-orders.js`
  (таблицы §3), подключённый в `createProjectChat`/сервер так же, как `project-chat-local-worker.js`.
  Live-прайс для сверки — `latestStmt.get('palitra/price')` (`:171`). Лимит тела — отдельный 32 KiB
  (общий `MAX_BODY` 1 МиБ — `:33`), паттерн лимита попыток — как `LOGIN_LIMIT` (`:733`).
- **content ⇄ chat**: `pendingTelegram()` дополняется заданиями из `site_order_outbox` (id вида
  `order:<n>`, строка); `acknowledgeTelegram(jobId, result)` ветвится по префиксу. Мост уже передаёт
  строковые id (`project-chat-bridge.js:260-268`: `Number.isSafeInteger` → иначе строка) и использует
  только `job.chatId, text, authorName, authorType, attachments` (`:162-203`) — **правок в chat нет**,
  кроме теста на строковый id.
- **chat**: `handlePrivateTelegram` (`ops/chat/server.js:710-766`) уже отвечает на `/start` в личке —
  это и есть «Дарья начала диалог с ботом». Ничего нового в chat не добавляется.
- **CRM**: не участвует в патче.

## 3. Данные (content, SQLite)

```
site_order_recipients(site TEXT PRIMARY KEY, company_code TEXT NOT NULL, telegram_chat_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '', verified_at TEXT, last_test_error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)
site_orders(id INTEGER PK, site TEXT NOT NULL, company_code TEXT NOT NULL, request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('cart','request')), status TEXT NOT NULL DEFAULT 'accepted'
    CHECK(status IN ('accepted','notified','notify_uncertain','notify_failed')),
  name TEXT NOT NULL, phone TEXT NOT NULL, phone_normalized TEXT NOT NULL, comment TEXT NOT NULL DEFAULT '',
  items_json TEXT NOT NULL, known_total INTEGER NOT NULL DEFAULT 0, unknown_count INTEGER NOT NULL DEFAULT 0,
  page TEXT NOT NULL DEFAULT '', utm_json TEXT NOT NULL DEFAULT '{}', ip_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(site, request_id))
site_order_outbox(id INTEGER PK, order_id INTEGER REFERENCES site_orders(id), kind TEXT NOT NULL CHECK(kind IN ('order','test')),
  chat_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','sending','sent','uncertain','error')), attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT, next_attempt_at TEXT NOT NULL, external_ids TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL)
site_order_rate(ip_hash TEXT, created_at TEXT)   -- окно попыток; чистится старше суток
```

`ip_hash` = sha256(ip + серверная соль), как в CRM `requestIpHash`. Телефон хранится как введён и
нормализованный (только цифры, `8`→`7`). Заказ и его outbox-задание — **одна транзакция** (`tx`).

## 4. Публичный маршрут `POST /api/orders` → `/public-orders/palitra`

Запрос (JSON, ≤ 32 KiB, `Content-Type: application/json`, `credentials: 'omit'`):

```
{ requestId: uuid, kind: 'cart'|'request', name, phone, comment?, consent: true,
  items: [{ id, qty }],                // cart: 1..30 строк; request: []
  occasion?, date?,                    // только для kind:'request' (форма главной) → в comment
  page, utm: {utm_source..utm_term}?, website: '' }   // website — honeypot, должно быть пусто
```

Серверные правила:

1. `Origin`/`Referer` обязаны быть хостом сайта (список: текущий `palitra-love.synapsebusiness.ru`,
   после подключения — `palitra-love.ru`); иначе 403. Honeypot непустой → 200 «принято» без записи.
2. `requestId` — UUID v4; `UNIQUE(site, request_id)`: повтор того же `requestId` → **200**
   `{ok:true, orderId, duplicate:true}` без новой записи и без нового уведомления. Другой
   `requestId` с тем же телефоном → **новый заказ** (повторные заказы не теряются).
3. `items`: каждый `id` обязан быть в live-документе `palitra/price` (`categories[].items[].id`);
   название и цена берутся **с сервера**, клиентские значения игнорируются; `price` пустая →
   `priceKnown:false`. `qty` — целое 1..20. Неизвестный `id` → 400 `ITEM_UNKNOWN` (клиент обновляет
   корзину по live-прайсу). Документа прайса нет → 503 `ORDERS_UNAVAILABLE` (корзина сохраняется).
4. `name` 1..80, `phone` 10..15 цифр, `comment` ≤ 1000, `consent === true`, `page` ≤ 300, utm ≤ 200 каждое.
5. Анти-злоупотребление: по `ip_hash` не больше 5 заказов за 10 минут и 20 за сутки → 429 с
   `Retry-After`; на страницу не более 1 запроса в 3 секунды с тем же `requestId` (идемпотентность и
   так закрывает двойной клик).
6. Успех **только после commit** заказа и outbox-задания: **201**
   `{ok:true, orderId, requestId, status:'accepted'}`. Текст клиенту: «Заявка №N принята. Менеджер
   свяжется с вами, подтвердит состав и стоимость, согласует оплату и доставку». Никаких «менеджер
   прочитал/подтвердил». Состояние доставки в Telegram клиенту не раскрывается.
7. Получатель не настроен (`site_order_recipients` пуст) → заказ **всё равно сохраняется**
   (`status='accepted'`, outbox не создаётся), ответ 201; ЛК показывает «заявки копятся без
   уведомления». Заявка не теряется из-за конфигурации.

Коды: 400 `VALIDATION`/`ITEM_UNKNOWN`, 403 `ORIGIN`, 413, 415, 429 `RATE_LIMITED`, 503
`ORDERS_UNAVAILABLE`. Тексты ошибок — короткие, без эха тела.

## 5. Уведомление Дарье: outbox и доставка

- Текст задания (`kind='order'`): `Заявка №N · Palitra · <дата, Europe/Moscow>` → имя, телефон,
  строки `«Название» × qty — цена | цена уточняется`, «Итого по известным ценам: … (ещё K позиций
  уточняются)», комментарий, страница/источник. Только личный чат Дарьи; в общий проектный чат не идёт.
- `pendingTelegram()` отдаёт `{ id:'order:<n>', companyCode, chatId, text, authorName:'Заявка с сайта',
  authorType:'system', attachments:[] }` тем же lease-механизмом (`sending`/`claimed_at`/`TELEGRAM_LEASE`).
  Мост: части дедуплицируются по `job_id+part` (`project_telegram_delivery`), обрыв после отправки →
  `uncertain` и **никакого автоматического повтора** (`:175-177, 192-197`); подтверждение сохраняется
  до ответа content (`queueAck`) — это готовое поведение.
- `acknowledgeTelegram('order:<n>', result)`: `ok` → outbox `sent`, заказ `notified`; `uncertain` →
  `notify_uncertain`; `retryable` (429 Bot API) → `pending` с паузой, до `TELEGRAM_ATTEMPTS`; иначе
  `error` → `notify_failed` с коротким кодом причины (например `403 bot can't initiate conversation`).
- Повтор — только явным действием владельца в ЛК: `POST /content/palitra/orders/:id/renotify`
  создаёт **новое** outbox-задание (человек видит, что первое `uncertain`/`error`); слепых
  авто-повторов после `uncertain` нет.

## 6. Получатель: настройка и проверка без обхода

- Хранится в `site_order_recipients` (компания-скоуп, `telegram_chat_id` — числовой id личного
  чата Дарьи; **не** `TELEGRAM_OWNER_ID`, **не** группа). Задаётся владельцем в ЛК:
  `PUT /content/palitra/order-recipient {telegramChatId, label}` (session + CSRF, право владельца
  как у `project-chat-runtime` owner-веток). Значение — только после ответа Влада; формат: `^\d{5,20}$`.
- Обязательное начало диалога: Telegram не даёт боту писать первым. Дарья отправляет `/start`
  боту `@synapse_sb_bot` (обработчик `:731-738` ответит просьбой поделиться контактом — делиться
  контактом для уведомлений **не обязательно**, достаточно `/start`).
- Проверка: `POST /content/palitra/order-recipient/test` → outbox-задание `kind='test'` с текстом
  «Проверка получателя заявок Palitra. Ответ не требуется.» → доставка через мост → ack:
  `ok` → `verified_at` = сейчас; `403 … can't initiate conversation` → `last_test_error`
  «получатель не начал диалог с ботом», `verified_at` пуст. Это реальная доставка, не эмуляция;
  выполняется Хью/Владом после настройки, не автоматически из кода.
- Пока `verified_at` пуст, ЛК показывает предупреждение, но заказы принимаются и сохраняются (§4.7).

## 7. Фронтенд (`sites/palitra-love`, без онлайн-оплаты)

- Новый `assets/order.js` (UMD как `catalog-live.js`): корзина в `localStorage['palitra-cart-v1']`
  `{items:[{id,qty}], requestId}` — **только id и qty**, названия/цены при показе берутся из
  live-прайса через `PalitraPrice.load` (клиент не источник цен); `[data-add]` в карточках
  (`price-render.js` `productCard`: кнопка «В корзину» добавляется **в этом патче**, когда endpoint
  есть), `[data-qty-inc/dec/remove]`, панель `aside.cart` (`[data-cart-open/close/count/items/total]`),
  итог «по известным ценам» + «K позиций — цена уточняется», форма имя/телефон/комментарий/согласие.
- Отправка: `POST /api/orders`; `pending` (кнопка и `fieldset` disabled, `aria-busy`); успех только
  при 201 с `orderId` → корзина и `requestId` очищаются, показывается номер и текст §4.6;
  200 `duplicate` после ранее неудачной попытки того же `requestId` → успех; 4xx/5xx/сеть/таймаут →
  `error`, корзина и поля сохранены, кнопка активна, повтор с тем же `requestId`; 400 `ITEM_UNKNOWN`
  → предложение обновить корзину по прайсу; 429 → текст с ожиданием.
- Форма `#zayavka` на главной → тот же endpoint, `kind:'request'`, повод/дата в comment.
  Общий обработчик всех форм в `app.js:19` (fake-success, `ORDER_ENDPOINT/TELEGRAM_ENDPOINT`) удаляется;
  `config.js` — только `SITE_URL`.
- Тексты, которые вводят в заблуждение (править в этом патче, это не юридические условия):
  `catalog/*` «Оставьте данные — подтвердим наличие, итоговую цену и пришлём ссылку на оплату» и
  примечание корзины «Оплата на сайте выключена. Подтвердим заказ и пришлём ссылку на оплату» →
  «Менеджер подтвердит состав и стоимость, согласует оплату и доставку»; `dostavka-i-oplata`
  «После подтверждения заказа пришлём ссылку на оплату» → «Оплату и доставку согласует менеджер после
  подтверждения заказа». Строку оферты «Ссылка на оплату направляется после подтверждения заказа»
  и FAQ «Предоплата составляет 100%» **не менять без Влада** (юридический текст).
- Статический JSON-LD `Product/Offer` с ценами и `InStock` — убрать из всех 24 страниц (цены только из
  прайса ЛК; `catalog-live.js` продолжает выдавать `ItemList` без `offers`).
- Кнопка «Корзина · N» в шапке становится рабочей на всех страницах (на главной добавить).

## 8. Вне патча / опционально

- Зеркало в CRM (`POST /leads`, `companyCode:'palitra-love'`, `channel:'Заказ с сайта'`, состав в
  `comment`) — только как best-effort после commit, флаг `ORDERS_MIRROR_CRM` (по умолчанию выкл.),
  результат не влияет на успех; включать после решения Влада.
- Домен/DNS/canonical — отдельный этап (см. `palitra-site-implementation.md` §5.3).
- Просмотр заказов в ЛК: минимум `GET /content/palitra/orders` (JSON: id, дата, имя, телефон,
  состав, статус уведомления) и `renotify`; интерфейс — по мере надобности.

## 9. Минимальный набор тестов контракта (описание, не код)

- `ops/content/site-orders.test.js`: валидация полей и лимитов; сверка `items` с live-прайсом (чужой
  id → 400, пустая цена → `priceKnown:false`, клиентская цена игнорируется); идемпотентность по
  `requestId` (второй POST → 200 duplicate, одна запись, один outbox); повтор с тем же телефоном и
  новым `requestId` → две записи; заказ + outbox в одной транзакции (ошибка outbox откатывает заказ);
  без получателя — заказ сохраняется, outbox нет; лимит 5/10 мин и 20/сутки → 429; honeypot; Origin.
- `ops/content/project-chat.test.js` (дополнить): `pendingTelegram` выдаёт `order:*` задания с
  `chatId` получателя и не смешивает их с комнатой; `acknowledgeTelegram('order:n', …)` переводит
  статусы `notified/notify_uncertain/notify_failed`; `renotify` создаёт новое задание; `test`-задание
  ставит `verified_at` только при `ok`.
- `ops/chat/project-chat-bridge.test.js` (дополнить): строковый `job.id='order:7'` доставляется,
  подтверждается и не повторяется после `uncertain`.
- `sites/palitra-love/assets/order.test.cjs`: корзина только id/qty, показ по live-прайсу, payload,
  `send` (201 → успех/очистка; 200 duplicate после сетевой ошибки → успех; 400/429/5xx/сеть → корзина
  цела, кнопка активна; двойной клик → один fetch; `requestId` сохраняется между попытками;
  `consent=false` → без fetch; `credentials:'omit'`).
- `sites/palitra-love/pages.test.cjs` (дополнить): нет `ORDER_ENDPOINT`, нет статических `Offer`,
  тексты про «ссылку на оплату» отсутствуют вне оферты, `order.js` подключён на всех 24 страницах.
- Интеграция `ops/content/site-orders-integration.test.js` по образцу
  `project-chat-integration.test.js`: живой content + мост с поддельным `fetch` Telegram — заказ →
  outbox → доставка → ack → `notified`; сценарий 403 «can't initiate» → `notify_failed` и
  `last_test_error`; обрыв после отправки → `uncertain` без второго `sendMessage`.

## 11. Фактический backend-контракт (как реализовано)

Отличия от плана выше выделены; где план и код совпадают, действует план.

**Публичный `POST /api/orders` → `/public-orders/palitra`** (`ops/content/server.js`, только сайт `palitra`; другие `SITES` — 404).
- Требования запроса: `Content-Type: application/json` (иначе 415), тело ≤ 32 КиБ читается потоком (иначе 413),
  `Origin` или `Referer` из точного списка `PALITRA_ORDER_ORIGINS` (по умолчанию `https://palitra-love.synapsebusiness.ru`; иначе 403 `ORIGIN`).
  Клиентский IP: `X-Forwarded-For` принимается только когда соединение пришло из частной сети (Caddy) и только его последнее
  значение; хранится лишь `sha256(ip|соль)`, соль выводится из `SESSION_SECRET`.
- Тело: `{requestId(uuid v4), kind:'cart'|'request', name(1..80), phone(10..15 цифр после нормализации, 8→7), comment?(≤1000),
  consent:true, items:[{id,qty 1..20}] (cart: 1..30, без повторов; request: []), occasion?(≤80), date?(≤40), page?(≤300),
  utm?{utm_source,utm_medium,utm_campaign,utm_content,utm_term ≤200}, website:''}`. Неизвестные поля → 400. Лишние поля внутри
  `items[]` (цена, название) игнорируются.
- Порядок проверок: Origin → валидация → honeypot (`website` непустой → `200 {ok:true,status:'accepted'}` без записи) →
  **повтор `requestId` до лимита частоты** → лимит (5 за 10 мин, 20 за сутки на IP-хеш → 429 `RATE_LIMITED`, `Retry-After: 600`) →
  live-прайс `palitra/price` (нет документа → 503 `ORDERS_UNAVAILABLE`; неизвестный `id` → 400 `ITEM_UNKNOWN` + `itemId`).
- Идемпотентность: отпечаток = `sha256({kind,name,phone_normalized,comment,items[id,qty] по id})`; `page`/`utm` в него не входят.
  Тот же `requestId` + тот же отпечаток → `200 {ok:true,duplicate:true,orderId,requestId,status:'accepted',message}` (без контактов);
  тот же `requestId` + другой отпечаток → 409 `REQUEST_MISMATCH`. Одновременный повтор ловится по `UNIQUE(site,request_id)`.
- Цены: строка прайса «9 270 руб.» → целые копейки; пустая, «от …», нечисловая или > 10¹¹ ₽ → цена неизвестна (`price:null`,
  входит в `unknownCount`); итог `knownTotal` — целые копейки с защитой от переполнения.
- Успех после commit заказа (и outbox-задания, если получатель настроен): `201 {ok:true,orderId,requestId,status:'accepted',
  message:'Заявка №N принята. Менеджер свяжется с вами, подтвердит состав и стоимость, согласует оплату и доставку.'}`.
  Ошибки: `{ok:false,code,error}` с кодами `VALIDATION|ITEM_UNKNOWN|ORIGIN|REQUEST_MISMATCH|RATE_LIMITED|ORDERS_UNAVAILABLE`.
- Без получателя заказ сохраняется со статусом `accepted`, outbox не создаётся, клиенту тот же 201.

**Хранение** (`site_orders`, `site_order_outbox`, `site_order_recipients`, `site_order_rate`): как §3, плюс `site_orders.fingerprint`,
`notified_at`; `site_order_recipients.version` (растёт при смене `telegram_chat_id`, сбрасывает `verified_at` и `last_test_error`);
`site_order_outbox.site, company_code, recipient_version, finished_at`.

**Очередь моста**: `pendingTelegram()` общего чата отдаёт задания комнаты первыми, затем одно `order`-задание
`{id:'order:<n>', companyCode, chatId, messageId:null, attempt, text, authorName:'Заявка с сайта', authorType:'system', attachments:[]}`
той же арендой (10 мин → `uncertain`). Текст задания не обрезается (его размер ограничен валидатором); на части по 3500 символов
его делит мост, уже отправленные части при повторе не досылаются повторно.
`acknowledgeTelegram('order:<n>', …)`: для незавершённого задания — `ok`→`sent`/заявка `notified`; `uncertain`→`notify_uncertain`;
`retryable`→`pending` до 3 попыток, затем `error`/`notify_failed` с короткой причиной. Для уже завершённого (`uncertain`/`error`)
поздний `retryable`/отказ ничего не меняет (задание не оживает), поздний `ok` уточняет исход до `sent`. Статус заявки отражает только
текущую (последнюю) попытку: поздний ответ по прежней попытке после `renotify` его не перезаписывает.
Тестовое задание засчитывается получателю только при совпадении `recipient_version` и `chat_id` с текущими. Смена `telegramChatId`
останавливает ещё не начатые (`pending`) задания прежнему получателю: они получают `error` «Получатель изменён до отправки», заявка —
`notify_failed`, и попадают в `unnotifiedOrders`; `sending`/`uncertain` не перенаправляются. Новому получателю их отправляет только
явный `renotify`. В `chat` ничего не менялось; текст в личный чат уходит с префиксом `Заявка с сайта`.

**Маршруты владельца** (`/content/palitra/...`; действующая сессия владельца, `role==='owner'`, CSRF для не-GET; участники и
Mini App-сессии — 403; сайт вне `palitra` — 404):
- `GET /content/palitra/orders?limit=1..100&beforeId=<id>` → `{orders:[{id,requestId,kind,status,createdAt,notifiedAt,name,phone,comment,
  items:[{id,title,qty,price|null}],knownTotal,unknownCount,page,utm,notify:{jobId,kind,status,attempts,error,createdAt,finishedAt,
  recipientVersion}|null}], nextCursor, recipient}`. Порядок — по `id` убыванию (новые первыми), `limit` по умолчанию 50, нецелый или
  вне 1..100 → 400; `beforeId` — курсор: `id` последней показанной заявки (страница содержит только `id < beforeId`);
  `nextCursor` — значение для следующей страницы или `null`, когда всё показано.
- `GET /content/palitra/order-recipient` → `{configured,telegramChatId,label,version,verifiedAt,lastTestError,lastTest,unnotifiedOrders,updatedAt}`
  (`unnotifiedOrders` — заявки `accepted` или `notify_failed` без уведомления, которое ушло или идёт; `notify_uncertain` не входят;
  `lastTest` — только текущей версии).
- `PUT /content/palitra/order-recipient {telegramChatId:^\d{5,20}$, label≤80}` → статус; смена чата → `version+1`, `verified_at=null`.
  Сама по себе ничего не отправляет.
- `POST /content/palitra/order-recipient/test` → `202 {ok,jobId:'order:<n>',recipient}` (409, если получатель не настроен).
- `POST /content/palitra/orders/:id/renotify` → `202 {ok,jobId,previous,order}`: новое задание текущему получателю; 409, если
  получатель не настроен или по заявке уже есть задание `pending/sending`. Работает и для старых `accepted` без уведомления.
- Ни один маршрут не пишет контакты/токены в журнал.

**Caddy**: в блоке `palitra-love.synapsebusiness.ru` добавлен `@orders {path /api/orders; method POST}` → `rewrite /public-orders/palitra`.
Для будущего `palitra-love.ru` нужен тот же блок и добавление origin в `PALITRA_ORDER_ORIGINS`.

**Тесты**: `ops/content/site-orders.test.js` (10, в т.ч. длинный заказ через настоящий мост с поддельным Telegram, поздние
подтверждения, смена получателя, страницы >100 заявок), `ops/content/site-orders-integration.test.js` (1, живой content +
внутренние маршруты моста), `ops/chat/project-chat-bridge.test.js` (+1: строковый `order:<n>`, uncertain без повтора).

## 10. Реальные блокеры

1. **Telegram ID Дарьи (Трафик)** — точный числовой id личного чата от Влада; до него получатель пуст,
   заказы сохраняются без уведомления (§4.7). Дарья должна один раз отправить `/start` боту
   `@synapse_sb_bot`, после чего владелец запускает проверку получателя (§6).

Оплата и доставка согласуются менеджером — утверждено Владом, отдельного решения не требуется.
CRM-зеркало (§8) в задачу не входит. Сайт и интерфейс владельца — в работе параллельно.
