# Свидетельства

## После ревью 461, 04.11.2026
В ветку влита claude/lead-public-response (PR 500). node --test lead-visit-stitch, lead-public-response, analytics,
origin: 5/5 PASS. Публичный ответ каждой заявки — ровно {id, deduplicated}, поля читаются через GET с ключом.
Если форма передала utmCampaign=form-campaign и utmMedium=social без utmSource, эти значения сохраняются, а
source=yandex-direct берётся из визита. Полный ops/crm/*.test.js: 1016/1018 (email-campaigns и task-products-http
падают и на main). gate.py check: ok.

## Первая версия

04.11.2026, Linux, ветка claude/analytics-lead-visit-stitch от main 0a618be.
- node --test ops/crm/lead-visit-stitch.test.js ops/crm/analytics.test.js: 3/3 PASS.
  Заявка с clientId посетителя из 2ГИС получила source=2gis и его referrer. Посетитель Директа получил
  yandex-direct, cpc и cmp-1. Прямой заход дал null. UTM и source формы сохранились. Визит чужой компании
  и визит старше 30 дней не использованы. В ЛК строка 2gis: визитов 1, заявок 1.
- Полный ops/crm/*.test.js: 1015/1017. Те же два падения, что на чистом main (email-campaigns, task-products-http).
- gate.py check: ok.
Не проверено: форма сайта (ещё не передаёт clientId), рабочая база, выпуск.
