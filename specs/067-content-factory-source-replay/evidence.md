# Свидетельства CF18

## Реализовано

lookupSourceAttachment(code,body) переиспользует существующий sourceAttachment и прежний JSON payload. Два SELECT (company, company/request key) возвращают null либо сохранённый result с duplicate:true; несовпадение нормализованного payload409 REQUEST_CONFLICT. Никаких get/invalidate/transaction/write/экспорта файлов или пересборки исторического DTO.

Существующий закрытый handler принимает точное POST /internal/content-factory/source-attach-lookup, повторяет edit/company/identity guards вокруг async readJson и проверяет смену trusted userId. Ответ {companyCode,receipt}, no-store. Обычные attach/usage сохраняют контракт. Полный server-owned body проверяется существующим CRM нормализатором; body не выдаёт actor права.

## Собственные локальные проверки01.10.2026

- Шесть новых проб CF18 и прежние source-links/handler:20/20.
- Финальная regression:108/108, exit0. Наборы autoposting.test.js, autoposting-recovery.test.js, autoposting-review-batch.test.js, autoposting-source-links.test.js, content-factory-source-http.test.js. Node v24.18.1, synthetic memory SQLite/injected handler, без сети/live API.
- Чистота проверена через SQLite query_only, total_changes(), неизменность полных строк posts/links и db.isTransaction. information.get и db.exec заменены запрещающими заглушками; lookup всё равно вернул исходный receipt/null. Отдельная scheduled карточка со stale profile_revision не была инвалидирована.
- Исходный receipt вернулся после ручной правки и архивации; canonical trim/hash case/URL host normalization совпали с attachSource. Source/target changes под прежним ключом409, company keys изолированы, отсутствующая квитанция не создала карточку/линк, invalid body/source/URL400.
- HTTP helper с реальным autoposting проверил полный body, receipt/null,409/400/scope и отсутствие DBwrite. Дополнительные guard пробы проверили POST/exact path/no-store/edit до чтения, смену permission/user/company scope после read. Общий service key здесь не проверялся runtime: handler получает уже проверенный server context.
- Browser block /internal и существующая передача handler из server.js прочитаны, не изменены. Content bridge, server wiring и metadata mismatch recovery end-to-end принадлежат root.
- Свежее исходное содержимое четырёх файлов сохранено до patch. Обратное удаление только нового lookup/export дало autoposting.js, совпадающий с исходным содержимым (нормализован только CRLF). Все прежние source-links тесты сохранены без изменения. В HTTP handler изменены только четыре выражения dispatch/permission; в тестовой fixture только lookup stub/состояние/доступ к guard и добавлены новые пробы.
- git diff --check без ошибок; Spec Kit gate status=ok, verifiedFiles48. Gate подтверждает процесс, не рабочую систему.

## Converge и передача

Проверены FR-001–005 и три сценария в пределах CRM ownership; незакрытых требований этого пакета не найдено, convergence tasks не добавлялись. Сценарий metadata revision mismatch и запрет stale нового attach проверяет root в bridge/spec068 отдельно. QA/manifest/state и остальные existing files не синхронизировались и не записывались. После восьми окончательных SHA запись остановлена.
