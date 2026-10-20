# R2 transport — только локальная подготовка к review

Статус: LOCAL_TRANSPORT_PREPARED_NOT_AUTHORIZATION. Публикация, загрузка на сервер, staging, preflight, build/up и admission не выполнялись. Frozen R2 и старый R1 неизменны.

## Изменения

Два helper взяты из принятых R1: stage SHA43353240…94690 и admission SHA4b93f738…3f659. AST-проверка допускает только namespace r2, новый закрытый RAW-путь, точные финальные pins десяти файлов/ZIP/prepare/manifest/entry и добавление released PID3204327/3205870/3207300. Логика функций не менялась. См. AST_REVIEW.json и R1_TO_R2_CONSTANTS.patch.

Stage принимает только явный свежий --lease-pid и неизменный 40hex --commit. Будущие два URL находятся строго в официальном raw.githubusercontent.com/Elk0980/synapse-server/<commit>/ops/palitra-report-day-source20-20261020-r2/; сами immutable URL и commit здесь не придуманы. Закрытые имена — installer-code.zip и prepare.py. TLS default, без proxy/redirect, bounded60s; все outer/inner pins проверяются до exec prepare.

В будущей POSIX-root среде durable root600 EXCL UNKNOWN создаётся до любых staging effects, затем новый root700 каталог report-day-source20-cache-20261020-r2-transport-r1. Здесь transport-r1 — первая транспортная попытка нового namespace R2. Существующие UNKNOWN/каталог/CODE запрещают повтор и перезапись. Никакой автоматической очистки неизвестного результата нет. Fresh lease проверяется перед exact prepare. Только код записывается в новый private CODE; runtime/DB не запускаются.

## Disabled admission template

Шесть констант ACTUAL_PID/PREFLIGHT_SHA/EXPIRES_AT_UTC/NONCE/ROOT_RUNTIME_REVIEW_SHA/ROOT_ACCEPTANCE_SHA остаются None. Не подставлять текущий или исторический PID, nonce, срок или допуск в этот общий шаблон. Для будущего действия нужны отдельные свежий R2 preflight, конкретный Root runtime-review и exact action-time acceptance.

Preview после будущей отдельной настройки лишь вычисляет acceptanceSHA и ничего не записывает. Approve разрешён только с отдельными точными Root pins, создаёт новый EXCL root-acceptance и вызывает только approve. Apply/build/up этот wrapper не вызывает; runtime-допуск этим локальным пакетом не выдан.

## Проверки

30/30 локальных тестов PASS: прежние22 stage +5 admission +3 constant-AST/frozen bindings. Команда из R2: `python -B -m unittest discover -s TRANSPORT/tests -v`; PYTHONDONTWRITEBYTECODE=1, TEMP/TMP — собственная TRANSPORT/tests/. Сеть, POSIX-права и lslocks подменены; файлы fixture изолированы. Реальных HTTP, серверных команд и записей данных не было.

Следующий шаг — личный Root review транспорта и отдельная публикация проверенного code-only commit. Текущая серверная основа/lease каждый раз проверяются заново. Ни работающий worker, ни права, ни Push, ни source20 этим пакетом не активируются.
