# CF24 — выборочный перенос legacy версии идеи

Spec Kit 1.0.0. Ограниченный контракт root согласован 01.10.2026. Исполнитель Codex.

## Сценарии

1. У одной идеи согласованы две площадки. Выбор одной создаёт ровно её draft; соседние версии и ранее созданные карточки не изменяются.
2. Повтор выбранной версии после ручной правки или архивации карточки возвращает существующую расписку, не создаёт и не восстанавливает карточку.
3. Смена плана/брифа/профиля/согласования между чтением и записью отклоняет перенос. Отзыв прав или смена личности во время JSON чтения запрещает решение/перенос.

## Требования

- FR-001. post.planLink: null | {ideaId,platform,contentRevision,planRevision,briefRevision}, только scoped existing plan.linkOf(postId,companyId). Не угадывать происхождение по origin/meta/day/source links. createVariant PLAN_LINKED_POST409 и прежние guards сохраняются.
- FR-002. transferVariants body exact {planRevision,briefRevision,selection?:{ideaId,platform,contentRevision}}. Selection — полный строгий объект; идея и площадка из текущего плана, contentRevision положительный safe integer. Invalid/unknown/missing fields400; unknown idea404; unknown platform400; stale content409 STALE_VARIANT. Пустая/исключённая версия409 VARIANT_NOT_APPROVABLE, неутверждённая409 VARIANT_NOT_APPROVED. Нельзя молча пропустить выбранную версию или перенести соседнюю.
- FR-003. Без selection сохранять batch. С selection проверки пригодности topic/title относятся только к выбранной идее; неподходящий сосед не блокирует её. Повторно проверить текущую выбранную версию и одобрение внутри существующей транзакции вместе с прежними plan/brief/profile checks. Draft/immutable plan-link записываются атомарно; новых схем, clone плановой карточки, согласований или очереди нет.
- FR-004. Идемпотентность по прежней unique(company,idea,platform,contentRevision). Selected skipped содержит postId, cardStatus и archivedAt из текущей scoped строки, без get/update/восстановления карточки. Старый batch skipped DTO не расширять. Не перезаписывать ручную правку/архив и не копировать approval.
- FR-005. В двух variants decision/transfer POST после readJson повторить trusted company/edit context и проверить неизменность userId. Decision требует owner как до чтения, так и fresh owner после. Transfer сохраняет прежнее edit право. Actor берётся только fresh trusted identity; body не расширяет права.
- FR-006. Прежние platform-specific/current-plan/current-brief/profile и schedule/drain/beforePublish guards сохраняются. Изменение текста версии и отзыв согласования по-прежнему останавливают отправку.

## Границы

Разрешены только ops/crm/autoposting.js (planLink DTO), media-mentor-transfer.js (selection), media-mentor-http.js (два fresh guards), новый media-mentor-legacy-adaptation.test.js, existing media-mentor-http.test.js при необходимости и четыре документа specs074. Остальные файлы/QA/state/manifest/shared только чтение. Нет агентов/браузера/сети/live/production/секретов/commit/push/deploy. Legacy UI root выдаёт отдельно после приёмки backend; здесь его нет.
