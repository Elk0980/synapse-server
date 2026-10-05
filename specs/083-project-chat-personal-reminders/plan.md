# План

Владелец: Claude (единственный автор). Разрешённые файлы: `ops/content/personal-reminders.js` (новый), `ops/content/project-chat.js`, `ops/content/project-chat-miniapp.js`, `ops/chat/project-chat-bridge.js`, `sites/synapse/cabinet/project-chat.js`, `sites/synapse/cabinet/miniapp-host.js`, `sites/synapse/cabinet/miniapp.css`, их тесты, этот каталог. `ops/chat/server.js` и `ops/content/server.js` не меняются: параметр `capabilities` в `/outbox` и строковые `jobId` в `/acknowledge` уже есть после PR441.

1. `project-chat-miniapp.js` — `allowsWriteToPm`/`authDate` из подписанного initData; таблица `project_chat_telegram_write_access` (Telegram ID + бот); запись после принятого nonce; `writeAccess`, `revokeWriteAccess`, `linksOfUser`, `botId`.
2. `personal-reminders.js` — таблица-журнал `project_chat_personal_reminders`, частичный уникальный индекс незавершённого напоминания; `recipients`, `list`, `create`, `pending`, `acknowledge`, `isJob`.
3. `project-chat.js` — создание модуля; маршруты GET/POST `/personal-reminders` (владелец); `pendingTelegram`: правка, затем личное напоминание по флагам; `acknowledgeTelegram`: `personal:<n>`.
4. `project-chat-bridge.js` — `personalDelivery`, флаги `edit,personal`, `status` у определённого отказа Bot API, пропуск задания без номера.
5. `sites/synapse/cabinet/project-chat.js` — кнопка, окно, журнал.
5a. `project-chat-miniapp.js` — `personal` в ответе входа (FR-013). `miniapp-host.js` — плашка над чатом и кнопка `requestWriteAccess` по нажатию, без отправки ответа окна; `miniapp.css` — стиль плашки (FR-014).
6. Тесты SC-001–SC-004; правка ожидания флага в `project-chat-bridge-edit.test.js` (теперь `edit,personal`); мутации; полные прогоны; gate.

7. Третья редакция (T010): `project-chat-miniapp.js` — схема `project_chat_telegram_write_access` с `auth_date` (подписанное, секунды), `received_at` (сервер), `revoked_floor`/`revoked_at`; упорядоченный `recordWriteAccess`; `writeAccessState` — единый критерий; `revokeWriteAccess` выставляет порог; `personal` во входе через `writeAccessState`. `personal-reminders.js` — `dispatchBlocker` (в т. ч. снятая задача), `access_auth_date` вместо времени наблюдения. `miniapp-host.js` — «подтверждено» только при `ready`, тексты `stale_permission`/`revoked`. Таблицы второй редакции нигде не развёрнуты (патч не выпускался), миграции не нужно.

8. Четвёртая редакция (T011): `project-chat-miniapp.js` — `FRESH_MARGIN_S = AUTH_FUTURE_S + 1` в `writeAccessState` и `revokeWriteAccess`, экспорт `freshMarginSeconds`; `personal-reminders.js` и `miniapp-host.js` — тексты о повторном входе через минуту. Схема не меняется. База — `main` 08984a2 (PR442 меняет только сайт Palitra).

Порядок выпуска любой: новый мост + старый content — флаг `personal` игнорируется; старый мост + новый content — напоминание не выдаётся. Схема меняется только добавлением двух таблиц.
