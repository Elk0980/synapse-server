# Контент сайтов — сервис `content`

Хранит JSON-документы сайтов с историей версий. Сейчас один документ —
`alvi/price`: прайс ALVI и витрины главной («Проведи день для себя», «Один ритм
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
