# Проверки

2026-11-04. Изолированный Windows/Node24.18.1, только синтетические данные.

- Причина: task-coordination.js:478–479/664 на исходном main0a618bed возвращал только task_comments без уже сохранённой watchdog личности.
- 38/38 PASS: comment-identity, task-principal, task-watchdog, task-coordination, tasks-mcp/crm, watchdog-http. Настоящие локальные cabinet session/CSRF и MCP HTTP; оба ответа identity совпадают, legacy без principal, пагинация сохранена.
- Расширенная регрессия: 207 тестов = 206 PASS / 1 Windows SKIP / 0 FAIL (все tasks-mcp, watchdog/principal, coordination/products/waiting, старые/новые task UI). Spec Kit check: 48 файлов PASS; diff --check PASS.
- Negative: author/kind/agentId/identity из клиента, чужой owner/scope grant, удалённый grant, чужой comment/task, неверные key/kind/unsafe id. Immutable stamp не меняется после отзыва; чтение не создаёт stamp.
- Serializer выдаёт только source/verified/principal.kind/key/id; подписанные claims/signature/identityHash/credentialId отсутствуют, новых логов нет. tools.js и task-principal.js не менялись.
- FR-006 PENDING: issuer481/head60b54e2e ещё использует agentId/credentialId; запрос согласования №68/448. Сквозной issuer admission и production не заявлены, задача не закрыта.
