# HTTP завершения Контент завода

Spec Kit 1.0.0. Root подключает принятые storage/operations к существующему серверу, без новых прав/выпуска.

- FR-001 Создать один workflow factory, подключить к createAutoposting, generation service и media-mentor handler. Записанный manual запрещает новые назначения расписания; прежнее явно назначенное расписание не отменяется этой настройкой.
- FR-002 GET /autoposting/posts/:id/history читает cursor history; POST /autoposting/posts/:id/variants создаёт независимый черновик через CF20. Ответ no-store, created201/replay200.
- FR-003 Использовать существующие trusted companyModuleContext/autoposting.view/edit, свежую identity после чтения body. Body не задаёт scope/actor; client proxy использует существующую CSRF.
- FR-004 Запретить недопустимые методы/курсор/чужой scope/revoked access до mutation. Не обходить прежние mentor approval guards.

Приёмка: actual temporary CRM и Content HTTP с настоящей синтетической сессией, изоляция/права/CSRF/подмена identity/повтор после потерянного ответа/история более30/настройки/revision. Контроль Content transport добавляется в существующую fixture content-factory-inputs-proxy.test.js, без второго полного стенда. Production/live client API/секреты/сообщения/правила доступа/commit/push/deploy не меняются.
