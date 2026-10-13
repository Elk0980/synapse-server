# План
Один писатель интеграции: Codex, отдельный checkout codex/server-revenue-analytics-20261008, база 76ca87c7ac79e4e4bcb79866bdb6041003c770a2.
Claude реализовал ограниченный кандидат Direct в отдельной папке; Codex проверяет и исправляет контракт. Другая задача Claude COHORTS имеет отдельные файлы.

## Модули и миграция
revenue-direct-adapter.js — Reports; access.js — encrypted access и проверка кампаний; adapters.js — связывание; revenue-analytics.js — сохранённые задания и новая revenue_direct; quality.js/http.js — состояние и защищённый API; cabinet/analytics.js — отображение. Существующие таблицы и серверный таймер переиспользуются. Секреты, данные клиентов и чужие изменения не переносятся.
Смены таблиц совместимы с откатом: прежний код игнорирует revenue_direct. Перед рабочей установкой отключить сбор, сохранить backup/rollback и проверить свежую базу. Эта спецификация не выдаёт серверную аренду.

## Проверки
node --test ops/crm/revenue-direct-adapter.test.js ops/crm/revenue-direct-integration.test.js ops/crm/revenue-analytics.test.js
NODE_PATH с существующим приватным jsdom: node --test sites/synapse/cabinet/analytics-revenue.test.cjs
Spec Kit gate/converge; полный diff и отсутствие удалений чужих функций.
SC002/SC003 выполняются отдельно с подтверждённым доступом и окном.

## Следующий общий этап
Принять и интегрировать когортный движок и доказуемую связь заявка/запись/платёж. Продолжить 2ГИС и социальные сборщики. Не считать Direct этап завершением полного поручения.
