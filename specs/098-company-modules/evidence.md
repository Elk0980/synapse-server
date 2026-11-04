# Свидетельства проверки

Состояние: реализовано и проверено локально (Node 22, временные SQLite, jsdom). Не развёрнуто, в рабочей системе не проверено, не принято.

## Тесты

- `node --test ops/crm/company-modules.test.js` — 5/5: каталог и отметка «приобретён» (productId и старые строки по названию, чужая сделка не видна); только владелец; параметры по схеме, секреты (`smtpPassword`, `botToken`, `apiKey`) и неизвестные поля — 400; версия/409; история before/after; изоляция компаний; удалённый из каталога модуль только выключается; письма о заявках: без модуля ALVI/Авокадо/synapse-business/прочие как прежде, параметр модуля главнее, пустая строка отключает, выключение возвращает прежние адреса, отправитель не меняется; миграция на прежней схеме (без таблиц) и откат.
- `node --test ops/content/crm-permissions.test.js` — 31/31, новый подтест через content-прокси и настоящую CRM: 401 без сессии, 403 editor/viewer, 400 без компании, 404 чужой код, 403 неверный CSRF, 400 секрет в параметрах, сохранение → `/company-email` ALVI читает адрес модуля, Авокадо без изменений, писем не поставлено.
- `node --test sites/synapse/cabinet/company-modules.test.cjs` — 3/3: экранирование, ссылка на сделку, PUT с CSRF и кодом компании карточки, null для «как прежде», ошибка в карточке, не владелец не видит экран, ответ прежней карточки отбрасывается.
- Полный `ops/crm/*.test.js`: 996, 994 pass, 2 fail — `email-campaigns.test.js` и `task-products-http.test.js`, падают так же на origin/main fb59836 в этой среде.
- Полный `ops/content/*.test.js` (concurrency=1): 699, 697 pass, 0 fail, 2 skip.
- Полный `sites/synapse/cabinet/*.test.cjs` + `sites/synapse/*.test.cjs`: 994, 991 pass после правки проверки версии ресурсов в `task-board-routing.test.cjs`; 3 fail (`company-links.test.cjs` ×2, `editors.test.cjs` ×1) падают так же на чистом main.
- `python3 tools/spec-kit/gate.py check` — успешно.
- Скриншоты 1280 и 390 px (QA-данные в стенде вне git, реальные CSS кабинета): `/home/claude/crm74-shots/`; горизонтальной прокрутки нет (scrollWidth = ширине).

## Converge

FR1–FR8 покрыты кодом и тестами. Не выполнено: T8 (выпуск), T9 (перевод других функций на `companyModule`).
