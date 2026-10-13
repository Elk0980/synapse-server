# Palitra — пакет оформления и таблицы приёмки

Пакет к установке Root: **27 content-файлов + 1 static**, 886027 байт. `manifest.json` перечисляет только относительные `relativepath/sha256/bytes`; runtime BASE — пять SHA в `expected_runtime_baseline`, static BASE — в `expected_static_baseline`. Все копии прочитаны обратно и совпали с утверждёнными источниками. Скан известных секретов и приватных Windows-путей совпадений не обнаружил.

`Dockerfile` только наследует `palitra-production-base:20261013` и копирует `payload/content/` в `/app/`. В content — финальный server.js с review39 wiring, пять host-модулей, модуль/три страницы review и 17 файлов CRM из approved whitelist с четырьмя production overlays. Структура `palitra-crm/app` + `palitra-crm/telegram-ingest` сохранена; относительный импорт Telegram остаётся внутри неё. Lazy demo fallback `workspace.js → ../vendor/site-orders` намеренно не включён: integration требует переданный native siteOrders. Demo/index/form-preview, data, evidence, TASK_STATUS, секреты и Windows builders не копировались.

## Активация

- Только Root: свежие владение ресурса/runtime SHA, backup, build/readback и content-only активация. Пакет сам ничего не устанавливает.
- `PALITRA_CHECKOUT_ENABLED=true` включает разрешённый native checkout на корректном адресе магазина. CRM по умолчанию выключена: `PALITRA_CRM_ENABLED` не включать без отдельно подтверждённой конфигурации.
- Клиентские bot-orders по умолчанию выключены: `PALITRA_CRM_CLIENT_BOT_ORDERS` не включать самостоятельно. Пакет не выдаёт роли/доступы и не отправляет уведомления.
- `payload/static/palitra-editor.js` **не входит в Docker COPY**. Root отдельно публикует его на `/opt/synapse/sites/synapse/palitra-editor.js` с guard live SHA `085c51e97ed6b5e1c91e467bd425b57b90fa6d60fee888dbeec04a630c53eaf5`; candidate SHA `60b29bae2c9bac3c8e912f962f7612ed42392cd5fde073fa1a0207ca48d7ac44`. Это только две подписи; прайс v25 не откатывать и не записывать.
- Review стартует без приватного seed. Root загружает 39 задач через owner UI; отправляются только разрешённые поля, затем проверяет GET/readback/reload.

Откат — к сохранённому текущему образу с исправленным HTTP guard **e1b**, host/static backups и действующим томам. Не возвращать прежний блокирующий выдачу order.js HTTP guard 879. Не откатывать базу/прайс/человеческие проверки ради кодового отката.

Новых тестов/установщика не добавляли. Проверки 23 checkout/regression и 22 review выполнены раньше Root/исполнителями; этот проход — только package/hash/path scan. Native UI, runtime и фактическую публикацию принимает Root. Сервер/Git/браузер/прайс/права/сообщения этим упаковщиком не менялись; вкладок и процессов не оставлено.
