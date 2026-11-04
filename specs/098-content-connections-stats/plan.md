# План

Владелец: агент Е (Claude), ветки `claude/night98-connections-server` (а) и `claude/night98-connections-stats` (б).

- (а) Сервер. Новый модуль `ops/crm/content-connections.js` читает существующие таблицы: `companies` (ссылки через
  `company-links.js`), `social_accounts`/`social_snapshots` (social-stats), `autoposting_channels`, `vk_community_connections`,
  `external_stats`, `platform_company_metric_values` (2ГИС), `leads`, `events`. Отсутствующая таблица — пропуск, не ошибка.
  Подтверждения владельца — приватная переменная `CONTENT_CONNECTIONS_DECLARED` (JSON), не в репозитории.
  В `ops/crm/server.js` — одна строка require, одна создания, одна маршрута. В `ops/content/server.js` — ветка прав прокси.
  Миграций нет.
- (б) Интерфейс. `sites/synapse/cabinet/content-connections.js`, `content-stats.js`, общий `content-connections.css`;
  регистрация через `window.SynapseModules.register` (контракт А). В `cabinet.html` — только добавление id в
  `cabinetAssets`/`cabinetStyles`. Меню и маршруты `#content/*` — агент А.
- Проверки: `node --test ops/crm/content-connections.test.js ops/content/content-connections-proxy.test.js`,
  jsdom `sites/synapse/cabinet/content-connections.test.cjs`, Playwright 390/1440 (скрипт вне репозитория).
