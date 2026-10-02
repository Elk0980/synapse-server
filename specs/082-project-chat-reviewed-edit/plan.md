# План

Владелец: Claude (единственный автор кода). Разрешённые файлы: `ops/content/project-chat.js`, `ops/chat/project-chat-bridge.js`, `sites/synapse/cabinet/project-chat.js`, их тесты, `ops/content/server.js` (одна строка, необходимость ниже), этот каталог.

1. `ops/content/project-chat.js`
   - Таблица `project_chat_message_edits`, частичный уникальный индекс незавершённой правки, индекс очереди (`CREATE … IF NOT EXISTS`, существующие таблицы не меняются).
   - `editTarget` (FR-002), `createEdit` (FR-001–FR-005), `pendingEdit` (FR-006–FR-007, аренда 2 мин, 3 попытки), `acknowledgeEdit` (FR-009–FR-010).
   - `pendingTelegram(limit, {capabilities})`: правка — после очереди комнаты, до заявок сайта, только при `edit`.
   - `acknowledgeTelegram`: `edit:<n>` проверяется первым.
   - `decorateMessages`: `edit` (последняя правка) и `editedAt`.
   - Маршрут `/reviewed-messages/<id>/edit` рядом с `/reviewed-messages`.
2. `ops/chat/project-chat-bridge.js` — `editDelivery`, ветка `kind === 'edit'`, `description` у определённого отказа Bot API, `capabilities=edit` в запросе очереди, пропуск правки без номера `edit:<n>`, константа `TEXT_PART`.
3. `ops/content/server.js` — передать `capabilities` из запроса `/outbox` в `pendingTelegram`. Необходимость: без согласования версий content выдаёт правку и прежнему мосту, а он (проверено на `main` bc46689, evidence) отправляет её `sendMessage` новым сообщением — прямое нарушение FR-008. Других путей передать флаг нет: маршрут `/outbox` живёт только в `server.js`.
4. `sites/synapse/cabinet/project-chat.js` — `canEditMessage`, `editDialog`, `editNoteHTML`, обработчик кнопки.
5. Тесты SC-001–SC-004, мутации, полные прогоны, gate.

Порядок выпуска любой: новый мост + старый content — флаг игнорируется; старый мост + новый content — правка не выдаётся. `cabinet.html` и версия ресурсов не меняются (`/cabinet/*` отдаётся с `no-cache`).
