# Свидетельства CF8

Прочитаны местные AGENTS.md, docs/spec-kit-policy.md и .specify/memory/constitution.md, процесс 1.0.0; AGENT-ECONOMY прочитан ранее. Сначала созданы spec/plan/tasks. Единственный автор новых пяти файлов; существующая логика, общая копия, QA и координационные файлы только чтение.

## Реальный ограниченный прогон 01.10.2026
Выполнен ровно один запуск нового теста, Node v24.18.1:
`node --test ops/content/content-plan-notifications.test.js`.

NODE_PATH указывает на уже существующий CONTENT_FACTORY_CF1_QA_DEPS/node_modules (jsdom 26); CONTENT_PLAN_NOTIFICATIONS_UI_SOURCE — абсолютный readonly файл CONTENT_FACTORY_CF2_UI_CODEX_QA_20261001/sites/synapse/cabinet/project-chat.js. Установок и сети нет; источник sites CODEX не использован.

Результат: 4/4 pass, 0 fail/cancelled/skipped/todo, duration 4851.2404 ms. Тесты:
1. Настоящий runner.runOne получает синтетическую модель и доводит job до succeeded; реальные dispatch.error создают failed/delayed, enqueue с вопросом создаёт needs_input. runner.sync переносит четыре реальных события из CRM SQLite в отдельную content SQLite. GET project-chat через действительный handler возвращает владельцу только уведомления выбранной компании; участник не получает ownerAlerts. Настоящий DOM общей QA показывает pending, без sent и данных соседней компании.
2. После ack-alert CRM pendingEvents пуст, но уведомление в ЛК pending. Настоящий bridge.pendingTelegram выдаёт audience owner/chatId null даже при наличии клиентской room-привязки. acknowledgeTelegram с синтетической внешней квитанцией даёт sent; owner HTTP DTO и настоящий DOM показывают доставку.
3. Подмена HTTP теряет ack-alert до или после обработки, уже после durable INSERT. Повтор runner.sync оставляет ровно одну запись и одну выдачу bridge. Ветки потери квитанции обе проверены.
4. После синтетически принятой отправки без квитанции файловая content SQLite закрывается и открывается заново вместе с настоящим createProjectChat. Сохранённое sending после истечения аренды переводится bridge в uncertain. Повтор sync/pendingTelegram не выдаёт отправку; owner HTTP DTO и настоящий DOM показывают «Доставка уточняется».

## Converge
FR-001–005 соответствуют пяти новым файлам и четырём прошедшим связанным сценариям. Производственные модули переиспользованы, новая очередь не добавлена. Нераскрытая работа в границах пакета не обнаружена; пустой раздел convergence не добавлен. Проверка исходников этого пакета и SHA выполняется отдельно от тестового прогона.

## Дефекты и границы
Дефектов действующей логики в проверенных сценариях не обнаружено. Это локальные две синтетические БД, HTTP-подмена и настоящий клиент DOM; Telegram-квитанции синтетические. Внешний сетевой Telegram-мост и live доставка не запускались. UI проверен чтением общей QA; QA, manifest/state и все существующие файлы не менялись. Доказана постановка/представление/обработка квитанций и неизвестного результата, а не доставка реальному получателю. Интеграция и независимое ревью принадлежат координатору.

## Контракт
CRM ack-alert означает durable постановку в hugh_owner_alerts, не доставку. ownerAlerts виден только владельцу соответствующей комнаты/компании. Bridge использует owner audience, без адреса клиентского чата; Telegram destination выбирает существующий внешний мост. Sent появляется только по acknowledgeTelegram(ok:true), lost receipt после аренды остаётся uncertain и не повторяется автоматически.
