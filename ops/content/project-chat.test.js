'use strict';

/* Общий чат проекта: доступ, изоляция компаний, история, Telegram и очередь Хью.
   Только встроенные модули Node: node --test ops/content/project-chat.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createProjectChat } = require('./project-chat');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 1)]);
const ROOM = 'palitra-love';
const OTHER = 'alvi';
const OWNER_ID = 1;

const requireSession = (request) => {
  if (!request.session) throw Object.assign(new Error('Требуется вход в кабинет'), { status: 401 });
  return request.session;
};
const requireCsrf = (request, session) => {
  if (String(request.headers['x-csrf-token'] || '') !== session.csrf) {
    throw Object.assign(new Error('Некорректный CSRF-токен'), { status: 403 });
  }
};
const sendJson = (response, status, payload, headers) => {
  response.statusCode = status; response.payload = payload; response.headers = headers;
};
const readBody = async (request) => {
  if (!request.body || typeof request.body !== 'object') throw Object.assign(new Error('Ожидался JSON'), { status: 400 });
  return request.body;
};

function setup({ runtime = null, reply = null, statusTtl = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-chat-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const authStore = createAuthStore(db, `vlad:owner:${HASH}`);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body: parsed, raw: options.body, headers: options.headers || {} });
    if (String(url).endsWith('/status')) {
      const value = typeof runtime === 'function' ? runtime() : runtime;
      if (!value) throw new Error('служба не отвечает');
      return { ok: true, status: 200, json: async () => value };
    }
    const value = (typeof reply === 'function' ? reply(parsed, options.body) : reply) || { status: 503 };
    if (value.lost) throw new Error('ответ потерян: обрыв связи');
    if (value.throws) throw new Error('обрыв связи');
    return { ok: (value.status || 200) < 400, status: value.status || 200,
      headers: { get: (name) => (value.headers || {})[String(name).toLowerCase()] ?? null },
      json: async () => { if (value.broken) throw new Error('не JSON'); return value.payload ?? {}; } };
  };
  const chat = createProjectChat({ db, authStore, assetsDir: dir, runnerUrl: 'http://hugh-runtime:8080',
    chatApiKey: 'secret-key', requireSession, requireCsrf, sendJson, readBody, fetchImpl, statusTtl });
  const session = (id) => ({ user: authStore.getById(id), csrf: `csrf-${id}` });
  const person = (login, companies) => authStore.create(OWNER_ID,
    { login, displayName: login, password: 'x'.repeat(12), companies, permissions: [] }, HASH);
  return { db, authStore, chat, calls, dir, session, person, owner: session(OWNER_ID),
    storage: path.join(dir, 'project-chat') };
}

async function call(chat, { session = null, method = 'GET', url, body, bytes, headers = {} }) {
  const request = bytes ? Readable.from([bytes]) : {};
  request.method = method;
  request.headers = { ...(session && method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}), ...headers };
  request.session = session;
  request.body = body;
  const response = { statusCode: 0, payload: null, headers: null, raw: null,
    writeHead(status, head) { this.statusCode = status; this.headers = head; },
    end(data) { this.raw = data; } };
  const handled = await chat.handle(request, response, new URL(`http://x${url}`));
  return { handled, statusCode: response.statusCode, payload: response.payload,
    headers: response.headers, raw: response.raw };
}
const room = (suffix = '', code = ROOM) => `/content/project-chat/${code}${suffix}`;
const status = (value) => (error) => error.status === value;
const addMember = (chat, owner, ids, code = ROOM) =>
  call(chat, { session: owner, method: 'PUT', url: room('/members', code), body: { userIds: ids } });
const say = (chat, session, text, id, code = ROOM) =>
  call(chat, { session, method: 'POST', url: room('/messages', code), body: { text, clientMessageId: id } });

test('членство в комнате открывает проект без прав клиентского чата CRM', async () => {
  const { chat, authStore, owner, person, session } = setup();
  const daria = person('daria', [ROOM]);
  assert.deepEqual(daria.permissions, []);
  await addMember(chat, owner, [daria.id]);
  const hers = session(daria.id);
  const snapshot = await call(chat, { session: hers, url: room() });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.payload.access.canReply, true);
  assert.equal(snapshot.payload.access.owner, false);
  assert.ok(snapshot.payload.members.some((m) => m.userId === daria.id));
  assert.equal((await say(chat, hers, 'Привет команде', 'daria-0001')).statusCode, 201);
  // Права CRM не выдаются вместе с комнатой.
  assert.deepEqual(authStore.getById(daria.id).permissions, []);
});

test('компания без членства и членство без компании не дают доступа', async () => {
  const { chat, db, owner, person, session } = setup();
  const anna = person('anna', [ROOM]);
  const boris = person('boris', [OTHER]);
  await assert.rejects(() => call(chat, { session: session(anna.id), url: room() }), status(403));
  await call(chat, { session: owner, url: room() });
  // Осиротевшая строка членства после отзыва компании не открывает комнату.
  db.prepare('INSERT INTO project_chat_members VALUES(?,?)').run(ROOM, boris.id);
  await assert.rejects(() => call(chat, { session: session(boris.id), url: room() }), status(403));
  await assert.rejects(() => addMember(chat, owner, [boris.id]), status(400));
  await assert.rejects(() => call(chat, { session: null, url: room() }), status(401));
});

test('отзыв компании и смена пароля закрывают уже выданную сессию', async () => {
  const { chat, authStore, owner, person, session } = setup();
  const daria = person('daria', [ROOM]);
  await addMember(chat, owner, [daria.id]);
  const hers = session(daria.id);
  assert.equal((await call(chat, { session: hers, url: room() })).statusCode, 200);
  authStore.updateAccess(OWNER_ID, daria.id, [], []);
  await assert.rejects(() => call(chat, { session: hers, url: room() }), status(403));
  authStore.updateAccess(OWNER_ID, daria.id, [ROOM], []);
  assert.equal((await call(chat, { session: session(daria.id), url: room() })).statusCode, 200);
  authStore.updatePassword(OWNER_ID, daria.id, HASH);
  await assert.rejects(() => call(chat, { session: hers, url: room() }), status(401));
});

test('участник одной компании не читает комнату, файлы и задачи другой', async () => {
  const { chat, owner, person, session } = setup();
  const daria = person('daria', [ROOM]);
  await addMember(chat, owner, [daria.id]);
  const hers = session(daria.id);
  const foreign = await call(chat, { session: owner, method: 'POST', url: room('/attachments', OTHER),
    bytes: PNG, headers: { 'x-filename': 'alvi.png', 'content-type': 'image/png' } });
  assert.equal(foreign.statusCode, 201);
  const foreignTask = await call(chat, { session: owner, method: 'POST', url: room('/tasks', OTHER), body: { title: 'Чужая задача' } });
  assert.equal(foreignTask.statusCode, 201);
  await assert.rejects(() => call(chat, { session: hers, url: room('', OTHER) }), status(403));
  await assert.rejects(() => call(chat, { session: hers, url: room('/messages', OTHER) }), status(403));
  // Идентификатор чужого вложения в своём URL не выдаёт файл.
  await assert.rejects(() => call(chat, { session: hers, url: room(`/attachments/${foreign.payload.attachment.id}`) }), status(404));
  await assert.rejects(() => call(chat, { session: owner, method: 'PATCH',
    url: room(`/tasks/${foreignTask.payload.task.id}`), body: { title: 'Подмена' } }), status(404));
});

test('владельческие настройки и участники недоступны обычному участнику', async () => {
  const { chat, owner, person, session } = setup();
  const daria = person('daria', [ROOM]);
  await addMember(chat, owner, [daria.id]);
  const hers = session(daria.id);
  for (const request of [
    { method: 'PATCH', url: room('/settings'), body: { replyMode: 'delegate' } },
    { method: 'PUT', url: room('/members'), body: { userIds: [] } },
    { method: 'GET', url: room('/candidates') },
    { method: 'POST', url: room('/retry-ai'), body: {} },
  ]) await assert.rejects(() => call(chat, { session: hers, ...request }), status(403));
  await assert.rejects(() => call(chat, { session: hers, method: 'POST', url: room('/messages'),
    body: { text: 'Без токена', clientMessageId: 'daria-0002' }, headers: { 'x-csrf-token': 'подделка' } }), status(403));
  const settings = await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { replyMode: 'delegate' } });
  assert.equal(settings.payload.room.replyMode, 'delegate');
});

test('история отдаётся страницами по 100 сообщений в порядке показа', async () => {
  const { chat, owner } = setup();
  for (let index = 1; index <= 210; index++) await say(chat, owner, `Сообщение ${index}`, `msg-${String(index).padStart(5, '0')}`);
  const first = await call(chat, { session: owner, url: room() });
  assert.equal(first.payload.messages.length, 100);
  assert.equal(first.payload.hasMore, true);
  assert.equal(first.payload.messages.at(-1).text, 'Сообщение 210');
  assert.equal(first.payload.oldestMessageId, first.payload.messages[0].id);
  assert.ok(first.payload.messages.every((m, i, all) => i === 0 || all[i - 1].id < m.id));
  const second = await call(chat, { session: owner, url: room(`/messages?before=${first.payload.oldestMessageId}&limit=100`) });
  assert.equal(second.payload.messages.length, 100);
  assert.equal(second.payload.hasMore, true);
  assert.equal(second.payload.messages.at(-1).text, 'Сообщение 110');
  const third = await call(chat, { session: owner, url: room(`/messages?before=${second.payload.oldestMessageId}&limit=1000`) });
  assert.equal(third.payload.messages.length, 10);
  assert.equal(third.payload.hasMore, false);
  assert.equal(third.payload.messages[0].text, 'Сообщение 1');
});

test('повторный clientMessageId не создаёт второе сообщение', async () => {
  const { chat, db, owner } = setup();
  const first = await say(chat, owner, 'Одно сообщение', 'retry-0001');
  const again = await say(chat, owner, 'Одно сообщение', 'retry-0001');
  assert.equal(first.statusCode, 201);
  assert.equal(again.statusCode, 200);
  assert.equal(again.payload.duplicate, true);
  assert.equal(again.payload.message.id, first.payload.message.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_messages').get().n, 1);
  await assert.rejects(() => say(chat, owner, 'Другой текст', 'retry-0001'), status(409));
});

test('вложение проверяется по подписи и отдаётся только своей компании', async () => {
  const { chat, owner, storage } = setup();
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/attachments'),
    bytes: Buffer.from('<script>alert(1)</script>'), headers: { 'content-type': 'image/png' } }), status(415));
  const created = await call(chat, { session: owner, method: 'POST', url: room('/attachments'),
    bytes: PNG, headers: { 'x-filename': encodeURIComponent('фото/..\\опасное.png'), 'content-type': 'image/png' } });
  assert.equal(created.statusCode, 201);
  assert.ok(!created.payload.attachment.name.includes('/'));
  assert.ok(!created.payload.attachment.name.includes('\\'));
  const file = await call(chat, { session: owner, url: room(`/attachments/${created.payload.attachment.id}`) });
  assert.equal(file.headers['content-type'], 'image/png');
  assert.equal(file.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(file.raw, PNG);
  assert.equal(fs.readdirSync(storage).length, 1);
});

test('повтор события Telegram не создаёт ни второго сообщения, ни лишнего вложения', async () => {
  const { chat, db, owner, storage } = setup();
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1001' } });
  const event = { chatId: '-1001', messageId: '55', authorId: '777', authorName: 'Дарья', text: '',
    files: [{ name: 'photo.jpg', mime: 'image/png', bytes: PNG }] };
  const first = chat.bridge.receiveTelegram(event);
  const again = chat.bridge.receiveTelegram(event);
  assert.equal(first.duplicate, false);
  assert.equal(first.message.attachments.length, 1);
  assert.equal(first.message.text, '');
  assert.equal(again.duplicate, true);
  assert.equal(again.message.id, first.message.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_messages').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_attachments').get().n, 1);
  assert.equal(fs.readdirSync(storage).length, 1);
  // Пустое событие отклоняется и не оставляет файлов на диске.
  await assert.rejects(async () => chat.bridge.receiveTelegram({ chatId: '-1001', messageId: '56', authorName: 'Дарья', text: '' }), status(400));
  assert.equal(fs.readdirSync(storage).length, 1);
  assert.throws(() => chat.bridge.receiveTelegram({ chatId: '-9999', messageId: '1', text: 'чужая группа' }), status(404));
});

test('сообщение бота не отвечает само себе и не ставит задание Хью', async () => {
  const { chat, db, owner } = setup();
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1001', replyMode: 'delegate' } });
  chat.bridge.receiveTelegram({ chatId: '-1001', messageId: '70', authorId: '9', authorName: 'Бот', text: 'Хью, ответь', isBot: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_ai_jobs').get().n, 0);
  // Входящее сообщение не отправляется обратно в ту же группу.
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_outbox').get().n, 0);
});

test('очередь Telegram выдаёт по одному заданию и различает повтор, неизвестность и отказ', async () => {
  const { chat, db, owner } = setup();
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1001' } });
  for (const index of [1, 2, 3]) await say(chat, owner, `Сообщение ${index}`, `out-${index}0000`);
  const claimed = chat.bridge.pendingTelegram(20);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].chatId, '-1001');
  assert.equal(chat.bridge.pendingTelegram().length, 1, 'следующее задание другое');
  // Неизвестный результат не повторяется автоматически.
  chat.bridge.acknowledgeTelegram(claimed[0].id, { ok: false, uncertain: true, error: 'нет ответа' });
  assert.equal(db.prepare('SELECT status FROM project_chat_outbox WHERE id=?').get(claimed[0].id).status, 'uncertain');
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = chat.bridge.pendingTelegram();
    if (!next.length) break;
    assert.notEqual(next[0].id, claimed[0].id, 'неизвестная доставка не повторяется');
    chat.bridge.acknowledgeTelegram(next[0].id, { ok: true, externalMessageIds: ['900'] });
  }
  const third = db.prepare("SELECT * FROM project_chat_outbox WHERE status='sent' ORDER BY id LIMIT 1").get();
  assert.deepEqual(JSON.parse(third.external_ids), ['900']);
  assert.deepEqual(chat.bridge.acknowledgeTelegram(third.id, { ok: false, retryable: true }), { ok: true, status: 'sent' });
});

test('определённый отказ Telegram повторяется, пока не исчерпаны попытки', async () => {
  const { chat, db, owner } = setup();
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1001' } });
  await say(chat, owner, 'Сообщение', 'retryable-1');
  let last = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const jobs = chat.bridge.pendingTelegram();
    if (!jobs.length) break;
    last = jobs[0];
    const result = chat.bridge.acknowledgeTelegram(last.id, { ok: false, retryable: true, error: 'Telegram: 429' });
    assert.equal(result.status, attempt < 3 ? 'pending' : 'error');
    db.prepare("UPDATE project_chat_outbox SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(last.id);
  }
  const row = db.prepare('SELECT * FROM project_chat_outbox WHERE id=?').get(last.id);
  assert.equal(row.status, 'error');
  assert.equal(row.attempts, 3);
  assert.equal(chat.bridge.pendingTelegram().length, 0);
});

test('перенос группы в супергруппу сохраняет привязку и незавершённые отправки', async () => {
  const { chat, db, owner } = setup();
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1001' } });
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings', OTHER), body: { telegramChatId: '-1003' } });
  await say(chat, owner, 'До переноса', 'migrate-01');
  const moved = chat.bridge.migrateBinding({ chatId: '-1001', newChatId: '-1002' });
  assert.equal(moved.migrated, true);
  assert.equal(chat.bridge.getBinding('-1002').companyCode, ROOM);
  assert.equal(chat.bridge.getBinding('-1001'), null);
  assert.equal(db.prepare("SELECT chat_id FROM project_chat_outbox WHERE status='pending'").get().chat_id, '-1002');
  assert.equal(chat.bridge.pendingTelegram()[0].chatId, '-1002', 'отправка не застревает после переноса');
  // Повтор того же события и конфликт завершаются успехом, повторять их незачем.
  assert.deepEqual(chat.bridge.migrateBinding({ chatId: '-1001', newChatId: '-1002' }).reason, 'already');
  const conflict = chat.bridge.migrateBinding({ chatId: '-1002', newChatId: '-1003' });
  assert.equal(conflict.ok, true);
  assert.equal(conflict.migrated, false);
  assert.equal(conflict.reason, 'conflict');
  assert.equal(chat.bridge.getBinding('-1003').companyCode, OTHER);
  assert.throws(() => chat.bridge.migrateBinding({ chatId: '-1002', newChatId: 'не число' }), status(400));
});

test('задачи и этапы принимают только объекты своей комнаты', async () => {
  const { chat, owner, person, session } = setup();
  const daria = person('daria', [ROOM]);
  const anna = person('anna', [ROOM]);
  await addMember(chat, owner, [daria.id]);
  const stage = await call(chat, { session: owner, method: 'POST', url: room('/stages'), body: { title: 'Этап 1' } });
  const foreignStage = await call(chat, { session: owner, method: 'POST', url: room('/stages', OTHER), body: { title: 'Чужой этап' } });
  const source = await say(chat, owner, 'Нужна афиша', 'task-src-1');
  const foreignSource = await say(chat, owner, 'Чужое сообщение', 'task-src-2', OTHER);
  const created = await call(chat, { session: session(daria.id), method: 'POST', url: room('/tasks'),
    body: { title: 'Афиша', assigneeId: daria.id, stageId: stage.payload.stage.id,
      sourceMessageId: source.payload.message.id, due: '2026-03-01', status: 'in_progress' } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.payload.task.sourceMessageId, source.payload.message.id);
  for (const body of [
    { title: 'Чужой этап', stageId: foreignStage.payload.stage.id },
    { title: 'Чужое сообщение', sourceMessageId: foreignSource.payload.message.id },
    { title: 'Не участник', assigneeId: anna.id },
    { title: 'Плохая дата', due: '2026-02-30' },
    { title: 'Плохой статус', status: 'maybe' },
    { title: 'a'.repeat(201) },
    { title: 'Лишнее поле', priority: 'high' },
  ]) await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/tasks'), body }), status(400));
});

test('снимок различает «настроено» и «подключено» и не обещает ответ Хью', async () => {
  const { chat, owner } = setup({ runtime: null });
  const offline = await call(chat, { session: owner, url: room() });
  assert.equal(offline.payload.ai.configured, true);
  assert.equal(offline.payload.ai.connected, false);
  assert.equal(offline.payload.ai.runtimeState, 'unavailable');
  const live = setup({ runtime: { connected: true, authenticated: true, state: 'ready', provider: 'codex', model: 'gpt-5-codex' } });
  const ready = await call(live.chat, { session: live.owner, url: room() });
  assert.equal(ready.payload.ai.connected, true);
  assert.equal(ready.payload.ai.runtimeState, 'ready');
  assert.equal(ready.payload.ai.model, 'gpt-5-codex');
  const unconfigured = createProjectChat({ db: live.db, authStore: live.authStore, assetsDir: live.dir,
    runnerUrl: '', chatApiKey: '', requireSession, requireCsrf, sendJson, readBody });
  const none = await call(unconfigured, { session: live.owner, url: room() });
  assert.equal(none.payload.ai.configured, false);
  assert.equal(none.payload.ai.connected, false);
  assert.equal(none.payload.ai.runtimeState, 'unconfigured');
});

test('без подключения вопрос ждёт, а не сгорает: retry-ai возвращает его в очередь', async () => {
  let connected = false;
  const answers = [];
  const state = setup({
    runtime: () => (connected ? { connected: true, authenticated: true, state: 'ready', provider: 'codex', model: 'gpt-5-codex' } : { connected: false, state: 'login_required' }),
    reply: (body) => { answers.push(body); return { status: 200, payload: { text: 'Готово', provider: 'codex', model: 'gpt-5-codex' } }; },
  });
  const { chat, db, owner } = state;
  await say(chat, owner, 'Хью, что со сроками?', 'ai-0000001');
  const job = db.prepare('SELECT * FROM project_chat_ai_jobs').get();
  assert.ok(job, 'обращение к Хью ставит задание');
  await chat.processAIJobs();
  const blocked = db.prepare('SELECT * FROM project_chat_ai_jobs WHERE id=?').get(job.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.attempts, 0);
  assert.equal(answers.length, 0, 'запрос к модели не уходил');
  const waitingView = await call(chat, { session: owner, url: room() });
  assert.equal(waitingView.payload.ai.connected, false);
  assert.equal(waitingView.payload.ai.waiting, 1);
  assert.equal(waitingView.payload.ai.failed, 0, 'ожидание подключения не считается отказом');
  assert.equal(waitingView.payload.messages.at(-1).aiStatus, 'pending');
  await chat.processAIJobs();
  assert.equal(db.prepare('SELECT attempts FROM project_chat_ai_jobs WHERE id=?').get(job.id).attempts, 0);
  connected = true;
  // Ожидание подключения проверяется не чаще паузы; сдвигаем её вместо ожидания 30 секунд.
  db.prepare("UPDATE project_chat_ai_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(job.id);
  await chat.processAIJobs();
  const done = db.prepare('SELECT * FROM project_chat_ai_jobs WHERE id=?').get(job.id);
  assert.equal(done.status, 'done');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].jobId, `project-chat:${job.id}`);
  // Повторный проход не отвечает второй раз.
  await chat.processAIJobs();
  assert.equal(answers.length, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM project_chat_messages WHERE author_type='assistant'").get().n, 1);
});

test('исчерпанное задание Хью возвращается владельцем без повторного ответа', async () => {
  let failing = true;
  const answers = [];
  const { chat, db, owner } = setup({
    runtime: { connected: true, authenticated: true, state: 'ready', provider: 'codex', model: 'gpt-5-codex' },
    reply: (body) => { answers.push(body); return failing ? { status: 500 } : { status: 200, payload: { text: 'Ответ', provider: 'codex', model: 'gpt-5-codex' } }; },
  });
  await say(chat, owner, 'Хью, подскажи план', 'ai-0000002');
  const id = db.prepare('SELECT id FROM project_chat_ai_jobs').get().id;
  for (let attempt = 0; attempt < 3; attempt++) {
    db.prepare("UPDATE project_chat_ai_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
    await chat.processAIJobs();
  }
  const exhausted = db.prepare('SELECT * FROM project_chat_ai_jobs WHERE id=?').get(id);
  assert.equal(exhausted.status, 'error');
  assert.equal(exhausted.attempts, 3);
  db.prepare("UPDATE project_chat_ai_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
  await chat.processAIJobs();
  assert.equal(answers.length, 3, 'исчерпанное задание само не повторяется');
  failing = false;
  const requeued = await call(chat, { session: owner, method: 'POST', url: room('/retry-ai'), body: { jobIds: [id] } });
  assert.equal(requeued.payload.requeued, 1);
  assert.deepEqual(requeued.payload.jobIds, [id]);
  assert.equal(db.prepare('SELECT attempts FROM project_chat_ai_jobs WHERE id=?').get(id).attempts, 0);
  await chat.processAIJobs();
  assert.equal(db.prepare('SELECT status FROM project_chat_ai_jobs WHERE id=?').get(id).status, 'done');
  assert.equal(db.prepare("SELECT count(*) AS n FROM project_chat_messages WHERE author_type='assistant'").get().n, 1);
  // Отвеченное задание уже не возвращается в очередь.
  const second = await call(chat, { session: owner, method: 'POST', url: room('/retry-ai'), body: {} });
  assert.equal(second.payload.requeued, 0);
});

test('контекст Хью ограничен, содержит задачи и этапы и не просит инструментов', async () => {
  let payload = null;
  const { chat, owner } = setup({
    runtime: { connected: true, authenticated: true, state: 'ready', provider: 'codex', model: 'gpt-5-codex' },
    reply: (body) => { payload = body; return { status: 200, payload: { text: 'Принято', provider: 'codex', model: 'gpt-5-codex' } }; },
  });
  const stage = await call(chat, { session: owner, method: 'POST', url: room('/stages'), body: { title: 'Съёмка' } });
  await call(chat, { session: owner, method: 'POST', url: room('/tasks'),
    body: { title: 'Снять витрину', stageId: stage.payload.stage.id, due: '2026-03-05', status: 'todo' } });
  for (let index = 1; index <= 45; index++) await say(chat, owner, `Сообщение ${index}`, `ctx-${String(index).padStart(5, '0')}`);
  await say(chat, owner, 'Хью, что дальше?', 'ctx-question');
  await chat.processAIJobs();
  assert.ok(payload, 'запрос к службе Хью отправлен');
  assert.deepEqual(Object.keys(payload).sort(), ['companyCode', 'jobId', 'messages', 'system']);
  assert.ok(payload.messages.length <= 30, 'история ограничена');
  assert.equal(payload.messages.at(-1).content.includes('Хью, что дальше?'), true);
  assert.ok(payload.messages.every((m) => ['user', 'assistant'].includes(m.role)));
  assert.ok(payload.system.includes('Снять витрину'));
  assert.ok(payload.system.includes('#' + stage.payload.stage.id));
  assert.ok(payload.system.includes('У тебя нет инструментов'));
  assert.ok(!/tools|shell|exec/i.test(JSON.stringify(Object.keys(payload))));
});

test('перезапуск не задваивает ответ Хью и не теряет уже сохранённый', async () => {
  const { chat, db, owner } = setup();
  await say(chat, owner, 'Хью, привет', 'ai-0000003');
  await say(chat, owner, 'Хью, ещё вопрос', 'ai-0000004');
  const [first, second] = db.prepare('SELECT * FROM project_chat_ai_jobs ORDER BY id').all();
  const answer = db.prepare(`INSERT INTO project_chat_messages
    (company_code,author_id,author_name,author_type,text,created_at) VALUES(?,?,?,?,?,?)`)
    .run(ROOM, 'hugh', 'Хью', 'assistant', 'Уже отвечено', new Date().toISOString());
  db.prepare("UPDATE project_chat_ai_jobs SET status='running',reply_message_id=? WHERE id=?").run(Number(answer.lastInsertRowid), first.id);
  db.prepare("UPDATE project_chat_ai_jobs SET status='running' WHERE id=?").run(second.id);
  chat.startWorker();
  chat.stopWorker();
  assert.equal(db.prepare('SELECT status FROM project_chat_ai_jobs WHERE id=?').get(first.id).status, 'done');
  assert.equal(db.prepare('SELECT status FROM project_chat_ai_jobs WHERE id=?').get(second.id).status, 'pending');
});

test('повтор задания Хью уходит тем же запросом, даже если доску успели изменить', async () => {
  let lose = true;
  const bodies = [];
  const { chat, db, owner } = setup({
    runtime: { connected: true, authenticated: true, state: 'ready', provider: 'codex', model: 'gpt-5-codex' },
    reply: (body, raw) => {
      bodies.push(raw);
      // Первый вызов служба обработала, но ответ до нас не дошёл; повтор отдаёт тот же кэш.
      return lose ? { lost: true } : { status: 200, payload: { text: 'Готово', provider: 'codex', model: 'gpt-5-codex' } };
    },
  });
  const stage = await call(chat, { session: owner, method: 'POST', url: room('/stages'), body: { title: 'Съёмка' } });
  await call(chat, { session: owner, method: 'POST', url: room('/tasks'), body: { title: 'Снять витрину', stageId: stage.payload.stage.id } });
  await say(chat, owner, 'Хью, что дальше?', 'payload-001');
  const id = db.prepare('SELECT id FROM project_chat_ai_jobs').get().id;
  await chat.processAIJobs();
  const stored = db.prepare('SELECT * FROM project_chat_ai_jobs WHERE id=?').get(id);
  assert.equal(stored.status, 'error');
  assert.ok(stored.payload, 'запрос сохранён при первой отправке');
  // Доску правят между попытками: задачи, этапы и новые сообщения меняются.
  await call(chat, { session: owner, method: 'POST', url: room('/tasks'), body: { title: 'Новая задача', due: '2026-04-01' } });
  await call(chat, { session: owner, method: 'POST', url: room('/stages'), body: { title: 'Монтаж' } });
  await say(chat, owner, 'И ещё сообщение', 'payload-002');
  lose = false;
  db.prepare("UPDATE project_chat_ai_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
  await chat.processAIJobs();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1], bodies[0], 'повтор несёт тот же payload байт в байт');
  assert.ok(!bodies[1].includes('Новая задача'));
  assert.equal(db.prepare('SELECT status FROM project_chat_ai_jobs WHERE id=?').get(id).status, 'done');
  assert.equal(db.prepare("SELECT count(*) AS n FROM project_chat_messages WHERE author_type='assistant'").get().n, 1, 'ответ ровно один');
  assert.equal(db.prepare('SELECT payload FROM project_chat_ai_jobs WHERE id=?').get(id).payload, bodies[0], 'сохранённый запрос не переписан');
});

test('лимит подписки не жжёт попытки: вопрос ждёт и отвечается сам после восстановления', async () => {
  let limited = true;
  const bodies = [];
  const { chat, db, owner } = setup({
    runtime: { connected: true, authenticated: true, state: 'ready', provider: 'codex', model: 'gpt-5-codex' },
    reply: (body, raw) => {
      bodies.push(raw);
      return limited
        ? { status: 429, payload: { error: 'RATE_LIMITED', retryAfter: 30 } }
        : { status: 200, payload: { text: 'Готово', provider: 'codex', model: 'gpt-5-codex' } };
    },
  });
  await say(chat, owner, 'Хью, что со сроками?', 'limit-000001');
  const id = db.prepare('SELECT id FROM project_chat_ai_jobs').get().id;
  for (let round = 0; round < 4; round++) {
    await chat.processAIJobs();
    const row = db.prepare('SELECT * FROM project_chat_ai_jobs WHERE id=?').get(id);
    assert.equal(row.status, 'blocked', 'ограничение — это ожидание, а не отказ');
    assert.equal(row.attempts, 0, 'попытка не расходуется');
    assert.ok(row.error.includes('временно ограничена'));
    assert.ok(row.payload, 'запрос сохранён и не пересобирается');
    // Пауза выдержана: сдвигаем срок вместо ожидания 30 секунд.
    assert.ok(row.next_attempt_at > new Date().toISOString(), 'ограниченный вопрос ждёт с паузой');
    db.prepare("UPDATE project_chat_ai_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
  }
  assert.equal(bodies.length, 4, 'повторы продолжаются без участия пользователя');
  const waitingView = await call(chat, { session: owner, url: room() });
  assert.equal(waitingView.payload.ai.failed, 0, 'вопрос не превратился в ошибку');
  assert.equal(waitingView.payload.ai.waiting, 1);
  assert.ok(waitingView.payload.ai.waitingReason.includes('временно ограничена'));
  assert.equal(waitingView.payload.messages.at(-1).aiStatus, 'pending');
  limited = false;
  await chat.processAIJobs();
  const done = db.prepare('SELECT * FROM project_chat_ai_jobs WHERE id=?').get(id);
  assert.equal(done.status, 'done');
  assert.equal(done.attempts, 1, 'успех занял ровно одну попытку');
  assert.equal(bodies.at(-1), bodies[0], 'повтор ушёл тем же неизменным запросом');
  assert.equal(db.prepare("SELECT count(*) AS n FROM project_chat_messages WHERE author_type='assistant'").get().n, 1);
});

test('срок ожидания берётся из ответа службы и ограничивается разумными рамками', async () => {
  const cases = [
    // Формы ответов службы: BUSY и RATE_LIMITED приходят с заголовком Retry-After и телом {error,errorCode}.
    { name: 'занятый рантайм', seconds: 5,
      reply: { status: 429, headers: { 'retry-after': '5' }, payload: { error: 'Рантайм занят другим заданием', errorCode: 'BUSY' } } },
    { name: 'лимит подписки', seconds: 600,
      reply: { status: 429, headers: { 'retry-after': '600' }, payload: { error: 'Лимит подписки исчерпан, попробуйте позже', errorCode: 'RATE_LIMITED' } } },
    { name: 'из тела', reply: { status: 429, payload: { retryAfter: 120 } }, seconds: 120 },
    { name: 'из заголовка', reply: { status: 429, headers: { 'retry-after': '45' }, payload: { error: 'BUSY' } }, seconds: 45 },
    { name: 'слишком много', reply: { status: 429, payload: { retryAfter: 99999 } }, seconds: 900 },
    { name: 'слишком мало', reply: { status: 429, payload: { retryAfter: 1 } }, seconds: 5 },
    { name: 'без срока', reply: { status: 429, payload: { error: 'BUSY' } }, seconds: 60 },
    { name: 'нечитаемое тело', reply: { status: 429, broken: true }, seconds: 60 },
  ];
  for (const item of cases) {
    const { chat, db, owner } = setup({
      runtime: { connected: true, authenticated: true, state: 'ready', provider: 'codex', model: 'gpt-5-codex' },
      reply: () => item.reply,
    });
    await say(chat, owner, 'Хью, подскажи', 'limit-000002');
    const before = Date.now();
    await chat.processAIJobs();
    const row = db.prepare('SELECT * FROM project_chat_ai_jobs').get();
    const waited = Math.round((Date.parse(row.next_attempt_at) - before) / 1000);
    assert.ok(Math.abs(waited - item.seconds) <= 2, `${item.name}: пауза ${waited} c вместо ${item.seconds} c`);
    assert.equal(row.attempts, 0, `${item.name}: попытка не расходуется`);
  }
});

test('ограничение по статусу службы задерживает вопросы без обращения к модели', async () => {
  let limited = true;
  const bodies = [];
  const { chat, db, owner } = setup({
    runtime: () => (limited
      ? { connected: true, authenticated: true, state: 'limited', retryAfter: 45, provider: 'codex', model: 'gpt-5-codex' }
      : { connected: true, authenticated: true, state: 'ready', provider: 'codex', model: 'gpt-5-codex' }),
    reply: (body, raw) => { bodies.push(raw); return { status: 200, payload: { text: 'Готово', provider: 'codex', model: 'gpt-5-codex' } }; },
  });
  await say(chat, owner, 'Хью, что дальше?', 'limit-000003');
  await chat.processAIJobs();
  assert.equal(bodies.length, 0, 'при известном лимите запрос не отправляется');
  const row = db.prepare('SELECT * FROM project_chat_ai_jobs').get();
  assert.equal(row.status, 'blocked');
  assert.equal(row.attempts, 0);
  const view = await call(chat, { session: owner, url: room() });
  assert.equal(view.payload.ai.connected, true, 'вход в аккаунт сохранён');
  assert.equal(view.payload.ai.limited, true);
  assert.equal(view.payload.ai.retryAfter, 45);
  assert.equal(view.payload.ai.failed, 0);
  assert.equal(view.payload.ai.waiting, 1);
  limited = false;
  db.prepare("UPDATE project_chat_ai_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z'").run();
  await chat.processAIJobs();
  assert.equal(bodies.length, 1, 'после снятия лимита вопрос уходит сам');
  assert.equal(db.prepare('SELECT status FROM project_chat_ai_jobs').get().status, 'done');
  const ready = await call(chat, { session: owner, url: room() });
  assert.equal(ready.payload.ai.limited, false);
  assert.equal(ready.payload.ai.retryAfter, 0);
});

test('конфликт запроса службы Хью терминальный и не выдаётся за отсутствие подключения', async () => {
  const { chat, db, owner } = setup({
    runtime: { connected: true, authenticated: true, state: 'ready', provider: 'codex', model: 'gpt-5-codex' },
    reply: () => ({ status: 409, payload: { error: 'payload mismatch' } }),
  });
  await say(chat, owner, 'Хью, проверь план', 'conflict-01');
  const id = db.prepare('SELECT id FROM project_chat_ai_jobs').get().id;
  await chat.processAIJobs();
  const row = db.prepare('SELECT * FROM project_chat_ai_jobs WHERE id=?').get(id);
  assert.equal(row.status, 'error', 'конфликт входных данных не ждёт подключения');
  assert.equal(row.attempts, 3, 'автоповтор исчерпан сразу');
  assert.ok(row.error.includes('Нужна проверка владельцем'));
  await chat.processAIJobs();
  const view = await call(chat, { session: owner, url: room() });
  assert.equal(view.payload.ai.failed, 1);
  assert.equal(view.payload.ai.waiting, 0);
  assert.equal(view.payload.ai.connected, true);
  assert.deepEqual(view.payload.ai.failedJobIds, [id]);
});

test('выбывший исполнитель не мешает владельцу править задачу', async () => {
  const { chat, authStore, db, owner, person, session } = setup();
  const daria = person('daria', [ROOM]);
  const anna = person('anna', [ROOM]);
  await addMember(chat, owner, [daria.id, anna.id]);
  const task = await call(chat, { session: owner, method: 'POST', url: room('/tasks'),
    body: { title: 'Афиша', assigneeId: daria.id, status: 'todo' } });
  assert.equal(task.payload.task.assigneeName, 'daria');
  assert.equal(task.payload.task.assigneeActive, true);
  // Дарья уходит из проекта: задача остаётся с прежним исполнителем.
  authStore.updateAccess(OWNER_ID, daria.id, [], []);
  db.prepare('DELETE FROM project_chat_members WHERE company_code=? AND user_id=?').run(ROOM, daria.id);
  const patched = await call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${task.payload.task.id}`),
    body: { status: 'done' } });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.payload.task.status, 'done');
  assert.equal(patched.payload.task.assigneeId, daria.id, 'историческое значение сохранено');
  assert.equal(patched.payload.task.assigneeActive, false);
  assert.equal(patched.payload.task.assigneeName, 'daria');
  const renamed = await call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${task.payload.task.id}`),
    body: { title: 'Афиша к среде', due: '2026-04-02' } });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.payload.task.assigneeId, daria.id);
  const view = await call(chat, { session: owner, url: room() });
  assert.deepEqual(view.payload.formerMembers, [{ userId: daria.id, displayName: 'daria', active: false }]);
  assert.ok(!view.payload.members.some((m) => m.userId === daria.id));
  // Смену исполнителя по-прежнему проверяем.
  const reassigned = await call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${task.payload.task.id}`),
    body: { assigneeId: anna.id } });
  assert.equal(reassigned.payload.task.assigneeId, anna.id);
  await assert.rejects(() => call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${task.payload.task.id}`),
    body: { assigneeId: daria.id } }), status(400));
  const cleared = await call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${task.payload.task.id}`),
    body: { assigneeId: null } });
  assert.equal(cleared.payload.task.assigneeId, null);
});

test('отзыв доступа после загрузки файла закрывает и файл, и комнату', async () => {
  const { chat, authStore, owner, person, session } = setup();
  const daria = person('daria', [ROOM]);
  await addMember(chat, owner, [daria.id]);
  const hers = session(daria.id);
  const uploaded = await call(chat, { session: hers, method: 'POST', url: room('/attachments'),
    bytes: PNG, headers: { 'x-filename': 'photo.png', 'content-type': 'image/png' } });
  assert.equal(uploaded.statusCode, 201);
  const url = room(`/attachments/${uploaded.payload.attachment.id}`);
  assert.equal((await call(chat, { session: hers, url })).statusCode, 200);
  authStore.updateAccess(OWNER_ID, daria.id, [], []);
  // Право проверяется на каждом запросе, а не на момент загрузки.
  await assert.rejects(() => call(chat, { session: hers, url }), status(403));
  await assert.rejects(() => call(chat, { session: hers, url: room() }), status(403));
  await assert.rejects(() => say(chat, hers, 'Ещё сообщение', 'revoked-01'), status(403));
  assert.equal((await call(chat, { session: owner, url })).statusCode, 200, 'файл проекта остаётся у владельца');
});

test('подробности подключения Хью видит только владелец', async () => {
  const { chat, owner, person, session } = setup({
    runtime: { connected: false, state: 'login_required', error: 'Код входа 1234-ABCD по ссылке' },
  });
  const daria = person('daria', [ROOM]);
  await addMember(chat, owner, [daria.id]);
  const mine = await call(chat, { session: owner, url: room() });
  assert.ok(mine.payload.ai.runtimeError.includes('1234-ABCD'));
  const hers = await call(chat, { session: session(daria.id), url: room() });
  assert.equal(hers.payload.ai.runtimeError, '');
  assert.equal(hers.payload.ai.runtimeState, 'login_required');
  assert.equal(hers.payload.ai.connected, false);
});

test('текст сообщения сохраняется как данные и не превращается в разметку', async () => {
  const { chat, owner } = setup();
  const payload = '<img src=x onerror="alert(1)">Хью';
  const sent = await say(chat, owner, payload, 'xss-00001');
  assert.equal(sent.payload.message.text, payload);
  const snapshot = await call(chat, { session: owner, url: room() });
  assert.equal(snapshot.payload.messages.at(-1).text, payload);
  assert.equal(snapshot.payload.messages.at(-1).authorType, 'human');
});
