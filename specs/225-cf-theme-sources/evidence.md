# Свидетельства 225

Реализовано и проверено локально. Не подключено (не выпущено), в рабочей системе не проверено, не принято.

## Тесты (07.11.2026, node 22, worktree `claude/cf-theme-sources`)
- `node --test ops/crm/media-mentor-http.test.js`: 25 из 26; новый тест specs/225 проходит (просмотр — 403 на запись, чужая компания — 403, POST на PUT-маршрут — 405, `javascript:`/`http:`/логин в адресе/пробел/длина > 1000/не строка — 400, лишнее поле — 400, неизвестная тема — 404; версия плана и `variants` не меняются; непереданное поле сохраняется; очистка удаляет запись; список — всё или ничего, повтор темы — 400; журнал — 5 событий; версия плана одна). Падение `импорт проверяет компанию и edit до чтения файла` есть и на `origin/main` без изменений (проверено `git stash`).
- `node --test ops/crm/media-mentor.test.js`: проходит (список таблиц дополнен).
- Полный набор `ops/crm`: 1093 прошли, 5 падений — те же 5, что на `origin/main` (notification priority SMTP, импорт preview, reel-plan-file.test.js, smoke-test.js, board products CRM registry).
- `node --test sites/synapse/cabinet/*.test.cjs` (NODE_PATH основного checkout): 1190 из 1190 (на main 1186). Новые: `content-plan.test.cjs` ×2, `shooting.test.cjs` ×1, `materials.test.cjs` ×1.
- `python3 tools/spec-kit/gate.py check`: ok.

## Скриншоты
Стенд: настоящие `content-plan.js/.css`, `shell.css`, стили `cabinet.html`, реестр модулей, SAMPLE-данные, headless Chrome (playwright).
- `links-390.png`, `links-1440.png`: тема 1 — заданные «📁 Исходники» и «🎬 Монтаж»; тема 2 — «не указано» и открытая форма «Изменить» с длинной ссылкой. `scrollWidth` = ширине окна (390/1440), ошибок консоли нет, сохранение отправляет `PUT …/plan/ideas/s-2/links`.

## Разрывы
- «Съёмка» и «Монтаж» на стенде не снимались (проверены jsdom-тестами).
- Доступность ссылки на Диске не проверяется.
