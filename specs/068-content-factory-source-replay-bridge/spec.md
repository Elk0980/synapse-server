# Восстановление прикрепления после изменения сведений исходника

Spec Kit1.0.0,01.10.2026. Полная схема Влада требует восстановления неизвестного результата. Root пишет только Content bridge/test и HTTP integration fixture; CF18 агент отдельно пишет CRM067. No live/production/secrets/permissions/messages/commit/push/deploy.

- FR-001. Если ответ прикрепления потерян, последующая правка только metadata исходника не должна скрыть уже сохранённую квитанцию. При несовпадении sourceRevision выполнить только закрытый чистый CRM lookup по исходному нормализованному payload/key.
- FR-002. Для lookup сервер строит immutable pointer из фактической своей записи: id,ожидаемая исходнаяrevision,sha256,deterministic publishing URL. Клиент не задаёт SHA/URL. Lookup не читает/создаёт delivery файл и не запускает новое прикрепление.
- FR-003. Найденная квитанция возвращается первоначальной duplicate:true, с guard текущей компании/личности/CSRF/edit до и после async. После неё интерфейс отдельно получает свежую карточку. Нет восстановления прав/архивного состояния или публикации.
- FR-004. Отсутствие квитанции при stale sourceRevision сохраняет409, changed payload/key409, чужойscope403/404. Свежаяrevision требует прежних ready/MIME/file/magic/SHA/size checks, старое поведение не ослабляется. Настоящее несовпадение файла не объявлять новой доставкой.
- FR-005. Тесты: lost response→metadata changed→repeat returns original afterrestart/manualcardedit; no row/copy/DBchange on replay; stale newkey/changedpayload/revocation forbidden; real closedHTTP key/identity/body and browserinternal boundary. Авторский report не заменяет root run.
