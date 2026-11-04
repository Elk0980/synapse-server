# План

Владелец: Codex — Сторож доски; ревью Claude. Процесс Spec Kit 1.0.0.

1. В ops/crm/task-watchdog.js проецировать allowlist существующей immutable записи. Проверять пару comment/task IDs, формат key и совместимость роли; никакой повторной аутентификации, DDL или backfill.
2. В ops/crm/task-coordination.js применять один serializer к обоим ответам. Без watchdog возвращать verified=false.
3. ops/tasks-mcp/comment-identity.test.js: настоящий изолированный HTTP-стенд и точечные negative fixtures. Остальные тесты watchdog/CRM/пагинации — регрессия.
4. Контракт передать Claude в №68: accepted PR481/head60b54e2e пока ожидает agentId/credentialId. Не выдумывать credentialId; владелец consumer должен перейти на principal и доказать issuer admission.

Миграции/откат: схема не меняется. Откат к прежнему коду убирает только добавочное поле; старые комментарии и auth journal сохраняются. Исторический stamp означает личность на момент записи, а не действующий сегодня grant.
