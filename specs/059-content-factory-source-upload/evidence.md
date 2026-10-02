# Свидетельства CF9
Прочитаны местные AGENTS/policy/constitution, процесс 1.0.0, source integrity; AGENT-ECONOMY прочитан ранее. До кода создан пакет и передан DTO координатору.
Основа HEAD 4367133fac78fcfc7d1a401060c74cac8bc935f6, целевые два файла clean. SHA до изменения: telegram-sources.js 7C80A6AC50FEEA5EC2F169C0CD7D74E20E580F390BEA860FF0B2003D1EE4DFB6; multipart.js 26A015D260B90B2FD3DD3A0670B4C3B87322B4BCF589B4AC53ADFF555EDE9A05.
## Реализация и контракт
Изменены только два разрешённых существующих модуля, создан upload.test.js и четыре документа 059. Производственные server/CRM/UI/QA/manifest/state не менялись.

- POST `/content/telegram-sources/:company/upload`: multipart `file`, необязательные `caption` и `metadata` (строка JSON). Metadata по умолчанию `{platforms:[],formats:[],occasion:'',eventDate:'',usageRestrictions:'',materialState:'source'}`. Ответ `{item,duplicate}`: 201 новый, 200 stored SHA своей компании уже существует. Существующий item возвращается целиком; его caption/metadata/Telegram происхождение не перезаписываются.
- Серверный namespace: `chat_id='upload:'+company`, `message_id=SHA`, `import_method='upload'`, `imported_by` берётся из актуальной сессии. Клиентские chat/author/origin/telegramUrl обычная загрузка отвергает.
- PATCH `/content/telegram-sources/:company/:id/metadata`: JSON `{revision,metadata:<partial>,caption?}`. Revision — положительное целое; 409 при устаревшей версии, 404 для id вне компании. `[]` сбрасывает выбор, пустые строки сбрасывают текст; no-op сохраняет revision. Изменение повышает revision на один. Прежний manual-upload остаётся owner-only и при повышении существующей карточки также повышает revision.
- List DTO: прежние поля + `uploadAllowed`, `limits:{maxFileBytes,storageLimitBytes,mimeTypes[],extensions[],maxFiles:1}`, `metadataVocabulary:{platforms:[{id,label}],formats:[{id,label}]}`. Каждый item получает `revision` и полный `metadata`. Пустой выбор означает «пока не выбрано», без обязательного выбора площадки/формата.
- Read: прежний company scope + autoposting.view, owner с прежним исключением. Upload/PATCH: scope + view/edit, CSRF до чтения и повторная актуальная auth/CSRF после async. Права пользователей не изменяются.
- Старым записям миграция добавляет revision=1 и пустые metadata. Приватный file route прежний. MIME/magic/размеры/индивидуальные квоты/stream cleanup переиспользуются. Upload не требует включённого/привязанного Telegram-источника.

Content Dockerfile копирует только ops/content/*.js: production vocabulary локален, новый тест сравнивает ключи и подписи с действительными CRM CAPTION_PLATFORMS/FORMATS. CRM runtime-зависимости не добавлены.

## Лично выполненные проверки
- `node --test ops/content/telegram-sources-upload.test.js`: exit 0, 7 tests / 7 pass / 0 fail, duration 1007.3399 ms. Проверены отключённый Telegram, editor/owner upload, приватное скачивание и SHA, restart, list/vocabulary, дедупликация обычного и Telegram файла без переписывания происхождения, компания, defaults старой БД, PATCH/reset/no-op/revision409, неизвестные поля/значения/типы/повторы/даты, size/MIME/magic/quota/multipart cleanup, отсутствие сессии/view-only/edit-only/CSRF, отзыв прав/сессии после async.
- `node --test ops/content/telegram-sources-manual.test.js`: выполнен ровно один раз; exit 0, 5 tests / 5 pass / 0 fail, duration 4621.7048 ms. Включены потоковые 68 935 123 байта и архив 170 МБ, прежние provenance/owner/CSRF/лимиты/компании/restart.
- `git diff --check -- ops/content/telegram-sources.js ops/content/telegram-sources-multipart.js`: exit 0, замечаний нет.

## Converge / ограничения
FR-001–006 закрыты выделенным backend пакетом и синтетическими проверками. Реальный HTTP transport, browser/DOM, клиентский batch/attach/context, production config/хранилище, Telegram/API, публикация и deploy не проверялись и не заявляются. Отдельный attach/context контракт и UI остаются у координатора. Серверную миграцию/лимиты оценит координатор при интеграции; дополнительного deploy разрешения пакет не даёт. SHA-256 семи конечных файлов переданы в финальном отчёте (не включены внутрь evidence, чтобы избежать self-hash).
