# План

Точечный exact-route guard перед generic HTTP upstream: readRequestBody с existing limit, fresh permission/session/CSRF, identity continuity, owner decision. Не менять CRM guard или повторять всю проверку глобального прокси.

Actual fixture preload отмечает начало чтения targeted IncomingMessage после initial auth. Parent отправляет первый byte, ждёт marker, меняет только synthetic auth DB, заканчивает body. Нет внешней сети, токенов/секретов реальных аккаунтов. Отрицательная проба на предыдущем64 QA, затем scoped sync одного server path после read/diff/tests.
