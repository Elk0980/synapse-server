# CF11 — прикрепление файла из библиотеки через существующие службы
FR-001. Authenticated POST /content/telegram-sources/:company/:id/attach принимает только clientRequestId/sourceRevision и существующий postId/revision либо newPost. Требуются текущие company scope/autoposting.view+edit и CSRF; клиент не задаёт provenance/URL/SHA.
FR-002. Только stored исходник metadata.materialState=ready; реальная готовность файла, SHA и существующие publishing MIME/size limits проверяются сервером. Приватный original остаётся в библиотеке. Доставка копируется в существующий publishing namespace своей компании.
FR-003. Content передаёт серверный source tuple в закрытый CRM маршрут. CRM atomic attach/usage реализует Spec060. Browser CRM proxy не пропускает internal routes; module context проверяет identity/company.
FR-004. GET usage требует view своей компании, отдаёт реальные current/historical связи и archive flags без записи.
FR-005. Потеря CRM ответа не создаёт новый файл при повторе; CRM request key определяет единственный commit. Не обещать единую транзакцию двух БД. Никаких публикаций/согласований/расписания, никакой работы с живой сетью в проверках.
Полная цель сохраняет контекст генерации/статистику отдельным следующим пакетом. Эта спецификация их не объявляет реализованными.
