# Задачи 228

- [x] T1 `team-chat.js`: таблица ответов агента, видимость и `agentReply` в `list`, обращение «Лео, …», `scope()`.
- [x] T2 `team-chat-answers.js`: запасной ответ Лео (`agent_pending` / `agent_redirect`), без дубля после `agent_answered`.
- [x] T3 `team-chat-agent.js`: `reply` (проверка тела, комнаты, `replyTo`, идемпотентность, статус `agent_answered`) и `inbox` (персона, комнаты владельца, 7 дней, 50, `since`).
- [x] T4 `people-http.js` / `people-service.js`: маршруты `agent-reply`, `agent-inbox` только владельцу, CSRF.
- [x] T5 Кабинет: подпись «Лео»/«Хью», статусы, подсказки.
- [x] T6 Тесты, полные наборы, gate; evidence.
