# Контент сайтов — сервис `content`

Хранит JSON-документы сайтов с историей версий. Среди документов — `alvi/price` и
`palitra/price`. Первый содержит прайс ALVI и витрины главной («Проведи день для себя», «Один ритм
на двоих»). Редактируется в кабинете Synapse: `synapse.synapsebusiness.ru/price-editor.html`.

Node 24, встроенный `node:sqlite`, внешних пакетов нет. База — `/data/content.sqlite`
в томе `content_data`. При первом старте документ создаётся из `seed/alvi-price.json`
(та же копия лежит в `sites/alvi/data/price.json` как запасной вариант для сайта).

## Методы

- `GET /content/alvi/price` — актуальная версия, публично, без ключа.
  На сайте ALVI доступна как `https://alvi.synapsebusiness.ru/api/price` (только GET).
- `PUT /content/alvi/price` — новая версия. Заголовок `X-API-Key` = `CONTENT_API_KEY` из `.env`.
  Проверки: уникальные id, витрины не больше 8 позиций, не больше 8 популярных в разделе,
  все id витрин существуют. При ошибке — 422 и список проблем.
- `GET /content/alvi/price/history` — последние 10 версий.
- `GET /content/alvi/price/version/N` — конкретная версия.
- `POST /content/alvi/price/restore/N` — откат: версия N копируется как новая (по ключу).
- `GET /health`.

## Документ `alvi/site` — тексты и фоны главной

Редактор: `synapse.synapsebusiness.ru/site-editor.html`. На сайте доступен как `GET /api/site`.
Секции = блоки главной; поля привязаны к элементам разметки через атрибут `data-edit="<секция>.<поле>"`
(разметка проставлена скриптом `tag_site.py`, значения по умолчанию — в `seed/alvi-site.json`).
`sites/alvi/site-apply.js` подставляет тексты (разрешены только em/strong/b/i/sup и перенос строки)
и фоны: `background.image` (свой файл) или `background.default` (как было), `background.opacity`.

## Файлы (фоны)

- `POST /content/alvi/assets` — тело запроса = файл, заголовки `Content-Type: image/jpeg|png|webp`,
  `X-Filename`, `X-API-Key`. До 8 МБ. Ответ: `{ url: "/api/assets/<имя>" }`.
- `GET /content/alvi/assets/<имя>` — отдача файла; на сайте — `https://alvi.synapsebusiness.ru/api/assets/<имя>`.
- Хранятся в `/data/assets/alvi` (том `content_data`).

## Ключи

Два ключа, оба создаёт `ops/synapse-sync` и оба лежат только в `/opt/synapse/.env`:
- `CONTENT_API_KEY` — владелец (в истории версий подписывается «Влад»);
- `CONTENT_EDITOR_KEY` — редактор со стороны клиента (подписывается «Татьяна»).
Посмотреть: ` grep CONTENT_ /opt/synapse/.env`. Оба редактора принимают любой из ключей;
`GET /content/whoami` с ключом отвечает, кто вы.

## Ключ (историческая заметка)

`CONTENT_API_KEY` создаётся автоматически скриптом `ops/synapse-sync` (как и ключи CRM и chat)
и лежит только в `/opt/synapse/.env`. Посмотреть на сервере: ` grep CONTENT_API_KEY /opt/synapse/.env`.
Редактор спрашивает ключ один раз и держит его в sessionStorage браузера.

## Локально

```sh
mkdir -p data
PORT=8080 DATABASE_PATH="$PWD/data/content.sqlite" API_KEY=test node ops/content/server.js
```

## Единый вход

Кабинет и редакторы используют cookie `synapse_session` (HttpOnly, Secure,
SameSite=Lax, 30 дней). Пользователи задаются только в серверном `.env`:

```dotenv
AUTH_USERS='login:role:scrypt$N$r$p$base64url-salt$base64url-hash;login2:role:scrypt$N$r$p$base64url-salt$base64url-hash'
```

Допустимые роли: `owner` (все сайты) и `editor` (только `alvi` и `avokado`).
Готовую запись без показа пароля в терминале создаёт скрипт:

```sh
node ops/content/make-password.js vladislav owner
node ops/content/make-password.js tatyana editor
```

Обе напечатанные строки объединяют через `;` в `AUTH_USERS` и заключают всё значение в одинарные кавычки (они защищают символы `$` от подстановки Docker Compose). Пароли и хеши в
репозиторий не добавляются. `SESSION_SECRET` автоматически создаётся командой
`ops/synapse-sync` (`openssl rand -hex 32`, права `.env` 600); существующее
значение не перезаписывается. Если запустить content без секрета, он создаст
временный и предупредит, что сессии пропадут после перезапуска.

Старые `X-API-Key` (`CONTENT_API_KEY` и `CONTENT_EDITOR_KEY`) продолжают работать
для автоматики и как запасной вход редакторов. Cookie не требуется передавать
кросс-доменным клиентам, а CORS не включает `Access-Control-Allow-Credentials`.

## Прайс Palitra Love

Документ `palitra/price` создаётся из `seed/palitra-price.json`. Редактор находится по адресу
`synapse.synapsebusiness.ru/price-editor-palitra.html`, а публичная страница использует
`GET /content/palitra/price` (на домене клиента — `GET /api/price`). История версий и откат
работают по тем же путям, что у ALVI, с префиксом `/content/palitra/price`.

Файлы Palitra Love загружаются через `POST /content/palitra/assets` и читаются через
`GET /content/palitra/assets/<имя>`. Для записи прайса и загрузки файлов используется отдельный
ключ `CONTENT_KEY_PALITRA`. В серверный `.env` нужно добавить пустой заранее не заполняемый в
репозитории слот:

```dotenv
CONTENT_KEY_PALITRA=
```

Ключ ALVI (`CONTENT_API_KEY`/`CONTENT_EDITOR_KEY`) для маршрутов Palitra Love не подходит.
