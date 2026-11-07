# План 217

Владелец: Claude-исполнитель (задача №217). Проверяющий: Claude-оркестратор.

## Существующее, на что опираемся
- `ops/crm/autoposting.js` — отправка карточки по каналам (`processDue`), подпись площадки `captions[platform] || text`, лимиты `CAPTION_PLATFORMS`, `channel.caps`.
- `ops/crm/company-information.js` — эталон данных компании, `profile.websiteUrl`.
- `ops/crm/server.js` — `leads` (UTM, этап «продажа», `sale_amount`), `events` (визиты с UTM), `expenses` (`company_code` с spec 111), сшивка заявки с визитом (spec 112), `companyModuleContext`.
- `ops/crm/social-stats.js` — прежняя атрибуция постов по URL/`external_id`; не меняется, новая метка `post-<N>` с ней не пересекается (`cf` не является contentId).
- `ops/content/server.js` — прокси кабинета: `/social-stats/*` читается по analytics.view, пишется по crm.edit.
- `sites/synapse/cabinet/content-stats.js` — вкладка Контент → Статистика (CfKit).

## Изменения (разрешённые файлы)
- Новое: `ops/crm/reel-attribution.js` (настройка, метка, запись решений, отчёт), `ops/crm/reel-attribution-http.js` (маршруты), тесты.
- `ops/crm/autoposting.js` — необязательный параметр `captionLink`; одна точка вызова `decorate` в формировании подписи перед `transport.publish`.
- `ops/crm/server.js` — создание модуля, передача в автопостинг, подключение обработчика перед `/social-stats` (3 строки + 1).
- `ops/content/server.js` — запись настройки меток только владельцу (1 строка).
- `sites/synapse/cabinet/content-stats.js` + `content-connections.css` — блок воронки и переключатель владельца.

## Данные и миграции
Добавочные таблицы `reel_attribution_settings`, `reel_attribution_links` (`CREATE TABLE IF NOT EXISTS`), существующие таблицы не меняются. Бэкап перед выпуском — общий порядок managed-release. Откат — вернуть файлы; таблицы остаются пустыми/неиспользуемыми, подписи без ссылки.

## Проверки
Юнит и HTTP-тесты CRM, jsdom-тест кабинета, полные наборы `ops/crm`, `ops/content`, тесты статистики кабинета, gate, скриншоты 390/1440 (`visual.cjs`, SAMPLE).

## Выпуск
Затрагивает сервисы CRM и content (прокси) и статику кабинета. Порядок: бэкап crm.sqlite → выпуск CRM → content → статика → health → проверка вкладки «Статистика» у владельца. Метки выключены по умолчанию — после выпуска поведение публикаций не меняется до включения владельцем.
