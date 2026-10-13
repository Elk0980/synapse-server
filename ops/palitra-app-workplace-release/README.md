# Palitra — частный пакет рабочего места, 13.10.2026

Пакет фиксирует шесть точных кандидатов из принятого Root builder. По прямой передаче Root: final tests54/54 и actual routes80/80 PASS; Claude28241 завершён. Первичные UI P1 приняты после исправления; добавлены auth-read и positive-receipt guards. Финальное независимое readonly-ревью ещё идёт. Подготовщик только сверил BUILD/SHA/bytes и сделал точные копии; не запускал тесты, образ, БД, сеть, сервер, Git или браузер. Пакет не является установленным приложением.

Цель — одно рабочее место `/cabinet/palitra-work.html` с обычным входом Synapse и четырьмя вкладками «Заявки / Переписка / Товары / Сайт». Существующие редакторы и центральная очередь сохраняются. Telegram auto-login, новая роль, отдельная БД или второй worker не добавляются. Ответ владельца — текст через существующий outbox; «Поставлен в очередь» не означает «Доставлен».

## Два разных этапа

1. `payload/content/{server.js,client-dialogs.js,site-orders.js}` — backend3. `Dockerfile` имеет единственную основу `palitra-category-content:20261013` и копирует только эти три файла в `/app/`. Файлы других принятых модулей остаются в base image. Пакет не меняет host `ops/content`, Compose или Caddy. Root отдельно сверяет три runtime BASE SHA, принимает category image и делает image preflight/переключение своего единственного сервиса.
2. `payload/sites/synapse/cabinet/palitra-work.html`, `.js`, `.css` — три НОВЫХ static-файла. `manifest.json` содержит только эти target и `base_sha256:null`: любой существующий файл означает отказ. `install.py` клонирован из проверенного category installer; изменён только ALLOWLIST этих трёх путей, обратное сравнение даёт исходные байты. Алгоритм проверки/backup/atomic replace/rollback не менялся. Backend не устанавливается этим helper.

`METADATA.json` содержит десять файлов инвентаря с полными SHA/bytes и отдельно точные runtime BASE3. Manifest/metadata имена различаются целиком; никаких private source paths, DATA, прайса, секретов или контактов в них нет. Источник взят только из конкретного BUILD, не из частичного Claude WORK. Первичное создание каталога exclusive. Обновление конкретных файлов допускается только по отдельному поручению Root после сверки нового финального BUILD; остальные файлы и guards сохраняются.

## Обязательная последовательность Root

Main252 и принятый usability image остаются live до переключения Root. Category image уже собран: 8/8 FINISHED и офлайн-сверка шести SHA приняты Root; server/client-dialogs/site-orders и HTTP сохранены, validator/occasions обновлены. Category image ещё не активирован. Приложение тоже не установлено. Независимое финальное ревью приложения тоже не завершено. Root сначала принимает review, category image и fresh runtime BASE, затем отдельно backend приложения; только после рабочих protected endpoints — static интерфейс. Не заявлять установку по одному локальному PASS или наличию файлов.

Root сам выполняет meaningful offline temp `--check`, `--apply --group static`, `--rollback --group static`, stale/absence guards. Все параметры `--root` и `--backup-dir` явные абсолютные; backup вне root/package. Источники helper ограничены payload и SHA, manifest только static3, BASE null. Подготовщик эти проверки не исполнял.

Перед live действием Root сверяет фактического owner/единственного installer, fresh source SHA и отсутствие всех трёх новых файлов. После image/static — runtime/static exact readback, обычный native login/expiry, owner + exact Origin + CSRF до/после body, действительную связь order↔dialog, оба редактора и сохранение их несохранённой формы. Никаких реальных сообщений для QA и повторов неизвестной отправки. Прайс43 — старый снимок, а не current DATA proof; человеческие проверки не менять своей QA.

## Откат и данные

Static откатывается только собственным `--rollback --group static` с receipt этого package_id: current AFTER и backup проверяются, новые файлы удаляются только при совпадении; чужие изменения вызывают отказ. Backend Root возвращает к лично сохранённому category base image/config; остальные accepted modules сохраняются. Новая receipt table в существующей central DB не откатывается ручным DROP/SQL; старый код её не использует. Сама подготовка не открывает БД и не создаёт строки/заявки.

CRM/clientBotOrders flags остаются false; customer claim P1 не объявляется закрытым. Этот пакет не меняет права, получателя, menu, bot/group configuration, USER checks, прайс, реальные заявки или сообщения. Полный native252 frontend readback с SHA b9a12c33fa8129b3bcbb6fd84f098299c690e39f49c5bda15b235b9374aff293 лично принят Root. Это отдельное доказательство текущего frontend; оно не означает установку приложения. Root единственный live installer. Вкладок и фоновых процессов подготовщика нет.
