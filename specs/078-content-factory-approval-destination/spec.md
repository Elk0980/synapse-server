# CF28 — согласование назначения публикации

Spec Kit 1.0.0. Контракт root согласован 01.10.2026; исполнитель Codex.

## Сценарии и приёмка

1. После согласования канала A смена назначения на B, провайдера либо ключа подключения требует нового решения перед новым расписанием. Возврат A→B→A не возвращает старое согласование.
2. Отображаемое имя, check и включение прежнего назначения сами по себе не снимают согласование. Неподключённый канал по-прежнему не публикуется.
3. Согласование версии данных компании 1 не разрешает постановку после минимальной правки только profileRevision на 2.
4. Гонка настроек во время ожидания и ошибка записи полностью откатывают новую постановку/согласование; ранее назначенная очередь сохраняет прежние delivery guards.

## Требования

- FR-001. Сохранённая монотонная версия назначения растёт только при смене канонической цели, провайдера или фактического ключа. Сравнение того же ключа выполняется внутри transport без раскрытия. Имя/enabled/check/display label не меняют эту версию.
- FR-002. Согласование каждой площадки атомарно связывает content revision, profile revision карточки и версию назначения. Решение manual/offline без binding допустимо только как решение по содержимому.
- FR-003. NEW schedule требует актуальный binding; null legacy/manual или stale destination409 APPROVAL_DESTINATION_CHANGED, stale approved profile409 APPROVAL_PROFILE_CHANGED. После await settings внутри транзакции проверяются актуальные binding, company profile и фактическая channel revision перед INSERT. Stale settings409 CHANNEL_CHANGED, без обхода через approveAndSchedule.
- FR-004. Старые queued/publishing записи не отменяются массово и не требуют нового binding в drain. Нынешние content/plan/profile/channel revision/beforePublish guards сохраняются.
- FR-005. Internal sync adapter возвращает только destinationRevision/channelRevision; Promise/invalid данные отклоняются для binding. Public settings/HTTP body не расширяются. DTO не раскрывает назначения/ключи; stale binding отражается пригодностью согласования новой постановки.
- FR-006. Bindings и destination revision переживают restart/migration, company scoped. Проверки включают failing старый случай, reconnect/ABA/rename/profile-only update, partial platforms, rollback и async race, legacy очередь и изоляцию.

## Успех и ограничения

Все синтетические negative scenarios предотвращают новую доставку; положительный rename/same-token сценарий сохраняет согласование. Нет сети/live/production/UI/секретов/прав/commit/push/deploy/новых агентов. QA/state/manifest/server/socialstats и другие файлы readonly. Исправление не является production проверкой.
