# Проверки

04.11.2026: main fb598368. Первые unit/CRM 28/28 PASS. Первая полная серия133PASS/2FAIL/1Windows symlinkSKIP: старые тесты ожидали done без приёмки; обновлены под отказ, SQL ошибка получила понятный400. Повтор двух интеграционных сценариев и watchdog12/12PASS. Окончательная серия и CI указаны в PR.

Фактический MCP session_start503 «Карта не установлена»; task_get/update/comment/report работают, задачи и агент зарегистрированы. Реальный snapshot59/59: 26in_progress,13planned,6cancelled,11inbox,3done; исторических стадий code8/connected2/verified2/accepted0. Пример сохранён только в закрытом комментарии59/201, содержимое клиентских задач в репозиторий не переносилось.

Рассылка/merge/deploy0, production не проверен. Модульные проверки ролей используют синтетический injected principal и не доказывают наличие authenticated issuer. Контракт issuer/health/UI/TG открыт, PR draft.

Окончательная полная серия:137tests/136PASS/0FAIL/1Windows symlinkSKIP. SpecKit48PASS, syntax и diff-check PASS. Live read-only GitHub verifier подтвердил PR478 exact head7cfe5a474a7a59bb7f19afc76e314ae4359a6d15 и зелёный CI; не стадия этой задачи и не проверка production.

## Исправление ревью220 — 04.11.2026

Все пять замечаний реализованы: trusted owner-session/credential-ID, observe default, accepted/no-code/dispatch completion, authenticated activity, health skip/ждёт исполнителя. Новый async core тест проходит code→verified→connected→accepted с ID/receipt и immutable audit. Loopback HTTP enforce проверяет actual cabinet/MCP, author spoof, отозванный agent_access, no-code и dispatch. Тест отдельного MCP-сервиса с двумя ключами подтверждает разные registry ID без выбора через имя. Подпись проверена негативно: fake/stale/wrong path/method/identity/scope. Перезапуск observe после enforce не оставляет блокирующий guard.

Широкая локальная серия161:160PASS/0FAIL/1Windows symlinkSKIP; повтор20/20 после сохранения неизвестных метаданных и labels. Syntax/gate/diff PASS. Реальные ключи/сервер/рассылка не изменялись; production не проверен. Прежние заявления о блокере issuer и запрете всех новых стадий относятся к возвращённому head528994a и заменены этим исправлением. Остаток полного №59: UI/Telegram/конфигурация и выпуск.

Дополнительно47/47PASS: текущие сессии/права content, watchdog и реальный enforce HTTP после инвалидации производных acceptance/no-code разрешений при отмене решения. Снимки явно считают отдельно удостоверенные и не удостоверенные отметки, не выдают последние за боевой выпуск.

Окончательная серия после защиты grant:162tests/161PASS/0FAIL/1Windows symlinkSKIP. В observe отозванный credential не восстанавливает agent_access саморегистрацией; новые grants создаёт только authenticated cabinet Owner. Существующие grants не переписываются от отчётов агентов. PR477 source18a1d0 проверен чтением: единственный writer agent_access тот же reportAgent, tools.js не меняется.
