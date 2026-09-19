'use strict';

/* Личная переписка владельца Synapse с Хью по каждому проекту.

   Требование владельца 19.09.2026: во вкладке «Хью» его личного кабинета переписка идёт
   только между владельцем и Хью, без клиентов. Общий чат клиент+владелец+Хью остаётся
   отдельным разделом каждой компании. Истории не смешиваются даже в пределах одной компании.

   Почему отдельные таблицы, а не признак в общих
   ----------------------------------------------
   Изоляция здесь не фильтр в интерфейсе и не условие, которое можно забыть дописать.
   Личные сообщения лежат в собственных таблицах `owner_private_*`, а весь клиентский
   маршрут (`project_chat_*`, вложения, исходящая очередь, Telegram, задания модели)
   физически не читает эти таблицы. Пропущенное условие в одном запросе не может открыть
   личную историю клиенту, потому что клиентский код к ней не обращается вовсе.

   Область в каждом обращении
   --------------------------
   Каждый запрос и каждая запись ограничены тройкой `owner_user_id` + `company_code` +
   `audience='owner-private'`. Владелец берётся только из серверной сессии: роль из тела
   запроса, заголовков и клиентского профиля не читается никогда. Второй владелец не видит
   переписку первого — область привязана к конкретной учётной записи, а не к роли.

   Чего здесь намеренно нет
   ------------------------
   - Очереди заданий: ответ запрашивается синхронно и сохраняется в том же обращении.
     Поэтому повторный проход общей очереди не может записать личный ответ в общий чат:
     личных заданий в общей очереди не существует.
   - Вложений, поиска и сводок: их нет ни в одной из сторон, поэтому и переносить нечего.
   - Переноса из личной переписки в клиентские задачи. Задачи проекта показываются
     карточками только на чтение. Запись отложена сознательно — см. docs/owner-private-chat.md. */

const { COMPANIES } = require('./auth-store');

const AUDIENCE = 'owner-private';
const HISTORY_LIMIT = 40;
const CONTEXT_LIMIT = 20;
const MESSAGE_LIMIT = 4000;
const TASK_CARDS = 20;
const REQUEST_ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/i;

function fail(status, message, details) {
  throw Object.assign(new Error(message), { status, details });
}
const shortText = (value, max) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);

const SYSTEM = 'Ты Хью, бизнес-ассистент Синапс Бизнес. Это личная переписка владельца Synapse ' +
  'по проекту, клиент её не видит и не получит. Отвечай по-русски, кратко и по существу. ' +
  'Не предлагай отправить что-либо клиенту от его имени и не утверждай, что сообщение клиенту ' +
  'отправлено: из этой переписки ничего не уходит ни в общий чат проекта, ни в Telegram. ' +
  'Задачи проекта показаны владельцу отдельными карточками только для справки: изменить их ' +
  'отсюда нельзя, предложи владельцу сделать это в общем чате проекта. ' +
  'Не выдумывай цены, сроки и сведения о других компаниях.';

function createOwnerPrivateChat({ db, authStore, requireSession, requireCsrf, sendJson, readBody,
  ask, skills = null, now = () => Date.now() }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_private_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id INTEGER NOT NULL,
      company_code TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT '${AUDIENCE}' CHECK (audience = '${AUDIENCE}'),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner_user_id, company_code)
    );
    CREATE TABLE IF NOT EXISTS owner_private_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES owner_private_threads(id) ON DELETE CASCADE,
      -- Владелец и компания дублируются в строке намеренно: условие области попадает
      -- в каждый запрос напрямую, без надежды на соединение с таблицей веток.
      owner_user_id INTEGER NOT NULL,
      company_code TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT '${AUDIENCE}' CHECK (audience = '${AUDIENCE}'),
      author_type TEXT NOT NULL CHECK (author_type IN ('owner', 'assistant')),
      text TEXT NOT NULL,
      request_id TEXT,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS owner_private_messages_scope
      ON owner_private_messages(owner_user_id, company_code, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS owner_private_messages_request
      ON owner_private_messages(owner_user_id, company_code, request_id)
      WHERE request_id IS NOT NULL;
  `);

  const stamp = () => new Date(now()).toISOString();

  /* Владелец определяется только сервером: сессия, затем перечитанная учётная запись.
     Роль, идентификатор и компания из тела запроса не участвуют. */
  function owner(request, { write = false } = {}) {
    const session = requireSession(request);
    const user = authStore.getById(session.user?.id);
    if (!user || user.sessionVersion !== session.user.sessionVersion) fail(401, 'Требуется вход в кабинет');
    // Личная переписка существует только у владельца Synapse. Клиентские учётные записи
    // создаются ролью editor, поэтому получить сюда доступ они не могут ни при каких правах.
    if (user.role !== 'owner') fail(403, 'Личная переписка с Хью доступна только владельцу');
    if (write) requireCsrf(request, session);
    return user;
  }

  const company = (code) => {
    if (typeof code !== 'string' || !Object.hasOwn(COMPANIES, code)) fail(404, 'Неизвестный проект');
    return code;
  };

  function thread(ownerId, code) {
    const found = db.prepare(`SELECT * FROM owner_private_threads
      WHERE owner_user_id=? AND company_code=? AND audience=?`).get(ownerId, code, AUDIENCE);
    if (found) return found;
    const at = stamp();
    db.prepare(`INSERT INTO owner_private_threads(owner_user_id,company_code,audience,created_at,updated_at)
      VALUES(?,?,?,?,?)`).run(ownerId, code, AUDIENCE, at, at);
    return db.prepare(`SELECT * FROM owner_private_threads
      WHERE owner_user_id=? AND company_code=? AND audience=?`).get(ownerId, code, AUDIENCE);
  }

  const history = (ownerId, code, limit = HISTORY_LIMIT) =>
    db.prepare(`SELECT id,author_type,text,created_at FROM owner_private_messages
      WHERE owner_user_id=? AND company_code=? AND audience=? ORDER BY id DESC LIMIT ?`)
      .all(ownerId, code, AUDIENCE, limit).reverse();

  const messageJSON = (row) => ({ id: row.id, author: row.author_type, text: row.text, at: row.created_at });

  /* Карточки задач клиентского проекта — только для чтения и только если таблица существует.
     Личная переписка их не меняет и в них не попадает. */
  function taskCards(code) {
    try {
      return db.prepare(`SELECT id,title,status,due FROM project_chat_tasks
        WHERE company_code=? ORDER BY (status='done'), id DESC LIMIT ?`).all(code, TASK_CARDS)
        .map((row) => ({ id: row.id, title: shortText(row.title, 200), status: row.status, due: row.due || null }));
    } catch { return []; }
  }

  function view(user, code) {
    thread(user.id, code);
    return {
      audience: AUDIENCE,
      audienceLabel: 'Личная переписка: только вы и Хью. Клиент её не видит.',
      project: { id: code, name: COMPANIES[code]?.name || code },
      projects: Object.entries(COMPANIES).map(([id, item]) => ({ id, name: item.name || id })),
      messages: history(user.id, code).map(messageJSON),
      /* Задачи клиентского проекта показываются отдельно от личной истории и только на чтение.
         Ссылка ведёт в общий чат проекта, где аудитория другая. */
      tasks: taskCards(code),
      clientChat: { href: `#hugh-project:${code}`,
        label: `Общий чат проекта: клиент, вы и Хью — видно клиенту`,
        audience: 'client-shared' },
      handoff: { enabled: false,
        reason: 'Перенос из личной переписки в задачи проекта пока не включён: задачи показаны только для чтения.' },
    };
  }

  async function send(user, code, body) {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) fail(400, 'Сообщение пустое');
    if (text.length > MESSAGE_LIMIT) fail(400, `Сообщение длиннее ${MESSAGE_LIMIT} символов`);
    const requestId = body?.requestId === undefined || body?.requestId === null ? null : String(body.requestId);
    if (requestId !== null && !REQUEST_ID_RE.test(requestId)) fail(400, 'Некорректный идентификатор запроса');
    // Посторонние поля отклоняются: попытка передать роль, владельца или аудиторию телом
    // запроса не должна выглядеть как поддерживаемая возможность.
    for (const key of Object.keys(body || {})) {
      if (!['text', 'requestId'].includes(key)) fail(400, `Поле ${key} в личной переписке не принимается`);
    }
    const row = thread(user.id, code);
    if (requestId) {
      const seen = db.prepare(`SELECT id FROM owner_private_messages
        WHERE owner_user_id=? AND company_code=? AND audience=? AND request_id=?`)
        .get(user.id, code, AUDIENCE, requestId);
      if (seen) return { repeated: true, ...view(user, code) };
    }
    const at = stamp();
    db.prepare(`INSERT INTO owner_private_messages
      (thread_id,owner_user_id,company_code,audience,author_type,text,request_id,created_at)
      VALUES(?,?,?,?,'owner',?,?,?)`).run(row.id, user.id, code, AUDIENCE, text, requestId, at);
    db.prepare('UPDATE owner_private_threads SET updated_at=? WHERE id=?').run(at, row.id);

    const past = history(user.id, code, CONTEXT_LIMIT);
    /* В модель уходит только личная история этого владельца по этому проекту.
       Сообщения общего чата, вложения и задания клиентской очереди сюда не подмешиваются. */
    /* Навык из доверенного каталога — тот же механизм, что и в общем чате. Отказ загрузчика
       не должен ломать переписку. */
    let skill = null;
    try { skill = skills?.instructions?.(text, { companyCode: code }) || null; }
    catch { skill = null; }
    const payload = {
      jobId: `owner-private:${user.id}:${code}:${row.id}:${past[past.length - 1]?.id || 0}`,
      companyCode: code,
      audience: AUDIENCE,
      system: `${SYSTEM}${skill ? `\n\n${skill.text}` : ''}`,
      messages: past.map((item) => ({ role: item.author_type === 'assistant' ? 'assistant' : 'user', content: item.text })),
    };
    let answer;
    try { answer = await ask(payload, { companyCode: code, audience: AUDIENCE }); }
    catch (error) {
      // Вопрос владельца сохранён: ответ можно запросить снова, ничего не потеряно.
      fail(error?.status && error.status >= 400 && error.status < 600 ? error.status : 503,
        error?.message || 'Хью сейчас недоступен', { code: 'ASSISTANT_UNAVAILABLE' });
    }
    const reply = typeof answer?.text === 'string' ? answer.text.trim() : '';
    if (reply) {
      db.prepare(`INSERT INTO owner_private_messages
        (thread_id,owner_user_id,company_code,audience,author_type,text,provider,model,created_at)
        VALUES(?,?,?,?,'assistant',?,?,?,?)`)
        .run(row.id, user.id, code, AUDIENCE, reply,
          shortText(answer.provider, 100), shortText(answer.model, 100), stamp());
    }
    return { repeated: false, ...view(user, code) };
  }

  async function handle(request, response, url) {
    const match = url.pathname.match(/^(?:\/content)?\/owner-chat(?:\/([a-z0-9_-]{1,40}))?(.*)$/);
    if (!match) return false;
    const code = match[1] || '', suffix = match[2] || '', method = request.method;
    const reply = (status, data) => { sendJson(response, status, data, { 'cache-control': 'no-store' }); return true; };

    if (!code && !suffix && method === 'GET') {
      const user = owner(request);
      return reply(200, { audience: AUDIENCE,
        projects: Object.entries(COMPANIES).map(([id, item]) => ({ id, name: item.name || id })) });
    }
    if (code && !suffix && method === 'GET') {
      const user = owner(request);
      return reply(200, view(user, company(code)));
    }
    if (code && suffix === '/messages' && method === 'POST') {
      const user = owner(request, { write: true });
      const target = company(code);
      return reply(201, await send(user, target, await readBody(request)));
    }
    fail(404, 'Метод личной переписки не найден');
  }

  return { handle, view, send, owner, AUDIENCE };
}

module.exports = { createOwnerPrivateChat, OWNER_PRIVATE_AUDIENCE: AUDIENCE, PRIVATE_SYSTEM: SYSTEM };
