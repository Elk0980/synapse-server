# CF20 — связанный черновик площадки и полная история согласования

Spec Kit 1.0.0. Исполнитель Codex. Ограниченный контракт согласован root 01.10.2026 до реализации.

## Сценарии

1. Редактор создаёт отдельную адаптацию своей карточки для площадки. Исходная карточка, её история, публикации и согласования остаются прежними; новый черновик требует своего согласования.
2. После потери ответа повтор того же запроса возвращает сохранённый первоначальный post DTO, даже если исходник или новая карточка изменены/архивированы. Изменённый запрос под тем же ключом запрещён.
3. Владелец читает историю согласования полностью, страницами, включая старые решения и архивную карточку. Чтение не меняет состояние.

## Требования

- FR-001. history(id,code,{before?,limit?}) возвращает {companyCode,postId,contentRevision,items:[{id,action,contentRevision,comment,actorName,createdAt}],hasMore,nextBefore}. Только SELECT; limit по умолчанию 30, диапазон 1–100, before — положительный safe integer. Порядок id DESC; nextBefore — последний выданный id только при hasMore, иначе null. Проверять компанию как карточки, так и записей истории; архив допустим.
- FR-002. createVariant(id,code,{revision,clientRequestId,platformId},actor) возвращает {companyCode,created,post}. Только указанные поля; ключ 8–100 ASCII букв/цифр/_/-, revision положительный safe integer, platformId одна из семи штатных площадок. Разрешена отдельная адаптация площадки, уже выбранной исходником. Архивный исходник запрещён; опубликованный разрешён.
- FR-003. Атомарно создавать отдельный draft, server-owned связь и durable receipt. Первая попытка created:true; повтор того же company/key/canonical payload created:false с первоначальным post. Changed source/revision/platform payload под тем же ключом 409 REQUEST_CONFLICT. Повтор проверять до чтения текущего исходника и его guards.
- FR-004. post содержит variantOf:{postId,revision,contentRevision}, rootIdea:{postId,contentRevision}; у обычных карточек оба null. Потомки сохраняют первоначальный rootIdea. Копировать title/text/media, format/role, caption/options только выбранной площадки; сохранить source profile_revision/timezone и media SHA/expected-file guards. Не копировать day/schedule/approvals/review comments/deliveries/external receipts.
- FR-005. Связанный черновик требует нового отдельного согласования во всех компаниях. Очистка captions/dayKey и правка площадки не снимают это требование. Исходную карточку и другие карточки не изменять; не вызывать get/invalidate для создания или replay.
- FR-006. Legacy plan-linked источник отклонять 409 PLAN_LINKED_POST: новая версия плана с собственным согласованием требует зависимого mentor/transfer пакета. Старое согласование и связь плана не копировать; planLink guards не обходить. Это промежуточное ограничение, не приёмка полной схемы.
- FR-007. Optional server-owned workflow adapter в createAutoposting: configured:true с fields.releaseMode='manual' запрещает только новое schedule/approveAndSchedule, 409 WORKFLOW_MANUAL_MODE. Проверка до ожидания settings и повторно внутри schedulePrepared после ожидания. Без adapter или при unconfigured прежнее поведение сохраняется. Согласование без постановки, уже назначенная очередь/drain/processDue не меняются; workflow.js и server wiring пишет root.

## Границы

Единственный писатель: ops/crm/autoposting.js, новый autoposting-variants-history.test.js и четыре документа specs/069-content-factory-variants-history. Остальные файлы, QA/state/manifest только чтение. HTTP/server/UI integration выполняет root после сдачи. Нет live/production/сети/секретов/прав/client messages/commit/push/deploy.
