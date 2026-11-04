# План — 101 task-point-a-b

Владелец: Claude (сессия задачи №60). Ветка `claude/task-a-b-20261104` от PR 482 (795d7d6).

## Существующие модули и контракты

- `ops/crm/task-coordination.js` — карточка задачи, ревизии, история, обработчик инструментов `/coordination/mcp/<name>`. Добавлены: перенос `pointAB` в `save`, вид `point_ab/acceptance_steps/progress`, действия `task_point_ab`, `task_step_close`, `task_step_reopen`, проверка перехода в done в `update` и `selfStatus`, `assertCanFinish` для сервера.
- `ops/crm/task-coordination-steps.js` (новый) — чистые функции: разбор описания, валидация, слияние, закрытие/открытие шага, формула процента, `assertTaskCanFinish(db,row)`.
- `ops/crm/server.js` — одна строка в PATCH старого CRUD задач: done проверяется той же функцией.
- `ops/crm/task-dispatch.js` — приёмка поручения проверяет шаги перед `status='done'`.
- `sites/synapse/cabinet/task-overview.js` — формула процента, `stepsText`, сумма шагов модуля.
- `sites/synapse/cabinet/task-board.js`, `task-board.css` — блок «Было | Будет», шаги, форма правки; версия ресурсов `cabinet.html`.

## Данные и миграции

Миграций нет: блок — ключ JSON в существующей `task_coordination.data`. Откат = удаление кода; сохранённый ключ игнорируется прежним кодом (прежний `save` его отбросит при следующем сохранении — отмечено как ограничение отката).

## Проверки

`node --test` наборы из `.github/workflows/task-board.yml` (+ новый `task-coordination-steps.test.js`), `task-dispatch*`, `node --check`, `gate.py check`, Playwright 1280/390 вне git.
