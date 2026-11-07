# Свидетельства 217

Состояние: реализовано и проверено локально. Не подключено (не выпущено), в рабочей системе не проверено, не принято.

## Тесты (07.11.2026, node 22, локально)
- `node --test ops/crm/reel-attribution.test.js` — 10/10: метка и её формат; выкл. по умолчанию; вкл. + сайт → ссылка в подписи обеих площадок с их `utm_source`, карточка не переписана; карточка до включения — без ссылки; нет сайта — без ссылки и с причиной; лимит Telegram → `skipped_limit`, подпись не обрезана; ревизия/валидация/выключение, другая компания не затронута; отчёт (уникальные переходы, клик не переход, чужая компания и чужая кампания не засчитаны, продажа без суммы, `unmatched`, ROMI null → 200% после расхода, чужой расход не учтён, честный 0 вне периода); темы через адаптации, NO_DATA, неверный период; HTTP-права.
- `ops/crm/reel-attribution.test.js autoposting.test.js autoposting-transport.test.js social-stats.test.js` — 176/176.
- Полный набор `ops/crm/*.test.js` — 1086 тестов, 1082 прошли. 4 падения не связаны с изменениями (файлы не затронуты): нет установленных модулей `fflate` (reel-plan-file, media-mentor-http импорт), `@modelcontextprotocol/server` (task-products-http), `email-campaigns.test.js:131` (уведомления SMTP).
- Полный набор `ops/content/*.test.js` — 833, 1 падение: `media-mentor-proxy.test.js` импорт CSV через `reel-plan-file` → нет `fflate` в окружении (не связано).
- Кабинет: `content-stats-funnel.test.cjs content-connections.test.cjs content-factory-stats.test.cjs content-factory-stat-period.test.cjs` — 39/39 (jsdom).
- `python3 tools/spec-kit/gate.py check` — ok.

## Скриншоты (SAMPLE, `visual.cjs`, Playwright chromium, тёмная тема)
- `390-live.png`, `1440-live.png` — блок с двумя рилсами, ROMI 200% и прочерк без расхода, итог, свёртка тем.
- `390-empty.png`, `1440-empty.png` — метки выключены, «Нет данных», кнопка «Включить метки» владельцу.
- Горизонтальной прокрутки нет, ошибок консоли нет (`visual-results.json`).

## Разрывы
- Блок в «Аналитике» кабинета — следующий срез (тот же API).
- Instagram/TikTok: ссылка в подписи не кликабельна — нужен link-in-bio.
- Расход рилса вносится строкой «Расходы» с источником `cf-post-<N>`; отдельного поля на карточке нет.
