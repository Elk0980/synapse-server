# Установка нескольких получателей: контракт текущего runtime

Продукт принят в PR463; пять CRM-модулей и один static settings.js в payload.zip побайтно прежние. Этот пакет не меняет чат, Telegram, ботов, auth, sender, роли, env, другие сервисы, Caddy или цены.

R2 был безопасно остановлен на prepare до BASE/action/journal/apply и изменения БД/static: старый read-spec21Oct ожидал другую bridge-версию. Новый client-bot-bridge.js27676/SHA36b0bdc733ad4f4514635d0416867d5964fef4c82aeabe125f542a20969de0ee совпадает с main5fee60cf и принятым immutable chat image4d5b047dc76bae1d2b82067406f98c344eea4033f83f35a54cdef7cd355ed2ae. Image graph10 и полное дерево30 совпали с работающим обработчиком; его ID не менялся.

R3 имеет отдельный namespace и пинованный reader. Пять reader-code файлов побайтно прежние; в spec меняется только одна пара size/SHA внутри прежних десяти workerGraphExpected. Старые NodeOptions/hooks/startup/mount/restart/foreign guards и исходные Native script scopes остаются прежними. Новый loader штатно импортирует неизменный reader.py из нового закрытого каталога, без monkeypatch. Отдельная дополнительная Root-проба разрешает только известный image/CID и точные tree/graph scripts: network none, readonly, cap-drop, no-new-privileges, без production env/томов. Все прежние запреты широких Docker/read команд сохраняются.

Worker basis: graph2c859e48348fc2ceeb9e403497aa81158c013c0937b14c5e9e7026c6eade999d; treeaf68e20caf2e12f700b9a24d0d369dc0fc42a88303728f353243050ea0c05f54. Это SHA256 полного JSON через прежний pc-i4.enc(sort_keys,ensure_ascii=False,comma/colon,UTF8), не raw Node JSON. Рабочий обработчик не перезапускается и его код не записывается.

Перед применением обязательны exact merge/Root review, свежая собственная lease, фактические source/fulltree/global Compose/DB/queue0 и protected online backup. Глобальный resolved plan отличается только crm.image; CRM получает один слой поверх активного pinned image. Существующие данные сохраняются, добавляется только точная служебная delivery table. Stage/prepare/apply/inspect отдельные; один apply, без автоматического повтора, DBrestore или legacy rollback. Inspect выполняется до UI Save получателей. При неизвестном исходе без installed receipt — отдельное чтение journal/actual state, без повторного apply.

Если после перезапуска отсутствуют /tmp primitives, использовать только exact code-only копии из mergedcb2b0c03dc8370593a430a3894cd8b84598e8498/ops/avocado-multi-recipient-20261027-r2/primitives/. Их старые main/stage/capture/apply не запускать, существующие несовпадающие файлы не перезаписывать. Полная исходная load-цепочка проверяется по pins.

Локальная воспроизводимая проверка: python -B -m unittest discover -s . -p 'test_*.py'.61 offline-тестов PASS. original-reader.zip — только прежний публичный код, pin82ca78298c2b6eddda08b2d23e98e0d2d0022ef2ae851f01f2776461eeb4e3f3. В публичном test_reader изменён только путь этого fixture на локальный файл пакета; frozen авторский candidate сохранён.

Независимый QA:14 дополнительных,6 интеграций с точными pc-i4 методами и2 нового loader PASS. Source-derived positive fixture построен из29 проверенных публичных Git blobs и фактических атрибутов immutable image, оба canonical pins совпали. Это unit expected/test-copy данные, не ещё один native запуск. Сохранённая первая неудачная реконструкция не выдаётся за PASS.

Кодовый пакет и локальные проверки не означают native admission, установку, получение во Входящих или физический телефон. Реальные адреса, private packets/квитанции/экспорты не публикуются.
