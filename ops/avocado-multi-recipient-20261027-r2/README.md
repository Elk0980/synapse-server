# Ограниченная установка нескольких получателей компании

Продукт принят в PR463, merge5fee60cf6a153858f1aa142f694a5890aef3ffdd. Spec: specs/091-company-email-recipients. Пакет содержит только публичный код; реальные адреса и приватные квитанции сюда не входят.

Область: пять CRM-модулей из payload.zip и один статический settings.js. server.js, sender, auth, env, mounts, networks, остальные сервисы, Caddy, цены и данные сохраняются. Используется ровно один image-слой поверх закреплённой активной CRM, без npm/network/build исходного стека. Глобальная Compose-цепочка сверяется по всем пяти сервисам, включая последний Hugh image override. Full resolved plan может отличаться только crm.image.

Root проверяет exact merge/pins, собственную свежую lease, native source/fulltree/config, queue0 и отсутствие нового ledger. До переключения создаётся private SQLite online backup с quick_check; все старые строки сохраняются, допускается только точная служебная таблица доставки. Отдельные stage/prepare/apply/inspect, один apply и неизменяемый journal. При неизвестном исходе сначала фактическое чтение, повтор запрещён. Offline-проверки не являются установкой.

После перезапуска временные primitive-файлы могут отсутствовать. В primitives/ находятся побайтные, ранее принятые копии: pc-i4.py SHA19d8c6ea00264dc276920b3a196df9c3931d4b2e22c63fbe171da6e13904d73c; tg-r3.py SHAba26b351071719ac21a89ec9e393d532910196d9b6acbc8a6034b6a45d869106; tg-r1.py SHAdc20b9135921087c620949e35e4da20b8154af7f4831a7af94319d6343c66be0. Восстанавливаются только отсутствующие root-owned файлы с этими pins; существующий несовпадающий файл не перезаписывается. Прежние main/stage/capture/apply этих модулей не запускать. Сохранённые code/reader manifests и весь их закрытый набор должен пройти исходный load. Это восстановление кода, без credentials или нового способа доступа.

Root review: helper51c2e8480326a515aa657d5a226338ede5c57f9dca4026652764a3b65a5c015b;38 offline-тестов PASS, отдельно6 интеграционных с точными pc-i4 методами и fake commands. Реальный native framework/Docker этими проверками не исполнялся.

Inspect выполняется до UI смены получателей. Если apply остановлен до installed receipt, нужна отдельная инвентаризация journal/контейнера/статики/БД, без повторного apply. Никакого автоматического rollback и DBrestore. Старый worker запрещён при pending/sending, partial/unknown или многозначной конфигурации. После включения двух адресов предпочтителен forward fix.
