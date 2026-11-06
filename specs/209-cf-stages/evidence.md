# Доказательства (07.11.2026, локально; production не трогался)

Состояние: реализовано, проверено локально. Не подключено и не проверено в рабочей системе — выпуск вручную Root.

- `node --test ops/crm/content-stages.test.js` — 7/7: этапы script_review/script_rework/planned/shot/edit_review/edit_rework/ready/scheduled/published/publish_error по фактам; без фактов съёмки — пометка; подделанный/чужой/обрезанный заголовок не принимается; изоляция Авокадо/Алви, идея чужой компании → 404; повторная загрузка с ideaId → версия 2 той же карточки (HTTP 200), связь через перенесённую публикацию; offPlan → черновик при pending-плане и отказ PLAN_DECIDED при согласованном; эхо вычисленных полей в PUT плана → без новой версии; `company.timeZone` Asia/Irkutsk / unset.
- Адресные наборы crm (content-stages, reel-materials*, media-mentor*, reel-plan) — 127/127.
- `ops/content/shooting.test.js` 9/9 (новый тест фактов съёмки), `content-stages-proxy.test.js` 1/1 (настоящие content + CRM: дубль → shot, браузерный заголовок удалён, часовой пояс, эхо-PUT, прямой CRM без фактов), approvers/media-mentor proxy — без регрессий; итого 12/12.
- Полный `ops/crm`: 1076/1080. Падают те же 4 и на origin/main 6c15eb8e (проверено отдельно): company-expenses ROMI, email-campaigns notification priority, task-products-http, smoke-test.js — вне области.
- Полный `ops/content`: 810/820 pass, 1 fail — view-as-ui.test.js (нет jsdom в среде), вне области.
- `python3 tools/spec-kit/gate.py check` — ok, 48 файлов.

Разрывы (не выдумано): «Снято с публикации» — в CRM нет факта, этап не выдаётся. `ctx.company` в кабинете не строится (module-registry/cabinet.html отдают только id/name) — часовой пояс отдан в `GET /media-mentor` как `company.timeZone`; клиенту нужен однострочный переход (T8). materials.js пока не передаёт `ideaId` при загрузке — сервер готов.
