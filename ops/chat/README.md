# Чат — backend-сервис

Сервис хранит диалоги в SQLite, отвечает посетителю по редактируемому русскому сценарию и, когда собраны имя, телефон и вопрос, отправляет заявку в CRM. Внешняя модель не обязательна. Зависимостей npm нет: используются только встроенные модули Node.js и `node:sqlite`.

## Запуск

Нужен Node.js 22.5 или новее. Пример запуска: `API_KEY=secret ALLOWED_ORIGINS=https://example.ru node --experimental-sqlite server.js`. Файл `compose-fragment.yml` можно подключить к Compose через `docker compose -f docker-compose.yml -f ops/chat/compose-fragment.yml up -d chat`.

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `PORT` | Порт, по умолчанию `8080` |
| `DATABASE_PATH` | SQLite-файл, по умолчанию `/data/chat.sqlite` |
| `API_KEY` | Обязательный ключ операторских методов; при пустом значении сервис не запускается |
| `CHAT_ADMIN_KEY` | Ключ интерфейса владельца (`X-API-Key`) |
| `ALLOWED_ORIGINS` | Разрешённые CORS-origin через запятую |
| `CRM_URL` | Полный URL создания заявки, например `http://crm:8080/leads` |
| `CRM_API_KEY` | Ключ CRM в заголовке `X-API-Key` |
| `MODEL_API_URL` | Необязательный URL API модели |
| `MODEL_API_KEY` | Необязательный ключ модели |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота; при пустом значении ответы сохраняются, но не отправляются |
| `TELEGRAM_WEBHOOK_SECRET` | Секрет заголовка webhook; webhook отключён при пустом значении |
| `TELEGRAM_OWNER_ID` | Telegram user id Владислава для команды `/company` и уведомлений |

Секреты задаются только через окружение и не должны попадать в репозиторий.

При создании заявки сервис передаёт CRM атрибуцию в полях `utmSource`, `utmMedium`, `utmCampaign`, `utmContent`, `clientId`, `referrer` и `landingPage`. Значение `utm_term` сохраняется в базе чата, но не отправляется в CRM, поскольку такого поля в CRM нет.

## API

* `POST /conversations` — создать диалог. Принимает `site`, `page`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `referrer`, `client_id`; возвращает `id`, `visitorToken` и приветствие.
* `POST /conversations/:id/messages` — отправить `{ "text": "..." }`. Нужен `Authorization: Bearer <visitorToken>` (либо `X-Visitor-Token`). Возвращает настоящий ответ ассистента.
* `GET /conversations/:id` — получить диалог целиком. Доступен посетителю с его токеном или оператору с `X-API-Key`.
* `GET /conversations` — последние диалоги оператора; нужен `X-API-Key`.
* `POST /conversations/:id/operator` — добавить операторское сообщение `{ "text": "..." }`; нужен `X-API-Key`.
* `GET /admin/conversations[?company=alvi]` — список входящих владельца.
* `GET|POST /admin/conversations/:id/messages` — история и ответ владельца.
* `POST /admin/conversations/:id/read` — сбросить счётчик непрочитанных.
* `PATCH /conversations/:id` с `{ "company": "palitra" }` — изменить компанию.

Административные маршруты требуют `X-API-Key: <CHAT_ADMIN_KEY>`. Интерфейс находится по адресу `/inbox`, хранит ключ только в `localStorage` браузера и обновляется раз в пять секунд.

## Telegram-мост

Добавьте бота администратором в группу. Первое групповое сообщение автоматически создаёт Telegram-диалог. Владислав может привязать его командой `/company alvi`, `/company avokado` или `/company palitra`; команда принимается только от `TELEGRAM_OWNER_ID`.

Webhook регистрируется один раз вручную после задания переменных окружения:

```sh
curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  --data "{\"url\":\"https://chat.synapsebusiness.ru/telegram/webhook\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\",\"edited_message\"]}"
```

Проверить регистрацию можно методом `getWebhookInfo`. Токен и секрет нельзя помещать в командную историю или репозиторий на общем компьютере. Входящий webhook обязательно проверяется по `X-Telegram-Bot-Api-Secret-Token`. При новых сообщениях клиентов бот уведомляет `TELEGRAM_OWNER_ID` не чаще одного раза в минуту на диалог.

Для браузера реализован `OPTIONS`. Посетитель ограничен 20 сообщениями на диалог в минуту и 60 запросами на IP в час.

## Сценарий и модель

Все реплики обычного сценария находятся в объекте `SCRIPT` в начале `server.js`: их можно безопасно редактировать, сохраняя ключи объекта. Системная инструкция модели находится рядом, в константе `MODEL_SYSTEM_PROMPT`.

Чтобы включить модель, задайте одновременно `MODEL_API_URL` и `MODEL_API_KEY`. Сервис отправляет совместимый с Chat Completions JSON с массивом `messages`. Если модель недоступна или вернула ошибку, ошибка записывается в журнал, а посетитель без технического уведомления получает ответ обычного сценария. Сбор контакта и создание заявки в CRM продолжают работать в обоих режимах.
