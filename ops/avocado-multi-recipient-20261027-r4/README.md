# Точечная установка нескольких получателей: R4

Пять CRM-модулей и один статический settings.js в payload.zip побайтно совпадают с принятым продуктовым PR463. R4 исправляет проверочный установщик, сохраняя существующие auth, sender, роли, настройки других компаний, данные и остальные сервисы.

R3 остановился на prepare до BASE/action/journal/apply. Root подтвердил штатное отсутствие Config.User у закреплённого Docker image, эквивалентность фактических Compose service hashes при разных исторических base paths и реальный ExecStart выключенного синхронизатора. R4 допускает отсутствие User как Docker default root; явный null и значения вне прежнего набора отвергаются по закрытой политике этого установщика. OCI допускает null у optional-полей, поэтому этот отказ не является общим требованием OCI.

CRM/content/Hugh сохраняют совместимый prefix цепочек. Для всех пяти сервисов global/own hashes должны равняться actual labels; закрепляются все исходные файлы обеих исторических цепочек. Ожидаемый новый CRM hash и его цепочка вычисляются до up; остальные четыре сервиса сохраняются. Полный resolved plan меняет только crm.image. Проверяются фактический /usr/local/bin/synapse-sync, оба неизменных blocking scripts, отсутствие ошибочного sbin-пути, managed-release condition и disabled/inactive timer. Ничего из старого развёртывания не запускается.

Пустая активная очередь обязательна. Для одной конкретной старой pending-записи без маршрута предусмотрен отдельный явный допуск: Root сначала читает `seal PRIVATE_JOB_ID`, затем передаёт тот же частный ID и SHA в `prepare PRIVATE_JOB_ID PRIVATE_SEAL_SHA`. Без аргументов prepare требует полностью пустую очередь. ID и seal не включаются в публичный пакет.

Этот допуск закрепляет все поля outbox и связанного lead, exact Synapse bucket, отсутствие saved override и пустой global route, оба чистых resolver-результата, environment/source pins и отсутствие старого ledger. Любые другие pending/sending, unknown/SMTP errors, route drift или изменение строк дают STOP. Due должен быть позже фиксированного action expiry плюс 600 секунд; непосредственно перед up повторяются seal, активная очередь и запас времени. Это не доказывает исход всей истории SMTP. Старая запись не очищается, не помечается отправленной и не перенаправляется; будущий естественный retry сохраняет прежнее поведение.

Чистый resolver probe использует закреплённый прежний CRM image, сеть none, read-only filesystem, cap-drop/no-new-privileges и read-only mount только публичного кода. Он не получает production env/БД/credentials, не создаёт notifier/SMTP transport и не отправляет письмо. Reader6, его исходные startup/hooks/mount/restart/foreign guards и Native scopes побайтно сохранены из R3; изменён только entry нового закрытого manifest.

До применения обязательны exact merged REVIEW_READY, Root compatibility review, свежая собственная lease, source/fulltree/global plan/DB проверки и защищённый online backup. Stage, seal, prepare, один apply и отдельный inspect выполняются раздельно. Unknown/STOP требует чтения фактического состояния; автоматического повторения, DB restore и старого worker нет. После двух адресов предпочтителен forward fix.

83 offline-теста прошли без skips; Root повторил их в frozen candidate. В публичных тестах только переносимые fixture-пути: original-reader.zip и пинованный previous-reader.zip заменяют внешние каталоги; исходные проверки сохранены. Локальная команда: `python -B -m unittest discover -s . -p 'test_*.py'`.

Inspect обязательно завершить до сохранения адресов через штатный UI: такое сохранение законно меняет старую settings row и делает строгий BASE устаревшим. Код, локальные проверки и SMTP acceptance не подтверждают Входящие или физический телефон. Нативные квитанции, приватный seal, резервная копия и реальные адреса не публикуются.

Первичные источники по default user: [Docker](https://docs.docker.com/engine/containers/run/#user), [OCI](https://github.com/opencontainers/image-spec/blob/main/config.md#properties).
