# Локальный Хью: согласованный протокол первой версии

Решение Влада 17.09.2026: обработчик ответов временно работает на его Windows-компьютере, чат/вложения/задачи остаются на сервере Sb. При частых задержках из-за выключенного ПК обсудить отдельный хост. Платные API не подключаются. Код пишет Claude, проверяет и устанавливает Codex. Регион существующего сервера отклонён OpenAI; запросы модели с него не маскируются и не перенаправляются через прокси.

## Область и транспорт

- Исходящие HTTPS-запросы Windows worker к `/content/project-chat-worker/{heartbeat,claim,renew,complete}`, только POST, Bearer отдельного случайного ключа. Никаких входящих портов ПК и никаких глобальных CHAT_API_KEY/CONTENT_API_KEY в worker.
- Сервер хранит `HUGH_LOCAL_WORKER_KEY_SHA256` (hex SHA256), `HUGH_LOCAL_WORKER_COMPANIES=palitra-love`. Эти компании используют только local path, даже при выключенном ПК/неверной конфигурации. Прочие сохраняют существующий server path. Ключ и конфиг ПК находятся вне Git, с DACL владельца и SYSTEM; токен не наследуется дочерним Codex.
- Все операции проверяют ключ до чтения тела, scope по сохранённой компании задания, ограничение тела. Для тестов допускается явно разрешённый loopback HTTP; production требует HTTPS, редиректы запросов с ключом запрещены.
- `project_chat_ai_jobs` остаётся канонической очередью. Во всех массовых SQL существующего server worker (выборка, hold/offline, recovery) local companies исключаются. Исторические данные не удаляются.

## Запросы worker

- Heartbeat: `{bootId,status}`. Status — ограниченные публичные поля runtime (`state,authenticated,connected,available,limited,retryAfter,provider,model,safety,errorCode`), без кодов входа, адресов, текстов исключений и секретов. Ответ `{ok:true,serverTime,stats}`. Интервал 20 секунд, offline через 60 секунд по серверным часам; heartbeat продолжается во время вычисления ответа.
- Claim: `{bootId}` → `{job:null,retryAfter:5}` либо `{job:{id,kind,companyCode,payload,payloadHash,leaseToken,leaseExpiresAt}}`. Kind `reply` или `login`. Одна активная аренда. Reply выдаётся только при свежем подтверждённом готовом runtime; login допускается до авторизации. Claim атомарный. Payload reply — существующий сохранённый запрос с неизменным `jobId=project-chat:<ai job id>`; hash — SHA256 сохранённой строки. Для login payload `{}`. Lease 180 секунд.
- Renew: `{jobId,leaseToken}` → `{ok:true,leaseExpiresAt}` каждые 20 секунд параллельно работе. Токен при продлении не меняется; после повторного claim меняется.
- Complete: `{jobId,leaseToken,payloadHash,result}`. Reply success `{ok:true,text,provider,model}`; failure `{ok:false,errorCode,retryAfter}`. ErrorCode только из закрытого списка `LOGIN_REQUIRED,UNAVAILABLE,BUSY,RATE_LIMITED,INVALID_PAYLOAD,SAFETY_REJECTED,INTERNAL_ERROR`. Сервер формирует безопасные пояснения сам.
- Login success `{ok:true,status:{state,authenticated,connected,available,limited,retryAfter,provider,model,safety,loginUrl,userCode,expiresAt,errorCode}}`; поля кода/ссылки допускаются только при валидном официальном pending входе, ограничиваются TTL. Failure — тот же закрытый error envelope.
- Complete reply вставляет assistant message, Telegram outbox и done одной транзакцией. Повтор уже принятого результата с тем же финальным lease и вычисленным сервером result hash даёт 200; другой результат, заменённый lease или scope/mode mismatch — 409/403. Истекшая аренда позволяет новый claim, но сама по себе не должна терять уже вычисленный ответ, если не была заменена.
- Worker сохраняет результат на диск ДО complete, повторяет ACK до новых claim; неподтверждённые результаты не удаляются по retention. Job/payload сохраняются при обрыве и перезапуске; ровно одна публикация обеспечивается сервером. Ровно одна генерация при падении не обещается.

## Владелец и наблюдение

Уточнение стыка 17.09.2026 после проверки реализации: `job.id` у reply — строковое число из канонической очереди (например `"12"`), у login — `"login:3"`. Соответственно `payload.jobId="project-chat:12"`. Готовность к reply требует одновременно свежего heartbeat текущего boot, `authenticated`, `connected`, `available`, отсутствия `limited` и `safety.toolIsolationVerified=true`; `safety` — объект. Истечение аренды и выключение ПК не расходуют попытки. Смена addressed/delegate после постановки вопроса не отменяет уже выданный запрос; scope/mode mismatch относится к смене компании или local/server маршрута.

- Существующие owner `/content/project-chat-runtime/status` и `/login` получают `companyCode`; для local company status берётся из heartbeat и показывает offline/login/limit честно. POST login создаёт одну устойчивую команду, возвращает 202; повторный клик использует существующую pending команду или действительный pending код. Публичные snapshot участников не раскрывают loginUrl/userCode.
- При local offline все сообщения/задачи доступны, запросы ИИ ждут без расходования попыток. После возврата и входа worker очередь продолжается сама. Квота также не расходует попытки.
- Метрики с activation_at, без импорта истории: lastSeen, offline, pendingAi, oldestPendingAgeSeconds, humanMessagesWhileOffline24h, aiRequestsWhileOffline24h. Серверные часы, один учёт на message id; человеческие сообщения и запросы ответа считаются отдельно. Worker пишет безопасный `status.json` с этими метриками, без переписки, кодов и ключа, для последующего мониторинга.

## Windows

Node 24, закреплённый официальный Codex 0.154.0; direct HughRuntime внутри worker, без HTTP listener. Отдельные CODEX_HOME, пустой workspace, state SQLite. Проверка настоящего Windows бинаря уже прошла: инструментов 0, навязанных вызовов 14, отказов 14; каталог и proof в `C:/Users/Vlad/Documents/Codex/palitra-worker-preflight`. При установке повторно собрать каталог/proof для закреплённого бинаря, не подставлять тестовые fixtures.

Официальный бинарь найден: `C:/Users/Vlad/AppData/Local/npm-cache/_npx/4897a91091a83573/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`; для постоянного запуска скопировать vendor в устойчивый приватный каталог. Node: `C:/Program Files/nodejs/node.exe`. Автозапуск текущим пользователем при входе, Interactive/Limited, скрытый launcher ждёт Node, одна копия; перезапуск при сбое. Никаких новых паролей Windows.

## Приёмка и уточнения проверки

- По новому прямому указанию Влада все Claude-исполнители этой задачи используют Fable 5.1 (`claude-fable-5-1`).
- В mixed-company тестах проверяются все ветви прежнего обработчика: hold, offline, blocked recovery, claim и startup. Локальная компания не возвращается в прежний путь при отсутствующем ключе. При первоначальном включении локального режима восстанавливаются и прежние blocked/running задания без аренды.
- Message, Telegram outbox, done, final lease и result hash должны переживать перезапуск одной принятой транзакцией. Искусственный сбой внутри неё не оставляет частичного ответа; потерянное HTTP-подтверждение не создаёт второй ответ.
- Повторная выдача, продление, завершение после expiry до нового claim, устаревший lease, переключение режима и ручной retry проверяются отдельно. Ручной retry сохраняет payload и не отбирает действующую аренду.
- Метрики очереди агрегируют все задания, а не последние 200 из снимка комнаты. События offline считаются в серверной вставке нового сообщения; повторы запросов браузера/Telegram не увеличивают счётчики.
- Команда входа и показ её результата доступны только актуальной роли owner; CSRF проверяется до создания команды. Pending-вход не продлевает TTL от повторных кликов, не восстанавливается после смены boot или истечения срока. Коды не попадают в heartbeat, пользовательские снимки и status.json.
- Прямой `HughRuntime.reply()` не заменяет validation и операции job-store из HTTP-обёртки. `statusSnapshot()` не обновляет аккаунт и не запускает процесс. Срок действительного кода берётся из текущего `runtime.login.expiresAt`, без искусственного продления.
- Установленные Windows-дефолты планировщика: остановка через 72 часа, при переходе на батарею, отсутствие restart. Установщик задаёт бессрочное выполнение, восстановление, StartWhenAvailable и явную работу на батарее. Скрытая задача сама по себе не скрывает окно процесса; launcher запускается скрыто и ждёт Node. Проверяется второй ручной экземпляр.
- После локальных и CI-проверок: установка/повторная установка с сохранением состояния, реальный вход подписки, один живой ответ в ЛК и Telegram, остановка/возврат worker с восстановлением очереди. Проверка изоляции с mock-провайдером не объявляется живым ответом подписки.
