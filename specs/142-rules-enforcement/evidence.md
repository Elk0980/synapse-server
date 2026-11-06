# Свидетельства 142-rules-enforcement

Дата: 05.11.2026, worktree `claude/rules-enforcement-142` от origin/main e947e251.

## Реализовано (локально)
- `node --test ops/crm/task-rules.test.js` — 5/5: разбор якоря; 409 без якоря / с устаревшим кодом / до session_start;
  Влад не ограничен; `accepted` не требует якоря; «проверено» исполнителем → 409; без 390/1440 → 409;
  «готово» без «проверено» → 409, с `codeRequired=false` — проходит; `task_create` без полей → 422, «Модуль ·»/«Цель ·» —
  без проверки; observe: 0 отказов, 5 «отклонено бы», строки сводки.
- `node --test ops/tasks-mcp/rules-http.test.js` — 2/2 (настоящие CRM + tasks-mcp): session_start сохраняет
  `rules_revision` в CRM; `rules_anchor` в `task_get` (missing → stale → ok); 409/422 с текстами; владелец из кабинета
  создаёт и ставит без ограничений; «проверено» другим агентом с тремя ссылками принято; сводка
  `/coordination/watchdog` содержит «Не по правилам», «Отклонено (отказы)», `rules.current.code`; observe — проходит
  всё, «Отклонено бы (наблюдение, за сутки): 2».
- Полные наборы серийно (`--test-concurrency=1`): `ops/crm/*.test.js` — 1062/1065 (3 падения не связаны с задачей:
  `email-campaigns`, `media-mentor-http` (нет модуля `fflate` в окружении), `reel-plan-file`; файлы в PR не менялись);
  `ops/tasks-mcp/*.test.js` — 111/111.
- `python3 tools/spec-kit/gate.py check` — verifiedFiles 48, без ошибок.

## Не сделано в этом PR
- Подключено / проверено на боевом — нет (без merge и выпуска). После выпуска сторож в observe покажет в сводке
  раздел правил; переключение в enforce — `TASK_WATCHDOG_MODE=enforce` по решению Влада/оркестратора.
- Текст RULES v1.8/1.9 и карта на сервере — отдельный шаг.
