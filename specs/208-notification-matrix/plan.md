# План 208

Владелец: Claude (пакет E). Разрешённые файлы: `ops/content/content-settings.js`, `ops/content/content-settings.test.js`, `sites/synapse/cabinet/content-settings.js`, `.css`, `.test.cjs`, `specs/208-notification-matrix/`.

- Сервер: существующий модуль настроек контента (таблица `content_settings`, тело JSON). Новое необязательное поле по образцу `contentPlanSheetUrl`, без миграции. `options.notifications` — список этапов и ролей.
- Клиент: существующий экран `settings-content`; вкладки «Площадки и стиль» / «Уведомления», адрес `#settings/content/notifications`. Сохранение — существующий `ctx.settings.content.save`.
- Совместимость: старый сервер не возвращает ключ и отвечает 400 на него — клиент показывает сообщение и блокирует повторы.
- Проверки: node --test обоих файлов тестов, gate check, Playwright 390/1440.
