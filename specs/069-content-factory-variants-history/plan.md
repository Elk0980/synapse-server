# План CF20

1. Сохранить свежее содержимое autoposting.js. Переиспользовать company/rowFor, normalized, transaction и существующую политику согласования, не менять внешние методы.
2. Создать отдельные server-owned таблицы происхождения и request receipt. Источник и root принадлежат выбранной компании; child/receipt записываются в одной BEGIN IMMEDIATE транзакции. Receipt сохраняет полный первоначальный DTO; повтор возвращается до чтения source/current profile.
3. Добавить variantOf/rootIdea в DTO. requiresApproval учитывает наличие связи независимо от редактируемых признаков очереди. Новый draft копирует только разрешённые поля с прежней profile revision, сохраняет SHA guards и одну площадку; родителя не пишет. Plan-linked guard сохраняет безопасный отказ.
4. Экспортировать readHistory как history, сохранив приватную функцию записи history. SELECT limit+1, company/post scope, строгие options; без DTO/get/invalidate.
5. Проверить синтетическим memory SQLite: чистоту истории, страницы/курсор, чужую/архивную карточку; атомарный rollback link/receipt triggers, исходник без изменений, обязательное новое согласование после очистки captions/dayKey, публикацию только после решения, цепочку происхождения, company/revision/plan/archive/body guards и durable replay после ручных правок/архива/API restart.
6. Принято дополнение root: optional workflow.get(code), ранний manual-mode guard до awaited settings и повтор в schedulePrepared. Проверить отказ без записи, rollback approveAndSchedule при смене режима во время ожидания, unconfigured и ранее назначенную очередь. Не менять processDue/drain и workflow.js/server.
7. Выполнить targeted и существующие regression suites, diff/source-integrity, Spec Kit converge/gate, финальные шесть SHA; остановить запись. Root интеграция и новая plan-linked адаптация отдельны.

Две таблицы: autoposting_variant_links (child, company, immediate source revision/content revision, original root revision, target, creation provenance) и autoposting_variant_requests (company/key/canonical payload/child/original result). В API нельзя менять или подавать произвольную связь.
