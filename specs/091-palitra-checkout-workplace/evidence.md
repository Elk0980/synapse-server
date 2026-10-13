# Свидетельства проверки

## Актуальный checkpoint Root — 14.10.2026 06:21 Asia/Bangkok

Main257/общий прайс57; фотографии владельца и человеческие данные сохранены. Cart order255/renderer256 опубликован и лично принят. Старое native workplace установлено и принято в desktop/read-объёме. Finished E/R1 локально принят, coherent source16 frozen; все feature-исполнители завершены. Новое native chat/API/UI/upload0. Общее серверное окно ещё не подтверждено.

Это обновление документации по фактическим отчётам Root; подготовщик не запускал новые suite, браузер или сервисы. Частные пути/данные/контакты/токены и test logs не включены. Публичный `ops/palitra-unified-chat-release/` с payload16+builder готовит Root отдельно.

## Разные стадии

| Область | Подтверждено | Открыто |
|---|---|---|
| Main/shared price | Main257, центральный price57, native checkout и человеческие фотографии сохранены | Fresh BASE для каждого нового сохранения читается заново |
| Existing workplace | Native image/static/readback, desktop4tabs, оба штатных редактора и существующая история приняты Root | Новая фактическая доставка и физический Telegram/Safari |
| Cart | Native order255/renderer256, full readback/public exact, личные Main CTA/repeat/focus | Не доказывает всю backend/канальную доставку |
| Unified chat/files | FINAL_SCOPE B/C/D/E/R1 локально принят; exact source16 и builder13 PASS | Native chat/upload0; install, readback, личные native/канальные сценарии, full-ready |

Старые `README/METADATA` описывают свою контрольную точку, а не текущую установку. Наличие source, галочка или локальный PASS не заменяют live-proof.

## Native cart — уже принято, не повторять как pending

Root сопоставил свежий native BASE254 обоих файлов с baseline. По одному штатному сохранению: order255 в01:26:00, renderer256 в01:27:12. После каждого reload полный native readback совпал с candidate; Main/draft anonymous GET200 exact SHA подтвердили оба файла. Личный Main product→CTA добавилqty1 и открыл форму, повтор сохранилqty1 и focus корзины. Собственная QA-строка удалена; новых заявок/TG-сообщений не отправляли.

Исторический cart-пакет: `ops/palitra-cart-checkout-release/`, package ID `palitra-cart-checkout-20261014`. Public source254 служит provenance, не текущим native BASE. Исторический manifest `live_applied:false` не отменяет последующую Root-приёмку255/256.

| Target | Исторический BASE SHA256 | Опубликованный cart candidate SHA256 | Bytes |
|---|---|---|---|
| `assets/order.js` | `b9a12c33fa8129b3bcbb6fd84f098299c690e39f49c5bda15b235b9374aff293` | `f3fb7853f8c3db9e2897bbfb497624ac18a6dad7df0bfbddc02e0c8586782173` | 63272 |
| `price-render.js` | `0b87c08ed5498bb667bf1bcf079afafcb8b441b5f5bc52366d2c6a4b3a24d215` | `506a4048996930cfcd3d93ce6ef3c7d34b125a6d0a583585d4ba89e71e130b30` | 49409 |

Будущий managed order в unified release содержит принятый chat delta и имеет собственный manifest/fresh native CAS; его нельзя подменять этой исторической hash-таблицей.

## Исторические14 cart-сценариев

Реальные renderer/order/price-format выполнялись в порядке страницы, с перехватом всех HTTP и без пользовательского профиля. Root:14 PASS/0 FAIL; portable повтор с тем же результатом не является ещё14 уникальными сценариями.

| Объём | Cases |
|---|---:|
| BASE: CTA открывает пустую корзину без POST | 1 |
| CTA добавляет1, icon не дублирует, qty4 и чужие строки сохраняются | 4 |
| Цена по запросу; open/close/open не добавляет | 2 |
| Неверный/пустой ID; лимит30 сохраняет корзину | 3 |
| Mock201 с выбранным known/unknown товаром | 2 |
| Reject/квитанция без orderId сохраняет форму и корзину | 2 |

Только синтетические квитанции; actual delivery этими tests не подтверждена.

## Existing workplace — ранее принятый объём

Root подтвердил54 локальных проверки и80 динамических route-проверок; отдельно native image/static/health и desktop read-сценарии. Receipt/idempotency, отзыв owner, Origin/CSRF и expected-state конфликт проверялись без нового реального ответа. Загрузка настоящей истории не считается отправкой нового сообщения. CRM/clientBotOrders flags остаются false.

## FINAL_SCOPE E/R1 — локальные доказательства Root

Принимается одна каноническая web/TG-история собственной новой заявки, безопасный START с действием клиента, buyer/owner thread/legacy upload до20 MiB, существующая очередь/worker и устойчивые media/drafts. S1 устранил узкий source-comment defect; S2 исправил fixture с посторонним старым уведомлением без ослабления ID/ACK assertions. R1 исправил воспроизведённый text-only fallback во время SHA только в buyer/owner UI. Старые failing proofs сохранены как история исправления, не текущий статус.

| Suite/этап | Фактический Root результат | Что подтверждает |
|---|---|---|
| Итоговый syntax | 13 PASS; R1 buyer/work отдельно проверены | Парсинг final code/tests, не native запуск |
| E backend | 12 PASS | Scoped upload/journal/recovery и контракты; неизменён после R1 |
| E actual worker branch | 6 PASS | Настоящий multipart/receipt/recovery code с изолированным транспортом; не реальная TG-доставка |
| Independent R1 UI | 8 PASS/0 FAIL | Same UUID lost prepare, reload/hash/name, buyer/owner thread/legacy SHA button+submit guard, latecaption/target/epoch/principal/clear/error/draft |
| E authorUI6 + D UI7 + immutable UI3 после R1 | 16 PASS/0 FAIL | Конкретный повтор changed UI; authorUI6 входит в эти16 |
| D полный regression до узкого R1 | 78 PASS/0 FAIL | Media source/API/regression на E0612; changed UI после R1 проверен строкой выше |
| B/core/receipt/mirror/worker regression | 86 PASS/0 FAIL | Сохранённые core/native/queue assertions и совместимость |
| C на finished R1 | 37 PASS/0 FAIL, 1 Windows symlink SKIP | Принятые C-контракты; skip не заменяет Linux proof |
| Real decoder4 + active playback3 на finished R1 | 7 PASS/0 FAIL | No-autoplay, decode/time/pause и playing node/focus/draft при refresh/edit/status |
| Release builder | 13 PASS | Локальные packaging guards; не установка |

Эти suite имеют повторы и пересечения; общего числа уникальных tests не вычисляем. R1 counter заменяет прежний результат5 PASS/1 FAIL после исправления, а не прибавляет ещё8 уникальных сценариев. Изолированный headless Chrome не доказывает физический Safari/TG WebView.

Coherent source16 принят Root без tests/logs/context/данных в payload: content11, existing worker1, cabinet3, managed order1. Новое native chat/upload не установлено.

## Остаток приёмки

FR-002/003 и SC-002 подтверждены личной native cart-приёмкой. FR-008/010–016 имеют локальное доказательство в указанном объёме; SC-004 native-часть и SC-006 full-ready открыты. SC-003 ограничен existing desktop/read/auth/queue: новая реальная доставка остаётся отдельной.

До установки нужны свежий owner/window, exact current BASE/image/worker inventory, persistent media/checkpoints, Linux storage/preflight, guarded builder/activation/readback/public exact. Реальные новые заявки/сообщения/файлы, доступ сотрудников и изменение flags этим checkpoint не разрешены. Откат сохраняет новые DB/media/history/ACK/uncertain и человеческие изменения.

## Spec Kit и PR

Ранее `gate.py check`: status ok, verifiedFiles48. `check_pr` проверил предложенную строку, packet был not_sent. Эти результаты исторические; новая проверка после обновления не запускалась. Gate проверяет комплект, не истинность evidence или full-ready.

PR458 остаётся OPEN/unmerged по передаче Root. Окончательное тело и converge ведёт Root. Должна присутствовать ровно одна строка `Spec: specs/091-palitra-checkout-workplace`. Подготовщик этой документации не менял Git/PR/payload/BASE/WORK/CURRENT/state/userchecks/сервер и не создавал браузерных вкладок.

## Root: переносимый публичный пакет — 14.10.2026

Root сформировал `ops/palitra-unified-chat-release` из принятого exact-byte source16. Переносимый upload/worker/UI стенд лично пройден:24 PASS/0 FAIL; сборщик:13 PASS/0 FAIL/0 SKIP. Это повтор принятого объёма в публичном layout, не дополнительные уникальные сценарии. Payload16 совпадает с source-manifest; readonly зависимости проверены. Все HTTP изолированы, собственные temporary roots/contexts закрыты. UI fixture отличается только стандартным lookup Playwright; реальных пользовательских файлов в пакете нет.

После обновления четырёх документов Root лично выполнил `gate.py check`:status ok/verifiedFiles48 и `git diff --check`. PR обновляет Root; native chat/upload и общее окно всё ещё не подтверждены.
