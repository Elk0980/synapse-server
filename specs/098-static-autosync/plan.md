# План №178

Рабочая ветка claude/autosync-static, PR518. PR560 уже включён в e1bf5edc, runtime/CI diff пуст: не cherry-pick повторно.
Явная карта root→origin по read-only Caddyfile/compose, запреты до blob/read/write. Сохранить per-file CAS и batch JS gate. Отдельный строго pinned bootstrap Авокадо с сохранением исходного processed baseline.
Backup manifest содержит before state, mode и sha256 обоих состояний. Manual rollback сначала проверяет все live/backup, затем восстанавливает; повтор откатанного head не выполняется.
Установщик требует существующего service account и доступной папки сайта: не расширяет права. Копирует лишь затрагиваемые code/unit/state/site, без env и БД. Новые приватные служебные каталоги создаёт отдельно; public права не меняет.
Проверки: unittest Linux с Git/Node/flock, systemd @pkey positive/negative, полная установка pinned revision в одноразовой Ubuntu24.04 VM Actions с loopback HTTP. Windows — только syntax и дополнительный unittest с явно обозначенным test-only fcntl shim, не kernel/systemd доказательство.
