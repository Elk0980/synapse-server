# План 229 — ответы ИИ в «Чатах» кабинета

Владелец работы — Claude-исполнитель (чат ЛК), ветка `claude/chat-ai-works`. Деплой, сервер,
ключи и живые данные не трогаются.

## Существующие модули
- `ops/content/team-chat-answers.js` — фильтр, контекст, черновик + проверка через `hugh-runtime`.
- `ops/content/team-chat.js` — отправка сообщения, решение «звать ли ИИ».
- `ops/content/hugh-personas.js` — персоны Хью и Лео, `instruction`, `detect` (без изменений).
- `ops/crm/people-http.js` — `GET /internal/people/teamChatContext`.
- `ops/hugh-runtime` — без изменений.

## Изменения
- Новый `ops/content/team-chat-ai.js`: `ownContacts`, `maskOwnContacts`, `persona`, `leoBrief`,
  `leoMaterials`, `handoffText`. Логика вынесена, чтобы правки в общих файлах были точечными.
- `team-chat-answers.js`: `unsafe(text,code,contacts)`, `cleanContext(data,code,persona)`,
  `candidate(...,contacts)`, `answer(message,{persona})`, запасной ответ от имени персоны,
  ожидание хода 20 с в пределах прежних 24 с.
- `team-chat.js`: одна строка вызова ИИ — персона по обращению.
- `ops/crm/people-http.js`: `contacts` всегда, `brief` при доступе к контент-плану.

## Контракты
`teamChatContext` → `{companyCode,tasks,plan,contacts:{phone,email,websiteUrl,links[]},brief?}` —
поля добавочные. `answers.answer(message,{persona})` — та же сигнатура, что в PR #615.
Миграций нет.

## Пересечение с PR #615 (claude/leo-agent-replies)
#615 меняет те же места `team-chat-answers.js` и строку вызова в `team-chat.js`. Слияние:
- `team-chat.js`: при конфликте взять версию #615 (`leoAddressed` + `detect`) — правило то же.
- `team-chat-answers.js`: оставить из 229 `who=ai.persona(...)`, `context(...)`, контакты и
  `handoff`; из #615 добавить ветку `agent_pending/agent_redirect` для Лео в `fallback()` и
  проверку `status==='agent_answered'` в `finish`. Подпись берётся из `who.author`.
  Системные тексты #615 (`SYSTEM.replace('Ты Хью','Ты Лео')`) заменить на `who.system/who.review`.

## Проверки
`NODE_PATH=… node --test` по изменённым и соседним файлам, полные `ops/content/*.test.js`,
`python3 tools/spec-kit/gate.py check`.
