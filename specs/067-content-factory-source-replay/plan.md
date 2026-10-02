# План CF18

Единственный писатель Codex `/root/content_factory_batch_review`. Разрешены только ops/crm/autoposting.js, autoposting-source-links.test.js, content-factory-source-http.js/test.js и четыре документа этой спецификации. Остальные файлы, Content bridge, QA/manifest/state только чтение; bridge и его тест пишет root.

1. Зафиксировать свежее содержимое четырёх существующих файлов. Внести точечный новый lookup рядом с sourceAttachment, не менять attachSource.
2. Переиспользовать sourceAttachment и прежнюю сериализацию. SELECT request_payload/result по company_id/request_id; null при отсутствии,409 при несовпадении, сохранённый result с duplicate:true при совпадении. Ни invalidation, ни DTO чтения карточки.
3. Дополнить существующий закрытый handler точным source-attach-lookup. Edit/company/identity проверяются как attach до/после readJson; полный body валидируется lookup нормализатором. Общие service-key guards и browser block уже существуют и не меняются.
4. Проверить чистоту SQL через total_changes(), INSERT/UPDATE/DELETE запрещающие triggers и stale info revision, которую get/invalidate изменили бы. Проверить receipt после ручной правки/архивации, нормализацию, conflicts, null/другую компанию/неверный body.
5. Проверить HTTP status/response/no-store/edit guards/fresh actor/exact routes. Выполнить существующую локальную regression, converge, сохранность исходного содержимого и финальные SHA; остановить запись.

DTO lookup: null | {companyCode,duplicate:true,post:<original full DTO>,link:<original link DTO>}. HTTP: {companyCode:<lowercase>,receipt:<lookup result>}. Actor не принимается из body и не нужен read-only модулю. Для stale revision без квитанции Content root сохраняет409.
