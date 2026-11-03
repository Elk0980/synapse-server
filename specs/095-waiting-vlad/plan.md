# План реализации

SpecKit1.0.0. Root — интеграция/проверка/PR; один backendписатель task-coordination.js/task-waiting.js/tests, один UIписатель task-overview.js/task-board.js/css/tests. Ни один не меняет auth/tasks-mcp/server.js/схему. Разделение файлов не является productionlease.

CRMtasks_list overview:true добавляет ограниченный descriptionpreview1000Unicodecodepoints/truncatedflag, created_at, coordination.blocker/nextAction/updatedAt и waiting_since. Обычный summary сохраняется. Fulltask_get остаётся источником полного описания. UIограниченно загружает недостающие/обрезанные данные при старом сервере, не делает N+1для обычной новой краткой выдачи.

waiting_since читается только для текущих ожидающих задач из существующей immutablehistory. Подтверждённый переход false→true начинает текущую непрерывную цепочку; пропуски, недостоверные даты, повреждения и неоднозначное legacyназначение дают null. updated_at не выдаётся за дату начала. Нет записей или DDL на чтении.

Чистый UIhelper строит производную модель целей/направлений/состава/процента. task-board добавляет сводку и отдельный ответ владельца, сохраняя прежние формы и защиту черновиков/unknownresponse/CAS. Rootподключает helper перед board, обновляет ресурсную версию.

Проверки: новые backend/helper/UIрегрессии, прежние tasks-mcp тесты без правок, owner/nonowner/foreignproject/старые summary, синтаксис, diff/секреты/SpecKit. Браузер для desktop/390 был доступен на inventory, затем прямо остановлен guardURL; альтернативами запрет не обходить. Подготовить PRс честным перечнем выполненного и недоступной визуальной проверки.
