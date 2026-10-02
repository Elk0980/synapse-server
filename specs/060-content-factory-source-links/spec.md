# CF10: связь исходника с черновиком

Процесс Spec Kit 1.0.0. Область: CRM attach/usage, локальная синтетика. Владелец: агент content_factory_batch_review; HTTP/content export/UI интегрирует основной Codex.

## Требования
- FR1. attachSource принимает только clientRequestId, server-produced source {id,revision,sha256,url} и ровно одну цель: postId+revision либо newPost {title?,text?,format?,ovpRole?}. ID положительные safe integer, source revision >=1, SHA256 64hex, URL публичный HTTPS /content/publishing-assets/<своя компания>/<32hex>.(jpg|png|webp|mp4|webm), без query/fragment.
- FR2. Новый материал создаётся черновиком без расписания/согласования. Для существующего материал добавляется к mediaUrls, максимум10; прежние guards компании, revision, архива, отправки и неопределённого результата сохраняются. Правка содержимого снимает согласование.
- FR3. Карточка, связь и квитанция запроса фиксируются одной транзакцией. Сбой INSERT связи откатывает всю операцию; вложенный BEGIN не допускается.
- FR4. clientRequestId уникален внутри компании. Тот же нормализованный payload возвращает сохранённый post/link первоначального commit с duplicate=true даже после ручной правки. Другой source/target/payload с тем же ключом возвращает409.
- FR5. sourceUsage читает реальные связи и свежие status/contentRevision/mediaUrls карточки. current=true только при наличии URL в текущем mediaUrls; архив обозначен archivedAt. История связей сохраняется, другая компания исключена.

## DTO
attach: {companyCode,duplicate,post:<полный DTO>,link:{id,sourceId,sourceRevision,sha256,url,postId,contentRevision,attachedAt}}.
usage: {companyCode,sourceId,usages:[{...link,post:{id,title,status,revision,contentRevision,archivedAt},current}]}.

## Приёмка и границы
Создание и добавление к согласованному материалу; компания/revision/archive/delivery guards; rollback при отказе INSERT связи; потерянный результат/повтор; ручная замена/историческое использование; неверные ID/SHA/URL и превышение10 материалов. Только SQLite синтетика, без сети, внешних отправок, новых прав, commit/push/deploy. Авторизацию, CSRF и происхождение реального файла проверяет content/HTTP слой; здесь дополнительная валидация и company scope.
