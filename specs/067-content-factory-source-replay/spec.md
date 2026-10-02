# CF18 — восстановление квитанции прикрепления после изменения metadata исходника

Spec Kit1.0.0. Исполнитель Codex. Ограниченное поручение root01.10.2026.

## Сценарии и приёмка

1. CRM уже прикрепил материал, но Content потерял ответ. Последующая правка metadata исходника не должна закрывать доступ к первоначальной сохранённой квитанции этого запроса.
2. Квитанция после ручной правки или архивации карточки остаётся первоначальной. Lookup не возвращает карточку к прежнему состоянию и не выполняет новую запись.
3. Без сохранённой квитанции старый sourceRevision не разрешает новое прикрепление. Решение о revision и восстановлении immutable tuple делает Content bridge root.

## Требования

- FR-001. autoposting.lookupSourceAttachment(code,body) выполняет существующий строгий sourceAttachment нормализатор и тот же JSON payload, что attachSource. По company/request key возвращает первоначальный receipt с duplicate:true или null. Подмена нормализованного source/target payload под тем же ключом409 REQUEST_CONFLICT.
- FR-002. Lookup только читает. Нет BEGIN/transaction/invalidate/get/создания карточки/экспорта файла/пересборки DTO/DBwrite. Историческая квитанция после ручной правки/архивации возвращается из сохранённого result.
- FR-003. Точное POST /internal/content-factory/source-attach-lookup принимает тот же полный server-owned body. Ответ {companyCode,receipt:null|originalDTO}, no-store. Существующие service-key/trusted identity/company/edit guards сохраняются, включая повтор после async readJson и отказ при смене пользователя.
- FR-004. Browser proxy не открывает internal namespace; права не расширяются. Метод/путь/body/company/identity guards проверяются до вызова lookup. Company/request keys изолированы.
- FR-005. Существующее attachSource поведение не меняется. Content source-bridge и его пробы принадлежат root: только при несовпадении sourceRevision root строит первоначальный tuple из immutable source row и expected old revision, lookup receipt=null сохраняет409.

## Критерии успеха и границы

Синтетические memory SQLite и injected HTTP handler пробы подтверждают отсутствие total_changes/get sideeffects, сохранность результата, conflicts/scope/guards. Нет сети/live/production/секретов/прав/клиентских сообщений/commit/push/deploy. Межслужебное восстановление после metadata правки проверяет root отдельно.
