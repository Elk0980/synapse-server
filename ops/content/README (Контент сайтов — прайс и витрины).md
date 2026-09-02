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

## Ключ

`CONTENT_API_KEY` создаётся автоматически скриптом `ops/synapse-sync` (как и ключи CRM и chat)
и лежит только в `/opt/synapse/.env`. Посмотреть на сервере: ` grep CONTENT_API_KEY /opt/synapse/.env`.
Редактор спрашивает ключ один раз и держит его в sessionStorage браузера.

## Локально

```sh
mkdir -p data
PORT=8080 DATABASE_PATH="$PWD/data/content.sqlite" API_KEY=test node ops/content/server.js
```
