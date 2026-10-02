# Свидетельства CF20

До кода прочитаны правила Spec Kit 1.0.0, AGENT-ECONOMY и ограничения ownership. Root подтвердил DTO, дополнительный optional workflow guard и промежуточный отказ legacy plan-linked источникам: перенос без новой версии плана обходил бы связь с конкретной согласованной площадкой.

## Реализовано

- history(id,code,options) — чистый scoped SELECT, текущая contentRevision и страницы всех записей autoposting_reviews по id DESC. Default30/max100, limit+1, строгий before, явные hasMore/nextBefore; архив читается. Прежний краткий history в detail DTO не изменён.
- createVariant(id,code,body,actor) — одна транзакция child/link/platform pending review/receipt. Сохранённые source revision/content revision и rootIdea доступны в post.variantOf/rootIdea; обычная карточка имеет null. Ключ company/request и canonical source/revision/platform payload восстанавливают первоначальный post DTO до проверки текущего исходника. Первая created:true, повтор created:false; changed payload409.
- Новый draft с одной штатной площадкой, без schedule/day/approvals/deliveries/external receipts/старых review comments. Копия title/text/media/format/role, только target caption/options. Сохранены прежняя profile_revision/timezone и media SHA/expected-file guards; источник и другие карточки не пишутся. Нет get/invalidate/information.get при создании или replay. Наличие server-owned связи сохраняет обязательность собственного согласования после очистки captions/dayKey.
- Optional workflow.get(code): configured:true/manual даёт409 WORKFLOW_MANUAL_MODE до ожидания settings и повторно в schedulePrepared внутри транзакции. Только новое schedule/approveAndSchedule; прямое approve/createVariant и ранее назначенная очередь сохраняют поведение. Отсутствующий adapter/unconfigured совместимы с прежним API. workflow.js/server wiring не изменены.
- Legacy plan-linked source явно409 PLAN_LINKED_POST. Mentor/transfer не изменены; копия старого plan approval и обход planLink не добавлены.

## Собственные локальные проверки 01.10.2026

- Targeted: 16/16, exit0, Node v24.18.1; synthetic memory SQLite и injected transport без сети/live API.
- Regression: 163/163, exit0. Семь наборов: autoposting.test.js, autoposting-recovery.test.js, autoposting-review-batch.test.js, autoposting-source-links.test.js, content-factory-source-http.test.js, autoposting-variants-history.test.js, media-mentor-transfer.test.js.
- История: 145 событий всех семи action, interleaved чужие события и ошибочная чужая company row с тем же postId, default/max/последняя страница/пустая карточка/строгие limits. query_only ON, information.get и db.exec запрещающие заглушки, total_changes/полные снимки/transaction state неизменны. Архивная scheduled карточка со stale profile не актуализировалась.
- Новая версия: согласованный источник и соседняя карточка побайтно по SQL-строкам прежние; опубликованный исходник и его deliveries сохранены. Отдельный draft, разрешённые поля, отсутствие старых согласований/истории/доставок; media-only Story сохраняет свои options, включая false. Реальное обновление synthetic company profile доказало сохранение прежнего profile revision. Цепочка потомков сохраняет rootIdea и фиксирует непосредственную source contentRevision.
- Два refusal triggers BEFORE INSERT на link и receipt доказали rollback child/link/platform reviews/receipt вместе. Snapshot всех затронутых таблиц прежний, транзакция закрыта.
- Replay после ручной правки и архивации source/child и пересоздания API вернул первоначальный DTO; information.get запрещён, total_changes/снимки неизменны. Company keys изолированы; changed source/revision/platform409; неверный body400, foreign404, stale/archive/legacy guards409 без ребёнка.
- Очистка captions/dayKey не разрешила schedule до собственного approve; после отдельного решения новый child назначился, source approval сохранилось. Ручной workflow запретил обе новые постановки до settings без записи; смена во время await остановила schedule и откатила approveAndSchedule вместе с решением/историей. Unconfigured manual сохранил постановку; ранее назначенный synthetic post после переключения в manual отправился прежним drain.
- Обратное удаление только 11 собственных patch hunks восстановило полное исходное autoposting.js (нормализован лишь CRLF). Прежние функции и чужие изменения сохранены; git diff --check без ошибок. Spec Kit gate status=ok, verifiedFiles48; gate подтверждает процесс, не runtime.

## Converge и ограничения

FR-001–007 сведены с локальными проверками; незакрытых требований ограниченного пакета не найдено. Legacy plan-linked адаптация остаётся зависимым пакетом root и не считается приёмкой полной схемы. HTTP/server/UI integration, актуальная роль/CSRF и production не проверялись здесь и принадлежат root. DTO/module-only tests не доказывают подключение маршрутов. QA/state/manifest и чужие файлы не записывались. После окончательных шести SHA запись остановлена.
