# Свидетельства

04.11.2026, Linux, ветка claude/lead-public-response от main 0a618be.
- node --test ops/crm/lead-public-response.test.js ops/crm/analytics.test.js ops/crm/origin.test.js: PASS.
  Публичный ответ на создание и на дубль совпадает с {id, deduplicated}. Во втором ответе нет имени, комментария, clientId,
  referrer и телефона. С ключом ответ полный.
- Формы: sites/avokado3/callback.js:61-65 и sites/alvi/callback.js:146-203 читают только id и deduplicated.
  sites/avokado3/callback.test.cjs PASS. В sites/alvi/callback.test.cjs падает тест №2 «keeps the comment after a failed
  or duplicate request…», и так же он падает на чистом main (тест на заглушках, сервер не участвует).
- Полный ops/crm/*.test.js: 1015/1017. Два падения есть и на main (email-campaigns, task-products-http).
- gate.py check: ok.
Не проверено: рабочая система, выпуск.
