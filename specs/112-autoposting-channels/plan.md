# План

Владелец: Claude — код (№112). Файлы: ops/content/auth-store.js (право, зависимости, миграция),
ops/content/company-team.js (пресет администратора), ops/content/server.js (прокси autoposting),
ops/crm/server.js (маршруты /autoposting), sites/synapse/cabinet/autoposting.js и account.js (интерфейс),
тесты рядом, этот каталог.
Существующее: PERMISSIONS/DEPENDENCIES/normalizePermissions, auth_meta для однократных шагов,
companyModuleContext/requirePermission. Миграция только добавляет строки `auth_user_permissions`
(INSERT OR IGNORE), откат — удалить строки `autoposting.channels` и ключ `auth_meta`.
Связь: PR 523 (permission-help.js) проверяет, что каталог пояснений совпадает с PERMISSIONS — после
слияния 523 нужна строка для `autoposting.channels` (добавляется в том PR, что сливается вторым).
Проверки: новые тесты прав, затронутые наборы ops/content и ops/crm, jsdom autoposting/account, gate.py check.
