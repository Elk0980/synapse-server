# План CF8

1. Взять схемы fixtures существующих runner/project-chat/owner-alerts тестов. CRM memory SQLite и отдельная файловая content SQLite в временном каталоге; реальные jobs/dispatch/runner/queue/chat, только transport подменён.
2. Использовать действительный GET project-chat route с auth-store для представления владельца и изоляции компаний/участника. Внешние fetch запрещены fixture.
3. Fault injection только в подменённом CRM HTTP: потерянный ack до/после обработки. Вставка уведомлений производится runner.sync, не вручную.
4. Квитанция Telegram синтетическая через настоящий bridge. Закрыть и открыть файловую content БД для проверки uncertain без слепого повтора.
5. Для optional DOM читать sites общей QA через CONTENT_PLAN_NOTIFICATIONS_UI_SOURCE, jsdom через уже имеющийся NODE_PATH. Никаких установок или изменения UI.
6. Запустить только новый тест; зафиксировать реальные результаты, ограничения, converge и SHA пяти файлов. Владелец нового теста и пакета — назначенный агент Codex, интеграция — координатор.
