'use strict';

/* Правка отправленного сообщения Хью (specs/082-project-chat-reviewed-edit): права, изоляция компаний,
   очередь правки, квитанция моста и синхронизация текста ЛК.
   Только встроенные модули Node: node --test ops/content/project-chat-reviewed-edit.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createProjectChat, TELEGRAM_PART_LIMIT, HUGH_SIGNATURE, EDIT_TEXT_LIMIT } = require('./project-chat');
const { AI_SIGNATURE, TEXT_PART } = require('../chat/project-chat-bridge');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const ROOM = 'palitra-love';
const OTHER = 'alvi';
const OWNER_ID = 1;
const GROUP = '-100777000111';
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 1)]);
const EDIT = { capabilities: 'edit' };

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

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-chat-edit-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const authStore = createAuthStore(db, `vlad:owner:${HASH}`);
  // Сеть модулю не нужна: любой внешний вызов в этих тестах — ошибка.
  const fetchImpl = async (url) => { throw new Error(`неожиданный сетевой вызов ${url}`); };
  const chat = createProjectChat({ db, authStore, assetsDir: dir, requireSession, requireCsrf, sendJson, readBody, fetchImpl, statusTtl: 0 });
  const session = (id) => ({ user: authStore.getById(id), csrf: `csrf-${id}` });
  const person = (login, companies) => authStore.create(OWNER_ID,
    { login, displayName: login, password: 'x'.repeat(12), companies, permissions: [] }, HASH);
  return { db, chat, session, person, owner: session(OWNER_ID), dir };
}

async function call(chat, { session = null, method = 'GET', url, body, bytes, headers = {} }) {
  const request = bytes ? require('node:stream').Readable.from([bytes]) : {};
  request.method = method;
  request.headers = { ...(session && method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}), ...headers };
  request.session = session;
  request.body = body;
  const response = { statusCode: 0, payload: null, writeHead(status) { this.statusCode = status; }, end() {} };
  await chat.handle(request, response, new URL(`http://x${url}`));
  return { statusCode: response.statusCode, payload: response.payload };
}
const room = (suffix = '', code = ROOM) => `/content/project-chat/${code}${suffix}`;
const status = (value) => (error) => { assert.equal(error.status, value, error.message); return true; };
const count = (db, table) => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const editRow = (db, id) => db.prepare('SELECT * FROM project_chat_message_edits WHERE id=?').get(id);
const messageText = (db, id) => db.prepare('SELECT text FROM project_chat_messages WHERE id=?').get(id).text;

// Сообщение от Хью, отправленное владельцем и доставленное мостом одной частью (как TG136).
async function delivered(ctx, { text = 'Сводка 13 задач', externalIds = ['136'], clientId = 'summary-0001' } = {}) {
  const { chat, db, owner } = ctx;
  await call(chat, { session: owner, url: room() });
  db.prepare('UPDATE project_chat_rooms SET telegram_chat_id=? WHERE company_code=?').run(GROUP, ROOM);
  const sent = await call(chat, { session: owner, method: 'POST', url: room('/reviewed-messages'),
    body: { text, clientMessageId: clientId, expectedChatId: GROUP } });
  assert.equal(sent.statusCode, 201);
  const id = sent.payload.message.id;
  const [job] = chat.bridge.pendingTelegram();
  assert.equal(job.messageId, id);
  chat.bridge.acknowledgeTelegram(job.id, { ok: true, externalMessageIds: externalIds });
  return id;
}
const editBody = (over = {}) => ({ text: 'Сводка 13 задач — обновлено', expectedText: 'Сводка 13 задач',
  expectedChatId: GROUP, clientEditId: 'edit-key-0001', ...over });
const postEdit = (ctx, id, body = editBody(), session = ctx.owner, headers = {}) =>
  call(ctx.chat, { session, headers, method: 'POST', url: room(`/reviewed-messages/${id}/edit`), body });

test('ограничение правки совпадает с подписью и частью Telegram моста', () => {
  assert.equal(HUGH_SIGNATURE, AI_SIGNATURE);
  assert.equal(TELEGRAM_PART_LIMIT, TEXT_PART);
  assert.equal(EDIT_TEXT_LIMIT, TEXT_PART - AI_SIGNATURE.length - 1);
});

test('владелец правит доставленное сообщение Хью: очередь, квитанция, текст ЛК и журнал', async () => {
  const ctx = setup(), { chat, db } = ctx;
  const id = await delivered(ctx);
  const before = { messages: count(db, 'project_chat_messages'), outbox: count(db, 'project_chat_outbox'), ai: count(db, 'project_chat_ai_jobs') };
  const created = await postEdit(ctx, id);
  assert.equal(created.statusCode, 202);
  assert.equal(created.payload.edit.status, 'pending');
  assert.equal(created.payload.message.text, 'Сводка 13 задач', 'текст ЛК не меняется до квитанции');
  assert.equal(created.payload.message.edit.status, 'pending');
  // Правка не создаёт ни нового сообщения, ни исходящей отправки, ни задания ИИ.
  assert.deepEqual({ messages: count(db, 'project_chat_messages'), outbox: count(db, 'project_chat_outbox'), ai: count(db, 'project_chat_ai_jobs') }, before);
  // Повтор того же ключа с тем же телом — тот же результат без второй правки.
  const repeated = await postEdit(ctx, id);
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.payload.edit.id, created.payload.edit.id);
  assert.equal(count(db, 'project_chat_message_edits'), 1);
  // Мост без объявленной правки задания не получает.
  assert.deepEqual(chat.bridge.pendingTelegram(), []);
  assert.equal(editRow(db, created.payload.edit.id).status, 'pending');
  const [job] = chat.bridge.pendingTelegram(1, EDIT);
  assert.deepEqual(job, { id: `edit:${created.payload.edit.id}`, kind: 'edit', companyCode: ROOM, chatId: GROUP,
    telegramMessageId: '136', text: 'Сводка 13 задач — обновлено', authorType: 'assistant', authorName: 'Хью', attempt: 1 });
  assert.deepEqual(chat.bridge.pendingTelegram(1, EDIT), [], 'взятая правка не выдаётся второй раз');
  assert.deepEqual(chat.bridge.acknowledgeTelegram(job.id, { ok: true, editedMessageId: '136', chatId: GROUP }), { ok: true, status: 'sent' });
  assert.equal(messageText(db, id), 'Сводка 13 задач — обновлено');
  const row = editRow(db, created.payload.edit.id);
  assert.equal(row.status, 'sent');
  assert.equal(row.old_text, 'Сводка 13 задач', 'исходный текст остаётся в журнале');
  assert.equal(row.text_synced, 1);
  // Повторная квитанция ничего не меняет.
  assert.deepEqual(chat.bridge.acknowledgeTelegram(job.id, { ok: false, error: 'поздний сбой' }), { ok: true, status: 'sent' });
  const view = (await call(chat, { session: ctx.owner, url: room('/messages') })).payload.messages.find(m => m.id === id);
  assert.equal(view.text, 'Сводка 13 задач — обновлено');
  assert.equal(view.edit.status, 'sent');
  assert.ok(view.editedAt);
  assert.deepEqual(view.telegramLinks, [`https://t.me/c/${GROUP.slice(4)}/136`], 'ссылка на то же сообщение');
  assert.equal(view.reviewedByOwner, true);
});

test('«message is not modified» — успех: текст в Telegram уже новый, ЛК синхронизируется', async () => {
  const ctx = setup(), { chat, db } = ctx;
  const id = await delivered(ctx);
  const edit = (await postEdit(ctx, id)).payload.edit;
  const [job] = chat.bridge.pendingTelegram(1, EDIT);
  chat.bridge.acknowledgeTelegram(job.id, { ok: true, notModified: true, editedMessageId: '136', chatId: GROUP });
  assert.equal(editRow(db, edit.id).not_modified, 1);
  assert.equal(messageText(db, id), 'Сводка 13 задач — обновлено');
});

test('права: только владелец кабинета с CSRF; участник и чужая сессия правку не создают', async () => {
  const ctx = setup(), { chat, db, person, session, owner } = ctx;
  const id = await delivered(ctx);
  const member = person('daria', [ROOM]);
  await call(chat, { session: owner, method: 'PUT', url: room('/members'), body: { userIds: [member.id] } });
  await assert.rejects(() => postEdit(ctx, id, editBody(), session(member.id)), status(403));
  await assert.rejects(() => postEdit(ctx, id, editBody(), owner, { 'x-csrf-token': 'bad' }), status(403));
  await assert.rejects(() => postEdit(ctx, id, editBody(), null), status(401));
  db.prepare('UPDATE auth_users SET session_version=session_version+1 WHERE id=?').run(OWNER_ID);
  await assert.rejects(() => postEdit(ctx, id, editBody(), owner), status(401));
  assert.equal(count(db, 'project_chat_message_edits'), 0);
});

test('изоляция компаний: сообщение другой компании по чужому адресу не находится', async () => {
  const ctx = setup(), { chat, db, owner } = ctx;
  const id = await delivered(ctx);
  await call(chat, { session: owner, url: room('', OTHER) });
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room(`/reviewed-messages/${id}/edit`, OTHER), body: editBody() }), status(404));
  assert.equal(count(db, 'project_chat_message_edits'), 0);
});

test('правится только доставленное одной частью сообщение Хью, отправленное владельцем', async () => {
  const ctx = setup(), { chat, db, owner } = ctx;
  const id = await delivered(ctx);
  // Сообщение участника.
  const human = (await call(chat, { session: owner, method: 'POST', url: room('/messages'), body: { text: 'Обычное', clientMessageId: 'human-0001' } })).payload.message.id;
  await assert.rejects(() => postEdit(ctx, human, editBody({ expectedText: 'Обычное' })), status(409));
  // Даже с отметкой и доставкой одной частью сообщение не от Хью не правится.
  db.prepare('INSERT INTO project_chat_reviewed_messages(message_id,reviewer_id,chat_id,reviewed_at) VALUES(?,?,?,?)').run(human, '1', GROUP, 'x');
  db.prepare("UPDATE project_chat_outbox SET status='sent',external_ids='[\"141\"]' WHERE message_id=?").run(human);
  await assert.rejects(() => postEdit(ctx, human, editBody({ expectedText: 'Обычное' })), status(409));
  // Сообщение Хью без отметки владельца (например, ответ модели).
  db.prepare('DELETE FROM project_chat_reviewed_messages WHERE message_id=?').run(id);
  await assert.rejects(() => postEdit(ctx, id), status(409));
  db.prepare('INSERT INTO project_chat_reviewed_messages(message_id,reviewer_id,chat_id,reviewed_at) VALUES(?,?,?,?)').run(id, '1', GROUP, 'x');
  // Не доставлено, доставка неизвестна, ушло несколькими частями.
  for (const [state, ids] of [['pending', '[]'], ['uncertain', '["136"]'], ['error', '[]'], ['sent', '["136","137"]'], ['sent', '[]'], ['sent', 'не JSON']]) {
    db.prepare('UPDATE project_chat_outbox SET status=?,external_ids=? WHERE message_id=?').run(state, ids, id);
    await assert.rejects(() => postEdit(ctx, id), status(409), `${state} ${ids}`);
  }
  db.prepare("UPDATE project_chat_outbox SET status='sent',external_ids='[\"136\"]' WHERE message_id=?").run(id);
  // Сообщение с вложением.
  const upload = await call(chat, { session: owner, method: 'POST', url: room('/attachments'), bytes: PNG,
    headers: { 'content-type': 'image/png', 'x-filename': 'price.png' } });
  db.prepare('UPDATE project_chat_attachments SET message_id=? WHERE id=?').run(id, upload.payload.attachment.id);
  await assert.rejects(() => postEdit(ctx, id), status(409));
  db.prepare('UPDATE project_chat_attachments SET message_id=NULL WHERE id=?').run(upload.payload.attachment.id);
  assert.equal(count(db, 'project_chat_message_edits'), 0);
  assert.equal((await postEdit(ctx, id)).statusCode, 202, 'после восстановления условий правка принимается');
});

test('конфликты: другая группа, устаревший текст, незавершённая правка, чужой ключ', async () => {
  const ctx = setup(), { db } = ctx;
  const id = await delivered(ctx);
  await assert.rejects(() => postEdit(ctx, id, editBody({ expectedChatId: '-100999' })), status(409));
  await assert.rejects(() => postEdit(ctx, id, editBody({ expectedText: 'Старая версия' })), status(409));
  // Группа комнаты сменилась после отправки: правка в прежнюю группу не ставится.
  db.prepare('UPDATE project_chat_rooms SET telegram_chat_id=? WHERE company_code=?').run('-100555', ROOM);
  await assert.rejects(() => postEdit(ctx, id, editBody({ expectedChatId: '-100555' })), status(409));
  db.prepare('UPDATE project_chat_rooms SET telegram_chat_id=? WHERE company_code=?').run(GROUP, ROOM);
  assert.equal((await postEdit(ctx, id)).statusCode, 202);
  await assert.rejects(() => postEdit(ctx, id, editBody({ clientEditId: 'edit-key-0002', text: 'Ещё версия' })), status(409));
  // Тот же ключ с другим телом.
  await assert.rejects(() => postEdit(ctx, id, editBody({ text: 'Подмена' })), status(409));
  assert.equal(count(db, 'project_chat_message_edits'), 1);
});

test('проверка тела: пусто, тот же текст, длина подписи и текста, лишние поля, ключ', async () => {
  const ctx = setup(), { db } = ctx;
  const id = await delivered(ctx);
  for (const body of [editBody({ text: '   ' }), editBody({ text: 'Сводка 13 задач' }), editBody({ text: 'x'.repeat(EDIT_TEXT_LIMIT + 1) }),
    editBody({ extra: 1 }), editBody({ clientEditId: 'short' }), editBody({ expectedText: undefined }), editBody({ expectedChatId: 5 })]) {
    await assert.rejects(() => postEdit(ctx, id, body), status(400));
  }
  assert.equal(count(db, 'project_chat_message_edits'), 0);
  // Ровно на границе одной части — принимается.
  assert.equal((await postEdit(ctx, id, editBody({ text: 'x'.repeat(EDIT_TEXT_LIMIT) }))).statusCode, 202);
});

test('при выдаче мосту условия проверяются заново: сменилась группа или текст — правка не уходит', async () => {
  const ctx = setup(), { chat, db } = ctx;
  const id = await delivered(ctx);
  const first = (await postEdit(ctx, id)).payload.edit;
  db.prepare('UPDATE project_chat_rooms SET telegram_chat_id=? WHERE company_code=?').run('-100555', ROOM);
  assert.deepEqual(chat.bridge.pendingTelegram(1, EDIT), []);
  assert.equal(editRow(db, first.id).status, 'error');
  assert.match(editRow(db, first.id).error, /Группа Telegram/);
  db.prepare('UPDATE project_chat_rooms SET telegram_chat_id=? WHERE company_code=?').run(GROUP, ROOM);
  const second = (await postEdit(ctx, id, editBody({ clientEditId: 'edit-key-0002' }))).payload.edit;
  db.prepare('UPDATE project_chat_messages SET text=? WHERE id=?').run('Изменено в обход', id);
  assert.deepEqual(chat.bridge.pendingTelegram(1, EDIT), []);
  assert.equal(editRow(db, second.id).status, 'error');
  assert.equal(messageText(db, id), 'Изменено в обход');
});

test('ошибка, неподтверждённый и ложный успех не меняют текст ЛК', async () => {
  const ctx = setup(), { chat, db } = ctx;
  const id = await delivered(ctx);
  const edit = (await postEdit(ctx, id)).payload.edit;
  const take = () => { db.prepare('UPDATE project_chat_message_edits SET next_attempt_at=?').run('2000-01-01T00:00:00.000Z'); return chat.bridge.pendingTelegram(1, EDIT)[0]; };
  // ok с другим номером или другой группой — не успех.
  let job = take();
  assert.deepEqual(chat.bridge.acknowledgeTelegram(job.id, { ok: true, editedMessageId: '137', chatId: GROUP }), { ok: false, status: 'error' });
  assert.equal(messageText(db, id), 'Сводка 13 задач');
  for (const [key, receipt] of [['edit-key-0002', { ok: true, editedMessageId: '136', chatId: '-100999' }], ['edit-key-0022', { ok: true }]]) {
    const next = (await postEdit(ctx, id, editBody({ clientEditId: key }))).payload.edit;
    job = take();
    assert.equal(job.id, `edit:${next.id}`);
    assert.deepEqual(chat.bridge.acknowledgeTelegram(job.id, receipt), { ok: false, status: 'error' });
    assert.equal(editRow(db, next.id).error, 'Telegram не подтвердил правку этого сообщения');
  }
  // Определённый отказ Telegram — сразу ошибка.
  const third = (await postEdit(ctx, id, editBody({ clientEditId: 'edit-key-0003' }))).payload.edit;
  job = take();
  assert.deepEqual(chat.bridge.acknowledgeTelegram(job.id, { ok: false, uncertain: false, retryable: false, error: 'message to edit not found' }), { ok: false, status: 'error' });
  assert.equal(editRow(db, third.id).error, 'message to edit not found');
  // Неизвестный исход повторяется не больше трёх раз, затем ошибка.
  const fourth = (await postEdit(ctx, id, editBody({ clientEditId: 'edit-key-0004' }))).payload.edit;
  for (const expected of ['pending', 'pending', 'error']) {
    job = take();
    assert.equal(job.id, `edit:${fourth.id}`);
    assert.equal(chat.bridge.acknowledgeTelegram(job.id, { ok: false, uncertain: true, retryable: true, error: 'нет ответа' }).status, expected);
  }
  assert.equal(editRow(db, fourth.id).attempts, 3);
  assert.equal(messageText(db, id), 'Сводка 13 задач', 'ни одна неуспешная правка не изменила текст ЛК');
  assert.equal(edit.status, 'pending');
});

test('истёкшая аренда возвращает правку в очередь не больше трёх раз', async () => {
  const ctx = setup(), { chat, db } = ctx;
  const id = await delivered(ctx);
  const edit = (await postEdit(ctx, id)).payload.edit;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const [job] = chat.bridge.pendingTelegram(1, EDIT);
    assert.equal(job.attempt, attempt);
    db.prepare('UPDATE project_chat_message_edits SET claimed_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', edit.id);
  }
  assert.deepEqual(chat.bridge.pendingTelegram(1, EDIT), []);
  assert.equal(editRow(db, edit.id).status, 'error');
  assert.equal(messageText(db, id), 'Сводка 13 задач');
  // После ошибки можно поставить новую правку.
  assert.equal((await postEdit(ctx, id, editBody({ clientEditId: 'edit-key-0002' }))).statusCode, 202);
});

test('номера заданий не пересекаются: отправка №N и правка edit:N квитируются раздельно', async () => {
  const ctx = setup(), { chat, db, owner } = ctx;
  const id = await delivered(ctx);
  const edit = (await postEdit(ctx, id)).payload.edit;
  // Обычная отправка с тем же числовым номером, что у правки.
  await call(chat, { session: owner, method: 'POST', url: room('/messages'), body: { text: 'Новое', clientMessageId: 'human-0002' } });
  const outboxIds = db.prepare('SELECT id FROM project_chat_outbox ORDER BY id').all().map(r => r.id);
  assert.ok(outboxIds.includes(edit.id), 'есть отправка с тем же числом');
  const [send] = chat.bridge.pendingTelegram(1, EDIT);
  assert.equal(typeof send.id, 'number', 'сначала обычная очередь комнаты');
  assert.notEqual(send.kind, 'edit');
  chat.bridge.acknowledgeTelegram(send.id, { ok: true, externalMessageIds: ['140'] });
  assert.equal(editRow(db, edit.id).status, 'pending', 'квитанция отправки не трогает правку');
  const [job] = chat.bridge.pendingTelegram(1, EDIT);
  assert.equal(job.id, `edit:${edit.id}`);
  const sameNumber = db.prepare('SELECT status FROM project_chat_outbox WHERE id=?').get(edit.id).status;
  chat.bridge.acknowledgeTelegram(job.id, { ok: true, editedMessageId: '136', chatId: GROUP });
  assert.equal(db.prepare('SELECT status FROM project_chat_outbox WHERE id=?').get(edit.id).status, sameNumber, 'квитанция правки не трогает отправку');
  assert.throws(() => chat.bridge.acknowledgeTelegram('edit:999', { ok: true }), status(404));
});

test('поздняя квитанция старой правки не затирает более новый текст', async () => {
  const ctx = setup(), { chat, db } = ctx;
  const id = await delivered(ctx);
  const first = (await postEdit(ctx, id)).payload.edit;
  const [old] = chat.bridge.pendingTelegram(1, EDIT);
  // Аренда первой правки истекла трижды — она закрыта ошибкой.
  db.prepare("UPDATE project_chat_message_edits SET status='error',attempts=3,finished_at='x',claimed_at=NULL WHERE id=?").run(first.id);
  const second = (await postEdit(ctx, id, editBody({ clientEditId: 'edit-key-0002', text: 'Вторая версия' }))).payload.edit;
  const [job] = chat.bridge.pendingTelegram(1, EDIT);
  chat.bridge.acknowledgeTelegram(job.id, { ok: true, editedMessageId: '136', chatId: GROUP });
  assert.equal(messageText(db, id), 'Вторая версия');
  chat.bridge.acknowledgeTelegram(old.id, { ok: true, editedMessageId: '136', chatId: GROUP });
  assert.equal(messageText(db, id), 'Вторая версия');
  assert.equal(editRow(db, first.id).status, 'sent');
  assert.equal(editRow(db, first.id).text_synced, 0);
  assert.equal(editRow(db, second.id).text_synced, 1);
});
