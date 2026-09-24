# Palitra Love: handoff на выравнивание сайта и заявку менеджеру

## Статус 17.09.2026 — патч 1 «внешний вид» (ветка `codex/palitra-site-align`, не опубликован)

Сделано (только `sites/palitra-love`, ЛК-редактор и его копия рендера не тронуты):

- `price-render.js`: одна структура карточки для прайса и каталога — медиа-блок 4:5 (фото или
  заглушка с логотипом), название, описание целиком, прижатый к низу `product-footer`
  (цена + «Написать в Telegram», примечание, «Заказать под Ваш повод»). Пустая/пробельная
  цена → «Цена уточняется» с `data-price-known="false"`, не 0. Экспортирован
  `PalitraPrice.productCard`; API `renderSections/renderNav/load` и опции редактора сохранены.
- `assets/catalog-live.js`: карточки каталога строятся тем же `productCard` (запасная разметка
  идентична и покрыта тестом); фильтры/схема без изменений.
- `assets/app.js`: 4 карточки главной переведены на ту же структуру, тексты и цены прежние,
  `data-occasion` работает как раньше.
- `assets/styles.css`: новый завершающий блок «Выравнивание 17.09.2026» — карточка-колонка с
  `margin-top:auto` у нижнего блока, заголовки `clamp(20px,1.7vw,26px)` с переносами без
  обрезки, цена `clamp(22px,1.9vw,28px)`, сетки телефон 1 / планшет 481–800 → 2 / десктоп 3
  (каталог) и 2 (прайс, главная), компактная `.cart-button`, `.navlinks` без выдавливания, чипы
  фильтров ≥44px, формы/подвал/хлебные крошки с `overflow-wrap`. Убраны `min-height:270px` и
  `margin:auto` у цены как причины пустот.
- 24 HTML: только bump версий `?v=20260917align1` для `styles.css`, `app.js`, `price-render.js`,
  `catalog-live.js` (контент, тексты, JSON-LD не менялись).
- Тесты: новые `price-render.test.cjs`, `pages.test.cjs` (версии, общая шапка/подвал, внутренние
  ссылки существуют); обновлён `assets/catalog-live.test.cjs` (jsdom с настоящим рендером).
  Прогон: `node --test sites/palitra-love/price-render.test.cjs sites/palitra-love/pages.test.cjs
  sites/palitra-love/price-loading.test.cjs sites/palitra-love/assets/catalog-live.test.cjs` —
  19/19; `node --test sites/site-seo.test.cjs` — 10/10. jsdom не измеряет раскладку: визуальная
  приёмка 320/360/390/768/1024/1440/1920 — за Хью (CUA).

Не делалось в патче 1: домен/DNS/canonical, Telegram-handle (`quiz.js` → `palitra_love` vs
`palitralovee` — подтверждение по ЛК). Остальное закрыто патчем 2 ниже.

## Статус 17.09.2026 — патч 2 «корзина → заявка менеджеру» (frontend; backend — другая сессия, см. `palitra-order-implementation.md` §11)

Сделано в `sites/palitra-love` и `sites/synapse/cabinet` (не опубликовано, не коммичено):

- Дефекты после CUA-приёмки: примечание прайса перенесено в содержимое карточки перед низом
  (`price-render.js`, `catalog-live.js`, `app.js`), низ у всех карточек ряда одинаков: цена +
  «В корзину», затем ссылки «Написать в Telegram» и «Заказать под Ваш повод»; мобильное меню
  позиционируется от sticky `header` (`left:0;right:0`), а не от `nav` через `50vw` — на 320 при
  полосе прокрутки горизонтального скролла нет, закрытие/Escape прежние.
- `assets/order.js` (новый, UMD): корзина в `localStorage` только `{id, qty}`, названия и цены
  при показе — из live-прайса (`PalitraPrice.load`), недоступные позиции помечаются и требуют
  явного удаления; `POST /api/orders` по контракту (`requestId` UUID v4 в `sessionStorage`
  вместе с SHA-256-отпечатком смысла заявки, без контактов; тот же смысл → тот же id, изменение →
  новый, 409 `REQUEST_MISMATCH` → новый на следующей попытке); успех только 201/200 с `orderId`
  после ответа сервера, текст «Заявка №N принята. Менеджер свяжется…» без обещания прочтения;
  сеть/429/503/400 сохраняют корзину и поля, кнопка разблокируется; двойной клик — один запрос
  (флаг до первого await); `credentials:'omit'`; honeypot `website`; форма `#zayavka` главной —
  `kind:'request'` тем же путём. Общий обработчик форм с ложным успехом и `ORDER_ENDPOINT/
  TELEGRAM_ENDPOINT` удалены (`app.js`, `config.js`).
- 24 HTML (скриптом): единая панель `aside.cart[data-cart]` с формой «Отправить заявку
  менеджеру» и примечанием «Онлайн-оплаты на сайте нет…», кнопка «Корзина · N» и на главной;
  формы «Создать заказ» каталога заменены кнопкой «Открыть корзину»; тексты «пришлём ссылку на
  оплату» заменены на «оплату и доставку согласует менеджер» (каталог, доставка, оферта —
  по утверждённому решению Влада; «Предоплата — 100%» и остальные условия не тронуты);
  статический JSON-LD `Product/Offer/ItemList` с ценами удалён (FAQ/LocalBusiness/Breadcrumb
  остались, FAQ-разметка совпадает с видимым текстом — проверяется тестом); версии
  `?v=20260917order1`; `price-render.js` подключён на всех страницах перед `order.js`.
- ЛК: новый вид `site-orders` (`sites/synapse/cabinet/site-orders.js/.css`, пункт «Заявки с
  сайта» в меню «Управление», только владелец, ссылка из «Настроек компании» для Palitra):
  список заявок (номер, дата, состав, контакты, статус accepted/notified/uncertain/failed с
  пояснением, для `uncertain` — предупреждение о возможном дубле и `confirm` перед явным
  `renotify`), получатель Telegram (`PUT`, числовой ID, CSRF), проверка (`POST …/test` + опрос
  статуса до результата, подсказка про `/start`), предупреждение «N заявок сохранены без
  уведомления». Сайт в маршрутах фиксирован `/content/palitra/...` по компании `palitra-love`;
  смена компании отменяет запросы (`AbortController`) и отбрасывает старые ответы.
- Тесты (все прогнаны, 50/50): `sites/palitra-love/assets/order.test.cjs` (корзина, payload,
  requestId, 201/duplicate/сеть/429/503/409/ITEM_UNKNOWN, двойной клик, согласие, форма повода,
  Escape, honeypot), `price-render.test.cjs`, `pages.test.cjs` (версии, панель/кнопка корзины,
  нет «ссылки на оплату»/старых форм/статических цен, FAQ-синхронизация, ссылки),
  `assets/catalog-live.test.cjs`, `sites/synapse/cabinet/site-orders.test.cjs` (владелец/
  не-Palitra/смена компании/PUT/test-опрос/renotify), плюс `company-scope`, `sites`, `site-seo`.
  Команда: `node --test sites/palitra-love/*.test.cjs sites/palitra-love/assets/*.test.cjs
  sites/synapse/cabinet/site-orders.test.cjs sites/site-seo.test.cjs`.
- Не делалось: получатель не задан (ID Дарьи — от Влада), Telegram-handle квиза, домен.
  Визуальная приёмка (карточки 1440, меню 320, панель корзины 320–1920) — за Хью (CUA).

### Правки по приёмке Хью (17.09, версия ассетов `?v=20260917order2`)

1. Согласие: во всех 24 панелях корзины и форме главной — `<input type=checkbox>` отдельно, текст со
   ссылкой одним `<span>`; `.consent{display:flex;gap:10px}`, span `flex:1 1 auto;min-width:0`
   (размер шрифта прежний). Проверяется в `pages.test.cjs`.
2. `requestIdFor`: при `sessionStorage === null` или бросающих `getItem/setItem` — память страницы
   (`memoryRequests` по виду заявки): тот же смысл → тот же id, `forgetRequest` после успеха/409
   сбрасывает; контакты в хранилище не попадают (только UUID и SHA-256-хеш).
3. Отправка: `setBusy(true)` → один `try/finally` на ожидание прайса, `fingerprint`, `requestIdFor`,
   `send`; любая ошибка (в т.ч. `subtle.digest`) показывает сообщение и снимает блокировку.
4. `send`: единый таймаут (`AbortController` + гонка с `aborted`) покрывает и чтение тела;
   зависший `response.json()` → `NETWORK`, форма освобождается (тест «зависшее тело»).
5. Корзина во время отправки: изменения **не блокируются**; при успехе из корзины вычитается
   только отправленный снимок (`cart.consume(snapshot)`), добавленное за это время остаётся.
   Выбран этот вариант как более простой и без потери данных клиента; тест есть.
6. Прайс: состояния `idle/loading/ready/error`; до `ready` строки показывают «Загружаем прайс…»
   без пометки «больше нет», итог «—»; при `error` — сообщение и кнопка «Обновить прайс» (повторная
   загрузка); отправка корзины ждёт загрузку (форма занята), при неудаче не отправляет.
   Цена нулём не подменяется.
7. ЛК «Заявки с сайта»: первая страница `limit=50`, кнопка «Показать ещё» запрашивает
   `beforeId=<nextCursor>` (`limit=50`), список копится без дублей, одна догрузка за раз, при
   `nextCursor=null` кнопка скрыта и «Показаны все заявки»; после действий список перечитывается
   с `limit=max(50, показано)` (≤100); смена компании отменяет догрузку и отбрасывает ответ.

Прогон после правок: `node --test sites/palitra-love/*.test.cjs sites/palitra-love/assets/*.test.cjs
sites/synapse/cabinet/site-orders.test.cjs sites/synapse/cabinet/company-scope.test.cjs
sites/synapse/cabinet/sites.test.cjs sites/site-seo.test.cjs` — **55/55** (новые: requestId без
хранилища; зависшее тело + сбой digest; изменение корзины во время отправки; загрузка/ошибка
прайса с retry; «Показать ещё» с отменой при смене компании; согласие в разметке).

Дата: 17.09.2026. Автор: Claude (по поручению Хью). Read-only анализ исходников
`sites/palitra-love`, `caddy/Caddyfile`, `ops/content/server.js`, `ops/crm/server.js`,
`ops/crm/email-notifications.js`, `sites/avokado3/callback.js`. **UI в браузере, живые
endpoints, DNS и реальные данные ЛК/CRM не проверялись** — все наблюдения ниже сделаны по коду
и так и помечены. Реализация — следующим этапом, в отдельной ветке от актуального `main`.

## 1. Карта публичных страниц и общих файлов

| Страница | `data-page` | Скрипты | Карточки товаров | Форма |
| --- | --- | --- | --- | --- |
| `/` `index.html` | `home` | `config.js`, `hero.js`, `app.js` | 4 захардкоженных в `app.js:2-7` (`cards(list,true)`) | `#zayavka` (имя, телефон, повод, дата, комментарий) |
| `/price.html` | `price` | `config.js`, `app.js`, `price-render.js` + inline | `price-render.js` → `.pc.price-card` | корзина `aside.cart` |
| `/catalog/` + 10 разделов `catalog/*/index.html` | `catalog` | `config.js`, `app.js`, `price-render.js`, `catalog-live.js` | `catalog-live.js` → `.card` | «Оформить заказ» в `section.band` + корзина |
| `/vypiska`, `/den-rozhdeniya`, `/muzhchinam`, `/uchitelyu` | `vypiska`/`birthday`/`men`/`landing` | + `quiz.js` | квиз (`quiz-product`) | корзина |
| `/devichnik`, `/dofaminovye`, `/shary-giganty`, `/dostavka-i-oplata`, `/oferta`, `/privacy`, `/vozvrat` | `landing`/`dopamine`/`giants` | `config.js`, `app.js` | нет (кроме `[data-products]` там, где есть) | корзина |

Общие файлы: `assets/styles.css` (единственный CSS, ~190 строк, много перекрывающих слоёв),
`assets/app.js` (меню, фильтры, **единый обработчик всех форм**, cookie), `config.js`
(`SITE_URL`, `ORDER_ENDPOINT:""`, `TELEGRAM_ENDPOINT:""`), `price-render.js` (общий рендер
прайса; в ЛК используется **отдельная копия** `sites/synapse/price-render-palitra.js`,
`price-editor-palitra.html:387`), `data/price.json` (seed: 9 разделов, 11 позиций с ценой; **303
карточки живут в документе `palitra/price` сервиса content, не в Git — не импортировать**).

Источники цены на сайте сейчас три и они не согласованы: (1) live `/api/price` /
`/content/palitra/price` → content `public-content/palitra/price` (Caddy `caddy/Caddyfile:459-466`);
(2) seed `data/price.json`; (3) захардкоженные `products` в `app.js:2-7` (главная, `от N ₽`) и в
JSON квизов (`vypiska/index.html` и др.), плюс статический JSON-LD `Product/Offer` с ценами и
`InStock` в `<head>` каждой страницы. `catalog-live.js:66-68` вычищает Product/ItemList из JSON-LD
только после загрузки JS.

## 2. Точные корни несогласованных карточек

Наблюдение по коду (скриншот `/price.html` не источник цены):

1. **Два разных шаблона карточки.** `price-render.js:22-31` (`article.pc.price-card`: фото вне
   тела, `.price-card__body`, `h3`, описание, `.product-purchase{.pc__price + Telegram}`, `.note`,
   ссылка `/#zayavka`) и `catalog-live.js:30-39` (`article.card`: всё внутри `div`, `.price`,
   `Цена уточняется`, `.note`, ссылка `/#zayavka`). Третий — `app.js:9` (`.card`, `от N ₽`,
   `<button data-occasion>`). CSS для них разный: `.price-card__body{min-height:270px}`
   (`styles.css:106`) против `.card>div{display:flex;flex:1}` (`styles.css:143`).
2. **Пустая цена.** `price-render.js:29` выводит `esc(item.price)` без запасного текста: у
   позиции с `price:""` получается пустой `<p class="pc__price"></p>`; `catalog-live.js:35`
   подставляет «Цена уточняется». Валидатор content (`ops/content/server.js:317-324`) не
   требует `price`, `photo`, `desc`, `note` — пустые значения легальны.
3. **Пустоты.** `.pc__price{margin:auto 0 4px}` (`styles.css:106`) + `min-height:270px` +
   растяжение строки grid по самой высокой карточке: карточка с коротким описанием получает
   пустой блок над ценой. Фото необязательно и без placeholder — карточка без фото на одной
   строке с карточкой с фото 4:5 даёт «дыру» (`price-render.js:24`).
4. **Кнопки на разной высоте.** `.product-purchase{flex-wrap:wrap;justify-content:space-between}`
   (`styles.css:159`): цена `clamp(28px,2.5vw,34px)` + кнопка 14px переносятся на две строки в
   одной карточке и не переносятся в соседней; ниже ещё `.note` и вторая CTA — итоговая
   высота и позиция кнопок зависят от длины текста.
5. **Заголовки.** `.card h3,.price-card h3{font-size:clamp(26px,2.3vw,34px)}` (`styles.css:142`)
   без `overflow-wrap`/`hyphens` и без ограничения строк: длинное название в 2-колоночном
   `price-grid` на 320–390 даёт 4–5 строк, короткое — 1; пустое `title` валидатором запрещено.
6. **Сетки по ширинам.** `.grid{repeat(3,1fr)}` и `.price-grid{repeat(2)}` до 800px, далее
   `1fr` (`styles.css:15,105,108`): на 768 одна колонка с фото 4:5 шириной ~736px (карточка
   ~1.3 м высотой) — «огромные пустоты» на планшете; промежуточной 2-колоночной ступени
   481–800 нет. Главная `.home-products .grid{repeat(2)}` (`styles.css:137`).
7. **Навигация.** `.navlinks` — 7 ссылок на главной/прайсе, 6 на остальных; `.cart-button` **без
   единого CSS-правила** (стили `button` по умолчанию: зелёный фон, `padding:12px 18px`); на
   801–1100 `nav{gap:16px}.navlinks{font-size:14px}` — с брендом 200px и кнопкой корзины
   вероятно переполнение (по коду, не измерено). На ≤480 `nav{gap:8px}`: логотип 34px +
   «Меню» + «Корзина · 0» ≈ ширина экрана 320 — риск переноса/обрезки.
8. **Корзина.** `aside.cart` (`price.html:20`, все catalog/occasion/legal страницы) — ни одного
   CSS-правила для `.cart`, `[data-cart-items]`, `[data-total]`; ни одной строки JS, которая
   добавляет товар, открывает панель или обновляет `[data-cart-count]` (grep по `assets/*.js`
   пуст). Панель существует только как скрытый DOM.
9. **Подвал.** `.footer .two{gap:20px}` → одна колонка ≤800; текст адреса длинный, без
   `overflow-wrap`; `.contact-actions` только на главной. Переполнения по коду не видно, но
   на 320 стоит проверить `tel:`-ссылку и «Оферта · Политика · Возврат».
10. **Категории.** `.categories{flex-wrap}` без `min-height:44px` у `.filter` (кроме `.card button`
    ≤480) — на 320 чипы могут быть ниже 44px; переполнения нет.

## 3. Путь от корзины до endpoint сегодня (по коду)

- Кнопок «в корзину» нет. Карточки ведут либо на `https://t.me/palitralovee`, либо на
  `/#zayavka` (форма только на главной), либо `button[data-occasion]` → `app.js:17` ставит повод
  в `#zayavka` и скроллит (работает только на главной, где есть `#zayavka`).
- Квиз (`quiz.js:17-25`): «Оформить заказ» — ссылка `https://t.me/palitra_love?text=…` с составом.
  **Handle Telegram отличается**: `quiz.js` → `palitra_love`, всё остальное → `palitralovee`.
  Какой верный — только по ЛК/CRM (`/api/company-links` → `public-company-links/palitra` есть в
  Caddy, но сайт его не читает). Не угадывать.
- **Все формы** (главная, «Оформить заказ» на каталоге, форма корзины) обрабатываются одним
  слушателем `app.js:19`: `preventDefault` → проверка `consent` → `FormData` (имя, телефон,
  комментарий, повод/дата; **товары корзины не собираются**) → `localStorage['palitra-last-order']`
  → `fetch` в `C.ORDER_ENDPOINT` и `C.TELEGRAM_ENDPOINT`, **если они непустые** (в `config.js`
  оба `""` → запросов нет), без `await`, без проверки ответа → **безусловно**
  `f.innerHTML='Заявка отправлена'`. Это и есть текущий fake-success: отсутствующий endpoint,
  4xx/5xx и обрыв сети дают «Заявка отправлена». Защиты от двойного клика нет.
- В Caddy для palitra нет маршрута заявок; есть только `company-links`, `price`, `assets`.

## 4. Минимально достаточная существующая интеграция заявки менеджеру

Существует и уже используется другим сайтом: публичный `POST /leads` CRM
(`ops/crm/server.js:2889-2949`), проксируемый через Caddy как `/api/leads` (образец —
блок `avokado38.ru`, `caddy/Caddyfile:53-60`), клиентский образец — `sites/avokado3/callback.js`.

Факты по коду CRM:

- Поля: обязательные `name`, `contact`; необязательные `companyCode`, `channel`, `source`, `tag`,
  `page`, `landingPage`, `comment`, `firstQuestion`, `utmSource…utmTerm`, `clientId`, `referrer`.
  **Структурного поля для товаров нет** — состав корзины передаётся текстом в `comment`.
- `companyCode` обязан быть активной компанией CRM. Код компании Palitra в системе —
  `palitra-love` (`ops/content/auth-store.js:11`, `ops/content/server.js:37`
  `CONTENT_COMPANIES.palitra='palitra-love'`, `ops/crm/server.js:509-511`). Что запись
  `companies.code='palitra-love'` реально существует и активна — **проверить Хью в CRM**.
- Origin/Referer сверяется с `websiteUrl`/`socials` компании (`checkPublicOrigin`,
  `ops/crm/server.js:1174-1188`): при несовпадении — только warn в stderr, 403 лишь при
  `STRICT_ORIGIN=true`. Домен сайта должен быть в карточке компании (сейчас и после смены домена).
- Ответ: `201 {id, …, deduplicated:false}` — создана; `200 {…, deduplicated:true}` — по паре
  `companyCode + normalized_contact` уже есть заявка (**без окна времени**, `server.js:591-592`):
  новая заявка не создаётся, тело (в т.ч. `comment` с составом) **не сохраняется**, менеджеру
  уходит письмо «повторное обращение» без состава (`email-notifications.js:88`).
- Получатель письма — из настроек компании в ЛК (`companyRecipient`, `email-notifications.js:72-74`;
  `EMAIL_RECIPIENT_MISSING` если не задан). **Получатель не выдумывается и не задаётся в коде
  сайта; фактический адрес проверяет Хью в ЛК/CRM.** Заявка при этом всё равно сохраняется
  в CRM (письмо — отдельный outbox).

Вывод: для «только заявка менеджеру» достаточно (а) Caddy-маршрута `/api/leads → crm:8080/leads`
в блоке Palitra и (б) клиентского кода, который шлёт одну заявку с составом в `comment` и
считает успехом только `201` с целым `id`. Онлайн-оплаты, статусов «оплачено» и авто-подтверждения
в этой цепочке нет и не появляется.

**Открытый вопрос для Хью/Влада (реальное ограничение backend, не править в этой задаче):**
повторный заказ с тем же телефоном получит `200 deduplicated` и состав корзины никуда не
запишется. Варианты: показывать клиенту «заявка с этим телефоном уже есть — напишите состав в
Telegram/по телефону» и **не очищать корзину**; либо отдельная доработка CRM (сообщение к
существующей заявке) — вне области этого патча.

## 5. Целевое поведение и файлы для patch

### 5.1 Единая карточка (прайс = каталог)

- `sites/palitra-love/price-render.js` — единственный рендер карточки; `catalog-live.js`
  переиспользует `PalitraPrice.productCard` (сейчас дублирует разметку). Сохранить публичный API
  `window.PalitraPrice = {esc, findItem, isPopular, renderSections, renderNav, load}` и опции
  редактора (`editor`, `starHtml`, `editHtml`, `titleExtra`, `addCardHtml`, `prefix`) — их
  использует ЛК (`sites/synapse/price-editor-palitra.html:706-720`) через свою копию файла;
  копию синхронизировать отдельным решением, не в этом патче.
- Разметка карточки фиксированной структуры: `photo | placeholder` (всегда блок 4:5) →
  `h3` (фикс. высота через `-webkit-line-clamp:2` + `overflow-wrap:anywhere`, полное название
  в `title=`) → `desc` (clamp 3 строки или скрыто) → низ карточки `.product-purchase`:
  `.price` (известная цена как строка ЛК без пересчёта; пустая → «Цена уточняется» +
  `data-price-known="false"`) и **одна** кнопка «В корзину» (`button[data-add][data-id]`
  с `data-title`, `data-price`); `.note` — одной строкой над низом. Никаких `/#zayavka` из
  карточек; Telegram остаётся в шапке/подвале/hero.
- `sites/palitra-love/assets/styles.css` — переписать блок карточек: `.card,.price-card{display:flex;
  flex-direction:column}` с `margin-top:auto` только у `.product-purchase`; убрать
  `.price-card__body{min-height:270px}` и `.pc__price{margin:auto…}`; `.product-purchase{display:grid;
  grid-template-columns:1fr auto}` с `min-height` под 2 строки цены, `flex-wrap` убрать; кнопка
  `width:100%` на ≤390; добавить ступень `@media(min-width:481px) and (max-width:800px)` — 2
  колонки для `.grid,.price-grid,.home-products .grid`; на ≥1440 `.grid` — 4 колонки (проверить
  плотность), `.price-grid` — 3.
- Навигация: правила для `.cart-button` (компактная, `min-height:44px`, счётчик), на ≤480
  `nav` в две строки или скрытие текста «Корзина» с иконкой + `aria-label`; `.navlinks` на
  801–1100 — `flex-wrap`/меньший gap; `.pnav ul` горизонтальный скролл на мобильном уже есть.
- Главная: `app.js:2-13` — заменить захардкоженные 4 карточки на выборку из live-прайса
  (`showcase.self/two` или первые позиции разделов) через тот же рендер; если Влад хочет
  оставить 4 «готовых решения» — цены брать из прайса ЛК, не из `app.js`.
- JSON-LD: убрать статические `Product/Offer` с ценами и `InStock` из всех 24 HTML (они
  расходятся с прайсом ЛК и с правилом AGENTS о JSON-LD); оставить `LocalBusiness`, `FAQPage`,
  `BreadcrumbList`; `catalog-live.js` продолжает выдавать `ItemList` без `offers`.
- FAQ: текст слотов доставки на главной («до 18–20») отличается от остальных страниц («до
  20–22») — свериться с ЛК, не выбирать наугад.

### 5.2 Корзина и заявка

- Новый `sites/palitra-love/assets/order.js` (UMD как `catalog-live.js`, тестируемый без DOM):
  - состояние `localStorage['palitra-cart-v1']`: `{items:[{id,title,price|null,qty}], requestId}`;
    события `[data-add]`, `[data-qty-inc/dec]`, `[data-remove]`, `[data-cart-open/close]`,
    счётчик `[data-cart-count]`, список `[data-cart-items]`, «Итого» только по известным ценам с
    подписью «предварительно, N позиций с уточнением цены» (`[data-total]`);
  - `payload()`: `companyCode:'palitra-love'`, `name`, `contact` (телефон, валидация как в
    `callback.js:34-37`), `channel:'Заявка с сайта (корзина)'`, `page`, `landingPage`, `utm*`,
    `comment` = состав `«Название — qty × цена | цена уточняется»` + комментарий клиента +
    `requestId`; `consent===true` обязателен;
  - `send()`: `POST /api/leads`, `credentials:'omit'`, таймаут 15 с; успех **только**
    `201` и целый `id > 0`; `200 deduplicated` при первой попытке → состояние `existing`
    (корзина сохраняется, текст про Telegram/телефон); `429/4xx/5xx/сеть/таймаут` → `error`,
    форма и корзина сохраняются, кнопка снова активна;
  - ровно одна заявка: `pending`-флаг, `disabled` у кнопки и `fieldset`, `aria-busy`; повтор
    после сетевой ошибки использует тот же `requestId`; `deduplicated` после ранее неудачной
    отправки того же `requestId` считается подтверждением (заявка дошла);
  - очистка корзины и `requestId` — только после `201`.
- `assets/app.js:19` — убрать общий обработчик форм и `ORDER_ENDPOINT/TELEGRAM_ENDPOINT`;
  форма `#zayavka` на главной идёт через тот же `order.js` (без товаров, `channel:'Заявка
  с сайта (форма)'`). `config.js`: убрать пустые endpoint-ключи, оставить `SITE_URL`.
- HTML (все 24 страницы): единая разметка `aside.cart` (кнопки qty, `[data-cart-status]`,
  `<fieldset>`), подключение `order.js`, поднять `?v=` (`README.md` сайта), кнопка корзины и
  на главной; тексты «пришлём ссылку на оплату» оставить только там, где это подтверждено
  офертой (`oferta/index.html` уже говорит: подтверждение до оплаты, 100% предоплата).
- `caddy/Caddyfile` блок `palitra-love.synapsebusiness.ru`: добавить `@leads path /api/leads
  method POST → rewrite * /leads → reverse_proxy crm:8080` до `handle` со SPA-fallback.
  Никаких других серверных правок.

### 5.3 Домен `palitra-love.ru` (только план, зависит от ответа Анны)

Сейчас (по данным Хью): A apex/www → 95.163.244.138 (парковка REG.RU), наш сервер
72.56.249.147; MX/TXT/NS не трогать; DNS не менять до ответа Анны.

1. Caddy: новый блок `palitra-love.ru { … }` — копия блока `palitra-love.synapsebusiness.ru`
   **без** `import draft` (чтобы не было `X-Robots-Tag: noindex`), с теми же `company_links`,
   `price`, `assets`, `leads` маршрутами; `www.palitra-love.ru { redir https://palitra-love.ru{uri} 301 }`
   (образец `www.avokado38.ru`, `Caddyfile:39-41`). Сертификат выпустится автоматически при
   первом обращении после переключения A-записей.
2. Только после проверки нового домена (HTTPS, `/api/price`, `/api/leads` → 201 на тестовой
   заявке, страницы): старый `palitra-love.synapsebusiness.ru` → `redir https://palitra-love.ru{uri} 301`.
3. Сайт: `config.js SITE_URL`, `<link rel=canonical>`, `og:url` во всех 24 HTML, `sitemap.xml`
   (23 URL), `robots.txt` (сейчас `Disallow: /`) и `meta robots noindex` на всех страницах —
   снять после решения Влада; `price.html` — решить, индексировать ли; редакторы ЛК находятся
   на другом домене и остаются `noindex` (не касаются этого патча).
4. CRM: в карточке компании `palitra-love` добавить `websiteUrl` нового домена (иначе warn
   origin mismatch; при `STRICT_ORIGIN` — 403). Публичные ссылки — по решению
   OD-2026-09-15-COMPANY-LINKS, из CRM, не из кода.

## 6. Целевые behavior-тесты (node:test, как существующие `*.test.cjs`)

- `sites/palitra-love/assets/order.test.cjs` (без DOM, через `module.exports`):
  корзина add/qty/remove/persist; `payload` с известной и неизвестной ценой (итого только по
  известным, признак уточнения); `send`: `201+id` → успех; `200 deduplicated` первой попытки →
  `existing`, корзина цела; `404/500/429/сеть/таймаут` → `error`, корзина и поля целы, кнопка
  активна; двойной клик → один `fetch`; повтор после сетевой ошибки → тот же `requestId`, и
  `deduplicated` в этом случае = успех; `consent=false` → без `fetch`; в теле нет секретов/cookie
  (`credentials:'omit'`), `companyCode==='palitra-love'`.
- `sites/palitra-love/price-render.test.cjs` (новый, по образцу `price-loading.test.cjs`):
  карточка при `price:""` → «Цена уточняется» + `data-price-known="false"`; без `photo` →
  placeholder-блок; длинное/короткое/пустое-описание дают один и тот же порядок узлов и одну
  кнопку `[data-add]`; режим `editor:true` — прежний состав (`starHtml/editHtml/titleExtra`)
  и `renderNav` без изменений.
- `sites/palitra-love/assets/catalog-live.test.cjs` — обновить: карточка каталога = карточка
  прайса (один рендер), фильтр/схема как прежде, в схеме нет `offers`.
- `sites/palitra-love/site-consistency.test.cjs`: у всех 24 HTML одинаковые header/footer/
  `aside.cart`, подключён `order.js`, нет `ORDER_ENDPOINT`, нет статических `Product/Offer` в
  JSON-LD, `canonical`/`og:url` начинаются с `PALITRA_CONFIG.SITE_URL`, один Telegram-handle
  (после подтверждения в ЛК).
- Существующие `price-loading.test.cjs`, `catalog-live.test.cjs`, `sites/site-seo.test.cjs` —
  должны остаться зелёными (jsdom из среды проекта, см. AGENTS.md).

Layout jsdom не измеряет — визуальная часть только вручную (ниже).

## 7. Визуальная матрица (ручная, после патча; в CI не автоматизируется)

Ширины: 320, 360, 390, 768, 1024, 1440, 1920. Страницы: `/`, `/price.html`, `/catalog/`,
`/catalog/bukety`, `/vypiska`, `/dostavka-i-oplata`, `/oferta`.

| Проверка | Ожидание |
| --- | --- |
| Карточки: короткое / длинное (≥60 символов) / с описанием / без описания / без фото / `price:""` в одной строке сетки | одинаковая структура, кнопка и цена на одном уровне во всей строке, без пустых блоков выше 24px |
| Сетка | 320–480: 1 кол.; 481–800: 2; 801–1439: 3 (`.grid`) / 2 (`.price-grid`); ≥1440: 4 / 3; фото 4:5 не выше высоты экрана на 768 |
| Шапка | логотип, меню/ссылки, «Корзина · N» в одну строку без переноса/обрезки; на 320 бренд 34px; открытое мобильное меню не перекрывает корзину |
| Категории/`pnav` | чипы переносятся, `min-height:44px`; `pnav` скроллится горизонтально ≤800 |
| Корзина | открывается со всех страниц, список из 3+ позиций с qty, «Итого» с пометкой уточнения; на 320 панель во всю ширину, поля и кнопка ≥44px |
| Заявка | состояния `pending/success/existing/error` видимы и не сдвигают низ формы; после `error` данные на месте |
| Доставка/оферта/подвал | текст без горизонтального скролла, `tel:` и ссылки подвала не обрезаны на 320 |
| Cookie-баннер | не перекрывает кнопку заявки на 320–390 |

## 8. Что нужно от Хью до/во время реализации

1. Подтвердить в CRM: компания `palitra-love` активна, `websiteUrl`/`socials` содержат домен сайта,
   получатель заявок задан в ЛК; верный Telegram-handle (`palitralovee` vs `palitra_love`).
2. Решение по `200 deduplicated` (п. 4) и по индексации `price.html`/снятию `noindex`.
3. Ответ Анны по DNS — до него блок `palitra-love.ru` в Caddy не добавлять.
4. Данные прайса (303 карточки) остаются в ЛК; seed `data/price.json` не расширять.

## Статус 24.09.2026 — патч 3 «замечания Дарьи» (ветка `codex/palitra-darya-fixes-20260924`, не опубликован)

Источник: сообщения Дарьи в группе 20.09 16:12–16:14 (образец мобильного магазина шаров: «Два товара
в строчке и нажать купить. Без кнопки перейти в телеграм»; обведённая подпись «Цена из публикации
от … актуальность уточняется при заказе» — убрать везде). Только `sites/palitra-love/**`, сервер/БД/
прайс/CRM не тронуты.

- Карточка (`price-render.js`, запасная разметка `catalog-live.js`): низ — цена + одна кнопка
  «Купить» (`data-add`, добавляет в корзину; онлайн-оплаты нет, подпись возвращается после
  «В корзине»); ссылки «Канал в Telegram» и «Заказать под Ваш повод» из карточки убраны. Карточки-
  примеры главной (`app.js`) и результаты квиза (`quiz.js`) — без ссылки в Telegram; примеры без id
  каталога не получают «Купить», только «Заказать под Ваш повод». Ссылки в канал в шапке/подвале/
  навигации квиза остаются.
- Служебные примечания импорта («Цена из публикации от ДД.ММ.ГГГГ; актуальность уточняется при
  заказе», «Цена на момент публикации, актуальную подтверждаем при заказе») скрываются при показе
  (`PalitraPrice.isAutoPriceNote`: начало «Цена из/на момент публикации» + слово «актуальн»);
  любое другое примечание владельца показывается; редактор ЛК видит примечание как есть; строки
  прайса не переписываются, живые цены не подменяются, пустая цена — «Цена уточняется».
- `styles.css`, завершающий блок «Правки по замечаниям Дарьи»: на ≤480 `.price-grid` и каталог
  `body[data-page="catalog"] .grid` — две колонки (gap 12), компактная карточка: заголовок 15px,
  описание 12px, цена 17px своей строкой (`white-space:nowrap`, цифры не рвутся), под ней «Купить»
  40px во всю ширину (низ карточки `grid-template-columns:minmax(0,1fr)` — исправление дефекта
  приёмки Хью на 320px, где перекрывало правило патча 2 `minmax(0,1fr) auto`); 481–800 уже две
  колонки; десктоп без изменений. Фото 4:5 без обрезки (`object-fit:cover` от 4:5-исходников), тексты не обрезаются.
- 24 HTML: версии `?v=20260924darya1` для `styles.css`, `app.js`, `price-render.js`,
  `catalog-live.js`, `quiz.js`, `order.js`. Дополнительно найдено и исправлено: в статической
  разметке `den-rozhdeniya/index.html` (4 карточки) и `muzhchinam/index.html` (2 карточки) оставались
  кнопка «Канал в Telegram» и числовые цены (5 540 / 8 390 / 26 870 / 7 990 и 4 990 / 7 990 руб) — заменены на
  «Цена уточняется» (`data-price-known="false"`) и ссылку «Оставить заявку» на форму; это примеры без id
  каталога, «Купить» у них нет.
- Тесты: новый `sites/palitra-love/mobile-cards.test.cjs` (правила сетки по тексту CSS, каталог и
  прайс настоящим рендером: одна кнопка «Купить», нет ссылок, примечания импорта скрыты, «Купить»
  кладёт в корзину и не открывает её; главная — примеры без «Купить»); обновлены
  `price-render.test.cjs` (порядок блоков, `isAutoPriceNote`, редактор видит примечание),
  `order.test.cjs`, `quiz.test.cjs`, `pages.test.cjs` (версия). jsdom раскладку не измеряет —
  визуальная приёмка 320/360/390/414 в браузере за Хью.
