# Точечная установка нескольких получателей: R5

Продуктовый payload.zip побайтно принятому PR463: пять CRM-модулей и один статический settings.js. server.js, auth, sender, права, настройки других компаний и остальные сервисы не меняются. Шесть reader-файлов побайтно R4; изменён только entry закрытого manifest.

R4 остановился на prepare до BASE/action/journal/apply: в исходной ручной записи server.js SHA были переставлены две hex-позиции. Исправление metadata привязано к прежнему accepted CRM image и равенству его полного дерева работающему контейнеру; server.js не заменяется. Все пять payload before pins и static before pin подтвердились отдельно.

Build-only chat не имеет явного image в Compose JSON. R5 получает reference штатным `config --images SERVICE` из того же полного закреплённого плана. Требуются ровно одна ASCII reference и совпадение local image ID с actual для каждого из пяти сервисов. Снимается только один обычный LF/CRLF-терминатор; прочие whitespace/control separators, пустой/многострочный вывод и leading '-' запрещены. Нет fallback, самостоятельного вычисления tag, pull/build или digest-resolution. Исходный resolved JSON сохраняется, допустимая дельта остаётся только crm.image. Сохраняются все global/own/actual hashes, fulltree и config guards.

R4 guards продолжают проверять optional image User как Docker root default, восстановленные эквивалентные цепочки и фактический bin ExecStart выключенного старого синхронизатора. Managed-release, его blocking scripts и disabled/inactive timer сохраняются.

Для одной заранее выбранной старой pending-записи без маршрута Root читает `seal PRIVATE_JOB_ID`, затем передаёт тот же частный ID/SHA в `prepare PRIVATE_JOB_ID PRIVATE_SEAL_SHA --ttl SECONDS`. Без частного допуска очередь должна быть полностью пустой. ID, seal, реальные адреса и private BASE/backup не публикуются. Старые поля outbox/lead, отсутствие маршрута, environment/source pins и нулевой старый ledger запечатаны; любые другие active/unknown/changed jobs запрещают установку. Запись не очищается, не перенаправляется и не помечается отправленной.

TTL — явный integer300..1800, default1800. Более короткий permit ограничивает время apply; due/строки/содержимое job не меняются. Правило `nextDue > fixedExpires + 600` и late pre-up margin сохраняются. maxSafeActionSeconds является устаревающей диагностикой, без автоподбора. При истечении permit — STOP и чтение фактов; продления, повтора apply, DB restore или автоматического rollback нет. Readonly inspect доступен после original TTL под новой собственной lease. История всех SMTP попыток этим не доказывается.

Обязательны exact merged REVIEW_READY, Root compatibility review, fresh own lease/BASE/source/fulltree/globalplan/DB/queue и protected online backup. Один apply, отдельный independent inspect ДО UI Save адресов. Pure resolver probe изолирован: network none/read-only/cap-drop, mount только публичного кода, без production env/БД/credentials и вызова SMTP factory. Старые R2/R3/R4 операции не повторяются.

Root лично повторил99/99 frozen-тестов и99/99 переносимого публичного пакета,0skip. Первоначальный R5 parser V1 не прошёл независимую trailing-control regression; V1 сохранён приватно. V2 исправляет только parser. Публичные fixture-пути используют пинованные original/previous/R4 reader ZIP вместо внешних private-каталогов; исходные assertions сохранены. Команда: `python -B -m unittest discover -s . -p 'test_*.py'`.

Установка, фактические Входящие и физический телефон — отдельные границы проверки. Код и offline PASS не являются приёмкой этих шагов. После двух адресов предпочтителен forward fix; старый worker не запускается поверх частично принятых/неизвестных jobs или многозначной конфигурации.
