# Задачи

- [x] T001 Зафиксировать поручения владельца и границы компаний/данных/авторизации.
- [x] T002 Прочитать live attention и объединённую переписку, сохранить точные refs приватно.
- [x] T003 Снять fresh home/shop/register HTML и наблюдаемые JS, разделить кабинет/publicshop основы.
- [x] T004 Подтвердить текущие runtime bytes и canonical conversation/attention группировку.
- [ ] T005 Исправить отображение единого обращения и согласованные счётчики без потери разных заказов.
- [ ] T006 Убрать nullable render literal во всех подтверждённых оболочках.
- [ ] T007 Внести общую +7 маску в подтверждённые клиентские поля и проверить редактирование/вставку.
- [ ] T008 Согласовать actual registration/backend/auth контракт; имя/телефон обязательны, фамилия/адрес регистрации необязательны, восстановление по почте без ослабления доступа.
- [ ] T009 Передать разрешённые данные клиента между чатом/регистрацией/заказом без повторного ввода и смешения аккаунтов.
- [x] T010 Явно обозначить сохранение черновика публикации и отдельную отправку.
- [ ] T011 Точечно установить, независимо прочитать и лично проверить старые/новые сценарии.
- [ ] T012 Обновить отчёт/памятки, проверить Converge и убрать собственные временные ресурсы.

STATIC2: кабинетная частьT006 иT011 установлена и лично проверена320/390; публичныйSHOP остаётся открытым. T010 принят: дата/кнопка явно называют черновик, APIне изменён. Остальные требования полной задачи ещё не приняты.

MANAGED2: main assets/storefront.js и assets/order.js установлены штатными CAS сохранениями v331–332. Маска на главной и в регистрации лично просмотрена390/320, гостевой ручной ввод/MAX не смешивается. После самостоятельного входа пользователя Root лично принял подстановку текущего аккаунта на главной и в корзине, ручную правку и очистку, самовывоз/доставку и восстановление прежней вкладки без повторного входа. Живой выход во второй вкладке остаётся открытым, чтобы не прервать пользовательскую сессию. T007/T009/T011 целиком не закрываются; SHOP/widget/auth/attention ещё pending.

Следующий ограниченный серверный кандидат: scoped optional AccountService+factory и чат+adapter+SHOP+widget, ровно6 файлов. Root принял52 теста scoped account/widget,7 проверок управляемых форм со scoped backend и54 проверки механизма постоянного выпуска. Синтетические проверки не являются серверной установкой. Отдельная нативная проверка готовности отказала до любых stage/build/apply; причина устанавливается, защита не обходится. Необязательные фамилия/адрес пока не развёрнуты.
30Oct: R7 ровно6 runtime files установлен постоянным образом, stage/prepare/build/oneapply/separateinspect exit0, independent AFTER_PASS. Управляемые формы сохранены штатно333/334 с full141/139otherfiles/all332oldversions+333/image/price83 readback. Фамилия/адрес необязательны в регистрации и профиле; Root лично просмотрел рабочие формы и восстановленный прежний вход, согласия не отмечались и аккаунты/заявки/сообщения не создавались. Публичные старые query дают новые ресурсы. ЧастиT008/T011 приняты; целиком они остаются открытыми из-за phone-only/emailrecovery и новой мобильной/чатовой приёмки. RawCDP мобильного режима отклонён до команды при обработке документа, обход не выполнялся. Своя lease освобождена и проверена, завершённые editor/registration вкладки закрыты. Не повторять этот выпуск или два Save; следующий scope от currentR7+managed334. Полная Converge не объявляется: T005/T007/T008/T009/T011 имеют незавершённые части.

30Oct02:03МСК: Root personally принял390/320 optionalprofile/registration, chatoldaccountprefill/history/attachments иSHOPmask8→+7/internal8/clear+7/uncheckedconsent. Старыйзаказ29 открывается внутриSHOP безрегистрации. T007/T009/T011 остаютсячастичными: SHOPhelp name/contact пустые, privateисправлениевработе; newaccount/cross-tablogoutбезпрерыванияusersessionещёpending. R8attentionтолькоprivate, runtime/static0.

## 30.10 — выход между вкладками

- [x] T014 Воспроизвести рассогласование существующего профиля и состояния сессии в двух реальных вкладках с вымышленными данными, per FR-06/FR-11.
- [x] T015 Подготовить bounded кандидат на свежемstorefront335, сохранить ввод/CSRF/unknown outcomes, проверить10моковых и интеграционных сценариев, per FR-11. Результат установлен отдельной версией336.
- [x] T016 Выполнить свежий guarded managed CAS/backup/independentreadback и live без прерывания личной сессии, per FR-09/FR-11. Один штатный Save335→336, отдельный полный readback PASS, обычный reload редактора и ресурса с прежним query exact; desktop390320 без overflow. Локальная проверка в двух реальных Chrome вкладках PASS: выход, другой аккаунт, возвращение того же аккаунта и сохранность ручного ввода. Реальный production logout/profileSave не выполнялись; физический телефон отдельно не принят.

## 30.10 — восстановление доступа

- [x] T017 Проверить существующие account/SMTP/lead-mail контракты без реальных отправок: customer recovery отсутствует, staff reset и получатели заявок не подходят, per FR-05/FR-12.
- [x] T018 Подготовить изолированный приватный recovery core на точном R7 AccountService и проверить одноразовость/срок/realm/CSRF/сохранность других аккаунтов/unknown delivery с вымышленными данными, per FR-07/FR-12. 21локальная проверка PASS; никакой установки/реальных писем. Общая функция доT019 не готова.
- [ ] T019 Подключить отдельный ограниченный внутренний sender и клиентскую форму после проверки действительных сервисных границ; выполнить fresh guards/backup/readback перед разрешённым выпуском и принять старые аккаунты, per FR-09/FR-12. Private adapter18/UI17+Chrome desktop390320/lifecycle12tests и assembly13HTTP+5historical contract PASS; key reader9PASS/1POSIX-SKIP; shared-DB factory10PASS+1targeted race PASS, core неизменный. Bounded local timing/load измерены без отключения guards, это не production readiness. Рабочие routes/SMTP/master-key/форма не подключены; current runtime/endpoint isolation, actual persistent key source/mount/ACL/rotation, production timing/load, политика метаданных/operator UI и выпуск открыты. Два локальных дочерних процесса с одним fake key не доказывают host restart. Локальные прототипы не закрывают эту задачу.

## Новый прямой приоритет владельца 30.10

- [x] T020 Установлен единственный assets/order.js managed337: подтверждение принятого номера, same-origin /chat, выбранный Telegram через существующий проверенный endpoint либо явная причина недоступности. Root14новыхDOM/23delivery PASS, fake Chrome desktop390320, before1/officialSave1/independentafter1 PASS. История336/140прочихфайлов/прайс83/5runtime identities сохранены. Normal editor reload, main/draft/oldquery exact; actual cart formready/390320 безoverflow. Реальные submit/messages0; доставка Telegram и физический iPhone этой проверкой не подтверждены. per FR-13/FR-14.
- [ ] T021 Расширить grouped manager projection до одной карточки существующей доказанной общей переписки с несколькими order records: сохранить историю/refs/stages/actions, непрочитанное/counts/filter/search/cursor и изоляцию, per FR-01/FR-02/FR-07/FR-09. Старый private single-order display-v2 не принят для нового scope; sealed runtime releases не повторять.
  Прогресс: только private display-v3 core на native-matched e950,24fakeSQLite PASS. Все canonical members и v1 сохранены; общий ответ снимает прежнее ожидание, новый вопрос создаёт его снова. Пакетный notification witness2SQL для1/50cases. Frontend validator/member routing/actions/unread/restore, реальный выпуск и live приёмка открыты; core не установлен.
- [ ] T022 Обеспечить различимость одинаковых по цене выбранных товаров по названию/категории/варианту/подтверждённому составу или фото и itemId с совместимостью старых заказов, без правки цен/прайса/истории, per FR-15.


## 30.10 — T021 private display-v3 frontend, ещё не установлен

Root: CORE_R2 30fake SQLite PASS487.0754ms устраняет отдельный legacy-channel risk; прежний R1/24PASS заморожен. Frontend6полных файлов:22newintegrationPASS1760.3328ms +8source-integrityPASS1082.2765ms. Первые20PASS2FAIL — только ошибка fake frameById, fixture исправлен без product change. Уникальные canonical unread keys/unknown, typed member routing, все stages/actions/channels, fresh sourceRevision/cursor, права/foreign company, ручной draft и actual ackcontroller сохранены. Chrome localhost desktop390320:1case/6orders+priorchat;2→0→1notifications, соответствующие order32/legacy8 и order35/thread135. Все данные вымышленные, realorders/messages0. Preview closed, helper24412/59473 stopped/fresh0, metricscleared; app2833 handoff. Private receipts MANAGER_MULTIORDER_CORE_R2_20261030 и MANAGER_MULTIORDER_FRONTEND_20261030. Core manifests10/11pins exact; old suites не повторялись. Fresh full current source pins/integration/release feasibility/independent review/readback/live остаются открыты. T021 не закрывается. Runtime/deployhelper/R14 не подготовлены, sharedrestart не разрешён.


## 30.10 — T022 private immutable product snapshot, ещё не установлен

Три private файла: actual-matched siteorderscbded→3a2f275b55e91a6db94c3a97e9c98f424c5ae3d6aebf2b960b1a8cf07dc25859, cabinet/shop shell поверх замороженного T021. Metadata из того же trusted price при принятии: category/composition/desc/note/imageextension photo refs; browser fields не доверены. Новые строки сохраняют metadata в items_json без новой schema/route, предыдущие строки/очередь/история/цены не переписываются. Старые missing descriptions/photos явно обозначены; текущий прайс не выдаётся за старый snapshot. Existing exact order read supplies full details, bounded message preserves all original fields within8192; legacy/public brief summary не расширяется личными данными.

Root32newPASS1180.8543ms:17backend/10actualshellDOM/5fullreverse-integrity. Initial15PASS1missingmediaFAIL, UI8PASS2missingstrFAIL исправлены в harness; затем product photo regex hardening, full32 относится к окончательному коду. Actual unchanged R7 core1a392 accepts ordinary/max30-item checkout with fakecookie-CSRF/one message/no duplicate manager enqueue; two media dependencies historical fixture only, notfreshnativeproof. Chrome localhost desktop390320/new/legacy/unsafeHTMLrefusal PASS; photoURLs не открывались, actualimage availability/physicaliPhone не приняты. Fake-only/no native/runtime/realorders/messages/stage/pricewrites. Both helpers stopped/fresh0, ownpreviewtabs closed/metricscleared, app2833handoff, COM/lease0.

T022 остаётся открытой: current sources/consumer integration/independent review/guarded release feasibility/readback/live не пройдены. Receipt private PRODUCT_DETAILS_20261030/RESULT/MANIFEST/BROWSER_RECEIPT; frozen T02130pins exact, old suites не повторялись. R9–R13 sealed/no R14/helper, sharedrestart pending не повторяется.


## 31.10 — совместная private приёмка и сверка текущих исходников

Root16newPASS1468.3056ms на7неизменныхcandidate files: exactR7checkout adapter/core/schema, immutable product, CORE_R2/display-v3, actualhost/route/shell и readstate. Sixorders+priorchat→onecase; distinctcookie withsamephone staysseparate; exactduplicate/no grant/atomicCSRF-originrollback/oldmetadata preserved. Actualunread7→confirmedvisibleACK0→newquestion1, attention clearsbyhumanreply separately. Legacy/unknown/revokedactor checked. Initial8PASS8FAIL — fourharness/assertion gaps, correctedfixturesonly, seven products unchanged; старые suites не повторялись.

Fresh official nativeRO account/server/root confirmed:12SHA touchedbases and core/adapter/readstate/media dependencies allmatch, contentR7/chat running/restartCount0. No sourcecontents/secrets/env/rawlogs downloaded, no nativeinstall/lease/BASE/package/helper/runtime/DB/orders/messages/stage/price writes. Initial duplicated readonly id-u command rejected, ownlinecleared/singleid-u0 verified; gap retained privately. OwnCOM/parentclosed, app2833handoff. Receipt JOINT_CHECKOUT_CASE_20261030/RESULT and NATIVE_SOURCE_ACCEPTANCE, newnativeproofs localonly. This is not independentcode review/fullbootstrap/release permit: T021/T022 stayopen, R9–R13sealed, specificsharedrestart pending. Nextbounded currentbridge/entrypoints compatibilityRO, no new models/probes/replay.


## 31.10 — текущие публичные входы и Root compatibility review

BOOTSTRAP_COMPATIBILITY_20261031:4current entrypoint HTML/8publicJS exact, livecabinet16script graph matches anonymousHTML; bridge→native-host→shell and chat5ordereddefer. Currentdraft from337receipt HTML658625/chat5752 exact. Initiallegacyalias choice before receipt was a proceduralgap, strict redirect guard refused it; not treated as currentdraft defect. Eight public JS and13jointpins verified,7productfiles unchanged, no new require dependencies. Historical16/32/30/22/8suites not rerun. Root source review found no incompatibility in bounded scope; not independentreview/livebootstrap/PWA/physicalphone/releasepermit. No installation, nativecommands, UIwrites/reloads, realorders/messages or runtime. Ownapp2833handoff, COM/lease/helper0. T021/T022 stayopen: readiness refusal cause/permitted procedure, independentreview/freshguarded integration/readback/live/photos. Nextsource-only sealedreceipts/checker review, nooldhelperexecution/replay/R14/package.


## 31.10 — точная причина остановки R9–R13, разбор без исполнения

Сверены13сохранённых inputs, точные R13helper1d0c/diagnostic658 и ранее native-matched bridgeLF36b. Цепочка отказов различается: R9metadata mode, R10cache expiry window, R11changed rows/CRM visit, R12/R13combined readiness predicate. Последний DIAG_BRIDGE_NOT_STEADY_READY возникает в diagnostic_preservation.py:20: key/ok1/username syntax/botId syntax/errorEmpty. Эти условия объединены, точное нарушенное поле неизвестно. Отдельные проверки schema/snapshot/config/freshness имеют другие коды. Capture повторяется вокруг копий до Docker;10частичных copies и отсутствие backups.json/image/permit согласуются с native outcome. Эти снимки не непрерывный мониторинг. Все R9–R13apply0/runtime0; sealed journals не менялись.

Source verify-catch→okfalse/emptyids/error→heartbeat объясняет возможный путь, но не доказывает прошлую транспортную причину. Поздний healthy snapshot, R3fail counts и R5HEADsuccess не восстанавливают её. Новый namespace/TTL/retry не устранение причины. Старый helper привязан к managed334/старым6payload, не новый337/7files. Диагностический shared chat restart и старый content-only release имеют разные scopes; ранее заданный вопрос остаётся pending/no repeat. Receipt private DUPLICATE_PHONE_CASE_20261030/READINESS_CAUSE_REVIEW_20261031. Нет imports/исполнения старых helpers, native/network/testsuite/journal/productwrites/package/install. T021/T022 не закрыты. Следующая независимая работа — ограниченный обзор сохранённого PWA/resource/sessionrestore source с явной границей currentpins; не новые recovery-прототипы.


## 31.10 — T021/T022: найден и исправлен PRIVATE пробел обновления открытой вкладки

Ограниченный source-review PWA обнаружил реальный gap: frozen joint cabinet/shop shells сохранили старые PALITRA_UI_BUILD и SESSION_UI_BUILD. Current native-matched update-observer сравнивает их; старая открытая вкладка не предложила бы обновление. Прежний Root bootstrap review проверял другую ограниченную область, не конечную доставку; новые targeted fixtures подтверждают отсутствие предложения у старого кандидата.

OPEN_SESSION_DELIVERY_R1_20261031 — отдельные2shell, только2literals каждый→synapse-company-app-20261031-case-products-r1. Fullreverse возвращает все исходные bytes; actual updateobserver exact. Cabce05204609d4a63940df7c47771d6cf0deba1b116283d61bfc20fe3c32ee51d6/373408B; shop173325f501d2ab881b18a4a842d68000d386932218023cc9a468f3a3c4180553/377837B. Остальные5jointfiles неизменны, EFFECTIVE_SOURCE_SET связывает7ссылок на код, не пакет выпуска. Frozen predecessor folders/manifests не менялись.

Root6новых targetedPASS854.5363ms/exit0: fullreverse/actualobserver, oldnegativecontrol, новые полные shell для cabinet/mainshop/draftshop offer/noauto, dirty/file/pending/unknown и явный trusted click, BFcachelate-response/restore, Node syntax обоих полных файлов. Fake window/transport/clock/blockers; не browser/physical/live QA и не постоянные таймеры. Старые16/32/30/22/8серии не повторялись; полная совместная liveприёмка нового набора не заявляется. Manifest10pins/input10pins; independentreviewfalse/NOTinstalled/runtimepackage-helper-R14false.

Архивные WORK_R7/archive-successor SW одинаковы, notifications-only/no fetchhandler/Cache API; baseline pushf260 exact по сохранённому manifest. ActiveSW/currentpush source не сверены, поэтому livePWA кеш не исключён. Previously current shell/chat5752 source имеет защищённый visibility/BFcache возврат. Native/network/subscription/pushregister/logout/dirtyreload/workerupdate/realorders/messages0. T021/T022/T011 остаются открыты до freshguarded integration/readback/live/independent review; старые файлы с прежней меткой не использовать как окончательный набор для открытых сеансов. Следующий самостоятельный пункт — ограниченно подтвердить реальные public фото из принятого trustedprice83 по точным наблюдаемым путям, без обогащения старых заказов текущим прайсом.
