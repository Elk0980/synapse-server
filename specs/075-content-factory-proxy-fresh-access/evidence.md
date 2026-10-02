# Проверки root — CF25

Actual synthetic Content+CRM, временные базы/сессии, внешняя сеть заблокирована fixture. Старый Content proxy: собственный negative workflow mid-body permission revoke вернул 200 вместо403. Лог CODEX_CF25_FRESH_ACCESS_NEGATIVE_20261001.log.

Fix: только четыре точных мутирующих маршрута сначала дочитывают существующим ограниченным reader тело, затем повторяют актуальные session/company/edit/CSRF/userId, decision требует freshowner; свежий header заменяет пользовательский. При буферизации chunked header удаляется перед точным Content-Length.

Own positive: node --test ops/content/content-factory-inputs-proxy.test.js в отдельной QA:1/1,0fail,exit0. Лог CODEX_CF25_FRESH_ACCESS_POSITIVE_20261001.log. Проверены workflow revoke403/нетновойrevision; variants revoke403; transfer revoke403; owner downgrade→decision403; свежий displayName из auth попал в autoposting_platform_reviews.actor_name; обычная chunked variants запись201. Normal session/CSRF/company isolation/history/durable variant replay также проходят.

Две промежуточные ошибки собственного assert: DTO draft history пустая; created_by хранит numericuserId. Исправлен probe к фактическому actor_name platform review. Production код для этих assert не менялся.

CF24 принят отдельно:8SHA/delta чтение/own43/43 (CODEX_CF24_LEGACY_20261001.log). Selected replay/edit/archive/freshowner/transaction rollback и старый batch проверены. Автор230 не выдаётся за выполнение root.

QA accepted-only manifest66путей verified; UIindexce468daf не изменён. Соединённый UI synthetic probe и processgate записываются отдельно. Нет liveAPI/production/clientmessages/secrets/commit/push/deploy. Это ownrootexecution, не независимый rootbrowserlive.
