# CF22 — workflow в контексте будущего плана и HTTP

Процесс Spec Kit 1.0.0. Контракт утверждён root; пакет только интегрирует сохранённые настройки CF21, не исполняет публикации.

## Сценарии

1. Новая генерация с optional workflow dependency получает неизменяемый снимок настроек своей компании. Правка workflow после старта не меняет уже созданное задание. Повтор idempotency key возвращает это задание без новых чтений.
2. Настройки изменились между чтением и enqueue: отказ 409/INPUTS_CHANGED, без смешанного снимка и без новой задачи. Старые jobs/service без workflow работают как раньше.
3. Worker сообщает модели пожелания часов/сроков/режима без publisherName/actor/PII; не назначает время публикации/срок существующей задачи. Поддельный или некорректный queue snapshot отклоняется до provider API.
4. GET/PUT workflow использует existing company/view/edit guard, trusted actor, no-store. После async JSON повторяется context; потеря доступа/смена личности не сохраняет настройки. CSRF принадлежит существующему content-service bridge; новый bypass не создаётся.

## Требования

- FR-001. createContentPlanService({mentor,jobs,workflow?}) при наличии workflow.get(code) добавляет snapshot.inputs.workflowRevision и snapshot.workflow={companyCode,revision,configured,fields:{releaseMode,hours,preparationDays,reviewDays}}. Whitelist исключает publisherName/actor/approverRole и любые другие поля полного workflow DTO. Без dependency оба поля отсутствуют.
- FR-002. Snapshot companyCode соответствует компании задания, revision/configured взяты из CF21; fields deep-copy. Перед enqueue повторный workflow read и revision check вместе с brief/profile/month. Изменение ->409/INPUTS_CHANGED. Idempotent lookup остаётся раньше всех reads.
- FR-003. Queue workflow строго exact schema: companyCode/revision/configured/fields; fields только четыре operational поля. Company spoof/unknown fields/missing fields/coercion запрещены. revision safe >=0, configured boolean соответствует revision>0; unset revision0 имеет CF21 defaults. Часы <=24 unique exact HH:MM, дни integer0..30, режим exact manual|scheduled. inputs.workflowRevision совпадает snapshot.workflow.revision. Неверный snapshot ->INVALID_RESULT до authorize/provider generate; старый snapshot без workflow не требует поля revision.
- FR-004. Provider prompt содержит только sanitized operational workflow и объясняет configured=false, manual/scheduled, пожелания часов в timezone проекта и сроки планирования. Ни часы, ни scheduled не назначают автоматически отправку, согласование или due_date. Формат результата прежний; нет нового scheduling поля.
- FR-005. createMediaMentorHandler принимает optional workflow. Строго GET/PUT /media-mentor/workflow: view/edit через existing companyModuleContext, missing dependency501, неподдерживаемый метод405. PUT после readJson повторяет edit context, запрещает смену userId, actor только fresh trusted identity. JSON validation/revision/active company — существующий CF21 module. Ответ200 cache-control no-store.
- FR-006. Не менять server/autoposting/permissions/UI/QA/state/manifest, не подключать worker/env/таймер, не отправлять сообщения/публикации/сеть/live. Root wiring HTTP/factory/snapshot и CF20 schedule guard — отдельные пакеты.

## Приёмка

- SC-001. Реальная synthetic SQLite service + CF21: immutable snapshot без имени/актора, scope, configured defaults, changed revision race409, replay и missing dependency compatibility.
- SC-002. Worker prompt и synthetic provider получают operational поля; private names отсутствуют. Unknown/spoof/type/ref mismatch ->INVALID_RESULT, authorize/provider не вызваны; old job succeeds.
- SC-003. HTTP synthetic guard + real CF21: view/edit/company/actor/no-store/malformed/method/missing/revision; missing CSRF и revoke/identity swap during async JSON -> отказ без save.
- SC-004. Запущены только три затронутых тестовых файла. Переданы 10 окончательных SHA (6 существующих JS/test и 4 новых docs); запись остановлена.

## Область

Только ops/crm/content-plan-service.js/.test.js, content-plan-worker.js/.test.js, media-mentor-http.js/.test.js и новые specs/072-content-factory-workflow-context/{spec,plan,tasks,evidence}.md в source CONTENT_FACTORY_CF2_CODEX_20261001. Прочие existing files readonly. Без новых агентов/production/секретов/commit/push/deploy.
