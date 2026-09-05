# Мини-CRM — заявки, контакты, компании и юридические лица

JSON API хранит заявки и аналитику, а также карточки контактов, компаний и юридических лиц. Node.js 24
использует встроенный `node:sqlite`; внешних зависимостей нет. Все даты — UTC ISO 8601, внешний JSON — camelCase.
При запуске создаётся только схема: seed, демонстрационные карточки и предполагаемые реквизиты не добавляются.

## Запуск и безопасность

```sh
PORT=8080 DATABASE_PATH="$PWD/data/crm.sqlite" API_KEY='replace-me' node ops/crm/server.js
node ops/crm/smoke-test.js
```

Кроме публичных `POST /leads` и `POST /events`, все маршруты требуют `X-API-Key`. Один общий ключ даёт полный
административный доступ, включая персональные данные и банковские реквизиты: это **не RBAC**. Будущий UI обязан
использовать серверный прокси, который проверяет права; ключ нельзя помещать в браузер. Тела запросов и секретные
данные сервис не журналирует. Пароли, банковские логины, токены, API-ключи, cookie, приватные ключи, коды
подтверждения и CVV/CVC не являются полями модели и отклоняются.

## Модель

### Контакты

`contacts`: обязательное `name`; необязательные `position`, `phone`, `email`, `messengers`, `links`, `city`,
`timezone`, `preferredChannel`, `notes`, `birthDate`. Нормализованный телефон используется только внутри базы и не
уникален. `messengers` принимает до 25 объектов с `type` (`telegram`, `max`, `whatsapp`, `vk`, `phone`, `email`,
`other`), `label`, `handle`, `url`; обязателен `handle` или HTTP(S)-`url`. `links` содержит `label` и HTTP(S)-`url`.
Роли человека хранятся только в связях.

### Компании

`companies`: обязательные уникальный `code` и `name`; необязательные `industry`, `city`, `timezone`, `phone`,
`email`, `websiteUrl`, `socials`, `pipelineStage`, `startDate`, `endDate`, `preferredChannel`, `notes`. Код приводится
к нижнему регистру и допускает 2–64 символа `a-z`, `0-9`, `_`, `-`. Этапы: `application`, `call`, `kit_ready`,
`payment`, `active`; по умолчанию этап равен `null`. Ответственный определяется активной связью.

### Юридические лица и ИП

`legalEntities`: обязательные `legalForm` (`ip` или `ooo`) и `name`; необязательные `shortName`, `inn`, `kpp`,
`ogrn`, `ogrnip`, `phone`, `email`, `legalAddress`, `postalAddress`, `taxSystem`, `bankName`, `bik`,
`checkingAccount`, `correspondentAccount`, `recipientName`, `notes`. Реквизиты хранятся как TEXT. ИНН содержит 12
цифр для ИП или 10 для ООО; КПП и БИК — 9, ОГРН — 13, ОГРНИП — 15, счета — 20 цифр. `ogrnip` разрешён только
для ИП, `ogrn` — только для ООО. Подписанты определяются связями.

Все сущности имеют `id`, `createdAt`, `updatedAt`, `isDeleted`, `deletedAt`.

## Маршруты карточек

Для каждого ресурса доступны:

* `GET /contacts`, `POST /contacts`, `GET|PATCH|DELETE /contacts/:id`, `POST /contacts/:id/restore`;
* `GET /companies`, `POST /companies`, `GET|PATCH|DELETE /companies/:id`, `POST /companies/:id/restore`;
* `GET /legal-entities`, `POST /legal-entities`, `GET|PATCH|DELETE /legal-entities/:id`,
  `POST /legal-entities/:id/restore`.

`POST` отвечает `201` и `Location`. `PATCH` принимает только переданные поля; `null` очищает необязательное поле.
Списки принимают `q`, `deleted=exclude|include|only`, `limit` (50, максимум 200), `offset`. Фильтры контактов:
`companyId`, `legalEntityId`, `city`, `preferredChannel`; компаний: `contactId`, `legalEntityId`, `city`,
`pipelineStage`; юрлиц: `contactId`, `companyId`, `legalForm`. Полная удалённая карточка доступна администратору с
`?includeDeleted=true`. Списки и вложенные карточки исключают заметки, даты рождения, адреса и банковские реквизиты.

Нейтральный QA-пример:

```sh
curl -X POST http://localhost:8080/companies \
  -H 'X-API-Key: replace-me' -H 'Content-Type: application/json' \
  -d '{"code":"qa_company_a","name":"QA Company A"}'
```

## Связи

* `PUT|DELETE /contacts/:contactId/companies/:companyId` — `role`, `isResponsible`, `validFrom`, `validTo`, `notes`;
* `PUT|DELETE /companies/:companyId/legal-entities/:legalEntityId` — `role`, `isPrimary`, даты и `notes`;
* `PUT|DELETE /contacts/:contactId/legal-entities/:legalEntityId` — `role`, `isSignatory`, `signingBasis`, даты,
  `notes`.

Для первой связи и повторной активации `role` обязателен. PUT повторно использует ту же строку. На компанию может
быть только один активный ответственный и одно основное юрлицо; переключение транзакционно. Подписантов может быть
несколько. DELETE мягко отключает связь и идемпотентен.

Удаление карточки мягкое и транзакционно отключает её активные связи, но не соседние сущности и не заявки.
Повторный DELETE сохраняет исходный `deletedAt`. Restore восстанавливает только карточку; связи включаются новым PUT.
Физический `ON DELETE CASCADE` существует только для защиты junction-таблиц при прямом обслуживании SQLite.

## Заявки и компании

`POST /leads` принимает необязательный `companyCode`; неизвестная или удалённая компания отклоняется. Поле
возвращается в `GET /leads`, `GET /leads/:id` и последней колонкой CSV. Доступны фильтр
`GET /leads?companyCode=qa_company_a` и PATCH с кодом либо `null`. Изменение `companies.code` и каскадное обновление
заявок выполняются транзакционно. Удаление компании оставляет код у старых заявок для истории.

Дедупликация выполняется по паре `companyCode + normalized_contact`: одинаковый контакт внутри одной компании
склеивается, в разных компаниях создаёт разные заявки, а непривязанные заявки сравниваются только между собой.
Старые маршруты сообщений, истории, этапов, продаж, расходов, `/dashboard`, `/summary` и `/leads.csv` сохранены.

Миграции записываются в `schema_migrations`, выполняются транзакционно и повторяемо, не создают бизнес-данных и
завершаются `PRAGMA foreign_key_check`.

## События с сайтов

Публичный `POST /events` принимает визиты и клики с разрешённых CORS-источников. Обязательны `type`
(`visit` или `click`) и код активной компании `companyCode`. Поддерживаются `clientId`, `page`, `landingPage`,
`referrer`, поля `utmSource` … `utmTerm`, `source`, `target`, `label` и ISO-время `ts`. Ответ всегда содержит только
`{"ok":true}` с кодом 202. Повторный визит одного `clientId` на ту же страницу в течение 30 минут не записывается.
IP хранится только как SHA-256 от IP и серверной соли `API_KEY`; User-Agent сокращается до 60 символов.

```sh
curl -X POST http://localhost:8080/events -H 'Content-Type: application/json' \
  -d '{"type":"visit","companyCode":"qa_company_a","clientId":"browser-123",
"page":"/contacts","referrer":"https://2gis.ru/moscow"}'

curl -X POST http://localhost:8080/events -H 'Content-Type: application/json' \
  -d '{"type":"click","companyCode":"qa_company_a","clientId":"browser-123",
"page":"/contacts","target":"phone","label":"Позвонить"}'
```

`deriveSource({ utmSource, referrer })` сначала нормализует `utmSource` в нижний регистр. Без UTM он распознаёт
2ГИС, Яндекс, Google, Instagram, VK, Telegram и WhatsApp по хосту referrer. Пустой referrer даёт `direct`, прочий
домен — его host без `www.`. Для заявки referrer используется только при отсутствии `source` и `utmSource`;
`direct` в `leads.source` не записывается.

## Внешняя статистика площадок

`POST /external-stats` с ключом принимает источник, компанию, примечание и дневные строки. Все поля строки, кроме
`date`, являются числовыми метриками со свободными именами. Повторная отправка пары источник + компания + дата
перезаписывает снимок. `GET /external-stats` поддерживает фильтры `source`, `companyCode`, `from` и `to`.

```sh
curl -X POST http://localhost:8080/external-stats \
  -H 'X-API-Key: replace-me' -H 'Content-Type: application/json' \
  -d '{"source":"2gis","companyCode":"qa_company_a","rows":[
{"date":"2026-09-05","pageViews":42,"calls":3,"routes":5}],"note":"daily import"}'

curl 'http://localhost:8080/external-stats?source=2gis&companyCode=qa_company_a&from=2026-09-01&to=2026-09-05' \
  -H 'X-API-Key: replace-me'
```

`/dashboard` в `sources` отдаёт полный список имён источников из заявок, событий и внешних
снимков; список не ограничивается выбранным периодом или фильтром `source`. `/summary` в `sources` отдаёт
те же объекты статистики, что и в `sourceStats`. В `sourceStats` для каждого источника за период
возвращаются показатели заявок и продаж, уникальные визиты, количество кликов, `clicksByTarget`, сумма метрик
`external` и время последнего снимка `externalCapturedAt`. Пустой источник заявки объединяется с событиями
`direct`. Общие показатели также содержат `visits` и `clicks`.

## Задачи

`tasks` — план работ по проектам и очередь входящих поручений. Обязательное поле `title` содержит от 1 до 200
символов. Поля `description`, `assigneeName`, `sourceRef`, `sourceAuthor` и `createdBy` — строки. `companyCode`
равен пустой строке для общих задач Synapse либо коду существующей активной компании; код сохраняется в нижнем
регистре. `dueDate` — дата `YYYY-MM-DD` или пустая строка.

Допустимые значения:

* `assigneeRole`: `owner`, `admin`, `marketer`, `synapse` (по умолчанию);
* `status`: `inbox` (по умолчанию), `planned`, `in_progress`, `done`, `cancelled`;
* `priority`: `low`, `normal` (по умолчанию), `high`, `urgent`;
* `source`: `manual` (по умолчанию), `chat`, `telegram`.

Доступны `GET|POST /tasks` и `GET|PATCH|DELETE /tasks/:id`. Список поддерживает общие параметры `deleted`,
`limit`, `offset`, а также фильтры `companyCode`, `status`, `assigneeRole`, `source` и поиск `q` по названию,
описанию и автору источника. Задачи сортируются по входящему статусу, приоритету, сроку и времени создания.
`POST` с непустым `sourceRef` активной задачи идемпотентен: возвращает существующую задачу с HTTP 200 и
`duplicate: true`. `GET /tasks/summary` возвращает общие счётчики и `byCompany`; параметр `companyCode` ограничивает
выборку. Удаление мягкое.

```sh
curl -X POST http://localhost:8080/tasks \
  -H 'X-API-Key: replace-me' -H 'Content-Type: application/json' \
  -d '{"title":"Разобрать обращение","source":"chat","sourceRef":"chat:12:345"}'
```
