# План 194

Владелец изменения: Claude (claude.ai, Opus 5.5). Ревью — отдельный Claude-проверяющий.

## Существующие модули
- `ops/crm/agent-launch.js` — очередь запусков поверх `task_dispatch`, аренда, `reconcile` при каждом вызове. Добавлены: таблицы присутствия и передач, `presence`/`touch`/`workersStatus`/`handoff`, профиль ревью, `sweep()`.
- `ops/tasks-mcp/tools.js` — схемы MCP: `agent_launch` (профиль ревью), `agent_worker_update` (`presence`), новый `agent_workers_status` (20 инструментов).
- `ops/crm/server.js` — таймер `sweep()` раз в минуту рядом с таймером сторожа.
- `ops/crm/task-watchdog.js` — одна строка о передачах в сводке.
- `ops/content/agent-launch-local-worker.js` — сигнал присутствия, профиль ревью (`validateJob`, `prepareWorktree`, схема вердикта, `finishReview`).
- `ops/content/agent-launch-review-merge.js` (новый) — доверенные шаги git/gh: подготовка копии, ожидание CI, «КОД ПРИНЯТ», merge.
- `ops/content/agent-launch-child-mcp.js` — запрет «КОД ПРИНЯТ» от модели.
- `ops/content/agent-launch-worker-autostart.ps1`, `agent-launch-worker-run.ps1` (новые) — задача планировщика и запускатель с перезапуском.
- `sites/synapse/cabinet/task-board.js/.css`, `tasks.js` — индикатор.

## Данные и миграции
Только добавление: `task_dispatch_agent_workers`, `task_dispatch_agent_handoffs`, колонка `pr_number`, триггер неизменяемости профиля/PR. Старые запуски получают `pr_number=NULL` и прежнее поведение.

## Риски
- Слияние без человека: ограничено ветками `claude/`, базой `main`, точным head, зелёным CI, обычным merge без `--admin`; защита ветки GitHub продолжает действовать.
- Передача запасному останавливает только запуски без процесса (`queued`).
- PowerShell-скрипты не исполнялись в Linux-окружении автора; проверка — на ПК Влада (Codex).
