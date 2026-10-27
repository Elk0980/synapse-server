# Свидетельства проверки R2

Источник: main 9ffdae9f4705f10005678736dd0f73c6f3b3e844. Авторский ZIP R2 SHA256 020c240a048b173be450d149c978b3f2c6f484c4906e5cc72792f60e84948285. Root сохранил immutable R1/R2; manifest R2 17/17 совпал. В публичном PR только код и синтетические тесты, без реальных адресов и приватных пакетов.

Независимый QA: 19/19 PASS, прежние четыре набора 29/29 PASS, новые авторские 25/25 PASS, включая четыре jsdom и без skips. Повтор ACK/freeze 2/2 PASS. Root отдельно повторил все 19 независимых тестов: exit0, failures0, skipped0, cancelled0. SMTP только fake, временные SQLite удалены.

В R1 положительный результат без подтверждения целевого адреса воспроизведён через публичный settings/outbox/diagnostics API. R2 оставляет такой исход pending/EMAIL_DELIVERY_UNCONFIRMED. Частичный успех, reopen базы и retry оставшемуся, stale worker и квоты проверены. Три прежних Array.push fake callback теперь возвращают явный accepted; проверочные assertions сохранены.

Root принял сохранение положительного SMTP факта от stale worker: первоначальное ожидание дополнительной третьей отправки было неверным. Исходный FAIL не стёрт; в отдельной R2 версии теста ожидание исправлено с явным обоснованием.

Native read-only: email-settings/email-notifications/email-outbox и host settings.js совпали с BASE. Действующий server.js отличается от GitHub main и сохранён; actual createEmailOutbox(db,emailSettings.notifications,{acquireSlot:...}) совместим. Полная runtime-установка, реальная SMTP доставка и Входящие на два адреса ещё не приняты. Первый тест до этой функции сохранился в CRM и был принят SMTP только прежнему получателю; его повторно не отправляли.
