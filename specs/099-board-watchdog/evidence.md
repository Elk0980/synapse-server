# Проверки

04.11.2026: main fb598368. Первые unit/CRM 28/28 PASS. Первая полная серия133PASS/2FAIL/1Windows symlinkSKIP: старые тесты ожидали done без приёмки; обновлены под отказ, SQL ошибка получила понятный400. Повтор двух интеграционных сценариев и watchdog12/12PASS. Окончательная серия и CI указаны в PR.

Фактический MCP session_start503 «Карта не установлена»; task_get/update/comment/report работают, задачи и агент зарегистрированы. Реальный snapshot59/59: 26in_progress,13planned,6cancelled,11inbox,3done; исторических стадий code8/connected2/verified2/accepted0. Пример сохранён только в закрытом комментарии59/201, содержимое клиентских задач в репозиторий не переносилось.

Рассылка/merge/deploy0, production не проверен. Модульные проверки ролей используют синтетический injected principal и не доказывают наличие authenticated issuer. Контракт issuer/health/UI/TG открыт, PR draft.

Окончательная полная серия:137tests/136PASS/0FAIL/1Windows symlinkSKIP. SpecKit48PASS, syntax и diff-check PASS. Live read-only GitHub verifier подтвердил PR478 exact head7cfe5a474a7a59bb7f19afc76e314ae4359a6d15 и зелёный CI; не стадия этой задачи и не проверка production.
