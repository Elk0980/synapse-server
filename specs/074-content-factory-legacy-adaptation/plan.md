# План CF24

1. Зафиксировать свежие четыре существующих ownership файла; не перезаписать принятый CF20/CF22. Добавить ровно planLink DTO через scoped existing linkOf.
2. До reads нормализовать strict optional selection. Сверить selected idea/platform/contentRevision и approvability со snapshot, затем повторить по locked plan внутри нынешней BEGIN IMMEDIATE. Фильтровать только selected tuple; свежий approval проверять существующим scoped SQL. Отказ409 вместо batch skip для selected unapproved.
3. Прежний batch и схема не меняются. Selected existing receipt читает current post status/archive с company join, возвращает skipped без обновления. Ошибка связи откатывает создаваемую карточку.
4. В двух variants POST сохранить ранние guards, await body, fresh company/edit context, same userId и свежего actor; owner решение проверять повторно. Остальные routes не менять.
5. Synthetic memory SQLite: 2 approved neighbors/selected1, DTO scope, ручная правка/архив/replay, strict invalid selection/versions, plan/brief/profile/approval races перед BEGIN, refusal trigger rollback, batch и schedule/drain guards. Injected async HTTP: revoke, user swap, owner downgrade, fresh actor, code/body/CSRF scope.
6. Targeted и existing relevant regression, полный reverse-patch/source-integrity, diff check, Spec Kit converge/gate, финальные SHA изменённых/новых paths; STOP записи.
