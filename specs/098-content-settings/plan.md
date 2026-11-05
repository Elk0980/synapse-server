# План 098 (б) · Настройки → Контент

Владелец: агент «А · Каркас». Ветка claude/night98-a-settings от origin/main.
Файлы: ops/content/content-settings.js (новый модуль маршрута, таблица по компании с версией),
ops/content/content-settings.test.js, ops/content/server.js (2 точечные вставки: создание и маршрут),
sites/synapse/cabinet/content-settings.js/.css (экран, регистрируется как модуль settings-content).

Подключение в кабинет: строка "content-settings" в списках shellAssets/shellStyles части (а).
Порядок выпуска: (б) раньше (а) или вместе; без (а) файлы экрана не загружаются, маршрут сервера безвреден.
Проверки: node --test content-settings.test.js и всех ops/content тестов, node --check server.js.
