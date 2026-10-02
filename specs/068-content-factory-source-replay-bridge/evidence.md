# Свидетельства

Требования записаны01.10.2026 до реализации. CF18 агент владел CRM067 и остановил запись до приёмки; root владеет Content068, параллельной записи нет.

Root проверил 8/8 SHA пакета CF18, прочитал весь производственный diff CRM и пробы lookup. Собственный связанный прогон source-links/source-http/bridge/actual Content+CRM HTTP:28/28, exit0, CODEX_CF18_SOURCE_REPLAY_20261001.log. Это синтетические SQLite, пользовательские сессии и два настоящих локальных HTTP-сервиса; не живые клиентские API.

Lost reply→ручная правка карточки→изменение metadata исходника→restart→повтор старого key возвращает original duplicate:true. Проверены total_changes(), сохранность файла и числа карточек, свежая ручная правка, stale новый key409, изменённая цель с прежним key409 и отзыв edit во время async403. Изменённый sourceRevision не запускает export/attach; он только ищет квитанцию с серверным immutable pointer. Дополнительно bridge проверяет company/sourceId/revision/SHA/URL/postId/duplicate ответа. Свежая revision сохраняет прежние size/MIME/magic/SHA/readiness проверки.

Настоящий HTTP проверил повтор после metadata PATCH, первоначальную квитанцию и отсутствие права обратиться к закрытому lookup из browser proxy:403; без service key401; без trusted identity403. Изменённый target409 и новый stale key409.

После сохранности старых57SHA QA скопированы только7 принятых ops путей и specs067/068. Backend manifest57/57 source=QA, индекс UI d2b215f7bfc31d5c0b8477d4050292d9f99f4b01 не изменился. Git diff --check чистый.

Финальная собственная QA 01.10.2026:586/586 backend (включая Content+CRM HTTP, CONTENT_PLAN_UI_PROBE=1 и notification DOM),374/374 целевых UI. Логи CODEX_CF18_FINAL_BACKEND_20261001.log и CODEX_CF17_FINAL_UI_20261001.log. Gate status=ok/verifiedFiles48. Все проверки без живых API, клиентских данных и публикации. Приёмка пакета067/068 завершена; итоговую сверку разрешённого варианта и подготовку передачи root выполняет отдельно.
