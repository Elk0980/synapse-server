# План 226 — каталог компаний

Владелец работы — Claude (ветка `claude/company-catalog`). Разрешённая область — файлы ниже. Деплой, живые данные, права и ключи не трогаются.

## Выбор хранилища
Рабочие компании и права живут в базе content (`auth_users`, `auth_user_companies`, `auth_user_permissions`). Модули Контент-завода в CRM ищут компанию по `companies.code`. Поэтому каталог — в content (`workspace_companies`), а карточка CRM переиспользуется/создаётся существующим `POST /companies` CRM. Изменений кода CRM нет.

## Контракты
- `GET /content/companies` → `{companies:[{id,name,contentSiteId,city,timezone,modules}], canCreate}`.
- `POST /content/companies {code,name,city?,timezone?,modules?}` (сессия, CSRF, `companies.create` или владелец) → 201 `{company, addedPermissions, crm:'created'|'reused'}`; 400 валидация; 403 нет права/CSRF; 409 код занят (каталог) или `CRM_CODE_TAKEN`; 502/503 CRM.
- `whoami.companies[]` получает поля `city`, `timezone`, `modules` (добавочные).
- `access-options` возвращает каталог и право `companies.create`.

## Миграции (content, при старте, идемпотентно)
`CREATE TABLE IF NOT EXISTS workspace_companies(...)`; сид 6 строк `INSERT OR IGNORE`. Существующие таблицы не меняются. CRM: новых миграций нет.

## Файлы
- Сервер content (ручной выпуск): `ops/content/company-catalog.js` (новый), `ops/content/auth-store.js`, `ops/content/server.js`.
- Кабинет (автосинк): `sites/synapse/cabinet.html`, `sites/synapse/cabinet/permission-help.js`.
- Тесты: `ops/content/company-catalog.test.js`, `sites/synapse/cabinet/company-create.test.cjs`.

## Порядок выпуска
1. Сервер content (CRM без изменений, должна быть доступна с `CRM_API_KEY`). При старте создаётся таблица и сид.
2. Кабинет. Кабинет раньше сервера: кнопка видна владельцу, POST вернёт 404 «Адрес не найден» в форме — ничего не пишется.
3. Владелец выдаёт Лене `companies.create` в «Настройка аккаунтов».

## Откат
Вернуть прежние файлы content и кабинета. Таблица `workspace_companies` остаётся и игнорируется старым кодом. Созданные компании пропадут из переключателя (старый код знает только 6), но строки `auth_user_companies`, права и данные CRM/Контент-завода сохраняются и вернутся при повторном выпуске. Право `companies.create` в `auth_user_permissions` старым кодом игнорируется.

## Риски
- Права глобальны для пользователя: если у создателя не было `settings.edit`/`analytics.view`/`autoposting.edit`, они начнут действовать и в его прежних компаниях. Журнал фиксирует `addedPermissions`. Пер-компанийные права — отдельная задача.
- `autoposting.edit` по описанию права позволяет настраивать прямые каналы TG/VK своей компании (так задано поручением); Onlypult-профили остаются у владельца.
- Компанию нельзя переименовать/удалить из UI (не требовалось; «ничего не удалять»). Карточку CRM владелец правит в CRM.
- Логотипа у новых компаний нет — показывается первая буква.
