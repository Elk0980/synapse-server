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
| `CHAT_ADMIN_KEY` | Ключ API интерфейса владельца (`X-API-Key`) |
| `ALLOWED_ORIGINS` | Разрешённые CORS-origin через запятую |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота; может быть пустым для тестового режима |
| `TELEGRAM_WEBHOOK_SECRET` | Секрет заголовка webhook; обязателен для приёма обновлений |
| `TELEGRAM_OWNER_ID` | Числовой Telegram user id владельца |
| `CRM_URL` | Полный URL создания заявки, например `http://crm:8080/leads` |
| `CRM_API_KEY` | Ключ CRM в заголовке `X-API-Key` |
| `MODEL_API_URL` | Необязательный URL API модели |
| `MODEL_API_KEY` | Необязательный ключ модели |

Секреты задаются только через окружение и не должны попадать в репозиторий.

При создании заявки сервис передаёт CRM атрибуцию в полях `utmSource`, `utmMedium`, `utmCampaign`, `utmContent`, `clientId`, `referrer` и `landingPage`. Значение `utm_term` сохраняется в базе чата, но не отправляется в CRM, поскольку такого поля в CRM нет.

## API

* `POST /conversations` — создать диалог. Принимает `site`, `page`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `referrer`, `client_id`; возвращает `id`, `visitorToken` и приветствие.
* `POST /conversations/:id/messages` — отправить `{ "text": "..." }`. Нужен `Authorization: Bearer <visitorToken>` (либо `X-Visitor-Token`). Возвращает настоящий ответ ассистента.
* `GET /conversations/:id` — получить диалог целиком. Доступен посетителю с его токеном или оператору с `X-API-Key`.
* `GET /conversations` — последние диалоги оператора; нужен `X-API-Key`.
* `POST /conversations/:id/operator` — добавить операторское сообщение `{ "text": "..." }`; нужен `X-API-Key`.
* `GET /admin/conversations?company=palitra` — список входящих владельца.
* `GET`, `POST /admin/conversations/:id/messages` — история и ответ владельца.
* `POST /admin/conversations/:id/read` — сбросить счётчик непрочитанных.
* `PATCH /conversations/:id` — изменить компанию (`alvi`, `avokado`, `palitra`, `synapse`).

Административные методы используют `CHAT_ADMIN_KEY`. Веб-диалог получает ответы владельца в уже
существующем `GET /conversations/:id`; интерфейс посетителя может опрашивать этот метод.

## Telegram webhook

Добавьте бота администратором в групповой чат. Владелец может выполнить в группе `/company alvi`,
`/company avokado` или `/company palitra`. Команды не попадают в историю. Перед первым запуском
зарегистрируйте webhook вручную (значения берутся из серверного `.env`, в репозиторий их не пишут):

```sh
curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://chat.synapsebusiness.ru/telegram/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

Проверить регистрацию можно методом `getWebhookInfo`. Telegram передаёт секрет в заголовке
`X-Telegram-Bot-Api-Secret-Token`. Если токен не задан, входящие webhook всё равно можно тестировать,
а ответ владельца сохраняется вместе с системной пометкой о том, что отправка в Telegram не выполнена.

Для браузера реализован `OPTIONS`. Посетитель ограничен 20 сообщениями на диалог в минуту и 60 запросами на IP в час.

## Сценарий и модель

Все реплики обычного сценария находятся в объекте `SCRIPT` в начале `server.js`: их можно безопасно редактировать, сохраняя ключи объекта. Системная инструкция модели находится рядом, в константе `MODEL_SYSTEM_PROMPT`.

Чтобы включить модель, задайте одновременно `MODEL_API_URL` и `MODEL_API_KEY`. Сервис отправляет совместимый с Chat Completions JSON с массивом `messages`. Если модель недоступна или вернула ошибку, ошибка записывается в журнал, а посетитель без технического уведомления получает ответ обычного сценария. Сбор контакта и создание заявки в CRM продолжают работать в обоих режимах.
