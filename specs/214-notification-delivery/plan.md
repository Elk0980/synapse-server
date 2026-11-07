# План 214

Владелец: Claude (ветка `claude/cf-notification-delivery`). Выпуск и слияние — Root/оркестратор, вручную.

## Существующие модули и контракты
- `ops/content/content-settings.js` — настройки контента компании (таблица `content_settings`, тело JSON, версии, права owner/settings.edit). Добавлены необязательные ключи `notificationDelivery`, `rolePeople`, серверная отметка включения; `read()` отдаёт `people`, `canDeliver`, `delivery`, `options.delivery`; для сервера — `delivery(code)`, `deliveryCompanies()`, `canView()`. Матрица 208 не меняется.
- `ops/content/people-notifications.js` — существующая очередь людей (согласие, push/Telegram, уникальность `(user, company, event_key, channel, target)`, проверка события перед отправкой). Не меняется.
- `ops/content/people-service.js` — сборка people: новый модуль подключается здесь, его события проверяются веткой `cf-stage:` в существующем `validateEvent`; `handle/start/stop` объединены. Глобальный выключатель `PEOPLE_NOTIFICATIONS_ENABLED && …_TEXT_APPROVED` прежний.
- `ops/content/people-crm-client.js` — новое действие только чтения `contentStages` (право content-plan.approve, заголовок фактов съёмки).
- `ops/crm/people-http.js` — `GET /internal/people/contentStages`: только владелец, `contentStages.apply(mentor.get(code), code, shootingFacts(...))` → `{companyCode, shooting, ideas:[{ideaId, number, topic, date, stage}]}`.
- `ops/content/shooting.js` (`factsHeader`) и `ops/crm/content-stages.js` (`apply`, `shootingFacts`) — используются как есть.

## Новое
- `ops/content/content-stage-notify.js` — детектор переходов, выбор получателей, журнал, HTTP журнала. Таблицы content: `content_stage_baseline`, `content_stage_snapshot`, `content_stage_notify_log` (создаются при старте, добавочно).
- Клиент `sites/synapse/cabinet/content-settings.js/.css` — переключатель режима и журнал на вкладке «Уведомления», люди в ролях на вкладке «Участники».

## Подключение (минимально)
- `ops/content/server.js` — 1 строка: `createPeopleService(…, contentSettings, shootingFacts: shooting.factsHeader)`.
- `ops/crm/server.js` — 1 строка: `createPeopleHandler(…, contentStages: createContentStages(db))`.
MANAGED_RELEASE_BLOCKS_LEGACY_SYNC, права, ключи не меняются.

## Миграции
Только `CREATE TABLE IF NOT EXISTS` трёх таблиц content. Откат кода безопасен: старый код таблицы не читает; ключи настроек старый сервер отклоняет 400, клиент это показывает («после обновления сервера»).

## Проверки
node --test: content-stage-notify, content-settings (сервер и клиент), crm people-content-stages, people-http; полные ops/content и ops/crm; gate check; Playwright 390/1440.

## Выпуск (Root)
Серверные файлы → ручной выпуск `crm` и `content` (CRM первым: новое действие; content без него получает 404/503 — проход пропускается, ничего не отправляется). Статика кабинета: `content-settings.js/.css`.
