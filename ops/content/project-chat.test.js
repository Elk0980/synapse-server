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

function setup({ runtime = null, reply = null, statusTtl = 0, clock = null, file = false, dir: reuseDir = null, db: reuseDb = null } = {}) {
  const dir = reuseDir || fs.mkdtempSync(path.join(os.tmpdir(), 'project-chat-'));
  // file: true — база на диске: так тест может закрыть её и открыть заново, воспроизводя перезапуск сервера.
  const db = reuseDb || new DatabaseSync(file ? path.join(dir, 'chat.sqlite') : ':memory:');
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
    chatApiKey: 'secret-key', requireSession, requireCsrf, sendJson, readBody, fetchImpl, statusTtl,
    cabinetUrl: 'https://synapse.example.test',
    // Управляемые часы: срок отложенной отправки проверяется без ожидания реального времени.
    ...(clock ? { now: () => clock.now } : {}) });
  const session = (id) => ({ user: authStore.getById(id), csrf: `csrf-${id}` });
  const person = (login, companies) => authStore.create(OWNER_ID,
    { login, displayName: login, password: 'x'.repeat(12), companies, permissions: [] }, HASH);
  return { db, authStore, chat, calls, dir, session, person, owner: session(OWNER_ID), clock,
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

/* Реестр замечаний в кабинете: один собственник ведёт два сайта в одной переписке (решение Owner'а 18.09),
   поэтому у задачи есть метка сайта, отдельное состояние публикации и устойчивый внешний идентификатор. */

test('один общий чат двух сайтов: метка сайта обязательна, чужой сайт не принимается', async () => {
  const { chat, owner } = setup();
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { sites: [OTHER] } });
  const snapshot = await call(chat, { session: owner, url: room('') });
  assert.deepEqual(snapshot.payload.room.sites, [OTHER], 'комната обслуживает и второй сайт собственника');
  const own = await call(chat, { session: owner, method: 'POST', url: room('/tasks'), body: { title: 'Правка своего сайта', site: ROOM } });
  assert.equal(own.payload.task.site, ROOM);
  const second = await call(chat, { session: owner, method: 'POST', url: room('/tasks'), body: { title: 'Правка второго сайта', site: OTHER } });
  assert.equal(second.payload.task.site, OTHER);
  assert.equal(second.payload.task.siteStatus, 'known');
  // Сайт чужого собственника в общий чат не попадает.
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/tasks'),
    body: { title: 'Чужой сайт', site: 'avokado' } }), status(400));
  await assert.rejects(() => call(chat, { session: owner, method: 'PATCH', url: room('/settings'),
    body: { sites: ['нет-такого'] } }), status(400));
});

test('сайт из сообщения неоднозначен — «нужно уточнить», публикация запрещена, оба сайта не трогаются', async () => {
  const { chat, owner } = setup();
  const created = await call(chat, { session: owner, method: 'POST', url: room('/tasks'),
    body: { title: 'Убрать онлайн-запись', sourceQuote: 'Убрать онлайн запись везде' } });
  assert.equal(created.payload.task.site, '');
  assert.equal(created.payload.task.siteStatus, 'needs_clarification');
  assert.equal(created.payload.task.publication, 'not_started');
  await assert.rejects(() => call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${created.payload.task.id}`),
    body: { publication: 'published', publishedUrl: 'https://example.test/', verifiedAt: '2026-09-18' } }), status(400));
});

test('готово локально ≠ опубликовано: «на сайте» требует ссылку и дату проверки; отмена — состояние работы, не публикации', async () => {
  const { chat, owner } = setup();
  const task = (await call(chat, { session: owner, method: 'POST', url: room('/tasks'),
    body: { title: 'Ускорить слайды', site: ROOM, status: 'done', publication: 'prepared' } })).payload.task;
  assert.equal(task.status, 'done');
  assert.equal(task.publication, 'prepared');
  assert.equal(task.fixedOnSite, false, 'локальная готовность не выдаётся за правку на сайте');
  assert.match(task.publicationLabel, /ещё нет/);
  for (const body of [
    { publication: 'published' },
    { publication: 'published', publishedUrl: 'https://example.test/' },
    { publication: 'published', verifiedAt: '2026-09-18' },
    { publication: 'published', publishedUrl: 'http://example.test/', verifiedAt: '2026-09-18' },
    { publication: 'на сайте' },
    { publication: 'not_required' },
  ]) await assert.rejects(() => call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${task.id}`), body }), status(400));
  const live = await call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${task.id}`),
    body: { publication: 'published', publishedUrl: 'https://example.test/page', verifiedAt: '2026-09-18' } });
  assert.equal(live.payload.task.fixedOnSite, true);
  assert.equal(live.payload.task.cancelled, false);
  // Отмена поверх прежней публикации: задача перестаёт считаться исправлением, хотя published остался в поле.
  const cancelled = await call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${task.id}`), body: { status: 'cancelled' } });
  assert.equal(cancelled.payload.task.status, 'cancelled');
  assert.equal(cancelled.payload.task.cancelled, true);
  assert.equal(cancelled.payload.task.publication, 'published', 'история публикации сохранена');
  assert.equal(cancelled.payload.task.fixedOnSite, false, 'снятое не считается исправленным даже при старом published');
  // Снять задачу и одновременно объявить её опубликованной нельзя.
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/tasks'),
    body: { title: 'Снято и опубликовано', site: ROOM, status: 'cancelled', publication: 'published',
      publishedUrl: 'https://example.test/x', verifiedAt: '2026-09-18' } }), status(400));
  const dropped = await call(chat, { session: owner, method: 'POST', url: room('/tasks'),
    body: { title: 'Снято решением', site: ROOM, status: 'cancelled', publication: 'not_required' } });
  assert.equal(dropped.payload.task.fixedOnSite, false);
  assert.match(dropped.payload.task.publicationLabel, /не требуется/);
});

test('ожидание уточнения — отдельное состояние публикации, а не «не требуется» и не «не начато»', async () => {
  const { chat, owner } = setup();
  const waiting = await call(chat, { session: owner, method: 'POST', url: room('/tasks'),
    body: { title: 'Непонятно, чем занимается салон', site: ROOM, status: 'todo', publication: 'awaiting_clarification',
      sourceQuote: 'Непонятно чем занимается салон' } });
  assert.equal(waiting.payload.task.status, 'todo', 'работа не начата, а не заблокирована навсегда');
  assert.equal(waiting.payload.task.publication, 'awaiting_clarification');
  assert.equal(waiting.payload.task.fixedOnSite, false);
  assert.equal(waiting.payload.task.cancelled, false, 'ожидание уточнения не равно отмене');
  assert.match(waiting.payload.task.publicationLabel, /ждём уточнения/);
});

test('внутренние работы считаются отдельно от замечаний клиента', async () => {
  const { chat, owner } = setup();
  await call(chat, { session: owner, method: 'POST', url: room('/tasks'),
    body: { title: 'Замечание клиента', site: ROOM, kind: 'client_remark' } });
  const internal = await call(chat, { session: owner, method: 'POST', url: room('/tasks'),
    body: { title: 'Резерв текстов', site: ROOM, kind: 'internal', status: 'done', publication: 'prepared' } });
  assert.equal(internal.payload.task.kind, 'internal');
  const snapshot = await call(chat, { session: owner, url: room('') });
  assert.equal(snapshot.payload.tasks.filter(t => t.kind === 'client_remark').length, 1);
  assert.equal(snapshot.payload.tasks.filter(t => t.kind === 'internal').length, 1);
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/tasks'),
    body: { title: 'Неизвестный вид', kind: 'прочее' } }), status(400));
});

test('устаревший снимок реестра не затирает более позднюю правку владельца', async () => {
  const { chat, owner } = setup();
  const registry = (asOf) => ({ schemaVersion: 1, asOf, tasks: [
    { externalRef: 'А8', title: 'Фото вылезает на ПК', site: ROOM, status: 'done', publication: 'prepared' } ] });
  const first = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'), body: registry('2026-09-18') });
  assert.equal(first.payload.imported, 1);
  const id = first.payload.tasks[0].id;
  // Владелец правит задачу в кабинете уже после снимка.
  await call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${id}`),
    body: { publication: 'published', publishedUrl: 'https://example.test/a8', verifiedAt: '2026-09-19' } });
  const stale = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'), body: registry('2026-09-18') });
  assert.equal(stale.payload.imported, 0);
  assert.equal(stale.payload.skipped, 1);
  assert.match(stale.payload.results[0].reason, /позже снимка/);
  assert.equal(stale.payload.results[0].id, id);
  assert.equal(stale.payload.results.length, 1);
  const snapshot = await call(chat, { session: owner, url: room('') });
  assert.equal(snapshot.payload.tasks[0].publication, 'published', 'правка владельца сохранена');
  /* Более свежий asOf сам по себе разрешением НЕ является: новый календарный день не доказывает,
     что реестр учитывает правку владельца. Затереть её может только явный force. */
  const fresh = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'), body: registry('2026-09-20') });
  assert.equal(fresh.payload.imported, 0);
  assert.equal(fresh.payload.skipped, 1);
  assert.equal((await call(chat, { session: owner, url: room('') })).payload.tasks[0].publication, 'published');
  const forced = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'),
    body: { ...registry('2026-09-20'), force: true } });
  assert.equal(forced.payload.imported, 1);
  assert.equal((await call(chat, { session: owner, url: room('') })).payload.tasks[0].publication, 'prepared');
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/tasks/import'),
    body: { schemaVersion: 1, asOf: '2026-02-30', tasks: [{ externalRef: 'Д9', title: 'Плохая дата' }] } }), status(400));
});

test('повторная синхронизация реестра не плодит задачи и не удваивает уточнения', async () => {
  const { chat, owner } = setup();
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { sites: [OTHER] } });
  const registry = { schemaVersion: 1, tasks: [
    { externalRef: 'А8', title: 'Фото вылезает на ПК', site: ROOM, status: 'done', publication: 'prepared',
      sourceQuote: 'В версии ПК на сайте вылазит фотография' },
    { externalRef: 'А9', title: 'Онлайн-запись ведёт в контакты', site: OTHER, status: 'todo', publication: 'not_started',
      notes: [{ text: 'Только в Алви убрать', kind: 'clarification' }] },
  ] };
  const first = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'), body: registry });
  assert.equal(first.payload.imported, 2);
  const second = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'), body: registry });
  assert.equal(second.payload.imported, 2);
  assert.equal(second.payload.results[0].id, first.payload.results[0].id, 'та же сущность, а не копия');
  assert.equal(second.payload.results.length, 2);
  assert.deepEqual(second.payload.results.map(t => t.externalRef), ['А8', 'А9']);
  const snapshot = await call(chat, { session: owner, url: room('') });
  assert.equal(snapshot.payload.tasks.length, 2, 'двойного счёта нет');
  const a9 = snapshot.payload.tasks.find(t => t.externalRef === 'А9');
  assert.equal(a9.notes.length, 1, 'то же уточнение не добавляется дважды');
  // Уточнение крепится к исходной задаче, новую не создаёт.
  await call(chat, { session: owner, method: 'POST', url: room(`/tasks/${a9.id}/notes`), body: { text: 'Онлайн запись' } });
  const after = await call(chat, { session: owner, url: room('') });
  assert.equal(after.payload.tasks.length, 2);
  assert.deepEqual(after.payload.tasks.find(t => t.externalRef === 'А9').notes.map(n => n.text),
    ['Только в Алви убрать', 'Онлайн запись']);
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/tasks/import'),
    body: { schemaVersion: 1, tasks: [{ externalRef: 'Д1', title: 'Раз' }, { externalRef: 'Д1', title: 'Два' }] } }), status(400));
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/tasks/import'),
    body: { schemaVersion: 2, tasks: [{ externalRef: 'Д2', title: 'Раз' }] } }), status(400));
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/tasks/import'),
    body: { schemaVersion: 1, tasks: [{ title: 'Без идентификатора' }] } }), status(400));
});

test('задачи реестра не видны участнику чужого проекта и не переносятся между комнатами', async () => {
  const { chat, owner, person, session } = setup();
  await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'),
    body: { schemaVersion: 1, tasks: [{ externalRef: 'А1', title: 'Замечание собственника', site: ROOM }] } });
  const stranger = person('stranger', [OTHER]);
  await assert.rejects(() => call(chat, { session: session(stranger.id), url: room('') }), status(403));
  const other = await call(chat, { session: owner, url: room('', OTHER) });
  assert.equal(other.payload.tasks.length, 0, 'та же метка в другой комнате задачу не показывает');
  // Один и тот же externalRef в разных комнатах — разные задачи, счёт не смешивается.
  const twin = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import', OTHER),
    body: { schemaVersion: 1, tasks: [{ externalRef: 'А1', title: 'Другое замечание', site: OTHER }] } });
  assert.equal(twin.payload.imported, 1);
  assert.equal((await call(chat, { session: owner, url: room('') })).payload.tasks.length, 1);
});

test('блокеры ревью: вид задачи сохраняется, устаревший снимок отклоняется, дата проверки проверяется по-настоящему', async () => {
  const { chat, owner } = setup();

  // 1. Смена вида задачи через PATCH записывается, а не теряется молча.
  const created = await call(chat, { session: owner, method: 'POST', url: room('/tasks'),
    body: { title: 'Яндекс.Метрика на сайте', site: ROOM, kind: 'internal' } });
  assert.equal(created.payload.task.kind, 'internal');
  const switched = await call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${created.payload.task.id}`),
    body: { kind: 'client_remark' } });
  assert.equal(switched.payload.task.kind, 'client_remark');
  const reread = await call(chat, { session: owner, url: room('') });
  assert.equal(reread.payload.tasks.find(task => task.id === created.payload.task.id).kind, 'client_remark',
    'вид задачи сохранён в базе, а не только в ответе');

  // 2. Снимок старше записанного отклоняется, даже когда владелец ничего не правил руками.
  const registry = (asOf, title) => ({ schemaVersion: 1, asOf, tasks: [{ externalRef: 'Б1', title, site: ROOM, status: 'todo' }] });
  const newer = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'), body: registry('2026-09-18', 'Новее') });
  assert.equal(newer.payload.imported, 1);
  const older = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'), body: registry('2026-09-17', 'Старее') });
  assert.equal(older.payload.skipped, 1);
  assert.match(older.payload.results[0].reason, /старше записанного/);
  const kept = await call(chat, { session: owner, url: room('') });
  assert.equal(kept.payload.tasks.find(task => task.externalRef === 'Б1').title, 'Новее');
  // force остаётся единственным способом применить старый снимок сознательно.
  const forcedOld = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'),
    body: { ...registry('2026-09-17', 'Старее'), force: true } });
  assert.equal(forcedOld.payload.imported, 1);

  // 3. Собственная запись синхронизации не выглядит ручной правкой: registry_synced_at и updated_at совпадают.
  const same = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'), body: registry('2026-09-19', 'Ещё новее') });
  assert.equal(same.payload.imported, 1);
  const again = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'), body: registry('2026-09-19', 'Ещё новее') });
  assert.equal(again.payload.imported, 1, 'повтор того же снимка проходит: ложного признака ручной правки нет');
  assert.equal(again.payload.skipped, 0);

  // 4. Дата проверки — настоящая дата или дата-время, а не любая строка.
  const id = created.payload.task.id;
  for (const verifiedAt of ['вчера', '18.09.2026', '2026-02-30', '2026-09-18T25:00:00Z', '2026-13-01']) {
    await assert.rejects(() => call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${id}`),
      body: { publication: 'published', publishedUrl: 'https://example.test/x', verifiedAt } }), status(400));
  }
  for (const verifiedAt of ['2026-09-18', '2026-09-18T12:30:00Z', '2026-09-18T12:30:00+07:00']) {
    const ok = await call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${id}`),
      body: { publication: 'published', publishedUrl: 'https://example.test/x', verifiedAt } });
    assert.equal(ok.payload.task.verifiedAt, verifiedAt);
  }
});

test('ручная правка распознаётся флагом, а не часами: совпавшие до миллисекунды отметки времени не теряют правку', async () => {
  const { chat, owner, db } = setup();
  const registry = (asOf, title) => ({ schemaVersion: 1, asOf, tasks: [
    { externalRef: 'В1', title, site: ROOM, status: 'todo', publication: 'not_started' } ] });

  const first = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'), body: registry('2026-09-18', 'Из реестра') });
  assert.equal(first.payload.imported, 1);
  const id = first.payload.tasks[0].id;
  const row = () => db.prepare('SELECT * FROM project_chat_tasks WHERE id=?').get(id);
  assert.equal(row().registry_dirty, 0, 'после импорта задача чистая');

  // Владелец правит задачу в кабинете.
  await call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${id}`), body: { title: 'Правка владельца' } });
  assert.equal(row().registry_dirty, 1, 'правка из кабинета помечена явно');

  /* Ровно тот случай, который ронял CI: PATCH попал в ту же миллисекунду, что и синхронизация,
     поэтому сравнение updated_at > registry_synced_at ничего не даёт. Воспроизводим детерминированно. */
  db.prepare('UPDATE project_chat_tasks SET updated_at=registry_synced_at WHERE id=?').run(id);
  const same = row();
  assert.equal(same.updated_at, same.registry_synced_at, 'отметки времени совпадают до миллисекунды');

  const stale = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'), body: registry('2026-09-18', 'Из реестра') });
  assert.equal(stale.payload.imported, 0, 'правка владельца не затёрта');
  assert.equal(stale.payload.skipped, 1);
  assert.match(stale.payload.results[0].reason, /позже снимка/);
  assert.equal(row().title, 'Правка владельца');

  // force остаётся единственным способом перезаписать и снимает признак правки.
  const forced = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'),
    body: { ...registry('2026-09-18', 'Из реестра'), force: true } });
  assert.equal(forced.payload.imported, 1);
  assert.equal(row().registry_dirty, 0, 'после перезаписи задача снова чистая');
  assert.equal(row().title, 'Из реестра');

  // И следующий обычный импорт проходит: ложного признака правки не осталось.
  db.prepare('UPDATE project_chat_tasks SET updated_at=registry_synced_at WHERE id=?').run(id);
  const next = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'), body: registry('2026-09-18', 'Снова из реестра') });
  assert.equal(next.payload.imported, 1);
  assert.equal(row().title, 'Снова из реестра');

  // Задача, заведённая руками в кабинете, импортом не перезаписывается даже при совпавшем идентификаторе.
  const byHand = await call(chat, { session: owner, method: 'POST', url: room('/tasks'),
    body: { title: 'Своя задача', externalRef: 'В2', site: ROOM } });
  assert.equal(byHand.statusCode, 201);
  const handId = byHand.payload.task.id;
  assert.equal(db.prepare('SELECT registry_dirty AS d FROM project_chat_tasks WHERE id=?').get(handId).d, 1);
  const collide = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'),
    body: { schemaVersion: 1, asOf: '2026-09-18', tasks: [{ externalRef: 'В2', title: 'Из реестра поверх', site: ROOM }] } });
  assert.equal(collide.payload.skipped, 1);
  assert.equal(db.prepare('SELECT title FROM project_chat_tasks WHERE id=?').get(handId).title, 'Своя задача');
});

test('миграция переносит прежнее правило: правленая до обновления задача остаётся защищённой', async () => {
  const { chat, owner, db } = setup();
  const registry = { schemaVersion: 1, asOf: '2026-09-18', tasks: [
    { externalRef: 'В3', title: 'Из реестра', site: ROOM, status: 'todo' } ] };
  const first = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'), body: registry });
  const id = first.payload.tasks[0].id;

  /* Строка «из прошлой версии»: флага ещё нет (0), но по прежнему правилу она правленая —
     updated_at позже синхронизации. Повторяем то, что делает разовая миграция при обновлении. */
  db.prepare("UPDATE project_chat_tasks SET registry_dirty=0, updated_at='2999-01-01T00:00:00.000Z' WHERE id=?").run(id);
  db.exec(`UPDATE project_chat_tasks SET registry_dirty=1
    WHERE registry_synced_at IS NOT NULL AND registry_synced_at<>'' AND updated_at>registry_synced_at`);
  assert.equal(db.prepare('SELECT registry_dirty AS d FROM project_chat_tasks WHERE id=?').get(id).d, 1);

  const stale = await call(chat, { session: owner, method: 'POST', url: room('/tasks/import'), body: registry });
  assert.equal(stale.payload.skipped, 1, 'правка, сделанная до обновления, не теряется');
});

/* ОТЛОЖЕННАЯ ОТПРАВКА. Время всюду управляемое: ни одного ожидания реального времени. */
const clockAt = (iso) => ({ now: Date.parse(iso), tick(ms) { this.now += ms; } });
const scheduledRows = (db, code = ROOM) => db.prepare('SELECT * FROM project_chat_scheduled WHERE company_code=? ORDER BY id').all(code);
const roomMessages = (db, code = ROOM) => db.prepare('SELECT * FROM project_chat_messages WHERE company_code=? ORDER BY id').all(code);

test('отложенная отправка: пояс переводится в UTC, раньше срока не уходит, в срок уходит один раз существующей очередью', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner, db } = setup({ clock });
  // Комната с привязанной группой: доставка должна лечь в существующую исходящую очередь.
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1001234567890' } });

  // 9:00 по Иркутску — это 01:00 UTC того же дня.
  const created = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, text: 'Доброе утро! Статус по правкам', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.payload.item.dueAt, '2026-09-19T01:00:00.000Z');
  assert.equal(created.payload.item.timezone, 'Asia/Irkutsk');
  assert.equal(created.payload.item.status, 'pending');
  assert.equal(created.payload.item.deliveryStatus, '');

  const before = roomMessages(db).length;
  // За минуту до срока не уходит ничего.
  clock.now = Date.parse('2026-09-19T00:59:00.000Z');
  assert.deepEqual(chat.processScheduledMessages(), { sent: 0, expired: 0, blocked: 0, failed: 0 });
  assert.equal(roomMessages(db).length, before, 'раньше срока сообщение не создаётся');

  // В срок — ровно одно сообщение и одна запись в существующей очереди Telegram.
  clock.now = Date.parse('2026-09-19T01:00:00.000Z');
  assert.deepEqual(chat.processScheduledMessages(), { sent: 1, expired: 0, blocked: 0, failed: 0 });
  const messages = roomMessages(db);
  assert.equal(messages.length, before + 1);
  assert.equal(messages[messages.length - 1].text, 'Доброе утро! Статус по правкам');
  const outbox = db.prepare('SELECT count(*) AS n FROM project_chat_outbox WHERE message_id=?').get(messages[messages.length - 1].id);
  assert.equal(outbox.n, 1, 'доставка идёт существующей очередью, второго транспорта нет');

  // Повторные проходы ничего не задваивают.
  clock.tick(60000);
  assert.deepEqual(chat.processScheduledMessages(), { sent: 0, expired: 0, blocked: 0, failed: 0 });
  assert.equal(roomMessages(db).length, before + 1);
  const row = scheduledRows(db)[0];
  assert.equal(row.status, 'sent');
  assert.equal(row.message_id, messages[messages.length - 1].id);

  // Отправленное больше не изменить и не отменить.
  await assert.rejects(() => call(chat, { session: owner, method: 'PATCH', url: room(`/scheduled/${row.id}`),
    body: { status: 'cancelled' } }), status(409));

  // Задание Хью на своё же сообщение не ставится: отложенная отправка к ИИ не обращается.
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_ai_jobs WHERE message_id=?').get(messages[messages.length - 1].id).n, 0);
});

test('отложенная отправка: перенос и отмена до срока, отменённое не уходит', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner, db } = setup({ clock });
  const first = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, text: 'Напомню про домен', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' } });
  const id = first.payload.item.id;

  // Перенос на другой час и другой пояс.
  const moved = await call(chat, { session: owner, method: 'PATCH', url: room(`/scheduled/${id}`),
    body: { dueAtLocal: '2026-09-19T10:30', timezone: 'Asia/Bangkok', text: 'Напомню про домен и почту' } });
  assert.equal(moved.payload.item.dueAt, '2026-09-19T03:30:00.000Z');
  assert.equal(moved.payload.item.text, 'Напомню про домен и почту');

  // В прошлое перенести нельзя.
  await assert.rejects(() => call(chat, { session: owner, method: 'PATCH', url: room(`/scheduled/${id}`),
    body: { dueAtLocal: '2026-09-18T10:00', timezone: 'Asia/Bangkok' } }), status(400));

  // Отмена до срока: в назначенное время ничего не создаётся.
  const cancelled = await call(chat, { session: owner, method: 'PATCH', url: room(`/scheduled/${id}`), body: { status: 'cancelled' } });
  assert.equal(cancelled.payload.item.status, 'cancelled');
  const before = roomMessages(db).length;
  clock.now = Date.parse('2026-09-19T04:00:00.000Z');
  assert.deepEqual(chat.processScheduledMessages(), { sent: 0, expired: 0, blocked: 0, failed: 0 });
  assert.equal(roomMessages(db).length, before, 'отменённое не отправляется');
});

test('отложенная отправка: перезапуск сервера и просрочка — один раз в запас, старое помечается и не уходит задним числом', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner, db } = setup({ clock });
  const soon = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, text: 'Короткая просрочка', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' } });
  const old = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, text: 'Давняя просрочка', dueAtLocal: '2026-09-19T09:05', timezone: 'Asia/Irkutsk' } });

  /* Сервер «лежал»: первый срок просрочен на два часа (в пределах запаса), второй — на сутки.
     Планировщик ничего не помнит в памяти: состояние только в базе, поэтому перезапуск не мешает. */
  clock.now = Date.parse('2026-09-19T03:00:00.000Z');
  const firstPass = chat.processScheduledMessages();
  assert.equal(firstPass.sent, 2, 'обе просрочки в пределах запаса уходят по одному разу');

  const third = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, text: 'Совсем старое', dueAtLocal: '2026-09-19T12:00', timezone: 'Asia/Irkutsk' } });
  clock.now = Date.parse('2026-09-21T00:00:00.000Z');
  const before = roomMessages(db).length;
  const late = chat.processScheduledMessages();
  assert.deepEqual(late, { sent: 0, expired: 1, blocked: 0, failed: 0 });
  assert.equal(roomMessages(db).length, before, 'задним числом клиенту ничего не уходит');
  const expired = db.prepare('SELECT * FROM project_chat_scheduled WHERE id=?').get(third.payload.item.id);
  assert.equal(expired.status, 'expired');
  assert.match(expired.error, /Срок прошёл/);
  void soon; void old;
});

test('отложенная отправка: права проверяются в момент отправки, чужой проект недоступен', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner, db, person, session } = setup({ clock });
  const helper = person('daria', [ROOM]);
  await call(chat, { session: owner, method: 'PUT', url: room('/members'), body: { userIds: [OWNER_ID, helper.id] } });

  const planned = await call(chat, { session: session(helper.id), method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, text: 'Сообщение участника', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' } });
  assert.equal(planned.statusCode, 201);

  // Участника исключили из комнаты до наступления срока.
  await call(chat, { session: owner, method: 'PUT', url: room('/members'), body: { userIds: [OWNER_ID] } });
  const before = roomMessages(db).length;
  clock.now = Date.parse('2026-09-19T01:00:00.000Z');
  const result = chat.processScheduledMessages();
  assert.deepEqual(result, { sent: 0, expired: 0, blocked: 1, failed: 0 });
  assert.equal(roomMessages(db).length, before, 'исключённый автор не отправляет клиенту ничего');
  const row = scheduledRows(db)[0];
  assert.equal(row.status, 'error');
  assert.match(row.error, /больше не может писать/);

  // Чужой проект недоступен и на планирование.
  const outsider = person('stranger', [OTHER]);
  await assert.rejects(() => call(chat, { session: session(outsider.id), method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, text: 'Чужое', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' } }), status(403));
});

test('отложенная отправка: напоминание по задаче даёт ссылку на задачу, чужая задача отклоняется', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner, db } = setup({ clock });
  const task = await call(chat, { session: owner, method: 'POST', url: room('/tasks'),
    body: { title: 'Выложить правку по фото', externalRef: 'А8', site: ROOM } });
  const taskId = task.payload.task.id;

  const planned = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, kind: 'task_reminder', taskId, text: 'Проверить, что правка на сайте',
      dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' } });
  assert.equal(planned.payload.item.kind, 'task_reminder');
  assert.equal(planned.payload.item.taskId, taskId);

  clock.now = Date.parse('2026-09-19T01:00:00.000Z');
  assert.equal(chat.processScheduledMessages().sent, 1);
  const last = roomMessages(db).pop();
  assert.match(last.text, /Напоминание по задаче А8: Выложить правку по фото/);
  assert.match(last.text, /Проверить, что правка на сайте/);
  // Ссылка ведёт на реально существующий адрес кабинета: выдуманного маршрута на задачу здесь нет.
  assert.match(last.text, /cabinet\.html#hugh/, 'в напоминании есть ссылка на чат проекта в кабинете');
  assert.doesNotMatch(last.text, /task=/, 'выдуманных параметров маршрута в ссылке нет');

  // Задача другого проекта в напоминание не берётся.
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/scheduled', OTHER),
    body: { clientId: `plan-${crypto.randomUUID()}`, kind: 'task_reminder', taskId, text: 'Чужая задача', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' } }), status(400));
});

test('напоминание: выполненная или отменённая задача не создаёт сообщение и сохраняет причину отмены', async (t) => {
  for (const taskStatus of ['done', 'cancelled']) {
    for (const when of ['before-planning', 'before-due', 'after-due']) {
      await t.test(`${taskStatus}, ${when}`, async () => {
        const clock = clockAt('2026-09-18T20:00:00.000Z');
        const { chat, owner, db } = setup({ clock });
        await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1001234567890' } });
        const task = await call(chat, { session: owner, method: 'POST', url: room('/tasks'),
          body: { title: 'Согласовать материал', status: when === 'before-planning' ? taskStatus : 'todo' } });
        const taskId = task.payload.task.id;
        const body = { clientId: `plan-${crypto.randomUUID()}`, kind: 'task_reminder', taskId,
          text: 'Проверить материал', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' };
        const planned = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'), body });
        if (when === 'after-due') clock.now = Date.parse('2026-09-19T01:01:00.000Z');
        if (when !== 'before-planning') await call(chat, { session: owner, method: 'PATCH',
          url: room(`/tasks/${taskId}`), body: { status: taskStatus } });
        if (when !== 'after-due') {
          assert.equal(chat.processScheduledMessages().sent, 0);
          assert.equal(scheduledRows(db)[0].status, 'pending', 'до срока сохраняется прежняя семантика расписания');
          clock.now = Date.parse('2026-09-19T01:00:00.000Z');
        }
        const before = roomMessages(db).length;
        assert.deepEqual(chat.processScheduledMessages(), { sent: 0, expired: 0, blocked: 1, failed: 0 });
        assert.equal(roomMessages(db).length, before);
        assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_outbox').get().n, 0);
        const row = scheduledRows(db)[0];
        assert.equal(row.status, 'cancelled');
        assert.match(row.error, taskStatus === 'done' ? /Задача уже выполнена/ : /Задача отменена/);
        assert.equal(row.message_id, null);
        assert.equal(row.sent_at, null);
        assert.equal(row.attempts, 0, 'это окончательная отмена, а не неудачная попытка доставки');
        const again = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'), body });
        assert.equal(again.payload.item.id, planned.payload.item.id);
        assert.equal(again.payload.item.status, 'cancelled');
        assert.equal(again.payload.item.deliveryStatus, '');
        await call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${taskId}`), body: { status: 'todo' } });
        assert.equal(chat.processScheduledMessages().sent, 0, 'повторное открытие задачи не возрождает отменённое напоминание');
        assert.equal(roomMessages(db).length, before);
      });
    }
  }
});

test('напоминание: исчезнувшая задача или связь с другой компанией отменяет отправку без раскрытия данных', async (t) => {
  for (const changed of ['deleted', 'missing-id', 'other-company']) {
    await t.test(changed, async () => {
      const clock = clockAt('2026-09-18T20:00:00.000Z');
      const { chat, owner, db } = setup({ clock });
      await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1001234567890' } });
      const task = await call(chat, { session: owner, method: 'POST', url: room('/tasks'), body: { title: 'Нужен исходник' } });
      const taskId = task.payload.task.id;
      const planned = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
        body: { clientId: `plan-${crypto.randomUUID()}`, kind: 'task_reminder', taskId, text: 'Прислать исходник',
          dueAt: '2026-09-19T01:00:00Z', timezone: 'UTC' } });
      if (changed === 'deleted') {
        // Только тестовая БД: имитируем старую/восстановленную запись с отсутствующей задачей.
        db.exec('PRAGMA foreign_keys = OFF');
        db.prepare('DELETE FROM project_chat_tasks WHERE id=?').run(taskId);
        db.exec('PRAGMA foreign_keys = ON');
      } else if (changed === 'missing-id') {
        db.prepare('UPDATE project_chat_scheduled SET task_id=NULL WHERE id=?').run(planned.payload.item.id);
      } else {
        await call(chat, { session: owner, url: room('', OTHER) });
        db.prepare('UPDATE project_chat_tasks SET company_code=?,title=? WHERE id=?')
          .run(OTHER, 'Закрытое описание другого проекта', taskId);
      }
      const before = roomMessages(db).length;
      clock.now = Date.parse('2026-09-19T01:00:00.000Z');
      assert.deepEqual(chat.processScheduledMessages(), { sent: 0, expired: 0, blocked: 1, failed: 0 });
      const row = scheduledRows(db)[0];
      assert.equal(row.status, 'cancelled');
      assert.match(row.error, /Задача больше не найдена в этом проекте/);
      assert.doesNotMatch(row.error, /Закрытое описание/);
      assert.equal(row.message_id, null);
      assert.equal(row.sent_at, null);
      assert.equal(roomMessages(db).length, before);
      assert.equal(roomMessages(db, OTHER).length, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_outbox').get().n, 0);
      assert.equal(chat.processScheduledMessages().blocked, 0, 'терминальная отмена не повторяется');
    });
  }
});

test('напоминание: незавершённые задачи продолжают отправляться один раз с текущим заголовком', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner, db } = setup({ clock });
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1001234567890' } });
  for (const taskStatus of ['todo', 'in_progress', 'blocked']) {
    const task = await call(chat, { session: owner, method: 'POST', url: room('/tasks'),
      body: { title: `Материал ${taskStatus}` } });
    const taskId = task.payload.task.id;
    await call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
      body: { clientId: `plan-${crypto.randomUUID()}`, kind: 'task_reminder', taskId, text: 'Обновить статус',
        dueAtLocal: '2026-09-19T08:00', timezone: 'Asia/Bangkok' } });
    await call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${taskId}`),
      body: { status: taskStatus, title: `Актуальный материал ${taskStatus}` } });
  }
  clock.now = Date.parse('2026-09-19T01:00:00.000Z');
  assert.equal(chat.processScheduledMessages().sent, 3);
  assert.equal(roomMessages(db).length, 3);
  assert.ok(roomMessages(db).every(message => message.text.includes('Актуальный материал')));
  assert.ok(scheduledRows(db).every(row => row.status === 'sent' && row.message_id && row.sent_at));
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_outbox').get().n, 3);
  assert.equal(chat.processScheduledMessages().sent, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_outbox').get().n, 3);
});

test('отложенное обычное сообщение отправляется независимо от закрытия связанной задачи', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner, db } = setup({ clock });
  for (const taskStatus of ['done', 'cancelled']) {
    const task = await call(chat, { session: owner, method: 'POST', url: room('/tasks'), body: { title: 'Материал' } });
    const taskId = task.payload.task.id;
    await call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
      body: { clientId: `plan-${crypto.randomUUID()}`, kind: 'message', taskId, text: `Сводка ${taskStatus}`,
        dueAt: '2026-09-19T01:00:00Z' } });
    await call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${taskId}`), body: { status: taskStatus } });
  }
  await call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, text: 'Сводка без задачи', dueAt: '2026-09-19T01:00:00Z' } });
  clock.now = Date.parse('2026-09-19T01:00:00.000Z');
  assert.deepEqual(chat.processScheduledMessages(), { sent: 3, expired: 0, blocked: 0, failed: 0 });
  assert.deepEqual(roomMessages(db).map(message => message.text), ['Сводка done', 'Сводка cancelled', 'Сводка без задачи']);
});

test('напоминание: закрытие задачи после создания сообщения не меняет отправку и не создаёт дубль', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner, db } = setup({ clock });
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1001234567890' } });
  const task = await call(chat, { session: owner, method: 'POST', url: room('/tasks'), body: { title: 'Согласовать материал' } });
  const taskId = task.payload.task.id;
  await call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, kind: 'task_reminder', taskId, text: 'Нужен ответ', dueAt: '2026-09-19T01:00:00Z' } });
  clock.now = Date.parse('2026-09-19T01:00:00.000Z');
  assert.equal(chat.processScheduledMessages().sent, 1);
  const before = scheduledRows(db)[0];
  await call(chat, { session: owner, method: 'PATCH', url: room(`/tasks/${taskId}`), body: { status: 'done' } });
  assert.deepEqual(chat.processScheduledMessages(), { sent: 0, expired: 0, blocked: 0, failed: 0 });
  assert.deepEqual(scheduledRows(db)[0], before, 'уже созданное сообщение остаётся в существующей очереди доставки');
  assert.equal(roomMessages(db).length, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_outbox').get().n, 1);
});

test('напоминание: смена комнаты Telegram по-прежнему блокирует незавершённую задачу', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner, db } = setup({ clock });
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1001234567890' } });
  const task = await call(chat, { session: owner, method: 'POST', url: room('/tasks'), body: { title: 'Согласовать материал' } });
  await call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, kind: 'task_reminder', taskId: task.payload.task.id,
      text: 'Нужен ответ', dueAt: '2026-09-19T01:00:00Z' } });
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1002222222222' } });
  clock.now = Date.parse('2026-09-19T01:00:00.000Z');
  assert.deepEqual(chat.processScheduledMessages(), { sent: 0, expired: 0, blocked: 1, failed: 0 });
  assert.equal(scheduledRows(db)[0].status, 'error');
  assert.match(scheduledRows(db)[0].error, /группа проекта изменилась/i);
  assert.equal(roomMessages(db).length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_outbox').get().n, 0);
});

test('отложенная отправка: срок в прошлом, неизвестный пояс и лишние поля отклоняются', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner } = setup({ clock });
  const bad = (body) => call(chat, { session: owner, method: 'POST', url: room('/scheduled'), body });
  await assert.rejects(() => bad({ text: 'Поздно', dueAtLocal: '2026-09-18T10:00', timezone: 'Asia/Irkutsk' }), status(400));
  await assert.rejects(() => bad({ text: 'Плохой пояс', dueAtLocal: '2026-09-19T09:00', timezone: 'Марс/Олимп' }), status(400));
  await assert.rejects(() => bad({ text: 'Без срока' }), status(400));
  await assert.rejects(() => bad({ text: 'Пустой пояс', dueAtLocal: '19.09.2026 09:00', timezone: 'Asia/Irkutsk' }), status(400));
  await assert.rejects(() => bad({ text: 'Лишнее поле', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk', secret: 1 }), status(400));
  await assert.rejects(() => bad({ text: '', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' }), status(400));
  await assert.rejects(() => bad({ text: 'Слишком далеко', dueAtLocal: '2030-09-19T09:00', timezone: 'Asia/Irkutsk' }), status(400));
});

test('отложенная отправка: смена и отключение Telegram-группы не отправляют старое сообщение новой аудитории', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner, db } = setup({ clock });
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1001111111111' } });
  const planned = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, text: 'Сводка для группы', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' } });

  // Владелец перепривязал проект к другой группе.
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1002222222222' } });
  const before = roomMessages(db).length;
  clock.now = Date.parse('2026-09-19T01:00:00.000Z');
  const moved = chat.processScheduledMessages();
  assert.equal(moved.blocked, 1);
  assert.equal(roomMessages(db).length, before, 'в новую группу старое сообщение не уходит');
  const row = db.prepare('SELECT * FROM project_chat_scheduled WHERE id=?').get(planned.payload.item.id);
  assert.equal(row.status, 'error');
  assert.match(row.error, /группа проекта изменилась/i);

  // Отключение группы — тот же исход, тоже без отправки.
  const second = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, text: 'Вторая сводка', dueAtLocal: '2026-09-19T10:00', timezone: 'Asia/Irkutsk' } });
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '' } });
  clock.now = Date.parse('2026-09-19T02:00:00.000Z');
  assert.equal(chat.processScheduledMessages().blocked, 1);
  assert.equal(db.prepare('SELECT status FROM project_chat_scheduled WHERE id=?').get(second.payload.item.id).status, 'error');
});

test('отложенная отправка: повтор запроса не создаёт второе сообщение, тот же ключ с другим текстом отклоняется', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner, db } = setup({ clock });
  const body = { clientId: 'plan-fixed-key-0001', text: 'Единственная сводка',
    dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' };
  const first = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'), body });
  const again = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'), body });
  assert.equal(again.payload.item.id, first.payload.item.id, 'потерянный ответ не превращается во вторую отправку');
  assert.equal(db.prepare("SELECT count(*) AS n FROM project_chat_scheduled WHERE company_code=?").get(ROOM).n, 1);

  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { ...body, text: 'Другой текст' } }), status(409));
  // Ключ обязателен: без него повтор неразличим.
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { text: 'Без ключа', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' } }), status(400));
});

test('отложенная отправка: чужую запись участник не меняет, владелец и автор — могут', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner, person, session } = setup({ clock });
  const daria = person('daria2', [ROOM]);
  const boris = person('boris', [ROOM]);
  await call(chat, { session: owner, method: 'PUT', url: room('/members'), body: { userIds: [OWNER_ID, daria.id, boris.id] } });

  const mine = await call(chat, { session: session(daria.id), method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, text: 'Сообщение Дарьи', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' } });
  const id = mine.payload.item.id;

  // Другой участник с правом ответа чужую отправку не трогает.
  await assert.rejects(() => call(chat, { session: session(boris.id), method: 'PATCH', url: room(`/scheduled/${id}`),
    body: { text: 'Подменённый текст' } }), status(403));
  await assert.rejects(() => call(chat, { session: session(boris.id), method: 'PATCH', url: room(`/scheduled/${id}`),
    body: { status: 'cancelled' } }), status(403));

  // Автор меняет свою, владелец может отменить любую.
  const edited = await call(chat, { session: session(daria.id), method: 'PATCH', url: room(`/scheduled/${id}`), body: { text: 'Свой текст' } });
  assert.equal(edited.payload.item.text, 'Свой текст');
  const cancelled = await call(chat, { session: owner, method: 'PATCH', url: room(`/scheduled/${id}`), body: { status: 'cancelled' } });
  assert.equal(cancelled.payload.item.status, 'cancelled');
});

test('отложенная отправка: перезапуск сервера с новой базой и новым экземпляром доставляет ровно один раз', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const first = setup({ clock, file: true });
  await call(first.chat, { session: first.owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1001234567890' } });
  await call(first.chat, { session: first.owner, method: 'POST', url: room('/scheduled'),
    body: { clientId: 'plan-restart-0001', text: 'Переживи перезапуск', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' } });
  // «Сервер выключили»: закрываем базу и поднимаем НОВЫЙ экземпляр на том же файле.
  first.db.close();

  const restarted = setup({ clock, file: true, dir: first.dir });
  clock.now = Date.parse('2026-09-19T01:00:00.000Z');
  assert.equal(restarted.chat.processScheduledMessages().sent, 1, 'после перезапуска отправка состоялась');
  const messages = roomMessages(restarted.db);
  assert.equal(messages.filter(m => m.text === 'Переживи перезапуск').length, 1);

  // Ещё один «перезапуск» — второго сообщения не появляется.
  restarted.db.close();
  const third = setup({ clock, file: true, dir: first.dir });
  clock.tick(3600000);
  assert.equal(third.chat.processScheduledMessages().sent, 0);
  assert.equal(roomMessages(third.db).filter(m => m.text === 'Переживи перезапуск').length, 1);
  third.db.close();
});

test('отложенная отправка: несуществующее местное время отклоняется, повторяющийся час берётся первым', async () => {
  const clock = clockAt('2026-03-01T00:00:00.000Z');
  const { chat, owner } = setup({ clock });
  const plan = (dueAtLocal, timezone) => call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, text: 'Перевод стрелок', dueAtLocal, timezone } });
  // 29.03.2026 02:30 в Берлине не существует: стрелки переводят с 02:00 на 03:00.
  await assert.rejects(() => plan('2026-03-29T02:30', 'Europe/Berlin'), status(400));
  const exists = await plan('2026-03-29T03:30', 'Europe/Berlin');
  assert.equal(exists.payload.item.dueAt, '2026-03-29T01:30:00.000Z');
  // 25.10.2026 02:30 в Берлине наступает дважды: берём первое, более раннее вхождение.
  const fold = await plan('2026-10-25T02:30', 'Europe/Berlin');
  assert.equal(fold.payload.item.dueAt, '2026-10-25T00:30:00.000Z');
});

test('отложенная отправка: пояс проверяется во всех ветках, готовый момент — только настоящий ISO', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner } = setup({ clock });
  const plan = (body) => call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, text: 'Проверка', ...body } });

  // Готовый момент: только Z или смещение, существующая дата.
  await assert.rejects(() => plan({ dueAt: '2026-09-19 09:00' }), status(400));
  await assert.rejects(() => plan({ dueAt: '2026-02-30T09:00:00Z' }), status(400));
  await assert.rejects(() => plan({ dueAt: 'завтра' }), status(400));
  const absolute = await plan({ dueAt: '2026-09-19T01:00:00Z' });
  assert.equal(absolute.payload.item.dueAt, '2026-09-19T01:00:00.000Z');
  const offset = await plan({ dueAt: '2026-09-19T09:00:00+08:00' });
  assert.equal(offset.payload.item.dueAt, '2026-09-19T01:00:00.000Z');

  // Пояс проверяется и рядом с готовым моментом.
  await assert.rejects(() => plan({ dueAt: '2026-09-19T01:00:00Z', timezone: 'Марс/Олимп' }), status(400));

  // И при изменении одного только пояса.
  const item = await plan({ dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' });
  await assert.rejects(() => call(chat, { session: owner, method: 'PATCH', url: room(`/scheduled/${item.payload.item.id}`),
    body: { timezone: 'Совсем/Нет' } }), status(400));
  // Пояс не прислали — наследуется прежний, срок не меняется.
  const kept = await call(chat, { session: owner, method: 'PATCH', url: room(`/scheduled/${item.payload.item.id}`),
    body: { text: 'Только текст' } });
  assert.equal(kept.payload.item.timezone, 'Asia/Irkutsk');
  assert.equal(kept.payload.item.dueAt, item.payload.item.dueAt);
});

test('отложенная отправка: повтор запроса узнаётся даже после срока и при заполненной очереди', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner } = setup({ clock });
  const body = { clientId: 'plan-late-0001', text: 'Утренняя сводка', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' };
  const first = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'), body });

  // Срок прошёл, сообщение уже отправлено — повтор того же запроса возвращает ту же запись, а не ошибку.
  clock.now = Date.parse('2026-09-19T02:00:00.000Z');
  assert.equal(chat.processScheduledMessages().sent, 1);
  const repeat = await call(chat, { session: owner, method: 'POST', url: room('/scheduled'), body });
  assert.equal(repeat.payload.item.id, first.payload.item.id);
  assert.equal(repeat.payload.item.status, 'sent');

  // Новая запись с прошедшим сроком по-прежнему отклоняется.
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/scheduled'),
    body: { ...body, clientId: 'plan-late-0002' } }), status(400));
});

test('отложенная отправка: право менять отдаётся сервером и совпадает с тем, что он разрешает', async () => {
  const clock = clockAt('2026-09-18T20:00:00.000Z');
  const { chat, owner, person, session } = setup({ clock });
  const daria = person('daria3', [ROOM]);
  const boris = person('boris2', [ROOM]);
  await call(chat, { session: owner, method: 'PUT', url: room('/members'), body: { userIds: [OWNER_ID, daria.id, boris.id] } });
  await call(chat, { session: session(daria.id), method: 'POST', url: room('/scheduled'),
    body: { clientId: `plan-${crypto.randomUUID()}`, text: 'Сообщение Дарьи', dueAtLocal: '2026-09-19T09:00', timezone: 'Asia/Irkutsk' } });

  const forAuthor = await call(chat, { session: session(daria.id), url: room('') });
  assert.equal(forAuthor.payload.scheduled[0].canManage, true, 'автору управление разрешено');
  const forOther = await call(chat, { session: session(boris.id), url: room('') });
  assert.equal(forOther.payload.scheduled[0].canManage, false, 'постороннему участнику — нет');
  assert.equal(forOther.payload.scheduled[0].authorId, daria.id);
  const forOwner = await call(chat, { session: owner, url: room('') });
  assert.equal(forOwner.payload.scheduled[0].canManage, true, 'владельцу разрешено');
});
