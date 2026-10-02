# Существующие списки и проверенный дефект

Основа:08984a2e1bce85f914fa840ed2e194cc74fe31d6. Проверка локальная, без production данных.

| Список | Модель / источник | Связь |
|---|---|---|
| Кабинет Задачи | CRM tasks + task_coordination/task_dispatch | Канонические ID для Eva |
| Проектный чат кабинета | content project_chat_tasks | Выборочный API-assistant мост |
| Клиентская доска чата | chat client_tasks | Общего моста в изученном коде не установлено |
| board.synapsebusiness.ru | sites/board/index.html → board.json | Отдельный файловый список |

`ops/content/task-dispatch-worker.js` синхронизирует только rooms.api_assistant=1,
external_ref api-assistant:*, открытые project_chat_tasks. Связь — task_dispatch_links,
на стороне CRM task_dispatch_mirrors(room,source_id). Нельзя подменять CRM ID номером из чата.
Работа этого worker на production здесь не проверялась. В Eva явно указан источник CRM;
другие списки могут содержать ещё не связанные задачи. Полнота объединения неизвестна.

## Дефект source_ref

В `ops/crm/server.js` POST /tasks проверяет существование по source_ref без company_code/source.
Локальная fixture: task101 принадлежит alvi, source_ref='shared-ref'; запрос новой avokado
задачи с тем же ref возвращает200 duplicate:true и task101 alvi.
Воспроизведение: `node --test ops/eva-tasks/audit-source-ref.test.js`.
Исходный результат и контрольные суммы сохранены в [source-ref-before.md](source-ref-before.md).
По дополнительному поручению владельца внесено узкое исправление company_code + source + source_ref;
regression tests теперь проверяют корректное разделение областей и повторный ID внутри одной области.
Production достижимость прежнего дефекта и рабочие данные не проверялись.

В одном текущем процессе CRM SELECT/INSERT синхронны без await между ними; проверен повтор8 запросов.
Межпроцессную уникальность эта правка не заявляет. Перед будущей миграцией уникального индекса
надо проверить существующие коллизии только чтением. Ничего не удалять/перенумеровывать/сливать автоматически.

## Путь расширения

Сервер уже хранит revision/history координации, dispatch историю, lease и приёмку.
Будущий журнал вопросов/ответов исполнителей должен ссылаться на эти taskId и историю,
разделять completed/reviewed/evidence и текущие полномочия. Здесь не запускаются таймеры,
новые AI-рантаймы, автоназначение или постоянные исполнители Codex/Claude.
