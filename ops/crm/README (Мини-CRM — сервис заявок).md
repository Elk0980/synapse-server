# Мини-CRM — заявки, контакты, компании и юридические лица

JSON API хранит заявки и аналитику, а также карточки контактов, компаний и юридических лиц. Node.js 24
использует встроенный `node:sqlite`; внешних зависимостей нет. Все даты — UTC ISO 8601, внешний JSON — camelCase.
При запуске создаётся только схема: seed, демонстрационные карточки и предполагаемые реквизиты не добавляются.

## Запуск и безопасность

```sh
PORT=8080 DATABASE_PATH="$PWD/data/crm.sqlite" API_KEY='replace-me' node ops/crm/server.js
node ops/crm/smoke-test.js
```

Кроме публичного `POST /leads`, все маршруты требуют `X-API-Key`. Один общий ключ даёт полный административный
доступ, включая персональные данные и банковские реквизиты: это **не RBAC**. Будущий UI обязан использовать
серверный прокси, который проверяет права; ключ нельзя помещать в браузер. Тела запросов и секретные данные сервис
не журналирует. Пароли, банковские логины, токены, API-ключи, cookie, приватные ключи, коды подтверждения и CVV/CVC
не являются полями модели и отклоняются.

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
