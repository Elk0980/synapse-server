# CF9: обычная загрузка в библиотеку исходников
Процесс Spec Kit 1.0.0. Существующая библиотека, приватное хранение и manual-upload сохраняются.

## Требования
- FR-001. POST /content/telegram-sources/:company/upload принимает один файл, необязательную caption и metadata JSON без Telegram-настройки/provenance. Namespace upload/company/SHA создаёт сервер; клиент не задаёт chat/author/origin.
- FR-002. Metadata: platforms[]/formats[] множественные, [] означает «пока не выбрано»; occasion/eventDate/usageRestrictions/materialState source|ready. Типы/неизвестные поля/значения/повторы/неверные даты дают 400; порядок списков канонический.
- FR-003. Повтор stored SHA в компании возвращает прежний item с 200/duplicate=true без перезаписи подписи, metadata и происхождения. Другая компания изолирована. Квота считает уникальные файлы.
- FR-004. Безопасная миграция добавляет revision>=1/metadata старым записям. PATCH /:company/:id/metadata {revision,metadata:<partial>,caption?} защищён company/ожидаемой revision, stale 409; no-op не создаёт revision.
- FR-005. Чтение: owner либо company + autoposting.view. Upload/PATCH: owner либо company + autoposting.view/edit. CSRF и повторная свежая auth после async. Не изменять права пользователей.
- FR-006. Использовать реальные size/MIME/magic/quota/cleanup; private file route прежний. List добавляет uploadAllowed, limits, metadataVocabulary и новые поля item. Прежний manual-upload имеет прежний контракт.

## Ограничения
Единственный автор только telegram-sources.js/multipart.js, нового upload.test.js и четырёх документов 059 в source. Server/CRM/UI/QA/manifest/state readonly. Attach/context/batch UI не входят. Без сети, секретов, коммитов, публикации и новых агентов.
