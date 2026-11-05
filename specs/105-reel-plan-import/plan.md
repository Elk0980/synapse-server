# План
Владелец: Codex — Доска в ЛК; ревью: Claude. База main 0a618bed, ветка codex/reel-plan-import-20261104. Документ не является блокировкой сервера.

Переиспользуем media_mentor_plans и неизменяемые версии JSON; аддитивные optional script/filmingBy/productionStatus без новой таблицы. Генератор 7–14 дней не меняется. Отдельный stateless POST /media-mentor/plan/import-preview читает CSV/XLSX под существующим доступом и возвращает ячейки; PUT /media-mentor/plan остаётся единственной записью. XLSX-reader закреплён в CRM, файл не сохраняется. Статусы: planned/shot/editing/draft, согласование прежнее.

Один автор на файлы: board_api — media-mentor.js и reel-plan.test.js; board_review — cabinet/media-mentor.js и reel-plan-import.js; root — parser/HTTP, CSS, loader, спецификация и интеграция. Остальные файлы, production и права не затрагивать. Тесты только на вымышленных компаниях/материалах. Проверить серверные контракты, DOM и 390px; фактический выпуск не входит в поручение.
