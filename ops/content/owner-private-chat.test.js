'use strict';

/* Личная переписка владельца с Хью по проектам: область доступа, изоляция от клиентского
   чата и от Telegram, отказ клиенту, чужой компании и второму владельцу.
   Живых обращений нет: ответ модели подменён.
   Запуск: node --test ops/content/owner-private-chat.test.js */

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createProjectChat } = require('./project-chat');
const { createOwnerPrivateChat, OWNER_PRIVATE_AUDIENCE } = require('./owner-private-chat');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const PILOT = 'alvi', SECOND = 'avokado';
const SECRET = 'Личная заметка владельца: клиенту это показывать нельзя';

const requireSession = (request) => {
  if (!request.session) throw Object.assign(new Error('Требуется вход'), { status: 401 });
  return request.session;
};
const requireCsrf = (request, session) => {
  if (String(request.headers['x-csrf-token'] || '') !== session.csrf) {
    throw Object.assign(new Error('Некорректный CSRF-токен'), { status: 403 });
  }
};
const sendJson = (response, status, payload) => { response.statusCode = status; response.payload = payload; };
const readBody = async (request) => request.body;

function setup(t, { ask } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-private-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  // Два владельца и клиент: клиентские записи создаются ролью editor.
  const authStore = createAuthStore(db, `vlad:owner:${HASH};second:owner:${HASH}`);
  const clientId = authStore.create(1, { login: 'client-alvi', displayName: 'Клиент ALVI',
    password: 'Client-password-1', companies: [PILOT], permissions: ['chat.view', 'chat.reply'] }, HASH).id;
  const asked = [];
  const chat = createProjectChat({ db, authStore, assetsDir: dir, requireSession, requireCsrf,
    sendJson, readBody, fetchImpl: async () => { throw new Error('сеть в тестах не используется'); },
    statusTtl: 0, fallback: { env: {} } });
  const priv = createOwnerPrivateChat({ db, authStore, requireSession, requireCsrf, sendJson, readBody,
    ask: async (payload) => { asked.push(payload); return ask ? ask(payload) : { text: 'Ответ Хью', provider: 'test', model: 'test-model' }; } });
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const session = (id) => ({ user: authStore.getById(id), csrf: `csrf-${id}` });
  return { db, chat, priv, asked, authStore,
    owner: session(1), otherOwner: session(2), client: session(clientId), clientId };
}

async function call(priv, session, method, pathname, body) {
  const request = { method, headers: session ? { 'x-csrf-token': session.csrf } : {}, session, body };
  const response = { statusCode: 0, payload: null };
  try {
    const handled = await priv.handle(request, response, new URL(`http://x${pathname}`));
    return { handled, statusCode: response.statusCode, payload: response.payload, error: null };
  } catch (error) {
    return { handled: false, statusCode: error.status || 500, payload: null, error };
  }
}
const say = (priv, session, code, text, requestId) =>
  call(priv, session, 'POST', `/content/owner-chat/${code}/messages`, requestId ? { text, requestId } : { text });
const open = (priv, session, code) => call(priv, session, 'GET', `/content/owner-chat/${code}`);

test('владелец пишет лично по проекту, ответ сохраняется в личной ветке', async (t) => {
  const f = setup(t);
  const sent = await say(f.priv, f.owner, PILOT, SECRET);
  assert.equal(sent.statusCode, 201, `отправка не прошла: ${sent.error?.message}`);
  assert.equal(sent.payload.audience, OWNER_PRIVATE_AUDIENCE);
  assert.match(sent.payload.audienceLabel, /Клиент её не видит/);
  const texts = sent.payload.messages.map((m) => m.text);
  assert.deepEqual(texts, [SECRET, 'Ответ Хью']);
  // В модель ушла только личная история этого владельца и явная отметка аудитории.
  assert.equal(f.asked.length, 1);
  assert.equal(f.asked[0].audience, OWNER_PRIVATE_AUDIENCE);
  assert.equal(f.asked[0].companyCode, PILOT);
  assert.match(f.asked[0].system, /личная переписка владельца/i);
  assert.deepEqual(f.asked[0].messages.map((m) => m.content), [SECRET]);
});

test('истории проектов не смешиваются между собой', async (t) => {
  const f = setup(t);
  await say(f.priv, f.owner, PILOT, `${SECRET} · ALVI`);
  await say(f.priv, f.owner, SECOND, `${SECRET} · Авокадо`);
  const alvi = await open(f.priv, f.owner, PILOT);
  const avokado = await open(f.priv, f.owner, SECOND);
  assert.equal(alvi.payload.messages.filter((m) => m.author === 'owner').length, 1);
  assert.match(alvi.payload.messages[0].text, /ALVI/);
  assert.equal(JSON.stringify(alvi.payload.messages).includes('Авокадо'), false);
  assert.match(avokado.payload.messages[0].text, /Авокадо/);
  assert.equal(JSON.stringify(avokado.payload.messages).includes('ALVI'), false);
  // Второе обращение получило контекст только своего проекта.
  assert.deepEqual(f.asked[1].messages.map((m) => m.content), [`${SECRET} · Авокадо`]);
});

test('клиент не получает личную переписку ни по одному маршруту', async (t) => {
  const f = setup(t);
  await say(f.priv, f.owner, PILOT, SECRET);
  for (const [method, pathname, body] of [
    ['GET', `/content/owner-chat/${PILOT}`, undefined],
    ['GET', '/content/owner-chat', undefined],
    ['POST', `/content/owner-chat/${PILOT}/messages`, { text: 'Пробую войти' }],
  ]) {
    const result = await call(f.priv, f.client, method, pathname, body);
    assert.equal(result.statusCode, 403, `клиент не должен пройти: ${method} ${pathname}`);
    assert.match(result.error.message, /только владельцу/);
    assert.equal(result.payload, null);
  }
  // Без сессии — тоже отказ, и подсказки о существовании переписки нет.
  const anonymous = await call(f.priv, null, 'GET', `/content/owner-chat/${PILOT}`);
  assert.equal(anonymous.statusCode, 401);
});

test('второй владелец видит собственную пустую ветку, а не переписку первого', async (t) => {
  const f = setup(t);
  await say(f.priv, f.owner, PILOT, SECRET);
  const other = await open(f.priv, f.otherOwner, PILOT);
  assert.equal(other.statusCode, 200, 'у второго владельца есть своя личная переписка');
  assert.deepEqual(other.payload.messages, [], 'чужая история не показывается');
  assert.equal(JSON.stringify(other.payload).includes(SECRET), false);
  // И запись второго владельца не попадает в ветку первого.
  await say(f.priv, f.otherOwner, PILOT, 'Заметка второго владельца');
  const first = await open(f.priv, f.owner, PILOT);
  assert.equal(JSON.stringify(first.payload.messages).includes('второго владельца'), false);
  assert.deepEqual(first.payload.messages.map((m) => m.text), [SECRET, 'Ответ Хью']);
});

test('роль из тела запроса и подставленный идентификатор ничего не открывают', async (t) => {
  const f = setup(t);
  await say(f.priv, f.owner, PILOT, SECRET);
  const forged = { ...f.client, user: { ...f.client.user, role: 'owner' } };
  // Сессия подделана в теле/объекте клиента, но учётная запись перечитывается сервером.
  const result = await call(f.priv, forged, 'GET', `/content/owner-chat/${PILOT}`);
  assert.equal(result.statusCode, 403, 'роль берётся из учётной записи, а не из присланных данных');
  const extra = await call(f.priv, f.owner, 'POST', `/content/owner-chat/${PILOT}/messages`,
    { text: 'Проба', ownerUserId: 2, audience: 'client-shared' });
  assert.equal(extra.statusCode, 400, 'посторонние поля не принимаются');
  const unknown = await open(f.priv, f.owner, 'no-such-company');
  assert.equal(unknown.statusCode, 404, 'угаданный код проекта не создаёт ветку');
});

test('отозванный доступ закрывает личную переписку по прежней сессии', async (t) => {
  const f = setup(t);
  const stale = { user: { ...f.owner.user, sessionVersion: f.owner.user.sessionVersion + 5 }, csrf: f.owner.csrf };
  const result = await open(f.priv, stale, PILOT);
  assert.equal(result.statusCode, 401, 'устаревшая сессия не проходит');
});

test('запись без CSRF-токена отклоняется', async (t) => {
  const f = setup(t);
  const request = { method: 'POST', headers: {}, session: f.owner, body: { text: SECRET } };
  const response = { statusCode: 0, payload: null };
  await assert.rejects(() => f.priv.handle(request, response, new URL(`http://x/content/owner-chat/${PILOT}/messages`)),
    /CSRF/);
  assert.equal(f.asked.length, 0, 'без CSRF обращения к модели не было');
});

test('личные сообщения не попадают ни в общий чат, ни в очередь Telegram, ни в задания модели', async (t) => {
  const f = setup(t);
  await say(f.priv, f.owner, PILOT, SECRET);
  await say(f.priv, f.owner, SECOND, SECRET);

  // Общий чат проекта: снимок и история владельца.
  const snapshot = await f.chat.snapshot(PILOT, f.owner.user, {});
  assert.equal(JSON.stringify(snapshot).includes(SECRET), false, 'снимок общего чата не содержит личного текста');
  assert.equal(JSON.stringify(f.chat.listMessages(PILOT, {})).includes(SECRET), false);

  // Ни одной строки в клиентских таблицах.
  for (const table of ['project_chat_messages', 'project_chat_attachments', 'project_chat_outbox',
    'project_chat_ai_jobs', 'project_chat_tasks', 'project_chat_scheduled', 'project_chat_task_notes']) {
    const n = f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    assert.equal(n, 0, `личная переписка не должна создавать строки в ${table}, найдено ${n}`);
  }

  // Исходящая очередь Telegram пуста: отправлять нечего.
  assert.deepEqual(f.chat.pendingTelegram ? f.chat.pendingTelegram(50) : [], []);

  // Личные строки существуют и помечены своей аудиторией.
  const rows = f.db.prepare('SELECT DISTINCT audience FROM owner_private_messages').all();
  assert.deepEqual(rows.map((row) => row.audience), [OWNER_PRIVATE_AUDIENCE]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM owner_private_messages').get().n, 4);
});

test('задачи проекта видны карточками, но личная переписка в них не попадает и их не меняет', async (t) => {
  const f = setup(t);
  f.db.prepare(`INSERT INTO project_chat_rooms(company_code,title,created_at,updated_at)
    VALUES(?,?,?,?)`).run(PILOT, 'ALVI', '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z');
  f.db.prepare(`INSERT INTO project_chat_tasks(company_code,title,status,created_at,updated_at)
    VALUES(?,?,?,?,?)`).run(PILOT, 'Согласовать план', 'todo', '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z');
  await say(f.priv, f.owner, PILOT, SECRET);
  const view = await open(f.priv, f.owner, PILOT);
  assert.equal(view.payload.tasks.length, 1);
  assert.equal(view.payload.tasks[0].title, 'Согласовать план');
  // Карточки лежат отдельно от истории и не содержат личного текста.
  assert.equal(JSON.stringify(view.payload.tasks).includes(SECRET), false);
  assert.equal(view.payload.handoff.enabled, false, 'перенос в задачи пока выключен');
  assert.match(view.payload.clientChat.label, /видно клиенту/);
  assert.equal(view.payload.clientChat.audience, 'client-shared');
  // Личное обращение не создало и не изменило задач.
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM project_chat_tasks').get().n, 1);
});

test('повтор с тем же идентификатором запроса не задваивает сообщение и не тратит обращение', async (t) => {
  const f = setup(t);
  const first = await say(f.priv, f.owner, PILOT, SECRET, 'req-1');
  assert.equal(first.payload.repeated, false);
  const again = await say(f.priv, f.owner, PILOT, SECRET, 'req-1');
  assert.equal(again.payload.repeated, true);
  assert.equal(f.asked.length, 1, 'повтор не обращается к модели второй раз');
  assert.equal(again.payload.messages.filter((m) => m.author === 'owner').length, 1);
});

test('смена провайдера и модели не меняет область: ответ остаётся в личной ветке', async (t) => {
  let call = 0;
  const f = setup(t, { ask: () => (++call === 1
    ? { text: 'Ответ первой модели', provider: 'openrouter', model: 'model-a' }
    : { text: 'Ответ второй модели', provider: 'deepseek', model: 'model-b' }) });
  await say(f.priv, f.owner, PILOT, `${SECRET} раз`);
  await say(f.priv, f.owner, PILOT, `${SECRET} два`);
  // Оба обращения несут отметку аудитории, какой бы провайдер ни ответил.
  assert.deepEqual(f.asked.map((item) => item.audience), [OWNER_PRIVATE_AUDIENCE, OWNER_PRIVATE_AUDIENCE]);
  const rows = f.db.prepare(`SELECT provider,model,audience FROM owner_private_messages
    WHERE author_type='assistant' ORDER BY id`).all();
  assert.deepEqual(rows.map((row) => row.model), ['model-a', 'model-b']);
  assert.deepEqual(rows.map((row) => row.audience), [OWNER_PRIVATE_AUDIENCE, OWNER_PRIVATE_AUDIENCE]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM project_chat_messages').get().n, 0,
    'смена модели не переносит ответ в общий чат');
});

test('недоступность модели сохраняет вопрос владельца и честно сообщает об отказе', async (t) => {
  const f = setup(t, { ask: () => { throw new Error('Резервные провайдеры недоступны'); } });
  const result = await say(f.priv, f.owner, PILOT, SECRET);
  assert.equal(result.statusCode, 503);
  assert.match(result.error.message, /недоступн/i);
  const view = await open(f.priv, f.owner, PILOT);
  assert.deepEqual(view.payload.messages.map((m) => m.text), [SECRET], 'вопрос сохранён, выдуманного ответа нет');
});
