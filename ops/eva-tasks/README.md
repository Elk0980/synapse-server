# Eva — задачник SynapseBusiness

Первая версия читает **существующие задачи Synapse CRM**: Сегодня, Проекты, Все задачи,
Ждут меня, карточка со статусом и следующим шагом, возврат к списку. Создание и изменение
задач остаются в кабинете. Новая база задач, LLM, платные AI API и публичный endpoint не нужны.
Работа на Linux-сервере не зависит от компьютера Влада.

Состояние этого комплекта: код и инструкция подготовлены; реальный бот, токен, owner ID,
volume и серверный запуск **не проверены**. Подключение не выполнено самим наличием файлов.
Имя в Telegram — Eva; предлагаемый username `SynapseBusinessEvaBot` требует проверки в BotFather.
Спецификация: [085-eva-task-reader](../../specs/085-eva-task-reader/spec.md).

## Роли и продолжение работы между чатами

Владелец принимает финальные решения. Ева координирует задачи, приоритеты и проверку;
проектные чаты выполняют назначенное, сохраняют контекст и возвращают доказательства.
Текущее прямое поручение владельца определяет область и имеет приоритет над старой перепиской.
Кнопочный бот Eva v1 только показывает CRM: наличие этого кода не означает реализацию
координатора, автоматическую доставку в чаты, их синхронизацию или запуск исполнителей по таймеру.

Этапы рабочего процесса различаются, но **не добавляют новые значения tasks.status**:

| Этап | Что фиксировать в существующей задаче |
|---|---|
| assigned | Конкретный исполнитель, ответственный за задачу, область и критерий готовности |
| in_progress | Канонический статус in_progress и свежий checkpoint; статус не доказывает активный процесс |
| executor_completed | Результат исполнителя и evidence; это ещё не проверка/приёмка |
| reviewed | Отдельный вердикт проверяющего, evidence и дата; verified и accepted не смешивать |
| ожидание / блокер | Причина, от кого нужно действие и следующий шаг; произвольный blocker не означает «Ждут меня» |

Используются прежние assignee-поля, task_coordination (ответственный чат, исполнитель,
result, nextAction, blocker, milestones) и их revision/history. Статус done в показанной
CRM-карточке сам по себе не подтверждает независимое reviewed или финальную приёмку.

У задачи один ответственный за продолжение и один активный писатель общего ресурса.
При передаче старый и новый чаты ссылаются на тот же CRM taskId: сохраняют checkpoint,
явно передают область и подтверждают получение. Передача не создаёт вторую задачу и
не оставляет двух исполнителей одного ресурса. Запись в документе не является серверной арендой.
Связь с чатами проверяется отдельно; автоматическое соблюдение этих правил пока не заявлено.

## Что можно проверить без токена

Из корня checkout, Node.js 24 и Python 3.9+:

```sh
node ops/eva-tasks/demo.js
node --test ops/eva-tasks/*.test.js
python3 -m unittest discover -s ops/eva-tasks -p setup_test.py -v
```

Demo использует вымышленные задачи. Unit-тесты не обращаются к Telegram, Docker или production CRM.
Python-тесты проверяют в том числе Linux-контракт вызовов файловой системы через подмены;
их успех на Windows не заменяет проверку прав и монтирования на Linux.

## Ограниченный доступ и согласование

Текущая конфигурация **не монтирует CRM DB**. Опциональный обработчик внутри существующего
процесса CRM отдаёт только `GET /v1/tasks` через приватный UNIX socket. `EVA_TASK_PROJECTS` —
непустой JSON-массив индивидуально согласованных существующих company_code на стороне CRM.
Wildcard, неуказанные проекты и задачи без проекта не включаются. HTTP-порт не открывается.
Общий CRM key и основная `.env` не попадают в Eva. Полный [аудит вариантов](../../specs/085-eva-task-reader/least-privilege.md).

Перед включением требуется отдельное согласование точного объёма:

- Deployment проверенного commit и перезапуск только CRM для опционального обработчика.
- Новый отдельный socket volume: CRM читает исходную DB своим прежним доступом; Eva получает
  только socket, свой transport-state и личный token file. Каталог0700 и socket0600,
  общий runtime UID проверяет оператор. Root volume и права существующих данных не расширяются.
- Доступ только к указанным проектам и девяти полям: `id`, `title`, `companyCode`, `companyName`,
  `status`, `dueAt`, `nextAction`, `blocker`, `waitingForOwner`; оболочка `version`/`readAt`.
  Владелец видит ID, проект, название, статус, срок, следующий шаг и блокер. Эти свободные
  тексты могут содержать рабочие сведения; их передача в Telegram входит в согласование.
- Один постоянный Eva poller. Исходящие HTTPS только Telegram Bot API: `getMe`, `getWebhookInfo`,
  `getUpdates`, `sendMessage`, `editMessageText`, `answerCallbackQuery`. Только ответы на действия
  настроенного владельца; нет LLM, webhook, плановых сообщений, записи/создания задач.
- Влад лично вводит отдельный BotFather token в скрытое поле серверной консоли. Ни агент,
  ни CI не получают этот токен через чат.

Согласование проекта не означает автоматический доступ ко всем будущим компаниям. Удалённая
компания/задача перестаёт выдаваться при следующем чтении. Read-only mount socket не ограничивает
его методы: ограничения пути, scope и полей реализованы обработчиком.

## Подготовка оператора

Нужны Linux, Docker Engine/Compose v2, Python3.9+ и `tzdata`. Сначала оператор проверяет
реальный существующий CRM compose project/service, его UID и прежний источник environment.
Не угадывать production project name и не заменять основной env файлом Eva.

После отдельного согласования выбрать **новое уникальное имя** socket volume в переменной
`EVA_TASK_SOCKET_VOLUME`. Оно не должно обозначать CRM data volume. Собрать image:

```sh
sudo docker build -t synapse-eva:local ops/eva-tasks
```

Следующий блок отказывает существующему volume, помечает новый случайной меткой и меняет права
только нового пустого каталога. Для него требуется подтверждённый CRM UID0, как у Eva.
Если UID другой — остановиться и согласовать конфигурацию, не делать chown существующих данных.

```sh
(
  set -eu
  : "${EVA_TASK_SOCKET_VOLUME:?Set the individually approved NEW socket-only volume name}"
  if sudo docker volume inspect "$EVA_TASK_SOCKET_VOLUME" >/dev/null 2>&1; then
    echo 'Volume already exists; no changes made.' >&2
    exit 1
  fi
  eva_init_nonce=$(python3 -c 'import uuid; print(uuid.uuid4())')
  sudo docker volume create --label "synapse.eva.setup=$eva_init_nonce" "$EVA_TASK_SOCKET_VOLUME" >/dev/null
  eva_seen_nonce=$(sudo docker volume inspect --format '{{ index .Labels "synapse.eva.setup" }}' "$EVA_TASK_SOCKET_VOLUME")
  [ "$eva_seen_nonce" = "$eva_init_nonce" ] || { echo 'Volume ownership label mismatch; stopped.' >&2; exit 1; }
  sudo docker run --rm --pull=never --network none --read-only --user 0:0 \
    --cap-drop ALL --security-opt no-new-privileges=true --pids-limit 32 --memory 128m \
    --mount "type=volume,source=$EVA_TASK_SOCKET_VOLUME,target=/socket,volume-nocopy" \
    --entrypoint node synapse-eva:local -e 'const fs=require("node:fs");const p="/socket";const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||fs.readdirSync(p).length!==0)process.exit(2);fs.chmodSync(p,0o700);if((fs.lstatSync(p).mode&0o7777)!==0o700)process.exit(3);'
)
```

При ошибке volume сохраняется для разбора оператором, автоматического удаления нет.
[compose.eva-crm.example.yml](compose.eva-crm.example.yml) — выключенный по умолчанию override
только для существующего CRM compose project. Он добавляет socket mount и два параметра:
`EVA_TASK_SOCKET_PATH=/run/eva-tasks/tasks.sock`, `EVA_TASK_PROJECTS=<согласованный JSON>`.
Реальные company_code берутся из текущей CRM; примеры названий проектов не заменяют коды.
Оператор применяет его штатной командой существующего compose, сохраняя прежний env и project name,
сначала `config --quiet`, затем согласованное `up -d --build --no-deps crm`. Точная команда зависит
от проверенного server checkout/project и поэтому не подменяется выдуманным абсолютным путём.

CRM handler выключен, если оба параметра отсутствуют; частичная/неверная настройка отказывает.
Он требует существующий закрытый родительский каталог, не исправляет его права и не перехватывает
чужой/stale socket. После аварии оператор подтверждает остановку прежнего процесса перед разбором socket.
Не менять и не заменять socket/volume при живом listener: Node/libuv при close сам удаляет путь
привязки; проверка inode защищает только дополнительную очистку нашего кода.

## Личный ввод токена

Влад создаёт отдельного бота через официальный BotFather и подтверждает свой **числовой Telegram
user ID** из доверенного источника. Username/телефон не подходят; первый написавший не получает доступ.
Оператор открывает Владу доверенную личную SSH-консоль на сервере в корне согласованного checkout:

```sh
sudo python3 ops/eva-tasks/setup.py
```

Программа спросит owner ID, IANA timezone, проверенное имя socket volume и затем **скрытое поле
токена**. Символы не отображаются. Не вставлять токен в чат, командную строку, GitHub, основной env,
скриншот или запись терминала. Setup не делает сетевых запросов и не запускает контейнер.

Создаются только новые файлы вне репозитория:

| Путь | Содержание | Владелец/права |
|---|---|---|
| `/etc/synapse/eva/` | Закрытый каталог | root0700 |
| `/etc/synapse/eva/telegram-token` | Токен бота | root0600 |
| `/etc/synapse/eva/eva.env` | Owner ID, timezone, точное имя socket volume | root0600 |

Существующие файлы не читаются/не перезаписываются; ссылки, чужой владелец и небезопасные права
вызывают отказ. При прерывании возможен частично созданный файл: оператор разбирает его локально,
не удаляя и не расширяя права вслепую. Ротация token и передача владельца автоматически не выполняются.

## Запуск и live-приёмка

Только после отдельного согласования, настройки socket и личного ввода токена:

```sh
sudo docker compose --env-file /etc/synapse/eva/eva.env -p synapse-eva -f ops/eva-tasks/compose.eva.yml config --quiet
sudo docker compose --env-file /etc/synapse/eva/eva.env -p synapse-eva -f ops/eva-tasks/compose.eva.yml up -d --build
sudo docker compose --env-file /etc/synapse/eva/eva.env -p synapse-eva -f ops/eva-tasks/compose.eva.yml ps
sudo docker compose --env-file /etc/synapse/eva/eva.env -p synapse-eva -f ops/eva-tasks/compose.eva.yml logs --tail 30 eva
```

Не объединять Eva compose с корневым compose: это отдельный проект. Он работает UID0 с
`cap_drop: ALL`, `no-new-privileges`, read-only root, без портов/Docker socket и с лимитами ресурсов.
`.dockerignore` включает только runtime/bot/socket-source и Dockerfile. DB adapter в image не входит.
External socket volume должен уже существовать; не создаётся пустая CRM вместо канонической базы.

Runtime сверяет bot ID с token prefix через `getMe`, отказывает при webhook, создаёт клиент socket
и начинает polling. Доступность и свежесть источника проверяются при запросе задач. Каждый message/callback снова проверяет owner ID и private chat.
Источник ограничивает размер/срок ответа и проверяет точную схему; ошибка не выглядит пустым списком.
Логи содержат только события/числовые коды, state — cursor/lock. `started` не означает приёмку.

Влад лично проверяет созданного бота:

1. Сегодня, Проекты, Все задачи, Ждут меня, карточку, Назад/Главная, пустой список и пагинацию.
2. ID/проекты/статусы совпадают с кабинетом. После правки в кабинете повторное открытие показывает
   свежие сведения. Проект вне allowlist недоступен; содержимое CRM не меняется от запросов Eva.
3. Сегодня включает просрочку в настроенном timezone; Все включает закрытые; Ждут меня использует
   явное назначение owner/dispatch needs_input или review. Произвольный blocker недостаточен.
4. Другой согласованный тестовый аккаунт/группа не получает данных; реального клиента не подключать.
5. По отдельности фиксируются «подключён», «проверен live», «принят» с датой и evidence.

Остановить только Eva, сохранив настройки и cursor:

```sh
sudo docker compose --env-file /etc/synapse/eva/eva.env -p synapse-eva -f ops/eva-tasks/compose.eva.yml stop eva
```

Для полного отзыва доступа оператор также отключает CRM overlay и применяет штатный CRM deploy.
Не удалять основной CRM volume или transport-state. После аварии runtime.lock не перехватывается:
сначала подтвердить остановку всех poller этого token, затем разбирать stale lock. Cursor сохраняется
до ответа: после аварии возможен потерянный экран, восстанавливаемый `/tasks`. Exactly-once доставка
не гарантируется. Код и CI не заменяют проверку production permissions, подключения и личную приёмку.
