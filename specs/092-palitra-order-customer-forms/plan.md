# План

Root — единственный production writer. Агенты работают в отдельных приватных областях: идентичность/сессия, телефонные формы, nullable render и подпись черновика. Основная ветка текущей доработки codex/palitra-order-customer-forms основана на установленной контентной ветке; её старые apply не повторяются.

1. Снять реальные manager-attention/conversation refs, текущие public HTML/JS и hash runtime. Кабинет и public shop имеют разные shell/native-host bytes; не копировать один поверх другого.
2. Сопоставить существующую conversation-v1/session-grants группировку с attention projection; сначала доказать каноническую связь. Не делать миграцию или новый identity join до проверки модели.
3. Проверить actual AccountService и поддержку подтверждения телефона. Optional demographics, маска и autofill отделены от изменения авторизации. Не устранять backend отказ только HTML required.
4. Реализовать ограниченные private candidates на fresh bytes, проверять literal patch outside-exact. Использовать существующие server session/grants/CSRF/формы и существующий транспорт.
5. Meaningful DOM/VM и SQLite проверки текущих функций/контрактов; browser read-only на существующих материалах и своей тестовой области. При установке runtime определить фактический сервис и его startup workers; отказ CRM queue guard не разрешает его отключить или изменить очередь.
6. Установка только нового bounded code-only пакета после fresh lease/base/backup; независимые runtime/static/public readbacks, live320/390, старые сеансы и cleanup. Пользовательские незавершённые формы сохранять. REPORT/CURRENT и доказательства приватны.

## Постоянный серверный выпуск

Следующий пакет меняет ровно шесть файлов сервиса content: `draft-account-service.cjs`, `site-workspace-feature.js`, `customer-chat.js`, `customer-chat-native-adapter.cjs`, `palitra-orders-public/shell.js`, `palitra-review-public/palitra-chat.js`. Образ строится из точного действующего родителя с одним слоем этих файлов, без установки зависимостей и сетевого доступа при сборке. Полное дерево `/app`, конфигурация образа и прочие слои сохраняются. Новый image-only overlay добавляется последним к свежей действующей цепочке Compose; CRM, Hugh, chat и Caddy не пересоздаются. Временная правка writable layer не является доставкой обновления.

AccountService используется также другими черновиками. Поэтому необязательные фамилия и адрес включаются только внутренним boolean флагом из существующей ветки фиксированного магазина Palitra после проверки origin; для остальных фабричных вызовов прежняя обязательность сохраняется. Запрос клиента не может включить этот флаг. Вход по email/password, CSRF, согласия и разделение сессий не меняются.

До единственного пересоздания content нужны проверенные исходники запуска, свежая собственная lease, точная конфигурация всех пяти сервисов, полный перечень постоянных баз и защищённые копии. Проверка очередей учитывает возможные эффекты запуска, старые неопределённые исходы и окно времени; очереди и флаги не изменяются. Встроенный мониторинг проверяется чистой проекцией предупреждений и локальным непрозрачным чтением существующего хранилища ключей: наружу только boolean результаты выбора провайдера, без значений ключей, балансов и сетевых обращений. Неопределённый результат установки разрешает только независимое чтение фактического состояния, без автоматического повтора или восстановления баз назад.

Два изменения управляемых файлов регистрации и профиля сохраняются штатным CAS как новые версии только после приёмки серверной части. Группировка списка обращений остаётся отдельным выпуском с отдельной проверкой typed refs, действий, счётчиков и страниц.

30Oct cross-tab FR-11: один bounded storefront335 patch. Subscribe на действующий readonly account-view закрывает профиль при unknown/guest/другом actor; DOM ручного ввода сохраняется скрытым. Прежние handlers получают pre/post identity fence, свежий session response обновляетCSRF только при принятойgeneration. Не менять backend/auth/cookies/провайдеры/очереди/othercompanies. Отдельная локальная Chrome приёмка, потом guarded managed update с новой основой и историей; старые apply не повторять.


## Приватное ядро email-восстановления

Только локальный прототип на неизменной копии принятого R7 AccountService; production маршруты, отправитель и runtime не подключаются. В приватном каталоге артефактов добавить recovery core с SQLite-таблицами одноразовых digest и зашифрованных почтовых заданий, фиксированным origin/realm и прежними Origin/CSRF/password проверками. Отдельный fake worker проверяет сохранённого получателя, неизвестный исход и запрет автоматического replay. Повторный/истёкший/чужой токен не меняет данные. Успешное подтверждение атомарно меняет пароль и отзывает сессии того же аккаунта без автоматического входа; прочие пользователи и их данные сохраняются.

Перед любой будущей интеграцией нужны отдельный внутренний mail-контракт, защищённое хранение ключа, клиентская форма, проверки равномерности ответов и реальные свежие runtime pins/backup/readback. Lead-outbox, его получатели и staff-reset не переиспользуются как recovery. Рабочие пароли, письма, SMS и производственные базы в этом прототипе не затрагиваются.


## Изолированный mail adapter

Следующий private-only слой: использовать существующий getEnvironment внутри CRM как поздний источник настроек, без возврата/копирования рабочих секретов в content. Прототип принимает только injected fake transport и явное internal-enabled. Проверяет существующий service key, отсутствие browser identity/Origin и отдельную HMAC-подпись точного намерения с ограниченным сроком. Fixed company/realm/origin и фиксированные reset-link/reset-completed шаблоны; произвольные subject/HTML/cc/вложения не принимаются. Digest-only журнал намерений сохраняется до send, повторный job не отправляется заново, потерянный/неопределённый исход не переводится в pending. Это новый приватный контракт, не подключённый endpoint; фактические guards/API/SMTP настройки не меняются. Проверки — только :memory:, fake settings/keys/transport, включая сохранённые настройки и idempotency/отказы.


## Приватная клиентская форма восстановления

Один reusable fragment и ранний bootstrap без сторонних скриптов/хранилищ: fragment-token читается в closure, query/hash удаляются до session fetch; при невозможности удаления форма закрыта. Fixed same-origin API, session/CSRF только через текущий GET, POST только по явному submit. Двойное нажатие и unknown outcome блокируются без auto retry/auto login; поздний ответ не стирает более поздний ввод. Referrer-policy no-referrer, обычный вход открывается отдельно, пароли очищаются только после подтверждённого успеха без последующих правок. Штатные login/forgotten страницы не меняются до backend-интеграции. Локальная проверка jsdom и при доступном Chrome — толькоlocalhost/fake accounts/transport, затем уборка собственного helper/tab.

## Приватный lifecycle ключа и очереди

Не выбирать рабочий secret по догадке и не читать его в прототипе. Явный master key из будущего защищённого источника; derive HKDF context по backend-approved realm/origin, fingerprint binding в своей account DB до начала worker, failclosed при замене key/id/origin и при попытке принять неизвестные существующие recovery rows. Ключ не генерируется заново при запуске. Текущие фабрики разделяют сеансы origin при общей account DB; caller realm обязан быть однозначно связан с approved origin.

Локальный lifecycle только сохраняет audit/метаданные: stale sending→uncertain, expired pending→cancelled, секретный envelope терминального задания очищается; uncertain никогда не pending. Жёсткое удаление токенов/истории не добавлять без отдельной политики. Ручной review не означает delivered; accepted допускается только owner-capability с HMAC witness из фактически accepted mail journal, совпадающим job/attempt/intent digest. Ни reconcile, ни sweep не отправляют письма/не меняют пароли/не создают токены. Проверки — fake SQLite, ключи, журналы, включая close/reopen с тем же ключом и отказ с другим; реальные routes/keys/runtime остаются отключены.

## Приватная assembly и локальный HTTP-контракт

RecoveryAccountService наследует неизменный AccountService; current/db/user/issue и обычные dispatch остаются прежними. Включение recovery только из серверного конструктора для фиксированного Palitra workspace/company/approved origin; клиентские поля не включают функцию. Отказ key/config закрывает только новые recovery endpoints, обычный вход сохраняется. Ручной worker без interval: claim→сохранённый dispatch witness→injected internal send; accepted требует свежую HMAC accepted receipt того же job/attempt/intent, неизвестное не повторяется. Administrative reconcile/sweep доступны только внутренним methods с trusted owner callback, не публичным account paths.

Локальный HTTP harness использует 127.0.0.1, fake SQLite/accounts/settings/transport и фиксированный Host gate; он не доказывает mapping рабочего site-workspace-http. Расширенный поиск нашёл исторический WORK_MAIN handler с aliases/per-origin cache, отличный от более старого single-alias варианта. Его неизменная копия проверяется с fake dependencies; до интеграции нужны actual current source/hash и factory/runtime pins. Нагрузку и timing измерять только bounded fake local requests, не отключая rate/concurrency guards. Локальная выборка не является доказательством одинаковой production latency или разрешением выпуска.
