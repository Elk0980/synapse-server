# Свидетельства

04.11.2026, Linux, ветка claude/analytics-lead-visit-stitch от main 0a618be.
- node --test ops/crm/lead-visit-stitch.test.js ops/crm/analytics.test.js: 3/3 PASS.
  Заявка с clientId посетителя из 2ГИС получила source=2gis и его referrer. Посетитель Директа получил
  yandex-direct, cpc и cmp-1. Прямой заход дал null. UTM и source формы сохранились. Визит чужой компании
  и визит старше 30 дней не использованы. В ЛК строка 2gis: визитов 1, заявок 1.
- Полный ops/crm/*.test.js: 1015/1017. Те же два падения, что на чистом main (email-campaigns, task-products-http).
- gate.py check: ok.
Не проверено: форма сайта (ещё не передаёт clientId), рабочая база, выпуск.
