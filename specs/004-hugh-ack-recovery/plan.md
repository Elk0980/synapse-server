# План

Единственный исполнитель Codex по прямому разрешению владельца. Отдельная ветка codex/hugh-ack-recovery. Production-ресурс не захвачен, перед выпуском проверить владельца. Клиентские материалы не включать в репозиторий.

Изменения: ops/content/hugh-fallback.js (текст), ops/content/project-chat.js (выбор ожидающих обращений и запись уведомления), ops/content/hugh-fallback.test.js и hugh-continuity.test.js. Node.js, SQLite, текущая транзакция tx и outbox.

Добавить таблицу project_chat_acknowledged_jobs(job_id PRIMARY KEY REFERENCES project_chat_ai_jobs ON DELETE CASCADE, ack_message_id REFERENCES project_chat_messages). Хранить факт созданного уведомления, а не факт решения вопроса. CREATE TABLE IF NOT EXISTS совместим с существующей БД. Старый cooldown остаётся. При обновлении восстановить связи старых уведомлений только по точному прежнему системному шаблону, автору hugh/assistant, компании и порядку сообщений; чужие и частично совпадающие тексты не использовать. Это не изменяет сами сообщения или состояние доставки. Подтверждённый ответ владельца подавляет уведомление только при совпадении company и chat, source message id < reviewed message id, outbox sent и непустой квитанции external_ids.

Порядок: регрессионные тесты до изменения; схема/текст/выбор; целевые тесты и Spec Kit gate; проверка соответствия через converge; PR. Развёртывание и живую генерацию фиксировать отдельно от локальных тестов.
