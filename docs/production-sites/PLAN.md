# №57 — защита чистовиков

Дата: 04.11.2026 (Asia/Bangkok). Исполнитель: Codex — Защита чистовиков.
Основа: main fb598368ba0d05447e04d254bb8fd67807d891fa. Разведка до изменений: №57, комментарий184.
Это план для приёмки Claude и код CI, не установленная серверная изоляция.
Ревью224: [инструкция защиты main](MAIN_PROTECTION.md) и
[совместная серверная приёмка с №55](ISOLATION_ACCEPTANCE.md).
Сервер, содержимое sites/, текущие Caddy/Compose, данные и права не изменены.

## Проверка PR

`tools/protect-prod-sites/guard.py` требует точную метку `сайт <каталог>` для
изменений `sites/<каталог>/**`: например `сайт alvi`, `сайт avokado3`,
`сайт palitra-love`, `сайт taisabai`. Новый неизвестный каталог защищён автоматически.
Для вложенных черновиков: `сайт drafts/peptides`, `сайт drafts/alvi` и т.д.
Обрабатываются удаление и ОБА пути переименования, все страницы API (до3000 файлов;
больше/неполный ответ/смена SHA или меток при чтении — закрытый отказ).

Общие Caddy/Compose, legacy sync, shared track.js/company-links.js, корневые файлы
sites/, ВСЕ `.github/**` (включая любые новые workflows/actions), сама защита и ВСЕ
`ops/content/**` и `ops/crm/**` требуют `сайты: инфраструктура`.
Каталоги мастерской sites/{synapse,chat,board,vhod} не требуют клиентской метки,
кроме перечисленных shared JS. Backend content/CRM защищён целиком, поскольку
новый модуль, Dockerfile или зависимости также могут изменить цены/API.
CI-метка не обещает совместимость API; runtime admission описан ниже. Chat требует
отдельной проверки совместимости по текущему runtime-контракту.
CODEOWNERS с вымышленным GitHub аккаунтом Claude не создаётся.

Доверенный `pull_request_target` запускает guard только из base SHA, с read-only
contents/pull-requests и statuses:write только для статуса exact PR head; код PR не исполняется. Текущие файлы и метки читает GitHub API,
переименования проверяются по previous_filename. События labeled/unlabeled повторяют
проверку, concurrency отменяет прежний запуск. Secrets, отправок и deployment нет.
Непривилегированный PR workflow отдельно исполняет тесты и bootstrap-проверку,
включая labeled/unlabeled: добавление и снятие метки проверяются автоматически.
Его зелёный результат не подменяет доверенный target check.

Доверенный job пишет pending/failure/success с контекстом
`production-sites/path-approval` на exact PR head SHA: target workflow сам работает
на base SHA, его job не заменяет проверку head. Ошибка записи оставляет отсутствующий
или pending результат. Unprivileged workflow не имеет statuses:write и этот статус
не публикует. При подключении привязать required status к ожидаемому источнику
GitHub Actions; приёмку Claude это не заменяет.

При разведке GitHub main/protection=404 Branch not protected, rulesets=[].
До отдельного подключения required status `production-sites/path-approval` CI может отклонить PR,
но GitHub не запрещает merge. Этот PR настройки не меняет. После будущего одобренного
merge владелец репозитория подключает required check без bypass, затем проверяет
реальный отрицательный PR, добавление/снятие метки, смену SHA и правку самой защиты.
Новый target workflow до попадания в main не действует; bootstrap явно ограничен.
Метка выражает область изменения, НЕ является приёмкой Claude или разрешением выпуска.

## Карта main

Во всех строках статика обслуживается общим `caddy`, ./sites:/srv/sites:ro.
Host checkout из памяти /opt/synapse; фактические mounts/runtime нужно сверить отдельно.
Исторические refs ниже — ориентиры, не доказательство актуальной приёмки.

|Проект|Исходники|Домены/маршрут|Снимок/зависимости|
|---|---|---|---|
|ALVI|sites/alvi|spaalvi-38.ru, alvi.synapsebusiness.ru, www redirect|snapshot/alvi-do-pravok-tatyana-3008=f4b4e080; content price/site/assets/links, CRM leads/track, chat /t/*, shared JS|
|Авокадо основной|sites/avokado3|avokado38.ru, avokado3.synapsebusiness.ru, www redirect|accepted manifest неизвестен; content avokado price/avokado3 site/assets/links, CRM leads на основном домене и track, shared JS|
|Авокадо прежний|sites/avokado|avokado.synapsebusiness.ru|snapshot/avokado-do-pravok-tatyana-3008=f4b4e080; content/CRM track/shared JS|
|Авокадо эксперимент|sites/avokado2|avokado2.synapsebusiness.ru, noindex|accepted manifest неизвестен; content/CRM track/shared JS|
|Палитра|sites/palitra-love|palitra-love.ru, palitra-love.synapsebusiness.ru, www redirect|snapshot/palitra-hero-v2-2026-09-04=88f3820c; content price/assets/links/orders, SPA fallback; managed runtime не равен main|
|TaiSabai|sites/taisabai|taisabai.synapsebusiness.ru, noindex|accepted SHA неизвестен; общий Caddy/host|
|CELL LAB|sites/drafts/peptides|peptides.synapsebusiness.ru; drafts domain|черновик, общий Caddy|
|Черновики|sites/drafts/{alvi,avokado,materialy,sb} и корень|drafts.synapsebusiness.ru|приёмка неизвестна; сохранять все существующие пути|
|Небо / Новый Этап|в sites/main не найдены|в Caddy main не найдены|не утверждать отсутствие проекта; нужна приватная карта CRM/runtime от Claude|
|Мастерская|sites/{synapse,chat,board,vhod}, panel|synapse.*, chat.*, vhod.*, panel.*, корневой домен; board.* redirect в cabinet; tasks.*→tasks-mcp|CRM/content/chat/tasks-mcp и общие SQLite volumes|

Общие образы: caddy:2-alpine (плавающий), build ops/{crm,content,chat}; default network,
тома crm_data/chat_data/content_data, TLS caddy_data/config. Даже bind :ro не мешает
host checkout менять файлы. ops/synapse-sync в main содержит reset --hard/общий
compose up --build/reload с restart fallback. По текущей памяти на сервере legacy sync
заблокирован MANAGED_RELEASE_BLOCKS_LEGACY_SYNC; эту защиту сохранять.

## На существующем сервере: порядок после приёмки плана

1. Получить от Claude accepted manifests каждого клиента и реальную карту Небо/Новый
   Этап. В согласованное окно read-only сверить mounts, CID, digest, все overlays,
   Caddy effective config, домены, volumes, внешние JS/API и accepted source hashes.
   Зафиксировать неизвестное; current main не подменяет runtime. Один писатель по
   общей release lock №55; изменения478/477 и чужие сеансы не перехватывать.
2. Приватный полный baseline: имена/типы/права/размер/SHA256 всех файлов, config digest,
   image IDs, ссылки на приёмку exact SHA. SQLite — консистентный снимок с остановкой
   затронутых writers/VACUUM INTO/integrity; сохранить WAL/SHM, медиа, переписку,
   черновики, согласия, sessions и новые данные. Не добавлять их в публичный Git.
3. Копировать фактически принятые байты в
   `/opt/synapse-prod-sites/<slug>/releases/<manifest-sha>/`, вне git checkout.
   Root-owned каталог, файлы0444/каталоги0555, неизменяемый manifest; проверка типов,
   запрет symlinks за пределы snapshot. Хеши до/после копии совпадают. Читаемый каталог
   один для всех сохранённых URL/старых assets; предыдущие snapshots не удалять.
4. Отдельный Compose project `synapse-prod-sites`, отдельная статика/контейнер клиента,
   exact image digest, read_only, non-root, cap_drop ALL, no-new-privileges, tmpfs
   только где нужен. Монтировать только snapshot :ro, без репозитория и Docker socket.
   Отдельные сети и persistent volumes; TLS/edge не пересоздаются выпуском мастерской.
   Зафиксировать лимиты CPU/RAM/PIDs и запас диска после измерения потребления.
5. Edge слушает80/443 и держит отдельный неизменяемый client route include. Маршруты
   мастерской ведут к её внутреннему proxy; №55 меняет только его конфиг/сервисы.
   Для клиента сохраняются ВСЕ нынешние домены, www, noindex, SPA fallback, CORS,
   API/HTTP методы, ошибки и legacy URL. Сначала caddy validate и проверка на копии,
   затем одна атомарная замена client route и graceful reload без restart fallback.
   Прежний общий Caddy остаётся общим риском до завершения этого шага.
6. Shared track.js/company-links.js заморозить в отдельном compatibility route с теми
   же публичными URL и принятыми байтами. Не исправлять HTML клиентов ради переезда.
   Учесть query strings/старые ресурсы и доставку без старого cache.
7. Статика НЕ отделяет content price/site/assets/links/orders и CRM leads/track/chat.
   До отдельного решения сохранять действующие authoritative writers и API, новые
   параллельные writers/боты/уведомления не запускать. №55 блокирует выпуск затронутого
   backend при отсутствии client compatibility evidence. Для полной изоляции нужен
   отдельный стабильный клиентский runtime с совместимым API и выделенным источником
   данных/узким контрактом. Перенос SQLite/компаний/session keys и права — отдельная
   принятая миграция; не клонировать общую БД и не запускать две активные копии.
8. Два заранее поднятых snapshot targets позволяют переключить route обратно без
   сборки/download и без восстановления старой БД. Проверить время отката ≤300с,
   целостность данных и старые открытые сессии. Срок — критерий, ещё не измерен.

На одном host остаются общие ядро/диск/сеть/edge и root. Нельзя гарантировать отсутствие
любого простоя от отказа host или root-worker. Для границы от ошибочного выпуска worker
мастерской не должен иметь запись в prod paths или общий Docker socket: отдельный
rootless daemon/Unix user и узкий проверенный publisher capability. Смена прав/установка
не входят в этот PR. До завершения этапов выше заявляется только защита PR и план.

## Контракт с №55

№55 владеет `ops/release-agent/**`, эта задача туда не пишет. Перед каждым выпуском:

- Режим workshop по умолчанию; site paths из guard, shared JS, Caddy/Compose/sync
  являются admission deny до отдельного site/infra плана. Метка сама не разрешает apply.
- На exact PR/head требуется актуальная метка каждого клиента, authenticated приёмка
  Claude (не произвольная строка author в task_comment), task/PR link, backup receipt,
  accepted manifest, previous/current snapshot hashes, health и rollback target.
- При unknown ответе сначала readback/journal; не повторять переключение вслепую.
- Workshop build/up только allowlist своих сервисов, `--no-deps`; нельзя общий compose
  up/down, Caddy restart, git reset в bind клиентского каталога, prune или broad copy.
- Before/after: полные SHA256+mode/type manifests каждого чистовика, image/CID/starttime,
  route digest и public-resource hashes. Любое изменение вне scope → отказ/инцидент,
  не overwrite baseline. Shared backend change требует совместимости всех клиентов.
- Site release только отдельным journal step: own lock→fresh manifest CAS→backup→stage
  exactbytes→verify→switch→health→receipt. При ошибке code/route rollback с сохранением
  новых заказов/чатов; никакого blind restore старой SQLite поверх новых данных.

## Приёмка всей площадки

После отдельного разрешённого подключения проверить тестовый workshop release: ни
одного изменённого байта/mode/type в snapshots, прежние CID/starttimes/routes. Проверить
старые и новые записи/формы, клиентскую и административную стороны, переписку/вложения,
черновик и файл при ошибке/restore/reload, consent, клавиатуру и нижний composer,
старые query/asset URL без cache, авторизацию старой открытой сессии и после refresh.
Заказы/сообщения в production не отправлять ради теста без отдельного разрешения.
На копии испытать сломанный target, потерю lock, неизвестный ответ переключения,
позднее изменение manifest, откат ≤300с и сохранение новой записи после отката.
Результаты на копии и live различать. Подключено/проверено/принято отмечает ответственный
после фактических доказательств, не по наличию этой инструкции.

## Вариант отдельного сервера — только расчёт, без покупки

Проверка публичной витрины04.11.2026. Для статики начальная оценка: MSK Ultra30,
1vCPU/2ГБ RAM/30ГБ NVMe —3000₽/мес. Минимальный вариант Ultra15,
1vCPU/1ГБ/15ГБ —1920₽/мес. Это видимые тарифы, не утверждение о самом дешёвом
доступном тарифе аккаунта. [Источник Timeweb](https://timeweb.cloud/services/cloud-servers).

Расчёт по [публичному калькулятору](https://timeweb.cloud/prices): IPv4 бюджет200₽/мес,
автобэкап6₽/ГБ/мес. Калькулятор получен поисковым индексом; прямое открытие дало timeout.
На других официальных страницах встречается150₽/IPv4: перед выбором сверить финальную
корзину, не принимать меньшую цифру за подтверждённый счёт.

|Вариант|Сервер|IPv4|Бэкап полного диска (оценка)|Итого/месяц|12месяцев без скидки|
|---|---:|---:|---:|---:|---:|
|Минимальный Ultra15|1920|200|15×6=90|2210₽|26520₽|
|Рекомендуемый для оценки Ultra30|3000|200|30×6=180|3380₽|40560₽|

Вторая строка с запасом предпочтительна лишь после замера медиа, snapshots и логов;
две версии должны помещаться с30% свободного диска. Backend/БД могут потребовать другой
размер: эта смета для статики, не обещание вместимости всей платформы. Домен, платная
панель, администрирование, доп.DDoS и перенос не заказаны; скидки/предоплата не учтены.
Деньги сейчас0, на том же сервере доп.аренда0 при достаточном запасе ресурсов.

Перенос без планового простоя после «да» Влада: тот же разрешённый регион; новый host
из проверенного snapshot, закрытые preview Host/SNI health и hash checks до DNS;
никаких активных bot workers/новых writers. Заранее снизить TTL, подготовить TLS
до переключения, затем DNS A/AAAA и оба старый/новый endpoints обслуживают одинаковые
байты весь период TTL+запас. Старый endpoint не выключать/не удалять. APIs сначала
сохраняют единственного действующего writer через проверенный TLS upstream; это всё
ещё зависимость от мастерской. Полное отделение API — отдельно согласованная миграция
с write fence/догонкой и сохранением sessions, не DNS-трюк. Откат DNS с прежним endpoint
и snapshot; во время TTL работают оба. Нулевой простой и ≤5мин проверяются на копии,
не гарантируются расчётом. Никаких покупок, DNS/серверных изменений в этой задаче.
