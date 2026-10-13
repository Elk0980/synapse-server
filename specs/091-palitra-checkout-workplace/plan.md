# План и существующие контракты

Процесс Spec Kit 1.0.0. Единственный live-installer — Root/Codex; feature-реализации выполнялись последовательно Claude и завершены. Локальное принятие E/R1 не означает свободного общего серверного окна. Перед установкой заново проверяются владелец, компания, режим и fresh native BASE.

## Модули и источники

| Область | Источник | Контракт и стадия |
|---|---|---|
| Прайс и checkout | `ops/palitra-production-main-release/` | Последний центральный `palitra/price`, существующий `siteOrders.submit`; Main257/price57 сохраняются |
| Native workplace | `ops/palitra-app-workplace-release/` | Установленные native auth/SQLite/outbox, четыре вкладки и существующая история; новые доставки отдельно |
| Cart | `ops/palitra-cart-checkout-release/` | Два JS; native order255/renderer256 опубликованы, readback/public exact/Main CTA приняты Root |
| Unified chat | Подготовлен `ops/palitra-unified-chat-release/` | Frozen E/R1 локально принят; exact payload16 + builder сформированы и проверены Root; новое native chat/upload0 |

Старые README/METADATA отражают свой snapshot подготовки, а не текущий сервер. Stages определяются проверенным checkpoint Root и evidence.

## FINAL_SCOPE: один thread и одна очередь

Новая принятая заявка и собственная гостевая сессия связываются транзакционно. Собственная web-history работает без Telegram. Серверная START-ссылка привязывает подтверждённого Telegram-клиента к этому thread; клиент сам нажимает «Начать». Контакт/номер заявки не заменяет proof и не открывает старую историю. Для других каналов Telegram не обязателен.

Owner workplace различает `thread:N` и `legacy:N`, сохраняет постоянные четыре вкладки/редакторы и черновики. Старые диалоги остаются native, без подставных legacy ID и автоматического backfill. Новые web/TG сообщения и файлы используют каноническую историю, существующие DB/transaction/outbox и единственный worker.

Upload до20 MiB поддерживается buyer, owner thread и legacy. Bytes в памяти браузера; metadata+UUID до prepare, same UUID при lost prepare, known ref через read-only status GET, same size/hash после reload. Raw POST коммитит/reconciles; GET не создаёт запись. Локальное подтверждение файла не означает Telegram delivery.

Worker получает приватные bytes штатным scoped internal read и использует multipart/copy с настоящим tuple, планировщиком типа/подписи и строгой внешней квитанцией. Journal/quota/reservation, sent/sending/uncertain/ACK и recovery сохраняются. Не создаются вторая очередь, второй poller, новая DB или права.

## Native API и доступ

- `PUT /content/palitra/orders/:id/work`: owner, exact Origin/CSRF, свежая сессия после тела; expected-state conflict409 без записи.
- `GET /content/palitra/orders/:id/dialog`: защищённое чтение единственной доказанной связи; отсутствие/неоднозначность не подменяются последним клиентом.
- Owner reply требует `requestId/text`, точный typed target, действующего owner/site/company и транзакционную идемпотентную квитанцию. Same payload возвращает прежний receipt, иной payload с тем же ID конфликтует.
- Buyer chat требует собственной native/account/chat-сессии и отдельного chat CSRF. Binary и upload ограничены собственной историей; owner использует auth/CSRF кабинета.
- `Товары` встраивает штатный price editor, `Сайт` — site photos; `/palitra-review/` остаётся отдельной ссылкой. Новых вкладок workplace нет.
- Pending UUID, late receipt, logout/revoke и target epoch сохраняют границы автора/диалога. Во время SHA блокируются и кнопка, и submit, без отправки подписи отдельно.

## Планируемый exact release16

| Группа | Targets |
|---|---|
| Content runtime8 | `server.js`, `client-dialogs.js`, `palitra-host-adapter.cjs`, `customer-chat.js`, `customer-chat-http.cjs`, `customer-chat-native-adapter.cjs`, `customer-chat-media.cjs`, `customer-chat-upload.cjs` |
| Content public3 | `palitra-review-public/palitra-chat.{html,js,css}` |
| Existing worker1 | `ops/chat/client-bot-bridge.js` |
| Cabinet3 | `sites/synapse/cabinet/palitra-work.{html,js,css}` |
| Managed site1 | `managed-site/assets/order.js` |

Content и worker используют разные captured immutable image BASE. Сборщик принимает exact source16/manifest/approval, не wildcard и не WORK auto-discovery; tests/logs/context/данные не входят в payload. Preserved account/siteOrders/config/price/фотографии не заменяются. Public package и его installer ведёт Root.

## Установка и совместимый откат — ещё не выполнены

1. Root подтверждает свежее эксклюзивное окно общего ресурса, оба runtime/image BASE, worker/checkpoints, persistent media, cabinet/managed source и untouched inventory. Предыдущие hash/prompt не являются lease.
2. Проверяется Linux storage/preflight и exact manifest; расхождение BASE требует остановки и review/rebase. Windows skip не заменяет Linux proof.
3. Совместимый backend устанавливается до producers/UI; обновляется один существующий worker. Producers открываются только после capability/health/readback. Auth и CRM/clientBotOrders flags не ослабляются.
4. Cabinet применяет только guarded own delta; managed order — fresh native CAS/oneSave/full readback/public exact. Фотографии257, price57 и человеческие изменения сохраняются.
5. Root отдельно принимает buyer/owner thread/legacy, файлы/статусы/recovery и физические каналы. Реальная отправка требует отдельного действующего разрешения; локальный fixture его не заменяет.
6. Откат закрывает producers и сохраняет DB/media/journal/jobs/ACK/uncertain. Старый worker не получает неподдерживаемые upload jobs. Возврат бинарников допускается только по own AFTER/BASE и совместимости; whole DB/media restore поверх новой работы исключён.

## Проверки документации

Ранее read-only `gate.py check` подтвердил комплект48 files; `check_pr` проверил предложенную Spec-строку, packet не отправлялся. Это не новая проверка после обновления и не доказательство native-готовности. Новые процессы проверки этой документационной задачей не запускались.

В окончательном теле PR должна быть ровно одна строка:
`Spec: specs/091-palitra-checkout-workplace`.
