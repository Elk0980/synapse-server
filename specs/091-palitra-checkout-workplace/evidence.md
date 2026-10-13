# Свидетельства проверки

## Обновление Root после выпуска — 14.10.2026 01:27 Asia/Bangkok

Native source254 совпал с baseline SHA обоих cart-файлов. По одному штатному сохранению: order255 в01:26:00, renderer256 в01:27:12. После каждого reload полный native readback совпал с candidate; Main/draft GET200 exactSHA подтвердили оба файла. Main actual UI: product→CTA добавилqty1/9270₽ и открыл форму; повторный переход сохранилqty1 и фокус корзины. Свой QA товар затем убран, корзина0. Новыхзаявок/TGmessages не отправляли, прайс57/roles/bot не меняли. Cart live_applied=true; полная backend/delivery приёмка этим не заявляется.

Root завершённый webchat PhaseA проверил: syntax0,20авторскихtestsPASS. Независимые8контрпримеровFAIL воспроизвели4дефекта FR-010–013. Последовательный Claude repair активен в прежней сессии, actualinitclaude-opus-5-5/ReadWrite/MCP0; backend/UI/nativeинтеграция0. Перед repair пакетSpecKit1.0.0 передан в read-onlyCONTEXT; генерация и передача ещё не доказывают прочтение.

Историческая контрольная точка ниже описывает состояние ДО этого выпуска и не является актуальным статусом live_applied.

Контрольная точка: 14.10.2026, Asia/Bangkok. Источники — публичные source-пакеты и проверенные отчёты/артефакты координатора Root. Подготовщик документации не проводил live-действий и не повторял browser-suite. Частные материалы, контакты, идентификаторы клиентов, коды и пути не включены.

## Разные стадии

| Область | Реально подтверждено | Ещё не подтверждено |
|---|---|---|
| Main/shared price | Native Main254, прайс57; штатный общий price document и `siteOrders`; предыдущие native readback приняты Root | Свежая BASE для следующего сохранения всегда читается заново |
| Workplace | Backend/static установлены, runtime/static SHA и health200 приняты Root; desktop4tabs, оба штатных редактора, настоящая сохранённая история загружены | Новая actual composer-delivery, физический Telegram WebView, customer order↔dialog ownership claim |
| Cart-кандидат | Diff/syntax приняты Root; исходный дефект воспроизведён; private и переносимый public runner по14PASS/0FAIL | **Live-applied=0**; native/public UI/backend/delivery для этого кандидата не приняты |
| Новый веб-чат | По свежему поручению координатора последовательный локальный PhaseA завершён исполнителем exit0 | Review core, API/UI/bridge и native-интеграция; публикация=0 |

Публичные `ops/palitra-app-workplace-release/README.md` и `METADATA.json` содержат прежний snapshot подготовки. Последующая установка подтверждена отдельной native-приёмкой координатора; она не означает, что все виды доставки проверены. Gate/галочки не подменяют эти доказательства.

## Точный cart-пакет

Источник: `ops/palitra-cart-checkout-release/manifest.json`, `README.md`, `test/cart-flow.test.cjs`. Package ID: `palitra-cart-checkout-20261014`. `public_source_version:254`, `native_workspace_baseline_required:true`, `live_applied:false`.

| Target | BASE SHA256 | Candidate SHA256 | Candidate bytes |
|---|---|---|---|
| `assets/order.js` | `b9a12c33fa8129b3bcbb6fd84f098299c690e39f49c5bda15b235b9374aff293` | `f3fb7853f8c3db9e2897bbfb497624ac18a6dad7df0bfbddc02e0c8586782173` | 63272 |
| `price-render.js` | `0b87c08ed5498bb667bf1bcf079afafcb8b441b5f5bc52366d2c6a4b3a24d215` | `506a4048996930cfcd3d93ce6ef3c7d34b125a6d0a583585d4ba89e71e130b30` | 49409 |

Подготовщик read-only сверил эти четыре файла по фактическим байтам; значения совпали с manifest и результатом Root. Baseline — анонимный public snapshot, не источник полномочий и не гарантия текущего native BASE.

## 14 изолированных сценариев Root

Runner исполняет настоящие `price-format.js`, `price-render.js` и `assets/order.js` в порядке страницы. Все HTTP перехватываются/блокируются, service worker запрещён, пользовательский профиль не используется. Результат: `isolated:true`, `publicUiAcceptance:false`, passed14, failed0. Portable public package проверен Root отдельным прогоном с тем же результатом; это повтор проверки, а не28 различных сценариев.

| Сценарий | Количество | Результат |
|---|---|---|
| BASE: CTA открывает пустую корзину, форма не делает POST | 1 | PASS, дефект воспроизведён |
| CTA добавляет1; значок корзины не дублирует; количество4 сохраняется; повтор сохраняет чужую строку | 4 | PASS |
| Цена по запросу; open/close/open не добавляет товар | 2 | PASS |
| Неверный/пустой ID; лимит30 не теряет корзину | 3 | PASS |
| Mock201 содержит выбранный товар с известной/неизвестной ценой | 2 | PASS |
| Reject и ответ без orderId сохраняют форму/корзину, не показывают успех | 2 | PASS |

Только синтетические квитанции; реальных заявок/сообщений в этих тестах нет. Проверка не доказывает доставку или текущую работу опубликованного cart-кода.

## Workplace: ранее принятый объём

Root подтвердил54 локальных проверки и80 динамических route-проверок final workplace; отдельно native image/static installation, health и реальные desktop read-сценарии. Source-пакет: `ops/palitra-app-workplace-release`. Receipt/idempotency, отзыв owner при чтении тела, Origin/CSRF и конфликт expected state проверяются без реального исходящего сообщения. Загрузка истории/формы ответа не считается доставкой нового сообщения. CRM/clientBotOrders flags остаются false.

## Оставшиеся ограничения и converge

FR-001/004/005/006 имеют source и предшествующую native-приёмку в перечисленном объёме. FR-002/003 и SC-001 подтверждены локально; SC-002 и live-часть FR-007 ожидают выпуска/проверки. FR-008/SC-004 ещё не завершены. SC-003 ограничен desktop/read/auth/queue evidence, а перечисленные live-канальные проверки остаются открытыми. FR-009 сохраняется как обязательная граница всех следующих действий.

Штатное browser-соединение при последних попытках координатора не ответило. Пользователь выполнил предложенное действие; timeout инструмента не доказал отсутствие Chrome или отказ сайта. Ни неизвестное сохранение, ни отправка вслепую не повторялись.

## Проверка комплекта Spec Kit

Подготовщик выполнил только read-only локальные проверки:

- `gate.py check`: status=ok, integrations=codex/claude/qwen, verifiedFiles=48.
- `check_pr` с будущей отдельной строкой `Spec: specs/091-palitra-checkout-workplace`: mode=spec, четыре документа присутствуют. Это проверка предложенной строки, а не фактического тела PR458.
- `packet` сформирован в памяти/stdout: processVersion=1.0.0, fileCount=6, deliveryStatus=not_sent. Пакет никому не отправлен, получение/прочтение исполнителем не заявляется.
- В каталоге ровно `spec.md`, `plan.md`, `tasks.md`, `evidence.md`; нет выявленных частных абсолютных путей/формы bot-token и завершающих пробелов. Cart SHA сверены по байтам с manifest.

Gate проверяет наличие и целостность документов, не истинность функционального отчёта. Фактическое тело PR458/CI, native cart-выпуск и перечисленные live-проверки остаются действиями координатора. Подготовщик не менял payload/baseline/WORK/CURRENT/прайс/сервер/Git/PR и не создавал вкладок или фоновых процессов.
