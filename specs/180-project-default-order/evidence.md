# Свидетельства №180 (main)
Проверено локально 2026-11-06, Node 22.23.4:
- `node --test sites/synapse/cabinet/project-preferences.test.cjs` — 6/6 (серверный last с другого устройства до первого показа без мигания, частота за 30 дней, PUT с CSRF и только companyCode+requestId, повтор тем же requestId, старый сервер без запросов и ошибок, недоступная компания, view-as). На menu-preferences.js из main — 4 из 6 падают (тест различает).
- Регрессия: menu-preferences, company-switch-menu, view-as-company, content-factory, company-scope, ops/content/view-as-ui — 34/34.
- Сервер: `node --test ops/content/user-project-prefs.test.js ops/content/user-project-prefs-http.test.js ops/content/view-as-http.test.js` — 5/5.
Не выполнялось: выпуск, миграция production, проверка в рабочей системе, браузерные скриншоты.
