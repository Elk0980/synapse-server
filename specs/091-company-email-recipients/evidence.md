# Свидетельства проверки R2

R2 stage PASS, prepare остановлен ACTUAL_WORKER_GRAPH_FILE до записи BASE/action/journal/apply и изменения БД/static/runtime. Исходный reader уже выполнил чтение static и БД mode=ro; это не запись. Отказ не подавляли и prepare не повторяли. Собственная lease освобождена одним exit и свежим lslocks[].

Источник несовпадения установлен независимо: только client-bot-bridge.js, прежняя read-metadata34975/ac3a139d... против текущей27676/36b0bdc733ad4f4514635d0416867d5964fef4c82aeabe125f542a20969de0ee. Текущий файл совпал с GitHub main5fee60cf blob65381409d522935d455d2614a1a5cdadbf7fc08f. Root прочитал accepted immutable image4d5b...ed2ae отдельно без сети/томов/env и доказал graph10/fulltree30 равенство работающему контейнеру с неизменным ID. Нативные снимки и квитанции хранятся приватно; в PR только код проверок и его pins.

Новый helper R3a9a6a4198051c2cc88c08c5b605424984e0368ddf286234625f5437e80efc4ac сохраняет исходные reader-код и scopes; spec меняет только подтверждённую bridge-пару.61 offline-тест PASS, Root повторил61 также в публичном transport после единственной fixture-path правки. Product ZIP побайтно совпадает с R2/PR463. Установка и Входящие на два адреса всё ещё отдельные непроверенные шаги.

Независимый R3 review:14/14 дополнительных,6/6 интеграций с pc-i4,2/2 нового loader PASS, без skips. Положительный fixture получен из29 публичных Gitblob-verified source bytes и реально прочитанных атрибутов принятого image; оба canonical graph/tree pins совпали. Actual-поля этого unit fixture — тестовые копии expected, а не дополнительная физическая проверка. Первая неудачная all-mode420 реконструкция сохранена как неудача; реальные mode384/default и14 исключенийmode420 были прочитаны отдельно, не подобраны.

Продуктовый PR463 слит5fee60cf6a153858f1aa142f694a5890aef3ffdd после успешных Spec Kit/project-chat-check на exact head d9ebe3b. Root сверил все9 Git blobs с immutable R2. Авторский converge FR1–FR7 PASS; более строгий rollback plan имеет приоритет над неполным SQL только accepted из авторского OUTCOME.

Компонентный installer51c2e8480326a515aa657d5a226338ede5c57f9dca4026652764a3b65a5c015b:38 offline PASS, Root лично повторил38; независимый QA дополнительно проверил6 интеграций с точными pc-i4 методами и fake commands. Native framework/Docker не запускался. Пятый baseline диагностики тоже exact. После reboot отсутствуют три временные code-only primitives; два постоянных code/reader manifest на сервере сохранились и совпали с pins. Восстановление только точного публичного кода и исходный load обязательны до admission; старые операции не выполняются. Production/получатели пока не изменены.

Источник: main 9ffdae9f4705f10005678736dd0f73c6f3b3e844. Авторский ZIP R2 SHA256 020c240a048b173be450d149c978b3f2c6f484c4906e5cc72792f60e84948285. Root сохранил immutable R1/R2; manifest R2 17/17 совпал. В публичном PR только код и синтетические тесты, без реальных адресов и приватных пакетов.

Независимый QA: 19/19 PASS, прежние четыре набора 29/29 PASS, новые авторские 25/25 PASS, включая четыре jsdom и без skips. Повтор ACK/freeze 2/2 PASS. Root отдельно повторил все 19 независимых тестов: exit0, failures0, skipped0, cancelled0. SMTP только fake, временные SQLite удалены.

В R1 положительный результат без подтверждения целевого адреса воспроизведён через публичный settings/outbox/diagnostics API. R2 оставляет такой исход pending/EMAIL_DELIVERY_UNCONFIRMED. Частичный успех, reopen базы и retry оставшемуся, stale worker и квоты проверены. Три прежних Array.push fake callback теперь возвращают явный accepted; проверочные assertions сохранены.

Root принял сохранение положительного SMTP факта от stale worker: первоначальное ожидание дополнительной третьей отправки было неверным. Исходный FAIL не стёрт; в отдельной R2 версии теста ожидание исправлено с явным обоснованием.

Native read-only: email-settings/email-notifications/email-outbox и host settings.js совпали с BASE. Действующий server.js отличается от GitHub main и сохранён; actual createEmailOutbox(db,emailSettings.notifications,{acquireSlot:...}) совместим. Полная runtime-установка, реальная SMTP доставка и Входящие на два адреса ещё не приняты. Первый тест до этой функции сохранился в CRM и был принят SMTP только прежнему получателю; его повторно не отправляли.
