'use strict';

/* Личное напоминание от Хью (specs/083-project-chat-personal-reminders): подтверждённый участник,
   подписанное разрешение того же бота, права владельца, очередь personal:<n>, квитанция и защиты.
   Тестовая пара ключей Ed25519 передаётся только фабрике в этом файле.
   node --test ops/content/personal-reminders.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createProjectChat } = require('./project-chat');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const ROOM = 'palitra-love';
const OTHER = 'alvi';
const OWNER_ID = 1;
const BOT_ID = '777000';
const GROUP = '-100777000111';
const DARIA_TG = 5001;
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_HEX = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const BOTH = { capabilities: 'edit,personal' };

const requireSession = (request) => {
  if (!request.session) throw Object.assign(new Error('Требуется вход в кабинет'), { status: 401 });
  return request.session;
};
const requireCsrf = (request, session) => {
  if (String(request.headers['x-csrf-token'] || '') !== session.csrf) throw Object.assign(new Error('Некорректный CSRF-токен'), { status: 403 });
};
const sendJson = (response, status, payload) => { response.statusCode = status; response.payload = payload; };
const readBody = async (request) => {
  if (!request.body || typeof request.body !== 'object') throw Object.assign(new Error('Ожидался JSON'), { status: 400 });
  return request.body;
};

// Часы Mini App управляемые: момент привязки и момент разрешения различимы без ожидания.
function setup({ botId = BOT_ID, db = null, authStore = null, dir = null, clock = null } = {}) {
  const base = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'personal-reminders-'));
  const store = db || new DatabaseSync(':memory:');
  if (!db) store.exec('PRAGMA foreign_keys = ON;');
  const auth = authStore || createAuthStore(store, `vlad:owner:${HASH}`);
  const time = clock || { offset: 0, get now() { return Date.now() + this.offset; }, tick(ms) { this.offset += ms; } };
  current = time;
  const fetchImpl = async (url) => { throw new Error(`неожиданный сетевой вызов ${url}`); };
  const chat = createProjectChat({ db: store, authStore: auth, assetsDir: base, requireSession, requireCsrf, sendJson, readBody, fetchImpl,
    statusTtl: 0, miniApp: { botId, sessionSecret: 'test-session-secret', publicKeyHex: PUBLIC_HEX, now: () => time.now } });
  const session = (id) => ({ user: auth.getById(id), csrf: `csrf-${id}` });
  const person = (login, companies) => auth.create(OWNER_ID, { login, displayName: login, password: 'x'.repeat(12), companies, permissions: [] }, HASH);
  return { db: store, authStore: auth, chat, clock: time, session, person, owner: session(OWNER_ID), dir: base };
}
/* Каждый запуск Mini App — новый auth_date: часы теста сдвигаются на секунду, auth_date — их текущая секунда
   (порядок подписанных запусков совпадает с порядком вызовов). query_id делает данные уникальными, как у Telegram.
   Явный authDate — для проверок обратного порядка, равной секунды и устаревания. */
let sequence = 0, current = null;
/* V4: событие (привязка, 403) перекрывает подписанное раньше чем через FRESH_MS после себя — весь допуск
   опережения часов Telegram (60 с) плюс секунда округления. Новый вход засчитывается только после этой паузы. */
const FRESH_MS = 61 * 1000;
const nowSecond = () => Math.floor(current.now / 1000);
function initData({ tg = DARIA_TG, allows, authDate, botId = BOT_ID, project = ROOM } = {}) {
  if (authDate === undefined) { current.tick(1000); authDate = nowSecond(); }
  const user = { id: tg, first_name: 'Дарья', ...(allows === undefined ? {} : { allows_write_to_pm: allows }) };
  const params = { auth_date: String(authDate), query_id: `AAQ${++sequence}`, user: JSON.stringify(user), ...(project ? { start_param: project } : {}) };
  const data = `${botId}:WebAppData\n${Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('\n')}`;
  const signature = crypto.sign(null, Buffer.from(data, 'utf8'), privateKey).toString('base64url');
  return new URLSearchParams({ ...params, hash: 'ab'.repeat(32), signature }).toString();
}
async function call(chat, { session = null, method = 'GET', url, body, headers = {} }) {
  const request = {};
  request.method = method;
  request.headers = { ...(session && method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}), ...headers };
  request.session = session;
  request.body = body;
  const response = { statusCode: 0, payload: null, writeHead(status) { this.statusCode = status; }, end() {} };
  await chat.handle(request, response, new URL(`http://x${url}`));
  return { statusCode: response.statusCode, payload: response.payload };
}
async function open(chat, raw) {
  const request = Readable.from([Buffer.from(JSON.stringify({ initData: raw }))]);
  request.method = 'POST'; request.headers = {};
  const response = { statusCode: 0, payload: null };
  await chat.miniApp.handle(request, response, new URL('http://x/content/project-chat-miniapp/session'));
  return response;
}
const room = (suffix = '', code = ROOM) => `/content/project-chat/${code}${suffix}`;
const status = (value) => (error) => { assert.equal(error.status, value, error.message); return true; };
const count = (db, table) => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const row = (db, id) => db.prepare('SELECT * FROM project_chat_personal_reminders WHERE id=?').get(id);
const stateOf = async (ctx, userId) => (await call(ctx.chat, { session: ctx.owner, url: room('/personal-reminders') }))
  .payload.recipients.find((item) => item.userId === userId)?.state;

// Дарья — участница комнаты, Telegram привязан владельцем по коду; разрешение — отдельное действие.
async function linked(ctx, { tg = DARIA_TG, user = null } = {}) {
  const daria = user || ctx.person(`daria${tg}`, [ROOM]);
  if (!user) await call(ctx.chat, { session: ctx.owner, method: 'PUT', url: room('/members'), body: { userIds: [daria.id] } });
  const first = await open(ctx.chat, initData({ tg }));
  assert.equal(first.statusCode, 403);
  ctx.clock.tick(1000);
  const bound = await call(ctx.chat, { session: ctx.owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: first.payload.linkCode, userId: daria.id } });
  assert.equal(bound.statusCode, 201);
  ctx.clock.tick(FRESH_MS);
  return daria;
}
async function ready(ctx, opts = {}) {
  const daria = await linked(ctx, opts);
  assert.equal((await open(ctx.chat, initData({ tg: opts.tg || DARIA_TG, allows: true }))).statusCode, 200);
  return daria;
}
async function task(ctx, title = 'Подтвердить состав набора', code = ROOM) {
  const created = await call(ctx.chat, { session: ctx.owner, method: 'POST', url: room('/tasks', code), body: { title } });
  assert.equal(created.statusCode, 201);
  return created.payload.task;
}
const body = (recipient, item, over = {}) => ({ recipientUserId: recipient.id, taskId: item.id, text: 'Пришлите, пожалуйста, состав набора.',
  dependency: 'цена и карточка на сайте', expectedTelegramUserId: String(DARIA_TG), clientReminderId: 'personal-key-0001', ...over });
const remind = (ctx, payload, session = ctx.owner, headers = {}, code = ROOM) =>
  call(ctx.chat, { session, headers, method: 'POST', url: room('/personal-reminders', code), body: payload });

test('состояние получателя: нет привязки, разрешение до привязки, «не разрешено», готов; владелец не в списке', async () => {
  const ctx = setup();
  const daria = ctx.person('daria', [ROOM]);
  await call(ctx.chat, { session: ctx.owner, method: 'PUT', url: room('/members'), body: { userIds: [daria.id] } });
  ctx.person('anna', [ROOM]);   // учётная запись компании без членства в комнате — не получатель
  const listed = (await call(ctx.chat, { session: ctx.owner, url: room('/personal-reminders') })).payload;
  assert.deepEqual(listed.recipients.map((item) => [item.userId, item.state]), [[daria.id, 'no_link']]);
  assert.match(listed.recipients[0].stateLabel, /не привязан/);
  // Разрешение, данное ДО привязки, не засчитывается: после привязки нужен новый вход.
  const first = await open(ctx.chat, initData({ allows: true }));
  ctx.clock.tick(1000);
  await call(ctx.chat, { session: ctx.owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: first.payload.linkCode, userId: daria.id } });
  assert.equal(await stateOf(ctx, daria.id), 'stale_permission');
  ctx.clock.tick(FRESH_MS);
  assert.equal((await open(ctx.chat, initData({}))).statusCode, 200);
  assert.equal(await stateOf(ctx, daria.id), 'no_permission', 'без allows_write_to_pm разрешения нет');
  await open(ctx.chat, initData({ allows: 'true' }));
  assert.equal(await stateOf(ctx, daria.id), 'no_permission', 'учитывается только буквальное true');
  await open(ctx.chat, initData({ allows: true }));
  assert.equal(await stateOf(ctx, daria.id), 'ready');
  // Новое подписанное «не разрешено» снимает прежнее разрешение.
  await open(ctx.chat, initData({ allows: false }));
  assert.equal(await stateOf(ctx, daria.id), 'no_permission');
});

test('повтор и просроченные данные входа разрешение не меняют; разрешение не переносится на другой бот', async () => {
  const ctx = setup();
  const daria = await linked(ctx);
  const refused = initData({ allows: false });
  assert.equal((await open(ctx.chat, refused)).statusCode, 200);
  await open(ctx.chat, initData({ allows: true }));
  assert.equal(await stateOf(ctx, daria.id), 'ready');
  assert.equal((await open(ctx.chat, refused)).statusCode, 409, 'повтор отклонён');
  assert.equal((await open(ctx.chat, initData({ allows: false, authDate: nowSecond() - 400 }))).statusCode, 401);
  assert.equal(await stateOf(ctx, daria.id), 'ready', 'ни повтор, ни просроченные данные не записаны');
  // Тот же сервер с другим TELEGRAM_BOT_ID: прежнее разрешение к новому боту не относится.
  const other = setup({ botId: '888000', db: ctx.db, authStore: ctx.authStore, dir: ctx.dir, clock: ctx.clock });
  const listed = (await call(other.chat, { session: other.owner, url: room('/personal-reminders') })).payload.recipients;
  assert.equal(listed.find((item) => item.userId === daria.id).state, 'no_permission');
  // Две привязки к одной учётной записи — неоднозначно, личное сообщение не отправляется.
  const second = await open(ctx.chat, initData({ tg: 5002 }));
  await call(ctx.chat, { session: ctx.owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: second.payload.linkCode, userId: daria.id } });
  assert.equal(await stateOf(ctx, daria.id), 'several_links');
});

test('владелец ставит одно напоминание: текст с номером задачи и зависимостью, ключ повтора, без группы и уведомлений', async () => {
  const ctx = setup(), { chat, db } = ctx;
  const daria = await ready(ctx);
  const item = await task(ctx);
  db.prepare("UPDATE project_chat_tasks SET external_ref='7' WHERE id=?").run(item.id);
  db.prepare('UPDATE project_chat_rooms SET telegram_chat_id=? WHERE company_code=?').run(GROUP, ROOM);
  const before = { messages: count(db, 'project_chat_messages'), outbox: count(db, 'project_chat_outbox'), alerts: count(db, 'hugh_owner_alerts') };
  const created = await remind(ctx, body(daria, item));
  assert.equal(created.statusCode, 202);
  const reminder = created.payload.reminder;
  assert.equal(reminder.status, 'pending');
  assert.equal(reminder.telegramUserId, String(DARIA_TG));
  assert.equal(reminder.text, 'Напоминание по задаче №7 «Подтвердить состав набора» (проект Palitra).\nПришлите, пожалуйста, состав набора.\nОт вашего ответа зависит: цена и карточка на сайте');
  assert.deepEqual({ messages: count(db, 'project_chat_messages'), outbox: count(db, 'project_chat_outbox'), alerts: count(db, 'hugh_owner_alerts') }, before,
    'ни сообщения комнаты, ни групповой отправки, ни уведомления владельцу');
  const again = await remind(ctx, body(daria, item));
  assert.equal(again.statusCode, 200);
  assert.equal(again.payload.reminder.id, reminder.id);
  await assert.rejects(() => remind(ctx, body(daria, item, { text: 'Другая просьба' })), status(409));
  await assert.rejects(() => remind(ctx, body(daria, item, { clientReminderId: 'personal-key-0002' })), status(409), 'уже отправляется');
  assert.equal(count(db, 'project_chat_personal_reminders'), 1);
  const journal = (await call(chat, { session: ctx.owner, url: room(`/personal-reminders?taskId=${item.id}`) })).payload.reminders;
  assert.deepEqual(journal.map((entry) => entry.id), [reminder.id]);
});

test('права: только владелец кабинета с CSRF; участник, Mini App и чужая компания отказ', async () => {
  const ctx = setup(), { chat, db } = ctx;
  const daria = await ready(ctx);
  const item = await task(ctx);
  const opened = await open(chat, initData({ allows: true }));
  const bearer = { authorization: `Bearer ${opened.payload.token}` };
  await assert.rejects(() => remind(ctx, body(daria, item), ctx.session(daria.id)), status(403));
  await assert.rejects(() => call(chat, { session: ctx.session(daria.id), url: room('/personal-reminders') }), status(403));
  await assert.rejects(() => call(chat, { method: 'GET', url: room('/personal-reminders'), headers: bearer }), status(403));
  await assert.rejects(() => call(chat, { method: 'POST', url: room('/personal-reminders'), headers: bearer, body: body(daria, item) }), status(403));
  await assert.rejects(() => remind(ctx, body(daria, item), ctx.owner, { 'x-csrf-token': 'bad' }), status(403));
  await assert.rejects(() => remind(ctx, body(daria, item), null), status(401));
  // Задача и получатель — только этой компании.
  const foreign = await task(ctx, 'Чужая задача', OTHER);
  await assert.rejects(() => remind(ctx, body(daria, foreign)), status(404));
  await assert.rejects(() => remind(ctx, body(daria, item), ctx.owner, {}, OTHER), status(404));
  await assert.rejects(() => remind(ctx, body({ id: OWNER_ID }, item)), status(404), 'владельцу не напоминают');
  assert.equal(count(db, 'project_chat_personal_reminders'), 0);
});

test('отказы до постановки: нет разрешения, смена привязки, снятая задача, поля', async () => {
  const ctx = setup(), { db } = ctx;
  const daria = await linked(ctx);
  const item = await task(ctx);
  await assert.rejects(() => remind(ctx, body(daria, item)), (error) => error.status === 409 && error.code === 'no_permission'
    && /Нужно действие получателя/.test(error.message));
  await open(ctx.chat, initData({ allows: true }));
  await assert.rejects(() => remind(ctx, body(daria, item, { expectedTelegramUserId: '5999' })), (error) => error.status === 409 && error.code === 'link_changed');
  for (const over of [{ text: '  ' }, { dependency: '' }, { text: 'x'.repeat(1501) }, { dependency: 'x'.repeat(501) },
    { clientReminderId: 'short' }, { expectedTelegramUserId: 'username' }, { recipientUserId: 'x' }, { extra: 1 }]) {
    await assert.rejects(() => remind(ctx, body(daria, item, over)), status(400), JSON.stringify(over).slice(0, 60));
  }
  db.prepare("UPDATE project_chat_tasks SET status='cancelled' WHERE id=?").run(item.id);
  await assert.rejects(() => remind(ctx, body(daria, item)), status(409));
  assert.equal(count(db, 'project_chat_personal_reminders'), 0);
});

test('очередь: только мост с capabilities=personal, одно задание, повторно не выдаётся', async () => {
  const ctx = setup(), { chat } = ctx;
  const daria = await ready(ctx);
  const item = await task(ctx);
  const reminder = (await remind(ctx, body(daria, item))).payload.reminder;
  assert.deepEqual(chat.bridge.pendingTelegram(), [], 'прежний мост без флагов');
  assert.deepEqual(chat.bridge.pendingTelegram(1, { capabilities: 'edit' }), [], 'мост только с правкой (PR441)');
  const [job] = chat.bridge.pendingTelegram(1, BOTH);
  assert.deepEqual(job, { id: `personal:${reminder.id}`, kind: 'personal', companyCode: ROOM, chatId: String(DARIA_TG), botId: BOT_ID,
    text: reminder.text, authorType: 'assistant', authorName: 'Хью' });
  assert.deepEqual(chat.bridge.pendingTelegram(1, BOTH), [], 'взятое задание второй раз не выдаётся');
});

test('перед отправкой условия проверяются заново: отвязка, новая привязка, выход из комнаты, смена бота, отказ получателя', async () => {
  const cases = {
    unlink: async (ctx) => { await call(ctx.chat, { session: ctx.owner, method: 'DELETE', url: room(`/telegram-links/${DARIA_TG}`) }); },
    rebind: async (ctx, daria) => {
      await call(ctx.chat, { session: ctx.owner, method: 'DELETE', url: room(`/telegram-links/${DARIA_TG}`) });
      ctx.clock.tick(1000);
      await linked(ctx, { user: daria });
    },
    member: async (ctx) => { await call(ctx.chat, { session: ctx.owner, method: 'PUT', url: room('/members'), body: { userIds: [] } }); },
    refused: async (ctx) => { await open(ctx.chat, initData({ allows: false })); },
  };
  for (const [name, change] of Object.entries(cases)) {
    const ctx = setup();
    const daria = await ready(ctx);
    const item = await task(ctx);
    const reminder = (await remind(ctx, body(daria, item))).payload.reminder;
    await change(ctx, daria);
    assert.deepEqual(ctx.chat.bridge.pendingTelegram(1, BOTH), [], name);
    assert.equal(row(ctx.db, reminder.id).status, 'error', name);
    assert.match(row(ctx.db, reminder.id).error, /не отправлено/, name);
  }
  // Сервер перезапущен с другим ботом: задание прежнего бота не уходит.
  const ctx = setup();
  const daria = await ready(ctx);
  const item = await task(ctx);
  const reminder = (await remind(ctx, body(daria, item))).payload.reminder;
  const other = setup({ botId: '888000', db: ctx.db, authStore: ctx.authStore, dir: ctx.dir, clock: ctx.clock });
  assert.deepEqual(other.chat.bridge.pendingTelegram(1, BOTH), []);
  assert.equal(row(ctx.db, reminder.id).status, 'error');
});

test('квитанция: успех только с message_id этому получателю; неизвестный исход и аренда без повтора; 403 снимает разрешение', async () => {
  const ctx = setup(), { chat, db } = ctx;
  const daria = await ready(ctx);
  const item = await task(ctx);
  let key = 0;
  const next = async () => {
    const created = await remind(ctx, body(daria, item, { clientReminderId: `personal-key-${String(++key).padStart(4, '0')}` }));
    assert.equal(created.statusCode, 202);
    const [job] = chat.bridge.pendingTelegram(1, BOTH);
    assert.equal(job.id, `personal:${created.payload.reminder.id}`);
    return job;
  };
  // Успех.
  let job = await next();
  assert.deepEqual(chat.bridge.acknowledgeTelegram(job.id, { ok: true, messageId: '9001', chatId: String(DARIA_TG) }), { ok: true, status: 'sent' });
  const sent = row(db, Number(job.id.split(':')[1]));
  assert.deepEqual([sent.status, sent.telegram_message_id, sent.telegram_chat_id], ['sent', '9001', String(DARIA_TG)]);
  assert.deepEqual(chat.bridge.acknowledgeTelegram(job.id, { ok: false, error: 'поздний сбой' }), { ok: true, status: 'sent' });
  // ok без подтверждения этого получателя — не успех, но и не повтор.
  job = await next();
  assert.deepEqual(chat.bridge.acknowledgeTelegram(job.id, { ok: true, messageId: '9002', chatId: '5999' }), { ok: false, status: 'uncertain' });
  // Неизвестный исход.
  job = await next();
  assert.deepEqual(chat.bridge.acknowledgeTelegram(job.id, { ok: false, uncertain: true, error: 'нет ответа' }), { ok: false, status: 'uncertain' });
  // Поздняя правдивая квитанция по неизвестному исходу засчитывается.
  assert.deepEqual(chat.bridge.acknowledgeTelegram(job.id, { ok: true, messageId: '9003', chatId: String(DARIA_TG) }), { ok: true, status: 'sent' });
  // Истёкшая аренда — uncertain, повторной выдачи нет.
  job = await next();
  db.prepare("UPDATE project_chat_personal_reminders SET claimed_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(Number(job.id.split(':')[1]));
  assert.deepEqual(chat.bridge.pendingTelegram(1, BOTH), []);
  assert.equal(row(db, Number(job.id.split(':')[1])).status, 'uncertain');
  // Определённый отказ.
  job = await next();
  assert.deepEqual(chat.bridge.acknowledgeTelegram(job.id, { ok: false, uncertain: false, retryable: false, error: 'Telegram: 400 — chat not found' }), { ok: false, status: 'error' });
  // 403: видимая ошибка и снятие разрешения до нового действия получателя.
  job = await next();
  assert.deepEqual(chat.bridge.acknowledgeTelegram(job.id, { ok: false, uncertain: false, forbidden: true, error: 'Telegram: 403' }), { ok: false, status: 'error' });
  const refused = row(db, Number(job.id.split(':')[1]));
  assert.equal(refused.forbidden, 1);
  assert.match(refused.error, /нужно действие получателя/);
  assert.equal(await stateOf(ctx, daria.id), 'revoked');
  await assert.rejects(() => remind(ctx, body(daria, item, { clientReminderId: 'personal-key-9999' })), status(409));
  // Ни одно напоминание не вернулось в очередь само.
  assert.deepEqual(chat.bridge.pendingTelegram(1, BOTH), []);
  assert.deepEqual(db.prepare('SELECT status FROM project_chat_personal_reminders ORDER BY id').all().map((r) => r.status),
    ['sent', 'uncertain', 'sent', 'uncertain', 'error', 'error']);
  assert.equal(db.prepare('SELECT max(attempts) n FROM project_chat_personal_reminders').get().n, 1, 'каждое ушло не больше одного раза');
  // Новое действие получателя возвращает разрешение — вход после паузы допуска часов.
  ctx.clock.tick(FRESH_MS);
  await open(chat, initData({ allows: true }));
  assert.equal(await stateOf(ctx, daria.id), 'ready');
  assert.throws(() => chat.bridge.acknowledgeTelegram('personal:999', { ok: true }), status(404));
});

test('номера заданий не пересекаются: отправка №N, правка edit:N и личное personal:N квитируются раздельно', async () => {
  const ctx = setup(), { chat, db } = ctx;
  const daria = await ready(ctx);
  const item = await task(ctx);
  db.prepare('UPDATE project_chat_rooms SET telegram_chat_id=? WHERE company_code=?').run(GROUP, ROOM);
  await call(chat, { session: ctx.owner, method: 'POST', url: room('/messages'), body: { text: 'В группу', clientMessageId: 'group-msg-0001' } });
  const reminder = (await remind(ctx, body(daria, item))).payload.reminder;
  const [send] = chat.bridge.pendingTelegram(1, BOTH);
  assert.equal(typeof send.id, 'number', 'сначала обычная очередь комнаты');
  assert.equal(send.id, reminder.id, 'числовой номер совпадает с номером напоминания');
  chat.bridge.acknowledgeTelegram(send.id, { ok: true, externalMessageIds: ['140'] });
  assert.equal(row(db, reminder.id).status, 'pending', 'квитанция групповой отправки не трогает напоминание');
  const [job] = chat.bridge.pendingTelegram(1, BOTH);
  assert.equal(job.id, `personal:${reminder.id}`);
  assert.equal(job.chatId, String(DARIA_TG));
  chat.bridge.acknowledgeTelegram(job.id, { ok: true, messageId: '9100', chatId: String(DARIA_TG) });
  assert.equal(db.prepare('SELECT status FROM project_chat_outbox WHERE id=?').get(send.id).status, 'sent');
  assert.throws(() => chat.bridge.acknowledgeTelegram(`edit:${reminder.id}`, { ok: true }), status(404), 'правки с этим номером нет');
});

test('поток получателя: подтверждает только свежий подписанный вход; клиентские заявления, подмена и повтор — нет', async () => {
  const ctx = setup();
  const daria = await linked(ctx);
  // Вход без разрешения: сервер честно отвечает «не разрешено».
  const before = initData({});
  const plain = await open(ctx.chat, before);
  assert.equal(plain.statusCode, 200);
  assert.deepEqual(plain.payload.personal, { confirmed: false, state: 'no_permission' });
  assert.equal(await stateOf(ctx, daria.id), 'no_permission');
  // Клиент заявляет разрешение полями тела (как будто из callback requestWriteAccess или initDataUnsafe) — не в счёт.
  const request = Readable.from([Buffer.from(JSON.stringify({ initData: initData({}), allowsWriteToPm: true, granted: true,
    personal: { confirmed: true }, initDataUnsafe: { user: { id: DARIA_TG, allows_write_to_pm: true } } }))]);
  request.method = 'POST'; request.headers = {};
  const claimed = { statusCode: 0, payload: null };
  await ctx.chat.miniApp.handle(request, claimed, new URL('http://x/content/project-chat-miniapp/session'));
  assert.equal(claimed.statusCode, 200);
  assert.deepEqual(claimed.payload.personal, { confirmed: false, state: 'no_permission' });
  assert.equal(await stateOf(ctx, daria.id), 'no_permission');
  // Подмена поля внутри initData без новой подписи Telegram — отказ, ничего не записано.
  const unsigned = initData({});
  const params = new URLSearchParams(unsigned);
  params.set('user', JSON.stringify({ id: DARIA_TG, first_name: 'Дарья', allows_write_to_pm: true }));
  assert.equal((await open(ctx.chat, params.toString())).statusCode, 401);
  assert.equal(await stateOf(ctx, daria.id), 'no_permission');
  // После «да» в окне Telegram прежние данные входа не меняются: их повтор отклоняется и ничего не подтверждает.
  assert.equal((await open(ctx.chat, before)).statusCode, 409);
  assert.equal(await stateOf(ctx, daria.id), 'no_permission');
  // Новый запуск Mini App с подписанным allows_write_to_pm — подтверждено.
  const fresh = await open(ctx.chat, initData({ allows: true }));
  assert.deepEqual(fresh.payload.personal, { confirmed: true, state: 'ready' });
  assert.equal(await stateOf(ctx, daria.id), 'ready');
});

test('поток получателя: новая привязка требует нового входа; 403 снимает, свежее подписанное «да» возвращает', async () => {
  const ctx = setup(), { chat } = ctx;
  const daria = await ready(ctx);
  // Новая привязка того же Telegram: прежнее разрешение относится к прежней привязке.
  await call(chat, { session: ctx.owner, method: 'DELETE', url: room(`/telegram-links/${DARIA_TG}`) });
  ctx.clock.tick(1000);
  const unlinkedOpen = await open(chat, initData({ allows: true }));
  assert.equal(unlinkedOpen.payload.state, 'unlinked');
  ctx.clock.tick(1000);
  await call(chat, { session: ctx.owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: unlinkedOpen.payload.linkCode, userId: daria.id } });
  assert.equal(await stateOf(ctx, daria.id), 'stale_permission', 'разрешение до новой привязки не засчитано');
  ctx.clock.tick(1000);
  const tooSoon = await open(chat, initData({ allows: true }));
  assert.deepEqual(tooSoon.payload.personal, { confirmed: false, state: 'stale_permission' }, 'вход сразу после привязки — ещё в пределах допуска часов');
  ctx.clock.tick(FRESH_MS);
  const reopened = await open(chat, initData({ allows: true }));
  assert.deepEqual(reopened.payload.personal, { confirmed: true, state: 'ready' });
  assert.equal(await stateOf(ctx, daria.id), 'ready');
  // 403 при отправке: разрешение снято, получатель видит при следующем входе свежий ответ Telegram.
  const item = await task(ctx);
  const created = await remind(ctx, body(daria, item));
  const [job] = chat.bridge.pendingTelegram(1, BOTH);
  chat.bridge.acknowledgeTelegram(job.id, { ok: false, uncertain: false, forbidden: true, error: 'Telegram: 403' });
  assert.equal(await stateOf(ctx, daria.id), 'revoked');
  assert.match((await call(chat, { session: ctx.owner, url: room('/personal-reminders') })).payload.recipients[0].stateLabel, /403/);
  ctx.clock.tick(FRESH_MS);
  const refused = await open(chat, initData({}));
  assert.deepEqual(refused.payload.personal, { confirmed: false, state: 'no_permission' });
  assert.equal(await stateOf(ctx, daria.id), 'no_permission');
  const granted = await open(chat, initData({ allows: true }));
  assert.deepEqual(granted.payload.personal, { confirmed: true, state: 'ready' });
  assert.equal(await stateOf(ctx, daria.id), 'ready');
  assert.equal(created.payload.reminder.status, 'pending');
  // Две привязки — получатель видит, что личные напоминания не отправляются.
  const second = await open(chat, initData({ tg: 5002 }));
  await call(chat, { session: ctx.owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: second.payload.linkCode, userId: daria.id } });
  const ambiguous = await open(chat, initData({ allows: true }));
  assert.deepEqual(ambiguous.payload.personal, { confirmed: false, state: 'several_links' });
  assert.equal(await stateOf(ctx, daria.id), 'several_links');
});

const linkedAtOf = (ctx, tg = DARIA_TG) => Date.parse(ctx.db.prepare('SELECT linked_at FROM project_chat_telegram_links WHERE telegram_user_id=?').get(String(tg)).linked_at);

test('снятая после постановки задача: напоминание не выдаётся мосту и завершается ошибкой', async () => {
  const ctx = setup(), { chat, db } = ctx;
  const daria = await ready(ctx);
  const item = await task(ctx);
  const reminder = (await remind(ctx, body(daria, item))).payload.reminder;
  const cancelled = await call(chat, { session: ctx.owner, method: 'PATCH', url: room(`/tasks/${item.id}`), body: { status: 'cancelled', publication: 'not_required' } });
  assert.equal(cancelled.statusCode, 200);
  assert.deepEqual(chat.bridge.pendingTelegram(1, BOTH), [], 'мост ничего не получает — Telegram не вызывается');
  const row = db.prepare('SELECT * FROM project_chat_personal_reminders WHERE id=?').get(reminder.id);
  assert.deepEqual([row.status, row.attempts], ['error', 0]);
  assert.match(row.error, /Задача снята после постановки напоминания/);
});

test('порядок по подписанному запуску: более старый действующий запуск не перекрывает более свежий отказ; равная секунда не принимается', async () => {
  const ctx = setup(), { chat } = ctx;
  const daria = await linked(ctx);
  ctx.clock.tick(6000);
  const s = nowSecond();
  const olderYes = initData({ allows: true, authDate: s - 4 });
  const newerNo = initData({ allows: false, authDate: s - 2 });
  const sameSecondYes = initData({ allows: true, authDate: s - 2 });
  // Оба запуска подписаны, позже привязки и ни разу не использованы — приходят в обратном порядке.
  assert.deepEqual((await open(chat, newerNo)).payload.personal, { confirmed: false, state: 'no_permission' });
  const late = await open(chat, olderYes);
  assert.equal(late.statusCode, 200, 'вход действителен — это не повтор');
  assert.deepEqual(late.payload.personal, { confirmed: false, state: 'no_permission' }, 'Mini App не показывает «подтверждено»');
  assert.equal(await stateOf(ctx, daria.id), 'no_permission');
  assert.deepEqual((await open(chat, sameSecondYes)).payload.personal, { confirmed: false, state: 'no_permission' }, 'та же секунда — порядок неизвестен');
  // Безопасный путь: новый запуск.
  assert.deepEqual((await open(chat, initData({ allows: true }))).payload.personal, { confirmed: true, state: 'ready' });
  assert.equal(await stateOf(ctx, daria.id), 'ready');
});

test('новая привязка: ещё действующий запуск до неё не делает готовым — ни у владельца, ни в Mini App', async () => {
  const ctx = setup(), { chat } = ctx;
  const daria = await ready(ctx);
  await call(chat, { session: ctx.owner, method: 'DELETE', url: room(`/telegram-links/${DARIA_TG}`) });
  const unlinkedOpen = await open(chat, initData({ allows: true }));
  const beforeLink = initData({ allows: true });   // выдан до привязки, не использован
  ctx.clock.tick(1500);
  await call(chat, { session: ctx.owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: unlinkedOpen.payload.linkCode, userId: daria.id } });
  ctx.clock.tick(1000);
  const late = await open(chat, beforeLink);
  assert.equal(late.statusCode, 200);
  assert.deepEqual(late.payload.personal, { confirmed: false, state: 'stale_permission' });
  assert.equal(await stateOf(ctx, daria.id), 'stale_permission');
  // Секундная точность и допуск часов: засчитывается запуск не раньше linked_at + 61 с. Привязка в доле секунды:
  // linkSecond + 61 ещё раньше границы (stale), linkSecond + 62 — после неё (ready).
  const linked = linkedAtOf(ctx), linkSecond = Math.floor(linked / 1000);
  assert.ok(linked % 1000 > 0, 'фикстура: привязка в доле секунды');
  ctx.clock.tick(FRESH_MS);
  assert.deepEqual((await open(chat, initData({ allows: true, authDate: linkSecond }))).payload.personal, { confirmed: false, state: 'stale_permission' });
  assert.deepEqual((await open(chat, initData({ allows: true, authDate: linkSecond + 61 }))).payload.personal, { confirmed: false, state: 'stale_permission' });
  assert.deepEqual((await open(chat, initData({ allows: true, authDate: linkSecond + 62 }))).payload.personal, { confirmed: true, state: 'ready' });
  assert.equal(await stateOf(ctx, daria.id), 'ready');
});

test('граница: привязка ровно на целой секунде — auth_date до linked + 60 не засчитывается, linked + 61 — да', async () => {
  const ctx = setup(), { chat } = ctx;
  const daria = await linked(ctx);
  // Фикстура: момент привязки выравнивается на целую секунду. Запуск, сформированный за долю секунды ДО привязки
  // при часах Telegram впереди на 60,x с (допуск входа), несёт auth_date = whole + 60 — он не засчитывается.
  // Любой запуск до привязки имеет auth_date < whole + 61, поэтому whole + 61 — уже после неё.
  const whole = nowSecond() - 1;
  ctx.db.prepare('UPDATE project_chat_telegram_links SET linked_at=? WHERE telegram_user_id=?').run(new Date(whole * 1000).toISOString(), String(DARIA_TG));
  assert.deepEqual((await open(chat, initData({ allows: true, authDate: whole }))).payload.personal, { confirmed: false, state: 'stale_permission' });
  assert.deepEqual((await open(chat, initData({ allows: true, authDate: whole + 60 }))).payload.personal, { confirmed: false, state: 'stale_permission' });
  assert.equal(await stateOf(ctx, daria.id), 'stale_permission');
  assert.deepEqual((await open(chat, initData({ allows: true, authDate: whole + 61 }))).payload.personal, { confirmed: true, state: 'ready' });
  assert.equal(await stateOf(ctx, daria.id), 'ready');
});

test('часы Telegram впереди: запуск «из будущего», принятый до привязки, к новой привязке не относится', async () => {
  const ctx = setup(), { chat } = ctx;
  const daria = await ready(ctx);
  await call(chat, { session: ctx.owner, method: 'DELETE', url: room(`/telegram-links/${DARIA_TG}`) });
  // Подпись на 30 с впереди сервера (в пределах допуска 60 с), принят до привязки (без привязки — 403 с кодом).
  const ahead = await open(chat, initData({ allows: true, authDate: nowSecond() + 30 }));
  assert.equal(ahead.statusCode, 403);
  ctx.clock.tick(1000);
  await call(chat, { session: ctx.owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: ahead.payload.linkCode, userId: daria.id } });
  assert.ok(ctx.db.prepare('SELECT auth_date FROM project_chat_telegram_write_access').get().auth_date * 1000 > linkedAtOf(ctx), 'подпись позже привязки');
  assert.equal(await stateOf(ctx, daria.id), 'stale_permission', 'но принят сервером до привязки');
  // Выход: запуск через минуту после привязки — строго новее прежнего, после границы и принят после привязки.
  ctx.clock.tick(FRESH_MS);
  assert.deepEqual((await open(chat, initData({ allows: true }))).payload.personal, { confirmed: true, state: 'ready' });
  assert.equal(await stateOf(ctx, daria.id), 'ready');
});

test('после 403 ещё действующий запуск до отказа (и в ту же секунду) разрешение не возвращает; новый запуск — возвращает', async () => {
  const ctx = setup(), { chat } = ctx;
  const daria = await ready(ctx);
  const item = await task(ctx);
  const beforeRefusal = initData({ allows: true });   // выдан до отказа, не использован
  await remind(ctx, body(daria, item));
  const [job] = chat.bridge.pendingTelegram(1, BOTH);
  ctx.clock.tick(1000);
  chat.bridge.acknowledgeTelegram(job.id, { ok: false, uncertain: false, forbidden: true, error: 'Telegram: 403' });
  const refusalSecond = nowSecond();
  assert.equal(await stateOf(ctx, daria.id), 'revoked');
  const late = await open(chat, beforeRefusal);
  assert.equal(late.statusCode, 200);
  assert.deepEqual(late.payload.personal, { confirmed: false, state: 'revoked' });
  assert.deepEqual((await open(chat, initData({ allows: true, authDate: refusalSecond }))).payload.personal, { confirmed: false, state: 'revoked' });
  assert.equal(await stateOf(ctx, daria.id), 'revoked');
  // Порог отказа — секунда отказа + 61: auth_date refusalSecond + 61 ещё не засчитывается, новый вход после паузы — да.
  ctx.clock.tick(FRESH_MS);
  assert.deepEqual((await open(chat, initData({ allows: true, authDate: refusalSecond + 61 }))).payload.personal, { confirmed: false, state: 'revoked' });
  assert.deepEqual((await open(chat, initData({ allows: true }))).payload.personal, { confirmed: true, state: 'ready' });
  assert.equal(await stateOf(ctx, daria.id), 'ready');
});

/* V4, замечание root 17:41: часы Telegram впереди. Запуск подписан ДО новой привязки (или до 403) с допустимым
   временем «из будущего», впервые доставлен ПОСЛЕ события. received_at > linked_at и auth_date > linked_at,
   но свежесть не доказана — разрешение не засчитывается и отправка невозможна. Настоящий новый вход работает. */
for (const ahead of [40, 60]) {
  test(`часы Telegram впереди на ${ahead} с: запуск до НОВОЙ привязки, доставленный после неё, не делает готовым; новый вход — делает`, async () => {
    const ctx = setup(), { chat } = ctx;
    const daria = await ready(ctx);
    // Сформирован до перепривязки при опережении часов Telegram, ни разу не использован.
    const old = initData({ allows: true, authDate: nowSecond() + ahead });
    await call(chat, { session: ctx.owner, method: 'DELETE', url: room(`/telegram-links/${DARIA_TG}`) });
    ctx.clock.tick(1000);
    const unlinkedOpen = await open(chat, initData({}));
    await call(chat, { session: ctx.owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: unlinkedOpen.payload.linkCode, userId: daria.id } });
    ctx.clock.tick(1000);
    const late = await open(chat, old);
    assert.equal(late.statusCode, 200, 'вход действителен: в пределах допуска, подпись верна, не повтор');
    const stored = ctx.db.prepare('SELECT auth_date, received_at FROM project_chat_telegram_write_access').get();
    assert.ok(stored.auth_date * 1000 > linkedAtOf(ctx) && Date.parse(stored.received_at) > linkedAtOf(ctx), 'подпись и приём позже привязки — критерий V3 дал бы ready');
    assert.deepEqual(late.payload.personal, { confirmed: false, state: 'stale_permission' }, 'Mini App не показывает «подтверждено»');
    assert.equal(await stateOf(ctx, daria.id), 'stale_permission');
    const item = await task(ctx);
    await assert.rejects(() => remind(ctx, body(daria, item)), status(409), 'отправку поставить нельзя');
    // Настоящий новый вход при том же опережении — через минуту после привязки — засчитывается.
    ctx.clock.tick(FRESH_MS - ahead * 1000);
    const fresh = await open(chat, initData({ allows: true, authDate: nowSecond() + ahead }));
    assert.deepEqual(fresh.payload.personal, { confirmed: true, state: 'ready' });
    assert.equal((await remind(ctx, body(daria, item))).statusCode, 202);
  });

  test(`часы Telegram впереди на ${ahead} с: запуск до 403, доставленный после отказа, разрешение не возвращает; новый вход — возвращает`, async () => {
    const ctx = setup(), { chat } = ctx;
    const daria = await ready(ctx);
    const item = await task(ctx);
    await remind(ctx, body(daria, item));
    const old = initData({ allows: true, authDate: nowSecond() + ahead });   // до отказа, не использован
    const [job] = chat.bridge.pendingTelegram(1, BOTH);
    ctx.clock.tick(1000);
    chat.bridge.acknowledgeTelegram(job.id, { ok: false, uncertain: false, forbidden: true, error: 'Telegram: 403' });
    ctx.clock.tick(1000);
    const late = await open(chat, old);
    assert.equal(late.statusCode, 200);
    assert.deepEqual(late.payload.personal, { confirmed: false, state: 'revoked' });
    assert.equal(await stateOf(ctx, daria.id), 'revoked');
    await assert.rejects(() => remind(ctx, body(daria, item, { clientReminderId: 'personal-key-0002' })), status(409), 'новую отправку поставить нельзя');
    ctx.clock.tick(FRESH_MS);
    const fresh = await open(chat, initData({ allows: true, authDate: nowSecond() + ahead }));
    assert.deepEqual(fresh.payload.personal, { confirmed: true, state: 'ready' });
    assert.equal(await stateOf(ctx, daria.id), 'ready');
  });
}

test('граница свежести открыта модулю: допуск входа + 1 с', () => {
  const ctx = setup();
  assert.equal(ctx.chat.miniApp.freshMarginSeconds * 1000, FRESH_MS);
});
