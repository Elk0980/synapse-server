# Сверка пояснений с кодом

Только отображение; права и зависимости не меняются.

- `analytics.view` — Открывает аналитику, статистику площадок и сводные показатели назначенных компаний. Общий аналитический доступ Onlypult настраивает владелец. Источник: ops/content/server.js: analyticsReadPath, social-stats.
- `crm.view` — Чтение заявок, сделок и доступных данных CRM своих компаний. Воронки и отдельные служебные сведения ограничены владельцем. Источник: ops/content/server.js: proxyCrm; ops/crm/server.js: documentContext.
- `crm.edit` — Изменение заявок, сделок и доступных данных CRM своих компаний, а также ведение отзывов и площадок отзывов, запуск сбора статистики площадок. Расходы вносит только владелец; настройки аккаунтов статистики, ручной импорт и другие операции владельца это право не открывает. Источник: ops/content/server.js: proxyCrm (/expenses — только владелец); ops/crm/server.js: documentContext; ops/crm/reviews-http.js; ops/crm/social-stats-http.js; ops/crm/platform-demand-http.js.
- `sites.view` — Просмотр списка сайтов назначенных компаний. Редактирование сайта и прайса проверяется отдельными правами. Источник: ops/content/server.js: /content/sites; ops/content/site-store.js: capabilities.
- `sites.create` — Создание черновиков сайтов в доступных компаниях. Также требуются права просмотра сайтов и редактора. Источник: ops/content/server.js: /content/sites; ops/content/auth-store.js: DEPENDENCIES.
- `sites.delete` — Удаление управляемых сайтов в статусе черновика. Публикуемые и внешние сайты этим правом не удаляются. Источник: ops/content/site-store.js: capabilities.delete, remove.
- `site_editor.view` — Просмотр содержимого сайта в редакторе доступной компании. Для сохранения изменений нужно отдельное право. Источник: ops/content/server.js: requireContentAccess, /content/site-editor.
- `site_editor.edit` — Сохранение и восстановление содержимого сайта в редакторе доступной компании. Требует просмотра редактора. Источник: ops/content/server.js: requireContentAccess, restore.
- `price.view` — Просмотр прайса доступной компании. Не разрешает сохранять изменения. Источник: ops/content/server.js: price, requireContentAccess.
- `price.edit` — Сохранение и восстановление прайса доступной компании. Требует права просмотра прайса. Источник: ops/content/server.js: price, restore.
- `chat.view` — Пока не используется в серверных проверках. Фактический доступ к переписке определяется проверками CRM, компании и участника чата. Источник: ops/content/auth-store.js: registry only; proxyCrm/project-chat use other checks.
- `chat.reply` — Пока не используется в серверных проверках. Само по себе не разрешает отправку сообщений в чат. Источник: ops/content/auth-store.js: registry/dependency only.
- `settings.view` — Показывает пункт «Настройки» в кабинете. Отдельной серверной проверки этого права пока нет; операции имеют собственные ограничения. Источник: sites/synapse/cabinet.html: permittedView(settings).
- `settings.edit` — Пока не используется в серверных проверках. Подключения и изменения настроек проверяются другими правами или ролью владельца. Источник: ops/content/auth-store.js: registry/dependency only.
- `account.view` — Список аккаунтов, создание редакторов, смена паролей, компаний и прав. Изменение имени/роли и удаление аккаунтов доступны только владельцу. Источник: ops/content/server.js: /content/admin/accounts; ops/content/auth-store.js: create/updateAccess/updatePassword.
- `team.manage` — Просмотр команды и добавление администраторов и мастеров в доступной компании. Доступ исполнителей и их временные пароли создаёт владелец. Источник: ops/content/company-team.js: access/create; ops/content/people-http.js: members.
- `company-information.view` — Чтение сведений и показателей актуальности данных своей компании. Источник: ops/content/server.js: companyModule; ops/crm/server.js: companyModuleContext.
- `company-information.edit` — Сохранение и проверка сведений о своей компании. Требует права просмотра данных компании. Источник: ops/content/server.js: companyModule; ops/crm/server.js: company-information.
- `autoposting.view` — Просмотр материалов, плана, публикаций и настроек каналов своей компании. Также требуется просмотр данных компании. Источник: ops/content/server.js: companyModule/mentorPlan; ops/crm/server.js: autoposting.
- `autoposting.edit` — Редактирование материалов и публикаций, настройка прямых каналов и ключей TG/VK. Общий Onlypult и отметки внешней публикации ограничены владельцем. Источник: ops/crm/server.js: autoposting/settings; ops/crm/autoposting-transport.js: saveSettings.
- `autoposting.approve` — Согласование и отклонение публикаций своей компании. Требует прав редактирования и просмотра контента. Источник: ops/content/server.js: autoposting approve/reject; ops/crm/server.js: autoposting approve.
- `content-plan.approve` — Просмотр плана и согласование его текущих версий в разделе «Моя работа». Не даёт права публиковать материалы. Источник: ops/content/people-plan.js: access/decide; ops/crm/people-http.js: planVariantsDecision.
- `actor-onboarding.self` — Просмотр и заполнение своей анкеты, работа со своими материалами в доступной компании. Источник: ops/content/actor-onboarding.js: self; ops/content/actor-workspace.js: self.
- `actor-onboarding.manage` — Просмотр участников, сводки анкет и материалов своей компании. Также требуется право заполнения своей анкеты. Источник: ops/content/actor-onboarding.js: manage; ops/content/actor-workspace.js: manage.
- `tasks.self.view` — Просмотр назначенных задач и наследуемых подзадач в разделе «Моя работа». Для редактора требуется роль исполнителя проекта. Источник: ops/content/people-tasks.js: access/visible; ops/crm/people-http.js: tasks_list.
- `tasks.self.edit` — Изменение статуса задач, назначенных непосредственно вам. Просмотр унаследованной подзадачи сам по себе не даёт права изменить её статус. Источник: ops/content/people-tasks.js: update; ops/crm/task-coordination.js: selfStatus.

## Проверки
31/31 Node/jsdom PASS: все26 прав покрыты, checked/dependencies/presets и тело создания сохраняют исходные коды; карточка старого аккаунта и форма «Изменить», click/hover/Enter/Space/Escape, aria-describedby, опасные права и неизвестный код. Полный cabinet.html в Playwright Chrome390/1440 с синтетическим API: создание/редактирование/tooltip bounds PASS, JS errors0, горизонтального overflow0. Снимки D:/Codex_Task_Artifacts/CODE_CD_20261105/permission-help-*.png. SpecKit gate48PASS, diff-checkPASS.
Spec-lite: только клиентское отображение имеющихся прав; серверные проверки, наборы прав, зависимости и данные не меняются. Права account.view и autoposting.edit описаны по реальным маршрутам, не по предварительным названиям задачи. Не найденные серверные проверки chat.view/chat.reply/settings.edit прямо отмечены. settings.view используется меню, это указано отдельно.
Выпуск должен доставить permission-help.js ПЕРЕД account.js и people.js (в обеих HTML подключение уже добавлено); версии ресурсов обновлены. Независимое ревью Claude и production acceptance отдельно; server/merge0.

Дополнительно: проверка версии ресурсов в существующем routing-тесте проверяет формат версии и загрузку, а не жёстко старую дату релиза. Итоговый прогон35/35PASS (включая маршруты/обновление ресурсов).

CI обнаружил известный baseline400!=201 в people HTTP peer fixture после main493. Адаптирован только synthetic existing-account fixture;1/1HTTPPASS. Проверка PR Spec-lite отклоняла CRLF; корректная LF-строка локально принята check_pr, описания обновлены.

## Ревью 575/576 (Claude — код, 05.11.2026)
1) `crm.edit`: пояснение дополнено по реальным маршрутам — расходы прямо названы как операция только владельца (ops/content/server.js:726, ревью 647), отзывы и площадки отзывов (`ops/crm/reviews-http.js`), запуск сбора статистики (`ops/crm/social-stats-http.js`; настройки аккаунтов, импорт и замер — только владелец).
2) «Моя работа» → команда: права участника выводятся по фактическим правам аккаунта. `GET /content/people/members` дополнительно возвращает `permissions` каждого участника (только чтение; маршрут по-прежнему для владельца или `team.manage` своей компании). Права и проверки не меняются. Пустой список — «Права не назначены»; без поля (старый сервер) блок прав не показывается.
Проверки: jsdom people/permission-help/account-access/task-board-routing 36/36; HTTP people-http 1/1 (members.permissions у участника с выданным content-plan.approve, без crm.view). Версии ресурсов people.html/cabinet.html → `-r2`.

## Слияние с main 464460a и связь с №112 (Claude — код, 05.11.2026)
Конфликты: people-http.test.js — версия main (531); cabinet.html — версия ресурсов `20261105-night98-permission-help-110`; task-board-routing.test — регулярка main. Добавлено пояснение `autoposting.channels` (PR 537), тест требует пояснение для каждого права и не допускает лишних кодов, кроме этого. После слияния 537 нужно обновить тексты `autoposting.edit` (без ключей) и `autoposting.approve` (без правки) — делает тот PR, что сливается вторым. Прогон 37/37.
