# План

Один писатель Codex в codex/server-resource-queue-20261008. Claude High недоступен в проверенной проектной сессии, работа Codex — резерв согласно поручению. Общий checkout не меняется.

Добавить ops/crm/server-resource-queue.js с тремя изолированными таблицами, маршруты под существующим owner-only /coordination в CRM и существующим CSRF proxy. UI расширяет доску задач; нет новых прав, ключей или клиентского дизайна. Только фиксированный ресурс synapse-production: общая консоль/CRM/серверное размещение.

BEGIN IMMEDIATE + revision + lease hash + fence. Первый запуск unknown, expiry unknown. Без автоматического исполнения shell/чатов и новых каналов. Частные threadIDs/переписки только runtime БД, вне Git. Проверить backend, HTTP ACL, UI и SpecKit. Production: свежий владелец/окно, версия, backup, rollback, затем узкое размещение; молчание не является свободой.
