# Свидетельства

04.11.2026, Linux, Node с node:sqlite, ветка claude/analytics-company-expenses от main 0a618be.
- node --test ops/crm/company-expenses.test.js: 2/2 PASS. Первый тест берёт старую схему с общим расходом:
  создаётся один снимок v11 с той же строкой, расход остаётся общим (companyCode=null) и в компанию не попадает,
  повторный запуск второго снимка не создаёт. Второй тест: 1000 ₽ Авокадо-образца + выручка 3000 ₽ → ROMI 200 %;
  500 ₽ чужой компании и 300 ₽ общих не учтены; у компании без расходов null, а не 0; без компании 1800 ₽.
- node --test ops/crm/analytics.test.js: 2/2 PASS (прежняя атрибуция не изменилась).
- jsdom 24.1.3 (локально, вне репозитория), после ревью 461: node --test sites/synapse/cabinet/*.test.cjs — 959/959 PASS,
  из них analytics-expenses.test.cjs 6/6. Прежняя запись «962/962» была неверной: туда вошли 4 теста ops/crm,
  а прогон был до смены версии ассетов. task-board-routing.test.cjs ждёт новую версию 20261104-expenses-romi-111.
- Ревью 461, п.2: если по строке площадки есть только ручной расход, она помечена «РУЧНОЙ ВВОД», а не LIVE.
  Расход вместе с полученными данными даёт «LIVE + РУЧНОЙ ВВОД». Есть тест.
- Полный ops/crm/*.test.js: 1016/1018. Два падения (email-campaigns «notification priority…», task-products-http
  «board products and plan…») так же падают на чистом origin/main, к этому PR отношения не имеют.
- python tools/spec-kit/gate.py check: ok, 48 файлов. git diff --check: ok.
Не проверено: рабочая база (доступа нет), выпуск, реальный расход Директа в ЛК. Это делается после ревью и выпуска.
