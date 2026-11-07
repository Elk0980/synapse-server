# Задачи 214

- [x] T1. Найти существующие каналы доставки и определение людей по ролям (people-notifications/people-service/people-runtime, content-settings, auth-store, company-team). Итог в plan.md.
- [x] T2. content-settings: `notificationDelivery` (off по умолчанию, меняет только владелец), `rolePeople`, серверная отметка включения, `delivery()/deliveryCompanies()/canView()`.
- [x] T3. CRM: действие people `contentStages` (только владелец, своя компания, факты съёмки) + клиент content.
- [x] T4. content-stage-notify.js: первый снимок, детектор перехода с `seq`, получатели по матрице, журнал, trial/on, проверка события перед отправкой, сброс при выключении.
- [x] T5. Подключение: people-service (validateEvent `cf-stage:`, handle/start/stop), 1 строка ops/content/server.js, 1 строка ops/crm/server.js.
- [x] T6. Кабинет: переключатель «Отправлять уведомления», журнал «что ушло бы», люди в ролях на «Участниках».
- [x] T7. Тесты: сервер content, CRM, клиент; полные наборы; gate; скриншоты 390/1440 — evidence.md.
