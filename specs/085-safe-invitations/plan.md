# План

Владелец: Claude. Файлы: новые `ops/content/invitations.js`, `ops/content/invitation-delivery.js`, их тесты; `ops/content/auth-store.js` (параметр `options` в `create`: `within` и `auditSource`, обратно совместим); `ops/content/server.js` (создание модуля с `delivery: null` и подключение маршрутов); новые `sites/synapse/accept-invitation.html/js` и тест; этот каталог. V2: `sites/synapse/cabinet/account.js` — раздел «Приглашения» (создаётся в `#accounts-view` скриптом, `cabinet.html` не менялся) и его тест; `accept-invitation.css` и `release-headers.md`.

Схема: три новые таблицы (`invitation_recipients`, `invitations`, `invitation_audit`), существующие не меняются.

Активация (после согласования): 1) выпуск кода — канал остаётся выключен, приглашения создаются в `recipient_unverified`/`channel_disabled`; 2) отдельным решением — серверный проверяющий код получателя (например, по подписанной привязке Mini App/личного бота), отправитель, ключ шифрования вне репозитория, транспорт; 3) синтетическая живая проверка; 4) первое настоящее приглашение.
Откат: удалить подключение в `server.js` (маршруты пропадают), таблицы можно оставить или удалить; учётные записи, созданные приглашениями, — обычные и управляются как прежде.
