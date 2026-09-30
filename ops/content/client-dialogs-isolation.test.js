'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createSiteOrders } = require('./site-orders');
const { createClientDialogs } = require('./client-dialogs');

function fixture() {
  const db = new DatabaseSync(':memory:');
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-company-test-'));
  let clock = Date.parse('2026-09-29T09:00:00Z');
  const tx = fn => { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; } };
  const sites = { one: { companyCode: 'first', title: 'Первая', origins: [] },
    two: { companyCode: 'second', title: 'Вторая', origins: [] } };
  const orders = createSiteOrders({ db, tx, sites, priceReader: () => null, now: () => clock });
  const bots = Object.fromEntries(Object.entries(sites).map(([key, config]) => [key, {
    ...config, site: key, username: `${key}_test_bot`,
  }]));
  const dialogs = createClientDialogs({ db, assetsDir, siteOrders: orders, bots, now: () => clock });
  let messageId = 0;
  const receive = (key, from, text, extra = {}) => dialogs.receive(key, { message: {
    message_id: ++messageId, chat: { id: from, type: 'private' }, from: { id: from, first_name: 'Тест' }, text, ...extra,
  } });
  const drain = key => {
    for (let count = 0; count < 30; count++) {
      const [job] = dialogs.pendingJobs(key);
      if (!job) return;
      dialogs.acknowledge(key, { jobId: job.id, ok: true, externalMessageIds: job.parts.map((_, i) => String(1000 + count * 10 + i)) });
    }
    throw Error('Очередь не опустела');
  };
  for (const [key, operator] of [['one', 111111], ['two', 222222]]) {
    dialogs.heartbeat(key, { ok: true, username: bots[key].username, botId: key === 'one' ? '100' : '200' });
    orders.setRecipient(key, { telegramChatId: String(operator), label: key });
    const code = dialogs.createOperatorCode(key, 'test-owner');
    receive(key, operator, `/operator ${code.code}`);
    drain(key);
    orders.setTransport(key, { transport: 'client_bot' }, { clientBotReady: dialogs.transportReady });
  }
  return { db, orders, dialogs, receive, drain, advance: ms => { clock += ms; },
    close() { db.close(); fs.rmSync(assetsDir, { recursive: true, force: true }); } };
}

test('опрос второго бота не захватывает более раннее уведомление первой компании', () => {
  const t = fixture();
  try {
    t.orders.testRecipient('one'); t.orders.testRecipient('two');
    const [second] = t.dialogs.pendingJobs('two');
    assert.ok(second);
    assert.equal(second.parts[0].params.chat_id, '222222');
    assert.deepEqual(t.db.prepare('SELECT site,status,attempts FROM site_order_outbox ORDER BY id').all().map(row => ({ ...row })), [
      { site: 'one', status: 'pending', attempts: 0 }, { site: 'two', status: 'sending', attempts: 1 },
    ]);
    assert.throws(() => t.dialogs.acknowledge('one', { jobId: second.id, ok: true, externalMessageIds: ['9000'] }), /не найдена/);
    assert.deepEqual(t.dialogs.pendingJobs('two'), []);
    const [first] = t.dialogs.pendingJobs('one');
    assert.equal(first.parts[0].params.chat_id, '111111');
    t.dialogs.acknowledge('two', { jobId: second.id, ok: true, externalMessageIds: ['9000'] });
    assert.equal(t.orders.recipientStatus('one').verifiedAt, null);
    assert.ok(t.orders.recipientStatus('two').verifiedAt);
  } finally { t.close(); }
});

test('новый чек-лист Palitra не появляется и не изменяется в ботах других компаний', () => {
  const t = fixture();
  try {
    const id = Number(t.db.prepare(`INSERT INTO site_orders(site,company_code,request_id,fingerprint,kind,name,phone,phone_normalized,items_json,ip_hash,created_at)
      VALUES('one','first','fixture-1','hash','request','Тест','1111111111','1111111111','[]','ip','2026-09-30T10:00:00Z')`).run().lastInsertRowid);
    const row = t.orders.listOrders('one').orders[0]; assert.equal(Object.hasOwn(row, 'checklist'), false);
    t.orders.renotify('one', id);
    const [job] = t.dialogs.pendingJobs('one'); const part = job.parts.at(-1);
    assert.equal(part.params.reply_markup.inline_keyboard.length, 1);
    assert.doesNotMatch(part.params.text, /ручные отметки/);
    t.dialogs.acknowledge('one', { jobId: job.id, ok: true, externalMessageIds: ['5000'] });
    const result = t.dialogs.callback('one', { id: 'fake', from: { id: 111111 }, data: `oc:${id}:photo:1:0`,
      message: { message_id: 5000, chat: { id: 111111, type: 'private' }, text: part.params.text } });
    assert.equal(result.answer.showAlert, true); assert.equal(result.edit, null);
    assert.equal(t.db.prepare('SELECT count(*) AS n FROM site_order_checklist_events').get().n, 0);
  } finally { t.close(); }
});

test('истечение аренды одной компании не обрабатывается опросом другой', () => {
  const t = fixture();
  try {
    t.orders.testRecipient('one'); t.dialogs.pendingJobs('one');
    t.advance(11 * 60 * 1000);
    // Обновляем только подтверждение второго моста.
    t.dialogs.heartbeat('two', { ok: true, username: 'two_test_bot', botId: '200' });
    assert.deepEqual(t.dialogs.pendingJobs('two'), []);
    assert.equal(t.db.prepare('SELECT status FROM site_order_outbox').get().status, 'sending');
    t.dialogs.heartbeat('one', { ok: true, username: 'one_test_bot', botId: '100' });
    assert.deepEqual(t.dialogs.pendingJobs('one'), []);
    assert.equal(t.db.prepare('SELECT status FROM site_order_outbox').get().status, 'uncertain');
  } finally { t.close(); }
});

test('один клиент в двух ботах создаёт раздельные диалоги и получателей', () => {
  const t = fixture();
  try {
    const first = t.receive('one', 999999, 'Вопрос первой компании');
    const second = t.receive('two', 999999, 'Вопрос второй компании');
    assert.notEqual(first.dialogId, second.dialogId);
    assert.throws(() => t.dialogs.dialogView('one', second.dialogId), /не найден/);
    assert.equal(t.dialogs.listDialogs('one').dialogs.length, 1);
    assert.equal(t.dialogs.listDialogs('two').dialogs.length, 1);
    for (const [key, operator] of [['one', '111111'], ['two', '222222']]) {
      const [job] = t.dialogs.pendingJobs(key);
      assert.ok(job.parts.some(part => part.method === 'copyMessage'));
      assert.ok(job.parts.every(part => part.params.chat_id === operator));
      // Telegram может выдать одинаковые номера сообщений в разных ботах.
      const ids = job.parts.map((_, index) => String(7000 + index));
      t.dialogs.acknowledge(key, { jobId: job.id, ok: true, externalMessageIds: ids });
      const reply = t.receive(key, Number(operator), `Ответ ${key}`, {
        reply_to_message: { message_id: Number(ids.at(-1)) },
      });
      assert.equal(reply.action, 'reply');
      assert.equal(reply.dialogId, key === 'one' ? first.dialogId : second.dialogId);
      const [answer] = t.dialogs.pendingJobs(key);
      assert.equal(answer.parts[0].params.chat_id, '999999');
      assert.equal(answer.parts[0].params.from_chat_id, operator);
    }
    assert.throws(() => t.orders.pendingTelegram('client_bot', 'missing'), /Не найдено/);
  } finally { t.close(); }
});
