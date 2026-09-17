# Локальный обработчик Хью (Windows)

Половина «клиент + установщик» протокола из `docs/local-hugh-worker-contract.md`. Обработчик
работает на Windows-компьютере владельца, ходит к серверу Sb только исходящими HTTPS-запросами
и вызывает приватный рантайм Hugh напрямую (`ops/hugh-runtime/runtime.js`), без HTTP-слушателей.
Внешних npm-пакетов нет: Node 24 и встроенные модули (`node:sqlite`, `node:https`).

Файлы `ops/hugh-runtime/**` не изменялись: worker переиспользует `HughRuntime`, `createJobStore`,
`validateReplyPayload`/`canonicalPayload`, `device-login` и скрипты `test-support`.

## Что делает worker (`worker.js`)

| Шаг | Поведение |
| --- | --- |
| heartbeat | первый — до первого claim (сервер выдаёт reply только при свежем heartbeat той же загрузки), далее каждые 20 с независимо от генерации: `{bootId, status}` только с полями `state, authenticated, connected, available, limited, retryAfter, provider, model, safety, errorCode`. Кодов входа там нет никогда |
| claim | `{bootId}` — только когда нет активного задания и outbox пуст. Ответ разбирается строго (`id, kind∈{reply,login}, companyCode, payload, payloadHash hex64, leaseToken, leaseExpiresAt`); задание сразу пишется на диск |
| scope | `companyCode` не из списка `companies` (по умолчанию `palitra-love`) — задание не выполняется и не завершается, claim замирает на 5 минут, в статусе растёт `scopeRejected` |
| reply | `validateReplyPayload` → локальный хэш `canonicalPayload` → `store.claim` (готовый ответ переиспользуется без второй генерации) → `runtime.reply` → `store.complete/fail/release` как в `http-server.js`. В `complete` уходит **полученный** `payloadHash`; расхождение с локальной сверкой только считается |
| login | `runtime.startLogin()`; в `complete` — публичные поля плюс `loginUrl, userCode, expiresAt` **только** пока `runtime.login.status === 'pending'`, срок не вышел и адрес/код прошли проверки `device-login.js`. `expiresAt` — из `runtime.login.expiresAt`, не выдумывается. Рантайм показывает ожидающий вход как `connecting`, а сервер принимает код только в состоянии входа — поэтому в результате login `state` = `login_pending` (в heartbeat остаётся состояние рантайма) |
| renew | каждые 20 с параллельно генерации; 4xx помечает `leaseLost`, генерация всё равно доводится и complete решает сервер |
| outbox | результат пишется в SQLite **до** complete (`outbox.js`, транзакция с удалением активного задания). 200 → подтверждено; 400/403/404/409/… → окончательный отказ; 401/5xx/сеть → повтор с backoff 5…60 с. Пока есть неподтверждённый результат, claim не идёт. Retention удаляет только подтверждённые записи |
| перезапуск | активное задание без результата: аренда истекла по локальным часам → отпускается; иначе `renew` — подтверждена → генерация заново с той же арендой, отказ/сеть → отпускается (сервер выдаст заново). Аренда `job-store` снимается явно через `store.release`, не дожидаясь 10 минут |
| обслуживание | раз в минуту: `warmUp()` если процесс Codex не запущен, `refreshAccount()` не чаще раза в 5 минут (и `runPreflight()` если он ещё не прошёл); раз в час `store.prune()` и `outbox.pruneAcked()` |
| коды отказа | только `LOGIN_REQUIRED, UNAVAILABLE, BUSY, RATE_LIMITED, INVALID_PAYLOAD, SAFETY_REJECTED, INTERNAL_ERROR` (`error-codes.js`), `retryAfter` из рантайма или по умолчанию |

Журнал (`logs/worker.log`) и `state/status.json` содержат только короткие коды, числа и время:
без переписки, ключа, адресов, кодов входа и текстов исключений (`status-file.js` строит документ
по белым спискам; `transport.js` сводит ошибки сокета к категории `dns|network|timeout|tls|…`).

## Транспорт (`transport.js`)

Только POST на `<endpoint>/{heartbeat,claim,renew,complete}`, `Authorization: Bearer <ключ>`.
Endpoint проверяется строго: `https`, без логина/пароля, параметров и якоря, путь ровно
`/content/project-chat-worker`. Редиректы не выполняются (3xx → `redirect_blocked`), тело ответа
ограничено 512 KiB, TLS ≥ 1.2 с проверкой сертификата. Таймаут (30 с) — по настенным часам на
весь запрос: подключение, заголовки и тело; капающее по байту тело его не продлевает. Голый HTTP допускается только на loopback и
только с `allowInsecureLoopback: true` (тесты). Ключ живёт в замыкании транспорта; в `settings`,
статус и окружение дочернего Codex он не попадает (`runtime.childEnv()` собирает белый список).

## Установка на Windows (запускает Хью / владелец)

Из корня репозитория, в **Windows PowerShell 5.1** (без администратора):

```
powershell -NoProfile -ExecutionPolicy Bypass -File ops\local-hugh\install\Install-SynapseHugh.ps1 `
  -VendorSource "C:\Users\Vlad\AppData\Local\npm-cache\_npx\4897a91091a83573\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc" `
  -Endpoint "https://<сервер>/content/project-chat-worker"
```

Необязательные параметры: `-NodeExe` (по умолчанию `C:\Program Files\nodejs\node.exe`),
`-Companies palitra-love`, `-Model gpt-5.5`, `-RegenerateKey`, `-SkipTask`, `-NoStart`.
Служебные режимы: `-ShowKeyHash` (только SHA256 ключа), `-Uninstall` (удаляет задачу, данные остаются).

Установщик:

1. проверяет `node --version` = 24.x и `codex --version` = `codex-cli 0.154.0` у исходного и скопированного бинаря;
2. раскладывает `%LOCALAPPDATA%\SynapseHugh\{app,vendor,build,bin,secret,state,logs,codex-home,workspace}`,
   ставит DACL «владелец + SYSTEM» на корень (`icacls /inheritance:r`) и сбрасывает права детей на унаследованные;
3. копирует `ops/hugh-runtime` (без тестов) и `ops/local-hugh` в `app\`, vendor Codex — в `vendor\`;
4. собирает `build\restricted-models.json` из `codex debug models --bundled` **этого** бинаря
   (с пустым временным CODEX_HOME/профилем — настольная сессия Codex не читается) и прогоняет
   `test-support/run-isolation-check.js` на настоящем процессе с mock-провайдером на loopback.
   Без записанного `build\tool-isolation-proof.json` установка останавливается;
5. создаёт `secret\worker.key` (32 случайных байта, hex), если его нет; печатает **только** SHA256
   для `HUGH_LOCAL_WORKER_KEY_SHA256` на сервере. Сам ключ никуда не выводится;
6. пишет `config.json`, собирает скрытый запускатель `bin\SynapseHughLauncher.exe`
   (`Add-Type -OutputType WindowsApplication` из `install/SynapseHughLauncher.cs`: без окна, ждёт
   `node.exe`, возвращает его код выхода, mutex одного экземпляра, Job Object «убить при закрытии»);
   при сбое компиляции — запасной `SynapseHughLauncher.vbs` через `wscript //B`;
7. регистрирует задачу `SynapseHughWorker`: триггер «при входе» текущего пользователя, principal
   Interactive/Limited, `MultipleInstances=IgnoreNew`, `ExecutionTimeLimit=PT0S` (без предела 72 ч),
   `RestartCount=999` каждые 1 мин, `StartWhenAvailable`, батарея не мешает; затем запускает.

Обновление — та же команда (`-Endpoint` можно опустить): удаляются и пересоздаются только
`app\`, `vendor\x86_64-pc-windows-msvc\`, `build\bootstrap`, `bin\` внутри корня установки
(`Assert-InsideRoot`); `secret\`, `state\`, `codex-home\` не трогаются. Перед копированием задача
останавливается и ожидается выход процесса по PID из `state\worker.lock`.

Ничего из `%USERPROFILE%\.codex` не читается и не копируется; новых паролей Windows нет.

## Наблюдение

Безопасный статус: `%LOCALAPPDATA%\SynapseHugh\state\status.json` — `worker.*` (счётчики,
активное задание, outbox), `runtime.*` (публичные поля, `loginPending`), `server.*` (последний
heartbeat и метрики `lastSeen, offline, pendingAi, oldestPendingAgeSeconds,
humanMessagesWhileOffline24h, aiRequestsWhileOffline24h` из ответа сервера).

```
Get-Content "$env:LOCALAPPDATA\SynapseHugh\state\status.json"
Get-ScheduledTaskInfo -TaskName SynapseHughWorker
Get-Content "$env:LOCALAPPDATA\SynapseHugh\logs\worker.log" -Tail 50
```

Ручной запуск для отладки (с консолью, журнал дублируется на экран):

```
& "C:\Program Files\nodejs\node.exe" "$env:LOCALAPPDATA\SynapseHugh\app\local-hugh\main.js"
```

Второй экземпляр завершается кодом 0 («уже запущен»: файл-замок с PID + mutex запускателя).

## Тесты

```
node --test ops/local-hugh/*.test.js
```

Все тесты офлайн: поддельный транспорт по сценарию, поддельный рантайм, настоящие SQLite во
временном каталоге, управляемые часы (`test-support/fakes.js`). Покрыто: heartbeat без кодов входа,
claim→outbox→complete с эхом hash, идемпотентность, недоступный complete и повтор до новых claim,
409/401/5xx, перезапуск с неподтверждённым результатом и с прерванной генерацией (renew ок / 409 /
истёкшая аренда), таймеры heartbeat и renew во время хода, login с TTL, коды отказа, scope,
offline, обслуживание, отсутствие секретов в статусе и журнале; транспорт на loopback HTTP
(заголовки, редирект, лимит тела, таймаут по настенным часам, категории ошибок); outbox;
конфигурация; status.json.

`worker-server.integration.test.js` — настоящий стык: поднимает живой `ops/content/server.js`
(ключ worker, `HUGH_LOCAL_WORKER_COMPANIES=palitra-love`, серверная служба Хью на мёртвом порту)
и гоняет настоящий `LocalHughWorker` с настоящим транспортом (loopback HTTP по явному флагу) и
настоящими SQLite; подменён только Codex (`FakeRuntime`). Проверяет: команда входа → код у
владельца через complete и не в снимке комнаты, отсутствие генерации до подтверждённого входа,
ответ в чате, renew при долгой генерации, перезапуск без дублей, второй ответ новой загрузкой,
status.json без ключа/кода/адреса. Сеть и подписка не нужны.

Установщик и запускатель без установки и без планировщика:

```
powershell.exe -NoProfile -File ops\local-hugh\install\Test-InstallerOffline.ps1
```

Проверяет UTF-8 BOM и разбор `Install-SynapseHugh.ps1`, компилирует `SynapseHughLauncher.cs` в
`ops\local-hugh\test-output` (WinExe, PE Subsystem 2), поведение запускателя (код выхода node,
пути с пробелами, mutex второго экземпляра, закрытие node при завершении запускателя), VBS-запасной
вариант, границы `Remove-Managed` (корень, `..`, похожий префикс — отказ), параметры задачи как
объекты (`PT0S`, RestartCount/Interval, батарея, IgnoreNew, Interactive/Limited) — без
`Register-ScheduledTask`. Отдельно по AST: каждый `Start-Process` установщика идёт с
`-WindowStyle Hidden` и без `-NoNewWindow` (правило среды для фоновых helper), а запускатель
стартует node с `CreateNoWindow`/`ProcessWindowStyle.Hidden`. Артефакты убираются в `finally`;
`test-output/` в `.gitignore`.

**Кодировка `.ps1`.** Windows PowerShell 5.1 читает файлы без BOM в ANSI, и кириллица в строках
ломает разбор. Оба скрипта сохранены с UTF-8 BOM; проверка BOM входит в тест. При правках
сохраняйте BOM.

## Ограничения

- Ровно одна генерация при падении не гарантируется (контракт): после перезапуска с
  подтверждённой арендой генерация повторяется; ровно одну публикацию обеспечивает сервер.
- `payloadHash` считается сервером от сохранённой строки; worker не может воспроизвести её
  байт в байт, поэтому возвращает полученный хэш и лишь считает расхождения локальной сверки.
- Установщик компилирует запускатель через `Add-Type` (нужен .NET Framework 4.x с csc — есть в
  Windows 11). Запасной вариант — VBScript; на системах без VBScript останется только режим
  «видимая консоль», тогда пересоберите WinExe.
- Регистрация задачи для текущего пользователя без администратора возможна в стандартной
  политике Windows; если групповая политика это запрещает, используйте `-SkipTask` и
  зарегистрируйте задачу вручную по тем же параметрам.
- Живой обмен с подпиской (модель `gpt-5.5`) локальными тестами не покрывается — только
  установкой на реальном бинаре и первым сообщением в чате.
