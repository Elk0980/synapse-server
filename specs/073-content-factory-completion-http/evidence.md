# Проверки

Root принял CF20 (6SHA/read/own16), CF21 (6SHA/read/own8), CF22 (10SHA/read/own54). Свой completion handler3 + actualCRMHTTP1 вместе с CF20:20/20, CODEX_CF20_COMPLETION_20261001.log.

ActualContent session/CSRF probe в source:1/1, CODEX_CF23_SESSION_HTTP_20261001.log. Реальный synthetic owner/editor/viewer/other-company login; GET/PUT workflow/defaults/revision; trusted editor actor несмотря на forged header; отсутствующая сессия401, CSRF/view-only/чужой company403; manual schedule409 до внешнего transport; independent variant201/fresh approval/replay200 после ручной правки; history cursor/no-store/isolation. Отдельный CRM probe проверил >30 записей без потерь/повторов. Новый job по HTTP сохраняет whitelist workflow и версию, без publisherName/actor.

Root QA после accepted-only sync:64 backend paths source=QA; UI ce468daf. CODEX_CF23_QA_CONNECTED_HTTP_20261001.log:2/2, actualCRM + actualContent и настоящий DOM UI->HTTP->synthetic worker->2proposals->2drafts, modelCalls2/uiErrors0. Внешняя сеть fixture запрещена; liveAPI/Telegram/production не запускались. Первое ошибочное применение UI-probe к SOURCE с прежним CF1 UI выявило неверную копию теста, поэтому UI проверен в QA с актуальным UI. Неполный fixture history сначала имел1запись; добавлены реальные edit transitions, затем проверка прошла.

git diff --check чистый; Spec Kit gate ok48. QA manifest проверен до и после sync. Процессовые tests не равны полной UX/production приёмке: интерфейс сохранённых настроек/variant/history ожидает Claude, legacy mentor plan-linked source пока409 без обхода прежнего согласования.
