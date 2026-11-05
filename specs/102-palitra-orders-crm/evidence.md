# Свидетельства проверки

Состояние: реализовано и проверено локально (Node 22.23.4, временные SQLite). Не развёрнуто, в рабочей системе не проверено, не принято.

## Тесты

- `node --test ops/content/site-order-crm.test.js` — 5/5: заказ → одна заявка с каналом, источником, UTM, составом и суммой; повтор передачи и повтор requestId без дубля; потерянный ответ CRM → та же заявка; CRM недоступна/503 → заказ сохранён (201), пауза повтора соблюдается, после восстановления `sent`; подмена компании заказа → отправки нет; 409 `COMPANY_MISMATCH` → остановка; 409 `COMPANY_NOT_ACTIVE` → повтор; без ключа передача не запускается; миграция на прежней схеме site_orders (старый заказ не уходит) и откат.
- `node --test ops/content/site-order-crm-integration.test.js` — 1/1 с настоящим `ops/crm/server.js`: заявка видна только в `GET /leads?companyCode=palitra-love`, соседняя компания — 0; повтор без дубля; чужая компания с тем же номером — 409; без ключа — 401; CRM остановлена → заказ 201, `pending`, после запуска CRM — `sent`, заявок 2.
- `node --test ops/crm/site-order-leads.test.js` — 1/1: база после отката колонки (прежняя схема) с прежней заявкой → миграция при запуске, прежняя строка цела; 401 без ключа; 201 → 200 duplicate; по контакту не склеивается; `sale_amount` пуст, этап «новая»; 409 mismatch / not active; 400 на некорректные поля; писем в `lead_email_outbox` нет; откат после работы сохраняет заявки.
- Полный `node --test --test-concurrency=1 ops/content/*.test.js`: 704 теста, 702 pass, 0 fail, 2 skip.
- Полный `node --test --test-concurrency=4 ops/crm/*.test.js`: 992 теста, 990 pass, 2 fail — `email-campaigns.test.js` «notification priority mirrors SMTP defaults…» и `task-products-http.test.js` «board products and plan…»; оба падают так же на чистом origin/main fb59836 в этой среде (Node 22), к изменению не относятся.
- `python3 tools/spec-kit/gate.py check` — успешно.

## Converge

FR1–FR8 покрыты кодом и тестами выше. Не выполнено: T6 (выпуск и проверка живой корзиной), T7 (перенос исторических заказов) — требуют решения владельца.

## Правки по ревью (04.11)

- `site-order-crm.test.js` 7/7 (новые: предел 48 попыток и 7 суток → `error`, счётчик `crmErrors` в `listOrders`, остановленные не уходят автоматически; битые `items_json`/`utm_json` → `error` «Ошибка подготовки заявки», соседний заказ `sent`). Заявка собирается до сетевого вызова, поэтому битая строка не принимается за «CRM недоступна».
- `site-order-leads.test.js` 1/1: ответ служебного маршрута без `access-control-allow-origin`.
- `sites/synapse/cabinet/site-orders.test.cjs` 15/15: строка «Не передано в CRM: N» только при N > 0.
- Полный ops/content: 706, 701 pass, 3 fail, 2 skip. Эти 3 теста живого сервера (`platform-demand-proxy`, `project-chat-integration`, `project-chat-local-worker-integration`) упали, пока параллельно шли наборы другой ветки; отдельный повтор — 3/3 pass. Полный ops/crm: 992, 990 pass, 2 fail (те же, что на чистом main). `gate.py check` — ok.
