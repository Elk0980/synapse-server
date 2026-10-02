# План CF5
1. До кода закрепить миграцию nullable archived_at/archived_by и DTO archive в отдельном согласованном контракте; статус cancelled не переиспользовать как архив.
2. В autoposting.js отдельный guard активной карточки для команд; чтение истории и restore допускают архив. Перечислить все обходящие rowFor SQL пути.
3. Транзакции archive/restore, проверка deliveries/provider ids/receipts. При любой неопределённости отказ, без внешнего reconcile.
4. CRM HTTP explicit whitelist archive/restore и отдельный archive list; content proxy сохраняет edit/company/CSRF. Worker SQL, calendar, list, reorder, import требуют явного покрытия.
5. content-plan-drafts сохраняет mapping и возвращает архивное состояние существующей карточки.
6. Разрешённые файлы: ops/crm/autoposting.js, отдельный recovery helper при необходимости, content-plan-drafts.js, server.js и соответствующие backend/HTTP/proxy тесты. sites не менять. CF4 snapshot/QA не менять. Интеграция в QA только после доказательств и обновления manifest.
7. Ограниченные проверки по FR, Spec Kit gate/converge, manifest+delta. Передать Claude UI-контракт отдельно после CF4.
8. Уточнение после CF5ревью: сохранять original_title/marked_title связанной задачи в autoposting_recovery_task_marks; пометка и её условное снятие в той же транзакции. Не менять статус, назначение и срок. При повторном импорте передавать archivedAt/пояснение без восстановления.
