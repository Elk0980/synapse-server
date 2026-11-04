# План

Владелец: агент Е (Claude), ветки `claude/night98-connections-server` (а) и `claude/night98-connections-stats` (б).

- (а) Сервер. Новый модуль `ops/crm/content-connections.js` читает существующие таблицы: `companies` (ссылки через
  `company-links.js`), `social_accounts`/`social_snapshots` (social-stats), `autoposting_channels`, `vk_community_connections`,
  `external_stats`, `platform_company_metric_values` (2ГИС), `leads`, `events`. Отсутствующая таблица — пропуск, не ошибка.
  Подтверждения владельца — приватная переменная `CONTENT_CONNECTIONS_DECLARED` (JSON), не в репозитории.
  В `ops/crm/server.js` — одна строка require, одна создания, одна маршрута. В `ops/content/server.js` — ветка прав прокси.
  `ops/crm/metrika-site-source.js` — только локальные файлы: верхний уровень папки опубликованного сайта компании
  (alvi → alvi, avokado → avokado3, palitra-love → palitra-love; сверяется тестом с site-store) в каталоге
  `CONTENT_CONNECTIONS_SITES_DIR` (только чтение). Сетевых запросов нет. Каталог не задан — источник выключен.
  Миграций нет.
- Проверки: `node --test ops/crm/content-connections.test.js ops/content/content-connections-proxy.test.js`.
