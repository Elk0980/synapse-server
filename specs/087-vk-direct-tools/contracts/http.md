# HTTP contract

Process: Spec Kit 1.0.0. Согласованный контракт для реализации; сверить с финальными маршрутами и HTTP-тестами перед приёмкой.

Все перечисленные маршруты приватны: базовый путь кабинета `/content/crm/vk-tools`, обязательный query `companyCode`. Content проверяет сессию владельца; CRM повторно проверяет identity и область компании. Любой метод изменения требует CSRF. Нет произвольного проксирования методов/URL VK. Ответы и предпросмотры не публикуются для посетителей сайта.

## Подключения

| Метод и путь после base | Тело / результат |
|---|---|
| `GET /{analytics\|design}/settings` | DTO настройки без секрета. |
| `PUT /{analytics\|design}/settings` | `{revision,groupId,tokenType,accessToken,enabled?}`; возвращает новое состояние подключения. |
| `POST /{analytics\|design}/check` | `{revision}`; проверяет неизменную привязку чтением, возвращает состояние проверки. |

`tokenType` — `user` для аналитики, `user` или `group` для оформления. Пустой `accessToken` не очищает секрет и не переносит его на другую привязку. Перед сохранением клиент читает settings и передаёт полученную revision; не угадывает номер.

Settings DTO: `companyCode,purpose,groupId,tokenType,revision,configured,tokenConfigured,enabled,connected,checkedRevision,status,checkedAt,errorCode,group,capabilities`. Ни токен, ни зашифрованная форма, ни provider URL с секретными параметрами не возвращаются. Успешный check не равен проверенному праву на все изменения.

Аналитика использует существующий `POST /content/crm/social-stats/collect?companyCode=...` и его контракт периода/аккаунта. Нового endpoint сбора или планировщика публикаций нет.

## Оформление

| Метод и путь после base | Тело / результат |
|---|---|
| `GET /design/state` | Необязательный query `revision`; повторное чтение описания/обложки выбранной группы. |
| `POST /design/preview` | `{revision,operation:'description',description}` либо `{revision,operation:'cover',image:{mime,base64},crop?:{x,y,x2,y2}}`. |
| `POST /design/apply` | `{revision,previewId,requestId}`; явная отправка только подготовленной операции. |
| `POST /design/rollback-preview` | `{revision,requestId}`; requestId относится к прежней операции описания, создаётся новый предпросмотр восстановления. |
| `GET /design/history` | `{companyCode,items}` с операциями выбранной компании. |

Preview DTO: `{companyCode,groupId,revision,previewId,operation,before,after,sourceHash,warnings,createdAt}`. Apply DTO: `{companyCode,groupId,revision,previewId,requestId,operation,status,code,before,after,createdAt,completedAt}`. `status`: `applying|verified|applied_unverified|uncertain|failed`.

Клиент не передаёт `before` как доверенное состояние и не выбирает произвольный groupId для apply: целевая привязка берётся с сервера. Повтор одного requestId возвращает ранее зафиксированный результат; изменённая полезная нагрузка, чужой preview, устаревшая revision или конфликт текущего состояния отклоняются. `uncertain` не запускает новую отправку. Apply восстановления требует новый requestId.

## Пределы инкремента

Исходные пределы Synapse: описание до 4000 символов; статическая обложка JPEG/PNG до 8 MiB, до 40 миллионов пикселей и 16384 пикселей по каждой стороне. Это ограничения приложения, не заявление о максимумах VK. Проверка байтов/размеров обязательна независимо от заявленного MIME; URL вместо base64 не принимается. Лимит HTTP учитывает увеличение размера при base64.

Ошибки авторизации, company scope, CSRF, входных данных и конфликтов возвращаются без провайдерского секрета. Точные HTTP-коды проверяются route-тестами; фронтенд не считает любой HTTP 2xx доказательством `verified`.

Существующие `/content/crm/vk-community/...` для ручных сообщений и подключения Onlypult сохраняют свой контракт. Новых Callback/Long Poll маршрутов нет.
