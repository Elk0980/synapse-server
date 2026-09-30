'use strict';

/* Клиентский бот Palitra (хранилище и правила): привязка менеджера кодом, пересылка клиенту и обратно
   только через «Ответить», вложения и правки, неизвестный исход без повторов, связь заявки с диалогом,
   канал уведомлений о заявках и кнопки статуса. Синтетические данные, без сети.
   node --test ops/content/client-dialogs.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createProjectChat } = require('./project-chat');
const { createClientDialogs } = require('./client-dialogs');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const ORIGIN = 'https://palitra-love.ru';
const SITE = 'palitra';
const COMPANY = 'palitra-love';
const DARYA = '555000111';           // синтетический Telegram ID получателя заявок и менеджера
const STRANGER = '777000222';
const CLIENT = '900000001';
const CLIENT_2 = '900000002';
const PRICE = JSON.stringify({ categories: [{ id: 'c', items: [{ id: 'bukety-1', title: 'Букет', price: '3 500 руб.' }] }] });
const noop = () => { throw new Error('не используется'); };

function setup({ username = 'palitra_test_bot', maxFile = 1024, maxStorage } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-dialogs-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const authStore = createAuthStore(db, `vlad:owner:${HASH}`);
  const clock = { at: Date.parse('2026-09-29T09:00:00Z'), tick(ms) { this.at += ms; } };
  const chat = createProjectChat({ db, authStore, assetsDir: dir, runnerUrl: '', chatApiKey: '',
    requireSession: noop, requireCsrf: noop, sendJson: noop, readBody: noop, fetchImpl: async () => { throw new Error('нет службы'); },
    siteOrders: { sites: { [SITE]: { companyCode: COMPANY, title: 'Palitra', origins: [ORIGIN] } }, priceReader: () => PRICE, ipSalt: 'salt', now: () => clock.at } });
  const bots = { palitra: { companyCode: COMPANY, site: SITE, title: 'Palitra', username, hours: '09:00–21:00', policyUrl: 'https://palitra-love.ru/privacy' } };
  const dialogs = createClientDialogs({ db, assetsDir: dir, siteOrders: chat.siteOrders, bots, now: () => clock.at, maxFile,
    ...(maxStorage === undefined ? {} : { maxStorage }) });
  // Свежее подтверждение моста (getMe сделал сервис chat); тесты готовности управляют им явно.
  const beat = (body = { ok: true, username, botId: '1' }) => dialogs.heartbeat('palitra', body);
  if (username) beat();
  let updateId = 0, messageId = 100;
  const message = (from, text, extra = {}) => ({ message_id: ++messageId, date: 1790000000, chat: { id: Number(from), type: 'private' },
    from: { id: Number(from), first_name: from === DARYA ? 'Дарья' : 'Анна', username: from === DARYA ? 'darya_qa' : 'anna_qa' }, ...(text === null ? {} : { text }), ...extra });
  const receive = (from, text, extra) => { const msg = message(from, text, extra); updateId += 1; return { msg, result: dialogs.receive('palitra', { message: msg }) }; };
  return { db, chat, orders: chat.siteOrders, dialogs, clock, dir, receive, message, beat };
}
const outbox = (db) => db.prepare('SELECT * FROM client_bot_outbox ORDER BY id').all().map((row) => ({ ...row, parts: JSON.parse(row.parts), after: JSON.parse(row.after) }));
const pending = (db) => outbox(db).filter((row) => row.status === 'pending');
/* Выдать все задания моста и подтвердить их с номерами сообщений от 1000. */
function drain(dialogs, { from = 1000, result = () => ({ ok: true }) } = {}) {
  const done = [];
  let next = from;
  for (let guard = 0; guard < 50; guard++) {
    const [job] = dialogs.pendingJobs('palitra');
    if (!job) break;
    const ids = job.parts.map(() => String(next++));
    const outcome = result(job);
    done.push({ job, ids, ack: dialogs.acknowledge('palitra', { jobId: job.id, externalMessageIds: outcome.ok ? ids : [], ...outcome }) });
    if (!outcome.ok && !outcome.uncertain) break;
  }
  return done;
}
function bindDarya(t) {
  t.orders.setRecipient(SITE, { telegramChatId: DARYA, label: 'Дарья' });
  const code = t.dialogs.createOperatorCode(SITE, 'vlad');
  t.receive(DARYA, `/operator ${code.code}`);
  drain(t.dialogs);
  return code;
}

test('чек-лист в Telegram: только действующий оператор и подтверждённая связь сообщения/заявки; повтор, отмена, stale без отправки клиенту', () => {
  const t = setup(); bindDarya(t);
  t.orders.setTransport(SITE, { transport: 'client_bot' }, { clientBotReady: t.dialogs.transportReady });
  const created = order(t), id = created.body.orderId, [job] = t.dialogs.pendingJobs('palitra');
  const original = job.parts.at(-1).params.text;
  assert.match(original, /ручные отметки менеджера/);
  const keys = job.parts.at(-1).params.reply_markup.inline_keyboard;
  assert.equal(keys.length, 3); assert.equal(keys[1][0].callback_data, `oc:${id}:photo:1:0`);
  const press = (data, extra = {}) => t.dialogs.callback('palitra', { id: 'c-1', from: { id: Number(DARYA) }, data,
    message: { message_id: 4200, chat: { id: Number(DARYA), type: 'private' }, text: original }, ...extra });
  assert.equal(press(`oc:${id}:photo:1:0`).answer.showAlert, true, 'до ACK связь сообщения ещё не подтверждена');
  t.dialogs.acknowledge('palitra', { jobId: job.id, ok: true, externalMessageIds: ['4200'] });
  const jobsBefore = outbox(t.db), orderJobsBefore = t.db.prepare('SELECT * FROM site_order_outbox').all();
  const first = press(`oc:${id}:photo:1:0`);
  assert.equal(first.answer.text, 'Ручная отметка сохранена'); assert.equal(first.edit.text, original);
  assert.equal(first.edit.replyMarkup.inline_keyboard[1][0].callback_data, `oc:${id}:photo:0:1`);
  assert.match(first.edit.replyMarkup.inline_keyboard[1][0].text, /снять отметку/);
  const saved = t.orders.listOrders(SITE).orders[0];
  assert.deepEqual(saved.checklist.items[0].actor, { type: 'telegram', id: DARYA, label: 'Дарья' });
  assert.equal(saved.status, 'notified'); assert.equal(saved.work.status, 'new');
  t.clock.tick(1000);
  assert.equal(press(`oc:${id}:photo:1:0`).answer.text, 'Отметка уже сохранена');
  assert.equal(t.orders.listOrders(SITE).orders[0].checklist.history.length, 1);
  assert.equal(press(`oc:${id}:photo:0:1`).answer.text, 'Ручная отметка снята');
  const stale = press(`oc:${id}:photo:1:0`); assert.equal(stale.answer.showAlert, true);
  assert.equal(stale.edit.replyMarkup.inline_keyboard[1][0].callback_data, `oc:${id}:photo:1:2`);
  for (const extra of [{ from: { id: Number(STRANGER) } }, { message: { message_id: 999, chat: { id: Number(DARYA), type: 'private' }, text: original } },
    { message: { message_id: 4200, chat: { id: Number(DARYA), type: 'group' }, text: original } }]) assert.equal(press(`oc:${id}:guide:1:0`, extra).answer.showAlert, true);
  const another = order(t); assert.equal(press(`oc:${another.body.orderId}:guide:1:0`).answer.showAlert, true, 'номер другой заявки нельзя подставить в кнопку');
  assert.equal(t.orders.listOrders(SITE).orders.find((row) => row.id === id).checklist.history.length, 2);
  assert.deepEqual(outbox(t.db), jobsBefore, 'клиентских сообщений не создаётся');
  assert.deepEqual(t.db.prepare('SELECT * FROM site_order_outbox WHERE order_id=?').all(id), orderJobsBefore, 'уведомления не меняются');
  const inWork = press(`ow:${id}:in_work`); assert.equal(inWork.edit.replyMarkup.inline_keyboard.length, 3, 'изменение статуса сохраняет кнопки чек-листа');
  t.dialogs.revokeOperator(SITE, 'owner');
  assert.equal(press(`oc:${id}:guide:1:0`).answer.showAlert, true);
  assert.equal(t.orders.checklistOrder(SITE, id).order.checklist.items[1].checked, false);
});

test('бот не включён без имени; события групп и чужих личек не принимаются', () => {
  const off = setup({ username: '' });
  assert.throws(() => off.dialogs.receive('palitra', { message: off.message(CLIENT, 'Здравствуйте') }), (error) => error.status === 404 && error.code === 'BOT_DISABLED');
  assert.equal(off.dialogs.status(SITE).enabled, false);
  assert.equal(off.dialogs.issueOrderLink({ site: SITE, orderId: 1 }), null);
  const t = setup();
  const group = { ...t.message(CLIENT, 'в группу'), chat: { id: -1001, type: 'supergroup' } };
  assert.throws(() => t.dialogs.receive('palitra', { message: group }), (error) => error.status === 422);
  const foreign = { ...t.message(CLIENT, 'подмена'), chat: { id: Number(CLIENT_2), type: 'private' } };
  assert.throws(() => t.dialogs.receive('palitra', { message: foreign }), (error) => error.status === 422, 'chat.id должен совпадать с from.id');
  assert.throws(() => t.dialogs.receive('other', { message: t.message(CLIENT, 'x') }), (error) => error.status === 404);
  assert.equal(t.db.prepare('SELECT count(*) AS n FROM client_dialogs').get().n, 0);
});

test('код менеджера: только владелец создаёт, короткий срок, одноразовый, строго для Telegram ID получателя', (tt) => {
  const t = setup();
  assert.throws(() => t.dialogs.createOperatorCode(SITE, 'vlad'), (error) => error.status === 409 && error.code === 'RECIPIENT_MISSING');
  t.orders.setRecipient(SITE, { telegramChatId: DARYA, label: 'Дарья' });
  const first = t.dialogs.createOperatorCode(SITE, 'vlad');
  assert.match(first.code, /^[A-Z2-9]{10}$/);
  assert.equal(first.command, `/operator ${first.code}`);
  assert.ok(`op_${first.code}`.length <= 64);
  assert.equal(t.dialogs.status(SITE).pendingCode.expiresAt, first.expiresAt);
  // Чужой пользователь с верным кодом не привязывается и не узнаёт причину.
  t.receive(STRANGER, `/operator ${first.code}`);
  assert.equal(t.dialogs.status(SITE).operator.bound, false);
  assert.match(pending(t.db).at(-1).parts[0].params.text, /Код не подошёл или устарел/);
  assert.equal(pending(t.db).at(-1).parts[0].params.chat_id, STRANGER);
  // Пять неверных попыток гасят код даже для верного пользователя.
  for (let i = 0; i < 4; i++) t.receive(STRANGER, `/start op_${first.code}`);
  t.receive(DARYA, `/operator ${first.code}`);
  assert.equal(t.dialogs.status(SITE).operator.bound, false);
  // Новый код гасит прежний; истёкший срок — отказ.
  const second = t.dialogs.createOperatorCode(SITE, 'vlad');
  const third = t.dialogs.createOperatorCode(SITE, 'vlad');
  t.receive(DARYA, `/operator ${second.code}`);
  assert.equal(t.dialogs.status(SITE).operator.bound, false, 'прежний код погашен новым');
  t.clock.tick(11 * 60 * 1000);
  t.receive(DARYA, `/operator ${third.code}`);
  assert.equal(t.dialogs.status(SITE).operator.bound, false, 'срок 10 минут');
  // Верный пользователь в срок — привязан; повтор того же кода — отказ.
  const fourth = t.dialogs.createOperatorCode(SITE, 'vlad');
  t.receive(DARYA, `/start op_${fourth.code.toLowerCase()}`);
  const status = t.dialogs.status(SITE);
  assert.deepEqual([status.operator.bound, status.operator.telegramUserId, status.operator.matchesRecipient, status.pendingCode], [true, DARYA, true, null]);
  assert.match(pending(t.db).at(-1).parts[0].params.text, /вы подключены как менеджер Palitra/);
  t.receive(STRANGER, `/operator ${fourth.code}`);
  assert.equal(t.dialogs.status(SITE).operator.telegramUserId, DARYA, 'использованный код не переносит привязку');
  assert.ok(status.events.some((event) => event.kind === 'operator_bound'));
  assert.ok(status.events.every((event) => !event.detail.includes(fourth.code)), 'код не пишется в журнал');
  assert.equal(t.db.prepare('SELECT count(*) AS n FROM client_bot_codes WHERE code_hash=?').get(fourth.code).n, 0, 'в базе только хеш кода');
  tt.diagnostic('ok');
});

test('клиент пишет → копия менеджеру с шапкой; ответ через «Ответить» → клиенту от бота; без reply ничего не уходит', () => {
  const t = setup();
  bindDarya(t);
  const start = t.receive(CLIENT, '/start ig');
  assert.equal(start.result.action, 'start');
  const [greeting, header] = pending(t.db);
  assert.equal(greeting.parts[0].params.chat_id, CLIENT);
  assert.match(greeting.parts[0].params.text, /Это Palitra[\s\S]*09:00–21:00[\s\S]*сохраняются, чтобы обработать заказ[\s\S]*palitra-love\.ru\/privacy/);
  assert.match(header.parts[0].params.text, /Новый диалог: Анна \(@anna_qa\) · диалог №1 · источник: ig/);
  drain(t.dialogs);
  const first = t.receive(CLIENT, 'Нужен букет к 18:00');
  assert.deepEqual([first.result.action, first.result.dialogId], ['forwarded', 1]);
  const [forward] = pending(t.db);
  assert.deepEqual(forward.parts.map((part) => part.method), ['copyMessage'], 'шапка не повторяется, пока пишет тот же клиент');
  assert.deepEqual(forward.parts[0].params, { chat_id: DARYA, from_chat_id: CLIENT, message_id: first.msg.message_id });
  const [{ ids }] = drain(t.dialogs, { from: 5000 });
  // Второй клиент: шапка снова нужна, потому что сменился собеседник.
  t.receive(CLIENT_2, 'А шары есть?');
  assert.deepEqual(pending(t.db)[0].parts.map((part) => part.method), ['sendMessage', 'copyMessage']);
  drain(t.dialogs, { from: 6000 });
  // Ответ менеджера на копию сообщения первого клиента уходит первому клиенту.
  const reply = t.receive(DARYA, 'Добрый день! Соберём к 18:00.', { reply_to_message: { message_id: Number(ids[0]) } });
  assert.deepEqual([reply.result.action, reply.result.dialogId], ['reply', 1]);
  const [replyJob] = pending(t.db);
  assert.deepEqual(replyJob.parts[0], { method: 'copyMessage', params: { chat_id: CLIENT, from_chat_id: DARYA, message_id: reply.msg.message_id } });
  assert.deepEqual(replyJob.after[0].method, 'setMessageReaction');
  drain(t.dialogs, { from: 7000 });
  const view = t.dialogs.dialogView(SITE, 1);
  const out = view.messages.find((message) => message.authorType === 'operator');
  assert.deepEqual([out.direction, out.deliveryStatus, out.text], ['out', 'sent', 'Добрый день! Соберём к 18:00.']);
  assert.equal(view.dialog.unread, 0, 'ответ менеджера отмечает диалог прочитанным');
  assert.equal(t.dialogs.listDialogs(SITE).dialogs.find((dialog) => dialog.id === 2).unread, 1);
  // Без «Ответить» — подсказка менеджеру, клиенту ничего.
  const before = t.db.prepare("SELECT count(*) AS n FROM client_dialog_messages WHERE author_type='operator'").get().n;
  const loose = t.receive(DARYA, 'Анна, всё готово');
  assert.equal(loose.result.action, 'operator_unrouted');
  const hint = pending(t.db);
  assert.equal(hint.length, 1);
  assert.equal(hint[0].parts[0].params.chat_id, DARYA);
  assert.match(hint[0].parts[0].params.text, /не отправлено клиенту/);
  assert.equal(t.db.prepare("SELECT count(*) AS n FROM client_dialog_messages WHERE author_type='operator'").get().n, before);
  drain(t.dialogs, { from: 8000 });
  // Ответ на неизвестное сообщение (например, на подсказку бота) тоже никуда не уходит.
  assert.equal(t.receive(DARYA, 'кому?', { reply_to_message: { message_id: 8000 } }).result.action, 'operator_unrouted');
  assert.equal(pending(t.db).every((job) => job.parts[0].params.chat_id === DARYA), true);
  // Команды менеджера клиенту не уходят.
  assert.equal(t.receive(DARYA, '/help', { reply_to_message: { message_id: Number(ids[0]) } }).result.action, 'operator_command_ignored');
});

test('повтор события Telegram не создаёт второго сообщения и второго задания', () => {
  const t = setup();
  bindDarya(t);
  const msg = t.message(CLIENT, 'Привет');
  const first = t.dialogs.receive('palitra', { message: msg });
  const again = t.dialogs.receive('palitra', { message: msg });
  assert.equal(again.duplicate, true);
  assert.equal(again.dialogId, first.dialogId);
  assert.equal(t.db.prepare('SELECT count(*) AS n FROM client_dialog_messages').get().n, 1);
  assert.equal(pending(t.db).length, 1);
  const [{ ids }] = drain(t.dialogs);
  const answer = t.message(DARYA, 'Ответ', { reply_to_message: { message_id: Number(ids.at(-1)) } });
  t.dialogs.receive('palitra', { message: answer });
  t.dialogs.receive('palitra', { message: answer });
  assert.equal(outbox(t.db).filter((job) => job.kind === 'reply').length, 1, 'повтор ответа менеджера не отправляет клиенту дважды');
});

test('неизвестный исход не повторяется; отказ повторяется до предела; менеджер узнаёт о проблеме', () => {
  const t = setup();
  bindDarya(t);
  t.receive(CLIENT, 'Вопрос');
  const [{ ids }] = drain(t.dialogs);
  t.receive(DARYA, 'Ответ 1', { reply_to_message: { message_id: Number(ids.at(-1)) } });
  const [job] = t.dialogs.pendingJobs('palitra');
  assert.deepEqual(t.dialogs.acknowledge('palitra', { jobId: job.id, ok: false, uncertain: true, error: 'нет ответа' }), { ok: false, status: 'uncertain' });
  const [warning] = t.dialogs.pendingJobs('palitra');
  assert.equal(warning.parts[0].params.chat_id, DARYA, 'следующее задание — предупреждение менеджеру, не повтор ответа');
  assert.match(warning.parts[0].params.text, /Автоматически не повторяю/);
  t.dialogs.acknowledge('palitra', { jobId: warning.id, ok: true, externalMessageIds: ['9'] });
  assert.equal(t.dialogs.pendingJobs('palitra').length, 0);
  assert.deepEqual(t.dialogs.acknowledge('palitra', { jobId: job.id, ok: false, retryable: true }), { ok: false, status: 'uncertain' }, 'поздний отказ не оживляет');
  assert.deepEqual(t.dialogs.acknowledge('palitra', { jobId: job.id, ok: true, externalMessageIds: ['77'] }), { ok: true, status: 'sent' }, 'поздний успех уточняет исход');
  // Определённый отказ (429) — повтор с паузой до трёх попыток, затем failed и сообщение менеджеру.
  t.receive(DARYA, 'Ответ 2', { reply_to_message: { message_id: Number(ids.at(-1)) } });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const [again] = t.dialogs.pendingJobs('palitra');
    assert.equal(again.kind, 'reply');
    const result = t.dialogs.acknowledge('palitra', { jobId: again.id, ok: false, retryable: true, error: 'Telegram: 429' });
    assert.equal(result.status, attempt < 3 ? 'pending' : 'failed');
    t.clock.tick(60000);
  }
  const [failedNotice] = t.dialogs.pendingJobs('palitra');
  assert.match(failedNotice.parts[0].params.text, /Ответ клиенту не доставлен: Telegram: 429/);
  t.dialogs.acknowledge('palitra', { jobId: failedNotice.id, ok: true, externalMessageIds: ['10'] });
  // Просроченная аренда — uncertain без повторной выдачи.
  t.receive(DARYA, 'Ответ 3', { reply_to_message: { message_id: Number(ids.at(-1)) } });
  const [leased] = t.dialogs.pendingJobs('palitra');
  t.clock.tick(11 * 60 * 1000);
  const [after] = t.dialogs.pendingJobs('palitra');
  assert.notEqual(after?.id, leased.id);
  assert.equal(t.db.prepare('SELECT status FROM client_bot_outbox WHERE id=?').get(Number(leased.id.slice(3))).status, 'uncertain');
  const statuses = t.dialogs.dialogView(SITE, 1).messages.filter((message) => message.authorType === 'operator').map((message) => message.deliveryStatus);
  assert.deepEqual(statuses, ['sent', 'failed', 'uncertain']);
  assert.throws(() => t.dialogs.acknowledge('palitra', { jobId: 'cb:9999', ok: true }), (error) => error.status === 404);
});

test('вложения: голосовое, фото, видео, PDF сохраняются в пределе; большое и недоступное — явный статус без файла', () => {
  const t = setup({ maxFile: 1024 });
  bindDarya(t);
  const voice = t.receive(CLIENT, null, { voice: { file_id: 'v1', file_unique_id: 'uv1', mime_type: 'audio/ogg', file_size: 300 } });
  assert.deepEqual(voice.result.downloads.map((item) => [item.fileId, item.size]), [['v1', 300]]);
  const photo = t.receive(CLIENT, null, { caption: 'Вот такой', photo: [
    { file_id: 'p-small', file_size: 100, width: 90 }, { file_id: 'p-mid', file_size: 900, width: 320 }, { file_id: 'p-big', file_size: 5000, width: 1280 }] });
  assert.deepEqual(photo.result.downloads.map((item) => item.fileId), ['p-mid'], 'самый крупный размер фото в пределах лимита');
  const video = t.receive(CLIENT, null, { video: { file_id: 'vid', file_size: 50000, mime_type: 'video/mp4' } });
  assert.deepEqual(video.result.downloads, [], 'слишком большой файл не скачивается');
  const pdf = t.receive(CLIENT, null, { document: { file_id: 'doc', file_size: 200, mime_type: 'application/pdf', file_name: 'Заказ/../x.pdf' } });
  const again = t.dialogs.receive('palitra', { message: pdf.msg });
  assert.deepEqual(again.downloads.map((item) => item.fileId), ['doc'], 'повтор события снова отдаёт незавершённые скачивания');
  t.dialogs.saveAttachment('palitra', voice.result.downloads[0].attachmentId, Buffer.from('OggS-voice'));
  t.dialogs.saveAttachment('palitra', voice.result.downloads[0].attachmentId, Buffer.from('другое'));
  assert.equal(t.dialogs.saveAttachment('palitra', photo.result.downloads[0].attachmentId, Buffer.alloc(2048)).status, 'too_large', 'фактический размер сверх предела — только сведения');
  t.dialogs.markAttachment('palitra', pdf.result.downloads[0].attachmentId, 'unavailable', 'Telegram не отдал файл боту');
  const files = t.dialogs.dialogView(SITE, 1).messages.flatMap((message) => message.attachments);
  assert.deepEqual(files.map((file) => [file.kind, file.status]), [['voice', 'stored'], ['photo', 'too_large'], ['video', 'too_large'], ['document', 'unavailable']]);
  assert.equal(files[3].name, 'Заказ_.._x.pdf');
  assert.ok(files.every((file) => !('fileId' in file) && !('disk' in file)), 'идентификаторы Telegram и пути диска наружу не выдаются');
  const stored = t.dialogs.attachmentFile(SITE, files[0].id);
  assert.deepEqual([fs.readFileSync(stored.file, 'utf8'), stored.mime, stored.inline], ['OggS-voice', 'audio/ogg', true], 'повторная загрузка не перезаписывает файл');
  assert.throws(() => t.dialogs.attachmentFile(SITE, files[2].id), (error) => error.status === 404 && /больше 0 МБ|сведения/.test(error.message));
  assert.throws(() => t.dialogs.attachmentFile(SITE, files[3].id), (error) => error.status === 404);
  // Файл менеджера тоже сохраняется: обе стороны переписки.
  const [{ ids }] = drain(t.dialogs).slice(-1);
  const reply = t.receive(DARYA, null, { reply_to_message: { message_id: Number(ids.at(-1)) }, photo: [{ file_id: 'done', file_size: 500 }] });
  assert.deepEqual([reply.result.action, reply.result.downloads[0].fileId], ['reply', 'done']);
});

test('правки: клиентская — версия и заметка менеджеру; правка менеджера клиенту не уходит', () => {
  const t = setup();
  bindDarya(t);
  const sent = t.receive(CLIENT, 'К 18:00');
  const [{ ids }] = drain(t.dialogs);
  const edit = { ...sent.msg, text: 'К 19:00', edit_date: 1790000100 };
  t.dialogs.receive('palitra', { edited_message: edit });
  t.dialogs.receive('palitra', { edited_message: edit });
  const [note] = pending(t.db);
  assert.equal(pending(t.db).length, 1, 'повтор той же правки не дублирует заметку');
  assert.match(note.parts[0].params.text, /изменил\(а\) сообщение:\nК 19:00/);
  assert.equal(note.parts[0].params.reply_parameters.message_id, Number(ids.at(-1)));
  drain(t.dialogs, { from: 3000 });
  const view = t.dialogs.dialogView(SITE, 1).messages.find((message) => message.authorType === 'client');
  assert.deepEqual([view.text, view.edited, view.versions.map((version) => version.text)], ['К 19:00', true, ['К 18:00']]);
  // На заметку о правке тоже можно ответить — ответ уйдёт этому клиенту.
  assert.equal(t.receive(DARYA, 'Хорошо, к 19:00', { reply_to_message: { message_id: 3000 } }).result.action, 'reply');
  const reply = t.receive(DARYA, 'Опечатка', { reply_to_message: { message_id: Number(ids.at(-1)) } });
  drain(t.dialogs, { from: 4000 });
  t.dialogs.receive('palitra', { edited_message: { ...reply.msg, text: 'Исправлено', edit_date: 1790000200 } });
  assert.match(pending(t.db)[0].parts[0].params.text, /Исправление не отправлено клиенту/);
  assert.equal(outbox(t.db).filter((job) => job.kind === 'reply').length, 2, 'правка не создаёт отправки клиенту');
  const operatorView = t.dialogs.dialogView(SITE, 1).messages.find((message) => message.text === 'Опечатка');
  assert.deepEqual(operatorView.versions.map((version) => [version.text, version.kind]), [['Исправлено', 'operator_edit_not_sent']]);
});

const order = (t, over = {}) => t.orders.submit({ site: SITE, origin: ORIGIN, ip: '203.0.113.9', body: { requestId: crypto.randomUUID(), kind: 'cart', name: 'Анна',
  phone: '+7 900 000-00-01', consent: true, items: [{ id: 'bukety-1', qty: 1 }], ...over } });

test('ссылка «Продолжить в Telegram»: только полностью настроенному боту, одноразовая, короткий срок, без данных заявки', () => {
  const t = setup();
  const created = order(t);
  assert.equal(t.dialogs.issueOrderLink({ site: SITE, orderId: created.body.orderId }), null, 'без привязанного менеджера ссылки нет');
  bindDarya(t);
  assert.equal(t.dialogs.issueOrderLink({ site: SITE, orderId: 999 }), null, 'чужая или несуществующая заявка');
  const link = t.dialogs.issueOrderLink({ site: SITE, orderId: created.body.orderId });
  const payload = new URL(link.url).searchParams.get('start');
  assert.match(link.url, /^https:\/\/t\.me\/palitra_test_bot\?start=o_[A-Za-z0-9_-]{32}$/);
  assert.ok(payload.length <= 64);
  // В ссылке только случайный токен: повторная выдача для той же заявки даёт другой токен, телефона и имени нет.
  assert.notEqual(new URL(t.dialogs.issueOrderLink({ site: SITE, orderId: created.body.orderId }).url).searchParams.get('start'), payload);
  assert.ok(!/Анна|\+7|000-00-01/.test(decodeURIComponent(link.url)));
  assert.equal(Date.parse(link.expiresAt) - t.clock.at, 30 * 60 * 1000);
  t.receive(CLIENT, `/start ${payload}`);
  assert.equal(t.dialogs.listDialogs(SITE).dialogs[0].orderId, created.body.orderId);
  assert.match(pending(t.db)[0].parts[0].params.text, new RegExp(`заявка №${created.body.orderId} уже у менеджера`));
  // Повтор той же ссылки другим человеком не связывает его диалог с чужой заявкой.
  t.receive(CLIENT_2, `/start ${payload}`);
  assert.equal(t.dialogs.listDialogs(SITE).dialogs.find((dialog) => dialog.id === 2).orderId, null);
  // Подобранный или просроченный токен не работает.
  t.receive(CLIENT_2, `/start o_${'A'.repeat(32)}`);
  const late = t.dialogs.issueOrderLink({ site: SITE, orderId: order(t).body.orderId });
  t.clock.tick(31 * 60 * 1000);
  t.receive(CLIENT_2, `/start ${new URL(late.url).searchParams.get('start')}`);
  assert.equal(t.dialogs.listDialogs(SITE).dialogs.find((dialog) => dialog.id === 2).orderId, null);
  const refused = t.dialogs.status(SITE).events.filter((event) => event.kind === 'order_link_refused').map((event) => event.detail);
  assert.deepEqual(refused.sort(), ['нет такой ссылки', 'срок истёк', 'ссылка уже использована'].sort());
  assert.equal(t.db.prepare('SELECT count(*) AS n FROM client_order_links WHERE token_hash=?').get(payload.slice(2)).n, 0, 'в базе только хеш токена');
});

test('канал заявок: переключение только при готовом боте, ничего не рассылает, новые заявки идут ботом Palitra с кнопками', () => {
  const t = setup();
  const pendingProject = () => t.chat.bridge.pendingTelegram();
  t.orders.setRecipient(SITE, { telegramChatId: DARYA, label: 'Дарья' });
  const old = order(t);
  const ready = (site, chatId) => t.dialogs.transportReady(site, chatId);
  assert.throws(() => t.orders.setTransport(SITE, { transport: 'client_bot' }, { clientBotReady: ready }), (error) => error.status === 409 && /не привязан/.test(error.message));
  assert.throws(() => t.orders.setTransport(SITE, { transport: 'fax' }), (error) => error.status === 400);
  const code = t.dialogs.createOperatorCode(SITE, 'vlad');
  t.receive(DARYA, `/operator ${code.code}`);
  drain(t.dialogs);
  const jobsBefore = t.db.prepare('SELECT count(*) AS n FROM site_order_outbox').get().n;
  const switched = t.orders.setTransport(SITE, { transport: 'client_bot' }, { clientBotReady: ready });
  assert.deepEqual([switched.transport, switched.verifiedAt], ['client_bot', null]);
  assert.equal(t.db.prepare('SELECT count(*) AS n FROM site_order_outbox').get().n, jobsBefore, 'переключение не создаёт заданий');
  assert.equal(t.db.prepare('SELECT status FROM site_order_outbox WHERE order_id=?').get(old.body.orderId).status, 'error', 'не начатое уведомление старым каналом остановлено, не переслано');
  assert.equal(pendingProject().length, 0);
  // Новая заявка — только клиентскому боту; мост общего чата её не видит.
  const fresh = order(t);
  assert.equal(pendingProject().length, 0, 'старый маршрут не дублирует');
  const [job] = t.dialogs.pendingJobs('palitra');
  assert.equal(job.id, `order:${jobsBefore + 1}`);
  assert.equal(job.parts[0].params.chat_id, DARYA);
  assert.match(job.parts.at(-1).params.text, /Статус обработки: Новая$/);
  assert.deepEqual(job.parts.at(-1).params.reply_markup.inline_keyboard[0].map((button) => button.callback_data),
    [`ow:${fresh.body.orderId}:in_work`, `ow:${fresh.body.orderId}:done`, `ow:${fresh.body.orderId}:cancelled`]);
  assert.deepEqual(t.dialogs.acknowledge('palitra', { jobId: job.id, ok: true, externalMessageIds: ['4200'] }), { ok: true, status: 'sent' });
  assert.equal(t.orders.listOrders(SITE).orders[0].status, 'notified');
  // Ответ менеджера на уведомление: клиент не писал — подсказка; после связи — ответ уходит клиенту.
  assert.equal(t.receive(DARYA, 'Анна, здравствуйте', { reply_to_message: { message_id: 4200 } }).result.action, 'order_without_dialog');
  drain(t.dialogs, { from: 4300 });
  t.receive(CLIENT, 'Это Анна, заказ на сайте');
  const [{ ids }] = drain(t.dialogs, { from: 4400 });
  t.receive(DARYA, `/заявка ${fresh.body.orderId}`, { reply_to_message: { message_id: Number(ids.at(-1)) } });
  drain(t.dialogs, { from: 4500 });
  assert.equal(t.receive(DARYA, 'Анна, всё в силе', { reply_to_message: { message_id: 4200 } }).result.action, 'reply');
  // Кнопки статуса: только менеджер; повтор — без изменений; статус уведомления не трогается.
  const press = (from, data) => t.dialogs.callback('palitra', { id: 'q1', from: { id: Number(from) }, data,
    message: { message_id: 4200, chat: { id: Number(DARYA), type: 'private' }, text: `${job.parts.at(-1).params.text}` } });
  assert.equal(press(STRANGER, `ow:${fresh.body.orderId}:done`).answer.showAlert, true);
  const inWork = press(DARYA, `ow:${fresh.body.orderId}:in_work`);
  assert.equal(inWork.answer.text, 'Статус: В работе');
  assert.match(inWork.edit.text, /Статус обработки: В работе$/);
  assert.equal((inWork.edit.text.match(/Статус обработки/g) || []).length, 1);
  assert.equal(press(DARYA, `ow:${fresh.body.orderId}:in_work`).answer.text, 'Уже: В работе');
  assert.equal(press(DARYA, 'ow:999:done').answer.text, 'Заявка не найдена');
  const listed = t.orders.listOrders(SITE).orders[0];
  assert.deepEqual([listed.status, listed.work.status, listed.work.updatedBy], ['notified', 'in_work', 'Менеджер в Telegram']);
  // Проверочное сообщение новым каналом подтверждает получателя для этого канала.
  drain(t.dialogs, { from: 4550 });
  t.orders.testRecipient(SITE);
  const [testJob] = t.dialogs.pendingJobs('palitra');
  assert.equal(testJob.parts[0].params.reply_markup, undefined, 'у проверки нет кнопок');
  t.dialogs.acknowledge('palitra', { jobId: testJob.id, ok: true, externalMessageIds: ['4600'] });
  assert.ok(t.orders.recipientStatus(SITE).verifiedAt);
  // Смена получателя возвращает прежний канал; отключение менеджера — тоже.
  t.orders.setRecipient(SITE, { telegramChatId: STRANGER, label: 'Другой' });
  assert.equal(t.orders.recipientStatus(SITE).transport, 'project_bot');
  t.orders.setRecipient(SITE, { telegramChatId: DARYA, label: 'Дарья' });
  t.orders.setTransport(SITE, { transport: 'client_bot' }, { clientBotReady: ready });
  const revoked = t.dialogs.revokeOperator(SITE, 'vlad');
  assert.deepEqual([revoked.operator.bound, revoked.transport], [false, 'project_bot']);
  t.receive(CLIENT, 'Ещё вопрос');
  assert.equal(pending(t.db).filter((row) => row.kind === 'forward').length, 0, 'без менеджера сообщения только сохраняются');
});

test('кабинет: только диалоги своего бота и компании; чужой диалог и файл — 404', () => {
  const t = setup();
  bindDarya(t);
  t.receive(CLIENT, 'Привет');
  const foreign = t.db.prepare(`INSERT INTO client_dialogs(bot_key,company_code,telegram_user_id,chat_id,created_at,updated_at,last_message_at)
    VALUES('alvi','alvi','1','1','x','x','x')`).run().lastInsertRowid;
  assert.deepEqual(t.dialogs.listDialogs(SITE).dialogs.map((dialog) => dialog.id), [1]);
  assert.throws(() => t.dialogs.dialogView(SITE, Number(foreign)), (error) => error.status === 404);
  assert.throws(() => t.dialogs.listDialogs('alvi'), (error) => error.status === 404);
  assert.throws(() => t.dialogs.listDialogs(SITE, { limit: 1000 }), (error) => error.status === 400);
  assert.equal(t.dialogs.markRead(SITE, 1).ok, true);
  assert.equal(t.dialogs.listDialogs(SITE).dialogs[0].unread, 0);
});

test('отзыв менеджера: не начатые копии, заметки и ответы прежнему не выдаются; начатое не переотправляется и честно учитывается', () => {
  const t = setup();
  bindDarya(t);
  t.receive(CLIENT, 'Первое');
  const [inFlight] = t.dialogs.pendingJobs('palitra');                 // копия уже отдана мосту (sending)
  t.receive(CLIENT, 'Второе');                                          // ещё не начата
  t.dialogs.revokeOperator(SITE, 'vlad');
  assert.deepEqual(t.dialogs.pendingJobs('palitra'), [], 'прежнему менеджеру ничего не выдаётся');
  const stopped = outbox(t.db).filter((job) => job.status === 'failed');
  assert.deepEqual(stopped.map((job) => [job.kind, job.error]), [['forward', 'Менеджер отключён до отправки']]);
  const second = t.dialogs.dialogView(SITE, 1).messages.find((message) => message.text === 'Второе');
  assert.deepEqual([second.deliveryStatus, second.deliveryError], ['failed', 'Менеджер отключён до отправки']);
  // Начатая отправка не переотправляется: её исход приходит подтверждением.
  assert.equal(t.db.prepare('SELECT status FROM client_bot_outbox WHERE id=?').get(Number(inFlight.id.slice(3))).status, 'sending');
  t.dialogs.acknowledge('palitra', { jobId: inFlight.id, ok: false, uncertain: true, error: 'нет ответа' });
  assert.equal(t.dialogs.dialogView(SITE, 1).messages.find((message) => message.text === 'Первое').deliveryStatus, 'uncertain');
  // Новые сообщения клиента после отзыва только сохраняются.
  assert.equal(t.receive(CLIENT, 'Третье').result.action, 'stored');
  assert.deepEqual(t.dialogs.pendingJobs('palitra'), []);
  // Прежний менеджер больше не может отвечать клиентам.
  assert.notEqual(t.receive(DARYA, 'ответ', { reply_to_message: { message_id: 1000 } }).result.action, 'reply');
  assert.equal(outbox(t.db).filter((job) => job.kind === 'reply').length, 0);
});

test('смена получателя: прежнему менеджеру ни копий, ни ответов; перепривязка нового останавливает задания прежнего', () => {
  const t = setup();
  bindDarya(t);
  t.receive(CLIENT, 'До смены');
  const [{ ids }] = drain(t.dialogs);
  t.receive(DARYA, 'Ответ в очереди', { reply_to_message: { message_id: Number(ids.at(-1)) } });   // ответ ещё не начат
  t.receive(CLIENT, 'Копия в очереди');
  t.orders.setRecipient(SITE, { telegramChatId: STRANGER, label: 'Новый' });
  assert.deepEqual(t.dialogs.pendingJobs('palitra'), [], 'задания прежнего менеджера остановлены при выдаче');
  assert.deepEqual(outbox(t.db).filter((job) => job.status === 'failed').map((job) => job.kind).sort(), ['forward', 'reply']);
  assert.equal(t.dialogs.dialogView(SITE, 1).messages.find((message) => message.text === 'Ответ в очереди').deliveryStatus, 'failed');
  // Новые сообщения клиента прежнему не пересылаются; его ответы не уходят, он получает объяснение.
  assert.equal(t.receive(CLIENT, 'После смены').result.action, 'stored');
  const stale = t.receive(DARYA, 'Ещё ответ', { reply_to_message: { message_id: Number(ids.at(-1)) } });
  assert.equal(stale.result.action, 'operator_inactive');
  const [explain] = t.dialogs.pendingJobs('palitra');
  assert.deepEqual([explain.parts[0].params.chat_id, /получатель заявок изменён/.test(explain.parts[0].params.text)], [DARYA, true]);
  t.dialogs.acknowledge('palitra', { jobId: explain.id, ok: true, externalMessageIds: ['1'] });
  assert.equal(t.dialogs.status(SITE).operator.matchesRecipient, false);
  // Привязка нового менеджера (по коду для нового получателя) — новые сообщения идут ему.
  const code = t.dialogs.createOperatorCode(SITE, 'vlad');
  t.receive(STRANGER, `/operator ${code.code}`);
  drain(t.dialogs);
  assert.equal(t.receive(CLIENT, 'Новому').result.action, 'forwarded');
  const [job] = t.dialogs.pendingJobs('palitra');
  assert.ok(job.parts.every((part) => part.params.chat_id === STRANGER));
});

test('старый код после смены получателя не привязывает прежний ID', () => {
  const t = setup();
  t.orders.setRecipient(SITE, { telegramChatId: DARYA, label: 'Дарья' });
  const code = t.dialogs.createOperatorCode(SITE, 'vlad');
  t.orders.setRecipient(SITE, { telegramChatId: STRANGER, label: 'Новый' });
  t.receive(DARYA, `/operator ${code.code}`);
  const status = t.dialogs.status(SITE);
  assert.equal(status.operator.bound, false);
  assert.ok(status.events.some((event) => event.kind === 'operator_bind_refused' && /получатель заявок изменён/.test(event.detail)));
  t.orders.setRecipient(SITE, { telegramChatId: DARYA, label: 'Дарья' });
  t.receive(DARYA, `/operator ${code.code}`);
  assert.equal(t.dialogs.status(SITE).operator.bound, false, 'погашенный код не оживает при возврате получателя');
});

test('одна заявка — один диалог: вторая связь отклоняется, ответ на уведомление идёт единственному клиенту; перенос только через /отвязать', () => {
  const t = setup();
  bindDarya(t);
  t.orders.setTransport(SITE, { transport: 'client_bot' }, { clientBotReady: t.dialogs.transportReady });
  const created = order(t);
  const [notice] = t.dialogs.pendingJobs('palitra');
  t.dialogs.acknowledge('palitra', { jobId: notice.id, ok: true, externalMessageIds: ['7000'] });
  const link = t.dialogs.issueOrderLink({ site: SITE, orderId: created.body.orderId });
  t.receive(CLIENT, `/start ${new URL(link.url).searchParams.get('start')}`);
  t.receive(CLIENT_2, 'Я тоже по заказу');
  const done = drain(t.dialogs, { from: 7100 });
  const copyOfSecond = done.flatMap((item) => item.job.parts.map((part, index) => ({ part, id: item.ids[index] })))
    .find((entry) => entry.part.method === 'copyMessage' && entry.part.params.from_chat_id === CLIENT_2).id;
  const conflict = t.receive(DARYA, `/заявка ${created.body.orderId}`, { reply_to_message: { message_id: Number(copyOfSecond) } });
  assert.equal(conflict.result.action, 'manual_link_conflict');
  assert.match(pending(t.db).at(-1).parts[0].params.text, /уже связана с диалогом №1.*\/отвязать/);
  drain(t.dialogs, { from: 7200 });
  assert.deepEqual(t.dialogs.listDialogs(SITE).dialogs.map((dialog) => [dialog.id, dialog.orderId]).sort(), [[1, created.body.orderId], [2, null]]);
  const answer = t.receive(DARYA, 'По вашей заявке', { reply_to_message: { message_id: 7000 } });
  assert.deepEqual([answer.result.action, answer.result.dialogId], ['reply', 1], 'ответ на уведомление — только связанному клиенту');
  drain(t.dialogs, { from: 7300 });
  // Явный перенос: отвязать в первом диалоге, затем связать со вторым.
  const firstCopy = t.db.prepare("SELECT message_id FROM client_bot_map WHERE dialog_id=1 AND chat_id=? ORDER BY message_id LIMIT 1").get(DARYA).message_id;
  assert.equal(t.receive(DARYA, '/отвязать', { reply_to_message: { message_id: firstCopy } }).result.action, 'unlink');
  assert.equal(t.receive(DARYA, `/заявка ${created.body.orderId}`, { reply_to_message: { message_id: Number(copyOfSecond) } }).result.action, 'manual_link');
  drain(t.dialogs, { from: 7400 });
  assert.equal(t.receive(DARYA, 'Теперь вам', { reply_to_message: { message_id: 7000 } }).result.dialogId, 2);
  assert.throws(() => t.db.prepare('UPDATE client_dialogs SET order_id=? WHERE id=1').run(created.body.orderId), /UNIQUE/, 'уникальность держит и база');
});

test('готовность моста: без свежего подтверждения или с чужим именем бота — ссылки нет и канал не включается', () => {
  const t = setup();
  bindDarya(t);
  const orderId = order(t).body.orderId;
  assert.ok(t.dialogs.issueOrderLink({ site: SITE, orderId }), 'свежее подтверждение — ссылка есть');
  t.clock.tick(6 * 60 * 1000);
  assert.equal(t.dialogs.issueOrderLink({ site: SITE, orderId }), null, 'подтверждение старше 5 минут');
  assert.deepEqual([t.dialogs.status(SITE).bridge.ready, /свежего подтверждения/.test(t.dialogs.status(SITE).bridge.error)], [false, true]);
  assert.equal(t.dialogs.transportReady(SITE, DARYA).ok, false);
  t.beat({ ok: true, username: 'synapse_sb_bot', botId: '2' });
  assert.equal(t.dialogs.issueOrderLink({ site: SITE, orderId }), null, 'токен другого бота');
  assert.match(t.dialogs.status(SITE).bridge.error, /synapse_sb_bot/);
  t.beat({ ok: false, error: 'Telegram: 401 — Unauthorized' });
  assert.equal(t.dialogs.issueOrderLink({ site: SITE, orderId }), null);
  t.beat();
  assert.ok(t.dialogs.issueOrderLink({ site: SITE, orderId }));
  assert.equal(t.dialogs.transportReady(SITE, DARYA).ok, true);
});

test('клиент заменил фото правкой: прежнее помечено заменённым, новое сохраняется отдельно и приходит менеджеру', () => {
  const t = setup({ maxFile: 4096 });
  bindDarya(t);
  const sent = t.receive(CLIENT, null, { caption: 'Вот так', photo: [{ file_id: 'old-photo', file_unique_id: 'u-old', file_size: 100 }] });
  t.dialogs.saveAttachment('palitra', sent.result.downloads[0].attachmentId, Buffer.from('старое фото'));
  const [{ ids }] = drain(t.dialogs);
  const edited = { ...sent.msg, caption: 'Лучше так', photo: [{ file_id: 'new-photo', file_unique_id: 'u-new', file_size: 120 }], edit_date: 1790000500 };
  const result = t.dialogs.receive('palitra', { edited_message: edited });
  assert.deepEqual(result.downloads.map((item) => item.fileId), ['new-photo']);
  t.dialogs.saveAttachment('palitra', result.downloads[0].attachmentId, Buffer.from('новое фото'));
  const clientMessage = () => t.dialogs.dialogView(SITE, 1).messages.find((message) => message.authorType === 'client');
  const files = clientMessage().attachments;
  assert.deepEqual(files.map((file) => [file.status, file.superseded]), [['stored', true], ['stored', false]]);
  assert.equal(fs.readFileSync(t.dialogs.attachmentFile(SITE, files[1].id).file, 'utf8'), 'новое фото');
  const [note] = pending(t.db);
  assert.match(note.parts[0].params.text, /изменил\(а\) сообщение и заменил\(а\) вложение:\nЛучше так/);
  assert.equal(note.parts[0].params.reply_parameters.message_id, Number(ids.at(-1)));
  assert.deepEqual(note.parts[1].params, { chat_id: DARYA, from_chat_id: CLIENT, message_id: sent.msg.message_id });
  // Правка только подписи не заменяет вложение.
  t.dialogs.receive('palitra', { edited_message: { ...edited, caption: 'Подпись', edit_date: 1790000600 } });
  assert.equal(clientMessage().attachments.filter((file) => file.superseded).length, 1);
});

test('лимит хранилища: сверх общего предела файл не сохраняется, статус явный, история не удаляется', () => {
  const t = setup({ maxFile: 1024, maxStorage: 1000 });
  bindDarya(t);
  const first = t.receive(CLIENT, null, { voice: { file_id: 'v1', file_size: 600 } });
  t.dialogs.saveAttachment('palitra', first.result.downloads[0].attachmentId, Buffer.alloc(600, 1));
  const second = t.receive(CLIENT, null, { voice: { file_id: 'v2', file_size: 600 } });
  assert.deepEqual(second.result.downloads, [], 'известный размер сверх предела — не скачивается');
  const third = t.receive(CLIENT, null, { document: { file_id: 'd3', mime_type: 'application/pdf' } });   // размер неизвестен
  assert.equal(third.result.downloads.length, 1);
  assert.equal(t.dialogs.saveAttachment('palitra', third.result.downloads[0].attachmentId, Buffer.alloc(500, 2)).status, 'quota_exceeded');
  const files = t.dialogs.dialogView(SITE, 1).messages.flatMap((message) => message.attachments);
  assert.deepEqual(files.map((file) => file.status), ['stored', 'quota_exceeded', 'quota_exceeded']);
  assert.match(files[1].error, /Лимит хранилища/);
  assert.deepEqual(t.dialogs.status(SITE).storage, { usedBytes: 600, limitBytes: 1000 });
  assert.equal(t.dialogs.dialogView(SITE, 1).messages.length, 3, 'сообщения сохранены');
});
