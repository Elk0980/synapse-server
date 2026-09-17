'use strict';

/* Заявки с сайта Palitra: валидация и Origin, сверка с live-прайсом в копейках, идемпотентность
   до лимита частоты, одна транзакция заказа и уведомления, очередь моста order:<n>, получатель
   с версией. Только встроенные модули Node: node --test ops/content/site-orders.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createProjectChat } = require('./project-chat');
const { clientIp, originOf, priceKopecks } = require('./site-orders');
const { createProjectChatBridge } = require('../chat/project-chat-bridge');
const { parseQuietHours } = require('../chat/quiet-hours');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const ORIGIN = 'https://palitra-love.synapsebusiness.ru';
const SITE = 'palitra';
const ROOM = 'palitra-love';
const OWNER_ID = 1;
const PRICE = JSON.stringify({ categories: [{ id: 'c', items: [
  { id: 'bukety-1', title: 'Букет «Нежность»', price: '3 500 руб.' },
  { id: 'shary-1', title: 'Шары', price: 'от 2 500 руб.' },
  { id: 'korziny-1', title: 'Корзина', price: '' },
  { id: 'gigant-1', title: 'Гигант', price: '1 250,50 руб.' },
] }] });

const requireSession = (request) => {
  if (!request.session) throw Object.assign(new Error('Требуется вход в кабинет'), { status: 401 });
  return request.session;
};
const requireCsrf = (request, session) => {
  if (String(request.headers['x-csrf-token'] || '') !== session.csrf) throw Object.assign(new Error('Некорректный CSRF-токен'), { status: 403 });
};
const sendJson = (response, status, payload, headers) => { response.statusCode = status; response.payload = payload; response.headers = headers; };
const readBody = async (request) => request.body;

function setup({ price = PRICE } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-orders-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const authStore = createAuthStore(db, `vlad:owner:${HASH}`);
  const clock = { offset: 0, get now() { return Date.now() + this.offset; }, tick(ms) { this.offset += ms; } };
  const state = { price };
  const chat = createProjectChat({ db, authStore, assetsDir: dir, runnerUrl: '', chatApiKey: '',
    requireSession, requireCsrf, sendJson, readBody, fetchImpl: async () => { throw new Error('нет службы'); },
    siteOrders: { sites: { [SITE]: { companyCode: ROOM, title: 'Palitra', origins: [ORIGIN] } }, priceReader: () => state.price, ipSalt: 'salt', now: () => clock.now } });
  const owner = { user: authStore.getById(OWNER_ID), csrf: `csrf-${OWNER_ID}` };
  return { db, chat, orders: chat.siteOrders, clock, state, owner };
}
const body = (over = {}) => ({ requestId: crypto.randomUUID(), kind: 'cart', name: 'Анна', phone: '8 (914) 000-11-22', comment: 'к 18:00', consent: true,
  items: [{ id: 'bukety-1', qty: 2 }], page: '/catalog/bukety/', utm: { utm_source: 'yandex' }, website: '', ...over });
const submit = (orders, payload, { origin = ORIGIN, ip = '203.0.113.5' } = {}) => {
  try { return orders.submit({ site: SITE, body: payload, origin, ip }); }
  catch (error) { if (!error.status) throw error; return { status: error.status, body: { code: error.code, error: error.message, itemId: error.itemId } }; }
};
async function call(chat, { session = null, method = 'GET', url, body: payload }) {
  const request = { method, headers: session && method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}, session, body: payload };
  const response = { statusCode: 0, payload: null };
  await chat.handle(request, response, new URL(`http://x${url}`));
  return response;
}
const orderRows = (db) => db.prepare('SELECT * FROM site_orders ORDER BY id').all();
const outboxRows = (db) => db.prepare('SELECT * FROM site_order_outbox ORDER BY id').all();
const RECIPIENT = { telegramChatId: '123456789', label: 'Дарья' };

test('цены прайса читаются в копейках, всё неточное — неизвестно; IP берётся только от доверенного прокси', () => {
  assert.equal(priceKopecks('3 500 руб.'), 350000);
  assert.equal(priceKopecks('1 250,50 руб.'), 125050);
  assert.equal(priceKopecks('900 ₽'), 90000);
  assert.equal(priceKopecks(12.5), 1250);
  for (const value of ['', 'от 2 500 руб.', 'договорная', '-5', 'NaN', '1e5', null, undefined, Infinity, -1, '99999999999999999 руб.']) {
    assert.equal(priceKopecks(value), null, String(value));
  }
  const request = (remote, forwarded) => ({ socket: { remoteAddress: remote }, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } });
  assert.equal(clientIp(request('172.18.0.2', '198.51.100.7')), '198.51.100.7', 'частный адрес прокси → последний адрес заголовка');
  assert.equal(clientIp(request('172.18.0.2', '10.0.0.1, 198.51.100.7')), '198.51.100.7', 'только значение, дописанное прокси');
  assert.equal(clientIp(request('203.0.113.9', '198.51.100.7')), '203.0.113.9', 'публичный адрес: чужой заголовок не принимается');
  assert.equal(clientIp(request('::ffff:127.0.0.1', '198.51.100.7')), '198.51.100.7');
  assert.equal(clientIp(request('203.0.113.9')), '203.0.113.9');
  assert.equal(originOf({ headers: { origin: 'https://palitra-love.synapsebusiness.ru' } }), ORIGIN);
  assert.equal(originOf({ headers: { referer: 'https://palitra-love.synapsebusiness.ru/catalog/?x=1' } }), ORIGIN);
  assert.equal(originOf({ headers: { origin: 'not a url' } }), '');
});

test('публичный приём: Origin, honeypot, валидация, сверка с live-прайсом, итог в копейках', () => {
  const { orders, db, state } = setup();
  assert.deepEqual([submit(orders, body(), { origin: '' }).status, submit(orders, body(), { origin: 'https://evil.example' }).status], [403, 403]);
  assert.equal(submit(orders, body(), { origin: '' }).body.code, 'ORIGIN');
  for (const [name, over] of [
    ['requestId', { requestId: 'abc' }], ['kind', { kind: 'gift' }], ['consent', { consent: 'yes' }], ['лишнее поле', { price: 1 }],
    ['пустое имя', { name: '  ' }], ['телефон', { phone: '123' }], ['qty 0', { items: [{ id: 'bukety-1', qty: 0 }] }],
    ['qty 21', { items: [{ id: 'bukety-1', qty: 21 }] }], ['qty дробь', { items: [{ id: 'bukety-1', qty: 1.5 }] }],
    ['повтор позиции', { items: [{ id: 'bukety-1', qty: 1 }, { id: 'bukety-1', qty: 1 }] }], ['пустая корзина', { items: [] }],
    ['состав у формы', { kind: 'request', items: [{ id: 'bukety-1', qty: 1 }] }], ['длинное имя', { name: 'x'.repeat(81) }],
  ]) {
    const result = submit(orders, body(over));
    assert.deepEqual([result.status, result.body.code], [400, 'VALIDATION'], name);
  }
  assert.deepEqual(submit(orders, body({ website: 'http://spam' })), { status: 200, body: { ok: true, status: 'accepted' } });
  assert.equal(orderRows(db).length, 0, 'honeypot и ошибки ничего не записывают');
  const unknown = submit(orders, body({ items: [{ id: 'nope-1', qty: 1 }] }));
  assert.deepEqual([unknown.status, unknown.body.code, unknown.body.itemId], [400, 'ITEM_UNKNOWN', 'nope-1']);
  state.price = null;
  assert.deepEqual([submit(orders, body()).status, submit(orders, body()).body.code], [503, 'ORDERS_UNAVAILABLE']);
  state.price = PRICE;
  assert.equal(orderRows(db).length, 0);
  // Состав и цены — с сервера; клиентская цена и название игнорируются; пустая и «от …» цены — неизвестны.
  const accepted = submit(orders, body({ items: [{ id: 'bukety-1', qty: 2, price: 1, title: 'подмена' }, { id: 'shary-1', qty: 1 }, { id: 'korziny-1', qty: 3 }, { id: 'gigant-1', qty: 1 }] }));
  assert.equal(accepted.status, 201);
  assert.match(accepted.body.message, /Менеджер свяжется с вами, подтвердит состав и стоимость, согласует оплату и доставку/);
  assert.doesNotMatch(JSON.stringify(accepted.body), /Анна|914/);
  const row = orderRows(db)[0];
  assert.equal(row.id, accepted.body.orderId);
  assert.deepEqual([row.known_total, row.unknown_count, row.phone_normalized, row.status], [825050, 2, '79140001122', 'accepted']);
  assert.deepEqual(JSON.parse(row.items_json).map((i) => [i.id, i.title, i.qty, i.price]),
    [['bukety-1', 'Букет «Нежность»', 2, 350000], ['gigant-1', 'Гигант', 1, 125050], ['korziny-1', 'Корзина', 3, null], ['shary-1', 'Шары', 1, null]]);
  assert.notEqual(row.ip_hash, '203.0.113.5');
  assert.equal(row.ip_hash.length, 64);
  // Форма главной: повод и дата попадают в комментарий.
  const form = submit(orders, body({ kind: 'request', items: [], occasion: 'День рождения', date: '20.09' }));
  assert.equal(form.status, 201);
  assert.equal(orderRows(db)[1].comment, 'к 18:00\nПовод: День рождения\nДата: 20.09');
});

test('повтор requestId идемпотентен и проверяется до лимита частоты; другой состав → 409; лимиты 5/10 мин и 20/сутки', () => {
  const { orders, db, clock } = setup();
  const first = body();
  const created = submit(orders, first);
  assert.equal(created.status, 201);
  const again = submit(orders, first);
  assert.deepEqual([again.status, again.body.duplicate, again.body.orderId], [200, true, created.body.orderId]);
  assert.deepEqual(Object.keys(again.body).sort(), ['duplicate', 'message', 'ok', 'orderId', 'requestId', 'status']);
  assert.equal(orderRows(db).length, 1, 'повтор не создаёт записи');
  const changed = submit(orders, { ...first, name: 'Другое имя' });
  assert.deepEqual([changed.status, changed.body.code], [409, 'REQUEST_MISMATCH']);
  assert.deepEqual([submit(orders, { ...first, items: [{ id: 'bukety-1', qty: 3 }] }).status, submit(orders, { ...first, page: '/other/' }).status], [409, 200], 'страница не входит в отпечаток');
  // Лимит частоты: пять заявок за 10 минут; шестая — 429, но повтор уже принятой — по-прежнему 200.
  for (let index = 0; index < 4; index++) assert.equal(submit(orders, body()).status, 201);
  const limited = submit(orders, body());
  assert.deepEqual([limited.status, limited.body.code], [429, 'RATE_LIMITED']);
  assert.equal(submit(orders, first).status, 200, 'повтор проверяется раньше лимита');
  assert.equal(submit(orders, body(), { ip: '198.51.100.20' }).status, 201, 'другой адрес не ограничен');
  clock.tick(11 * 60000);
  assert.equal(submit(orders, body()).status, 201, 'тот же телефон с новым requestId — новая заявка');
  for (let index = 0; index < 14; index++) { if (index % 5 === 0) clock.tick(11 * 60000); submit(orders, body()); }
  clock.tick(11 * 60000);
  assert.equal(db.prepare("SELECT count(*) AS n FROM site_order_rate WHERE ip_hash=(SELECT ip_hash FROM site_orders WHERE id=1)").get().n, 20);
  assert.equal(submit(orders, body()).status, 429, 'суточный предел');
  clock.tick(25 * 3600000);
  assert.equal(submit(orders, body()).status, 201, 'через сутки окно очищено');
});

test('заказ и уведомление — одна транзакция; без получателя заявки копятся и отправляются явно после настройки', () => {
  const { orders, db } = setup();
  const early = submit(orders, body());
  assert.equal(early.status, 201);
  assert.equal(outboxRows(db).length, 0, 'без получателя уведомление не создаётся');
  let status = orders.recipientStatus(SITE);
  assert.deepEqual([status.configured, status.unnotifiedOrders, status.verifiedAt], [false, 1, null]);
  assert.throws(() => orders.renotify(SITE, early.body.orderId), (e) => e.status === 409);
  assert.throws(() => orders.testRecipient(SITE), (e) => e.status === 409);
  status = orders.setRecipient(SITE, RECIPIENT);
  assert.deepEqual([status.configured, status.telegramChatId, status.label, status.version, status.verifiedAt], [true, '123456789', 'Дарья', 1, null]);
  assert.throws(() => orders.setRecipient(SITE, { telegramChatId: '12', label: '' }), (e) => e.status === 400);
  assert.throws(() => orders.setRecipient(SITE, { telegramChatId: '123456789', extra: 1 }), (e) => e.status === 400);
  const later = submit(orders, body());
  const jobs = outboxRows(db);
  assert.equal(jobs.length, 1);
  assert.deepEqual([jobs[0].order_id, jobs[0].kind, jobs[0].chat_id, jobs[0].recipient_version, jobs[0].status], [later.body.orderId, 'order', '123456789', 1, 'pending']);
  assert.equal(orders.recipientStatus(SITE).unnotifiedOrders, 1, 'ранняя заявка по-прежнему без уведомления');
  const renotified = orders.renotify(SITE, early.body.orderId);
  assert.equal(renotified.jobId, 'order:2');
  assert.equal(renotified.previous, null);
  assert.equal(orders.recipientStatus(SITE).unnotifiedOrders, 0);
  assert.throws(() => orders.renotify(SITE, early.body.orderId), (e) => e.status === 409, 'пока задание в очереди, второе не ставится');
  assert.throws(() => orders.renotify(SITE, 999), (e) => e.status === 404);
  assert.throws(() => orders.listOrders('alvi'), (e) => e.status === 404, 'другой сайт не обслуживается');
  // Сбой записи уведомления откатывает и заказ: заявка не может остаться «принятой» без своего задания.
  db.exec('DROP TABLE site_order_outbox');
  const before = orderRows(db).length;
  assert.throws(() => orders.submit({ site: SITE, body: body(), origin: ORIGIN, ip: '203.0.113.5' }), /site_order_outbox/);
  assert.equal(orderRows(db).length, before);
});

test('очередь моста: комната первой, order-задания той же семантикой lease/uncertain, ack переводит статусы заявки', async () => {
  const { chat, orders, db, clock, owner } = setup();
  orders.setRecipient(SITE, RECIPIENT);
  await call(chat, { session: owner, method: 'PATCH', url: `/content/project-chat/${ROOM}/settings`, body: { telegramChatId: '-1001' } });
  await call(chat, { session: owner, method: 'POST', url: `/content/project-chat/${ROOM}/messages`, body: { text: 'В группу', clientMessageId: 'room-00001' } });
  const first = submit(orders, body());
  const roomJob = chat.bridge.pendingTelegram();
  assert.equal(typeof roomJob[0].id, 'number', 'сообщение комнаты идёт первым');
  chat.bridge.acknowledgeTelegram(roomJob[0].id, { ok: true, externalMessageIds: ['1'] });
  const [job] = chat.bridge.pendingTelegram();
  assert.deepEqual([job.id, job.companyCode, job.chatId, job.authorName, job.authorType, job.attachments, job.messageId], ['order:1', ROOM, '123456789', 'Заявка с сайта', 'system', [], null]);
  assert.match(job.text, new RegExp(`Заявка №${first.body.orderId} · Palitra`));
  assert.match(job.text, /Имя: Анна\nТелефон: 8 \(914\) 000-11-22/);
  // Разделитель тысяч у ru-RU — узкий неразрывный пробел (U+202F): сверяем через \s.
  assert.match(job.text, /• Букет «Нежность» × 2 — 7\s000\s₽/);
  assert.match(job.text, /Итого по известным ценам: 7\s000\s₽/);
  assert.match(job.text, /Страница: \/catalog\/bukety\//);
  assert.equal(chat.bridge.pendingTelegram().length, 0, 'одно задание в аренде');
  assert.deepEqual(chat.bridge.acknowledgeTelegram('order:1', { ok: true, externalMessageIds: ['77'] }), { ok: true, status: 'sent' });
  assert.deepEqual([orderRows(db)[0].status, Boolean(orderRows(db)[0].notified_at), outboxRows(db)[0].status], ['notified', true, 'sent']);
  assert.deepEqual(chat.bridge.acknowledgeTelegram('order:1', { ok: false, retryable: true }), { ok: true, status: 'sent' }, 'повторный ack не меняет отправленное');
  assert.throws(() => chat.bridge.acknowledgeTelegram('order:999', { ok: true }), (e) => e.status === 404);
  // Неизвестный результат: заявка notify_uncertain, автоматического повтора нет; явный повтор владельца — новое задание.
  const second = submit(orders, body());
  const [job2] = chat.bridge.pendingTelegram();
  chat.bridge.acknowledgeTelegram(job2.id, { ok: false, uncertain: true, error: 'нет ответа' });
  assert.equal(orderRows(db)[1].status, 'notify_uncertain');
  assert.equal(chat.bridge.pendingTelegram().length, 0, 'неизвестно доставленное не повторяется');
  const again = orders.renotify(SITE, second.body.orderId);
  assert.deepEqual([again.previous.status, again.previous.error, again.jobId], ['uncertain', 'нет ответа', 'order:3']);
  const [job3] = chat.bridge.pendingTelegram();
  assert.equal(job3.id, 'order:3');
  // Определённый отказ Bot API повторяется до предела попыток, затем notify_failed с причиной.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = chat.bridge.acknowledgeTelegram('order:3', { ok: false, retryable: true, error: 'Telegram: 429' });
    assert.equal(result.status, attempt < 3 ? 'pending' : 'error');
    if (attempt < 3) { db.prepare("UPDATE site_order_outbox SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE id=3").run(); chat.bridge.pendingTelegram(); }
  }
  assert.deepEqual([orderRows(db)[1].status, outboxRows(db)[2].error], ['notify_failed', 'Telegram: 429']);
  const failed = chat.bridge.acknowledgeTelegram('order:3', { ok: false, retryable: false, error: "403 bot can't initiate conversation" });
  assert.equal(failed.status, 'error');
  // Просроченная аренда: задание становится uncertain, заявка — notify_uncertain, без повторной выдачи.
  const third = submit(orders, body());
  const [job4] = chat.bridge.pendingTelegram();
  assert.equal(job4.id, 'order:4');
  clock.tick(11 * 60000);
  db.prepare("UPDATE site_order_outbox SET claimed_at='2000-01-01T00:00:00.000Z' WHERE id=4").run();
  assert.equal(chat.bridge.pendingTelegram().length, 0);
  assert.deepEqual([outboxRows(db)[3].status, orderRows(db)[2].status], ['uncertain', 'notify_uncertain']);
  // Список для владельца: состав, статус и последнее уведомление; контакты видны только здесь.
  const list = orders.listOrders(SITE, { limit: 10 });
  assert.equal(list.orders.length, 3);
  assert.deepEqual([list.orders[0].id, list.orders[0].status, list.orders[0].notify.status], [third.body.orderId, 'notify_uncertain', 'uncertain']);
  assert.deepEqual([list.orders[2].notify.jobId, list.orders[2].items[0].title, list.orders[2].knownTotal, list.orders[2].phone], ['order:1', 'Букет «Нежность»', 700000, '8 (914) 000-11-22']);
  assert.equal(list.recipient.configured, true);
});

/* Настоящий мост chat с поддельным Telegram поверх очереди content: части, дедупликация, подтверждения. */
function attachBridge(chat, telegram) {
  const sent = [], calls = { telegram: 0 };
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.telegram.org/bot')) {
      const method = target.split('/').pop();
      const body = JSON.parse(options.body);
      calls.telegram += 1;
      const outcome = telegram(method, body, calls.telegram);
      if (outcome.status) return { ok: false, status: outcome.status, json: async () => ({ ok: false, description: outcome.description || 'ошибка' }) };
      if (outcome.broken) return { ok: true, status: 200, json: async () => { throw new Error('не JSON'); } };
      sent.push(body);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 500 + sent.length } }) };
    }
    const route = target.slice(target.indexOf('/project-chat') + '/project-chat'.length).split('?')[0];
    const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
    if (route === '/outbox') return json({ jobs: chat.bridge.pendingTelegram() });
    if (route === '/acknowledge') { const body = JSON.parse(options.body); chat.bridge.acknowledgeTelegram(body.jobId, body); return json({ ok: true }); }
    return json({ error: 'нет маршрута' }, 404);
  };
  const bridge = createProjectChatBridge({ db: new DatabaseSync(':memory:'), contentUrl: 'http://content:8080', apiKey: 'k', telegramToken: 'bot-token',
    legacyHandler: async () => {}, fetchImpl, quietHours: parseQuietHours({}), now: () => new Date('2026-09-17T12:00:00Z') });
  return { bridge, sent, calls };
}
const LONG_PRICE = JSON.stringify({ categories: [{ id: 'c', items: Array.from({ length: 30 }, (_, i) => ({
  id: `pos-${String(i + 1).padStart(2, '0')}`, title: `Позиция ${i + 1} — ${'описание '.repeat(9)}`.trim(), price: `${(i + 1) * 100} руб.` })) }] });

test('длинный заказ уходит целиком: мост делит текст на части, при повторе досылает только недоставленные', async () => {
  const { chat, orders, db } = setup({ price: LONG_PRICE });
  orders.setRecipient(SITE, RECIPIENT);
  const comment = `${'Комментарий '.repeat(80)}КОНЕЦ-КОММЕНТАРИЯ`.slice(-1000);
  const items = Array.from({ length: 30 }, (_, i) => ({ id: `pos-${String(i + 1).padStart(2, '0')}`, qty: 20 }));
  const utm = Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].map((k) => [k, `${k}-${'x'.repeat(180)}`]));
  const accepted = submit(orders, body({ items, comment, utm }));
  assert.equal(accepted.status, 201);
  const text = outboxRows(db)[0].text;
  assert.ok(text.length > 3500, `текст задания длиннее одной части и не обрезан: ${text.length}`);
  assert.match(text, /Позиция 30 — .*× 20 — 60\s000\s₽/);
  assert.match(text, /КОНЕЦ-КОММЕНТАРИЯ/);
  // Вторая часть первой попытки упирается в 429: мост подтверждает «повторить», content ставит задание снова.
  const { bridge, sent, calls } = attachBridge(chat, (method, payload, index) => (index === 2 ? { status: 429, description: 'Too Many Requests' } : {}));
  await bridge.tick();
  assert.deepEqual([sent.length, calls.telegram], [1, 2], 'первая часть отправлена, вторая отклонена');
  assert.deepEqual([outboxRows(db)[0].status, orderRows(db)[0].status], ['pending', 'accepted']);
  db.prepare("UPDATE site_order_outbox SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE id=1").run();
  await bridge.tick();
  const parts = sent.map((m) => m.text);
  assert.deepEqual([parts.length, calls.telegram], [2, 3], 'при повторе дослана только вторая часть');
  assert.equal(new Set(parts).size, parts.length, 'ни одна часть не повторилась');
  const joined = parts.join('');
  assert.equal(joined, `Заявка с сайта\n${text}`, 'доставлен ровно полный текст, первая часть не продублирована');
  assert.match(joined, /Позиция 30 — /);
  assert.match(joined, /Комментарий: .*КОНЕЦ-КОММЕНТАРИЯ\n/);
  assert.match(joined, /Источник: utm_source=utm_source-x+, utm_medium=.*utm_term=utm_term-x+$/);
  assert.deepEqual([outboxRows(db)[0].status, orderRows(db)[0].status], ['sent', 'notified']);
  assert.deepEqual(JSON.parse(outboxRows(db)[0].external_ids).length, parts.length);
  await bridge.tick();
  assert.equal(sent.length, parts.length, 'подтверждённое задание не отправляется снова');
});

test('поздние подтверждения: uncertain/error не оживают от retryable, успех уточняет исход, прежняя попытка не перезаписывает текущую', () => {
  const { chat, orders, db } = setup();
  orders.setRecipient(SITE, RECIPIENT);
  const first = submit(orders, body());
  chat.bridge.pendingTelegram();
  chat.bridge.acknowledgeTelegram('order:1', { ok: false, uncertain: true, error: 'нет ответа' });
  assert.deepEqual(chat.bridge.acknowledgeTelegram('order:1', { ok: false, retryable: true, error: 'Telegram: 429' }), { ok: false, status: 'uncertain' });
  assert.deepEqual([outboxRows(db)[0].status, orderRows(db)[0].status, chat.bridge.pendingTelegram().length], ['uncertain', 'notify_uncertain', 0], 'uncertain не оживает');
  assert.deepEqual(chat.bridge.acknowledgeTelegram('order:1', { ok: false, retryable: false, error: 'позже отказ' }), { ok: false, status: 'uncertain' });
  assert.deepEqual(chat.bridge.acknowledgeTelegram('order:1', { ok: true, externalMessageIds: ['9'] }), { ok: true, status: 'sent' }, 'поздний успех уточняет доставку');
  assert.deepEqual([outboxRows(db)[0].status, orderRows(db)[0].status, JSON.parse(outboxRows(db)[0].external_ids)], ['sent', 'notified', ['9']]);
  // Прежняя попытка после явного повтора: её поздний ответ не трогает статус заявки по текущей попытке.
  const second = submit(orders, body());
  chat.bridge.pendingTelegram();
  chat.bridge.acknowledgeTelegram('order:2', { ok: false, retryable: false, error: 'отказ' });
  assert.equal(orderRows(db)[1].status, 'notify_failed');
  const again = orders.renotify(SITE, second.body.orderId);
  assert.equal(again.jobId, 'order:3');
  assert.deepEqual(chat.bridge.acknowledgeTelegram('order:2', { ok: false, retryable: true, error: 'поздний повтор' }), { ok: false, status: 'error' });
  assert.deepEqual([outboxRows(db)[1].status, orderRows(db)[1].status], ['error', 'notify_failed'], 'error не оживает и не ставит pending');
  assert.deepEqual(chat.bridge.acknowledgeTelegram('order:2', { ok: true, externalMessageIds: ['12'] }), { ok: true, status: 'sent' });
  assert.deepEqual([outboxRows(db)[1].status, orderRows(db)[1].status], ['sent', 'notify_failed'], 'поздний успех прежней попытки не меняет статус текущей');
  chat.bridge.pendingTelegram();
  chat.bridge.acknowledgeTelegram('order:3', { ok: true, externalMessageIds: ['13'] });
  assert.equal(orderRows(db)[1].status, 'notified');
  assert.equal(orders.listOrders(SITE).orders.find((o) => o.id === second.body.orderId).notify.jobId, 'order:3');
  assert.equal(first.status, 201);
});

test('смена получателя останавливает ещё не начатые задания прежнему; отправляемые не перенаправляются; явный повтор идёт новому', () => {
  const { chat, orders, db } = setup();
  orders.setRecipient(SITE, RECIPIENT);
  const inFlight = submit(orders, body());   // его задание уже в аренде у моста
  const waiting = submit(orders, body());    // его задание ещё не начато
  const [claimed] = chat.bridge.pendingTelegram();
  assert.equal(claimed.id, 'order:1');
  assert.equal(outboxRows(db)[1].status, 'pending');
  const changed = orders.setRecipient(SITE, { telegramChatId: '987654321', label: 'Новый менеджер' });
  assert.equal(changed.version, 2);
  const jobs = outboxRows(db);
  assert.deepEqual([jobs[0].status, jobs[0].chat_id], ['sending', '123456789'], 'уже отправляемое задание не перенаправляется');
  assert.deepEqual([jobs[1].status, jobs[1].error, jobs[1].chat_id], ['error', 'Получатель изменён до отправки', '123456789']);
  assert.equal(orderRows(db).find((o) => o.id === waiting.body.orderId).status, 'notify_failed', 'остановленное уведомление видно в заявке');
  assert.equal(chat.bridge.pendingTelegram().length, 0, 'прежнему получателю ничего не уходит');
  assert.equal(orders.recipientStatus(SITE).unnotifiedOrders, 1);
  const renotified = orders.renotify(SITE, waiting.body.orderId);
  assert.equal(renotified.previous.error, 'Получатель изменён до отправки');
  const [next] = chat.bridge.pendingTelegram();
  assert.deepEqual([next.id, next.chatId], [renotified.jobId, '987654321']);
  assert.equal(outboxRows(db).at(-1).recipient_version, 2);
  chat.bridge.acknowledgeTelegram(claimed.id, { ok: false, uncertain: true, error: 'обрыв' });
  assert.equal(orderRows(db).find((o) => o.id === inFlight.body.orderId).status, 'notify_uncertain');
  assert.equal(chat.bridge.pendingTelegram().length, 0);
});

test('список заявок: страницы по id без пропусков и повторов, старые заявки доступны, параметры проверяются', () => {
  const { orders, clock } = setup();
  const ids = [];
  for (let index = 0; index < 105; index++) {
    ids.push(submit(orders, body({ name: `Клиент ${index}` }), { ip: `203.0.113.${index % 250}` }).body.orderId);
    if (index % 4 === 3) clock.tick(11 * 60000);
  }
  const first = orders.listOrders(SITE, { limit: '100' });
  assert.equal(first.orders.length, 100);
  assert.equal(first.orders[0].id, ids[104]);
  assert.equal(first.nextCursor, first.orders[99].id);
  const second = orders.listOrders(SITE, { limit: 100, beforeId: first.nextCursor });
  assert.deepEqual([second.orders.length, second.nextCursor], [5, null]);
  const seen = [...first.orders, ...second.orders].map((o) => o.id);
  assert.deepEqual(seen, [...ids].sort((a, b) => b - a), 'все заявки, новые вперёд, без пропусков и повторов');
  assert.deepEqual(orders.listOrders(SITE, { limit: 10, beforeId: ids[2] }).orders.map((o) => o.id), [ids[1], ids[0]]);
  assert.equal(orders.listOrders(SITE, { limit: 10, beforeId: ids[0] }).orders.length, 0);
  assert.equal(orders.listOrders(SITE).orders.length, 50, 'по умолчанию 50');
  for (const params of [{ limit: 0 }, { limit: 101 }, { limit: 'x' }, { limit: 2.5 }, { beforeId: 'x' }, { beforeId: 0 }]) {
    assert.throws(() => orders.listOrders(SITE, params), (e) => e.status === 400, JSON.stringify(params));
  }
});

test('получатель: смена сбрасывает подтверждение и версию; тест засчитывается только текущему получателю', () => {
  const { chat, orders, db, clock } = setup();
  orders.setRecipient(SITE, RECIPIENT);
  const test1 = orders.testRecipient(SITE);
  assert.equal(test1.jobId, 'order:1');
  const [testJob] = chat.bridge.pendingTelegram();
  assert.deepEqual([testJob.id, testJob.chatId, testJob.text], ['order:1', '123456789', 'Проверка получателя заявок Palitra. Ответ не требуется.']);
  // Получатель изменён до подтверждения: версия 2, прежний тест ничего не доказывает.
  const changed = orders.setRecipient(SITE, { telegramChatId: '987654321', label: 'Дарья (новый)' });
  assert.deepEqual([changed.version, changed.verifiedAt, changed.lastTest], [2, null, null]);
  chat.bridge.acknowledgeTelegram('order:1', { ok: true, externalMessageIds: ['1'] });
  assert.equal(orders.recipientStatus(SITE).verifiedAt, null, 'ack старого теста не подтверждает нового получателя');
  // Тест текущему получателю: отказ фиксируется причиной, успех — временем подтверждения.
  orders.testRecipient(SITE);
  chat.bridge.pendingTelegram();
  chat.bridge.acknowledgeTelegram('order:2', { ok: false, retryable: false, error: "403 bot can't initiate conversation" });
  let status = orders.recipientStatus(SITE);
  assert.deepEqual([status.verifiedAt, status.lastTestError, status.lastTest.status], [null, "403 bot can't initiate conversation", 'error']);
  orders.testRecipient(SITE);
  chat.bridge.pendingTelegram();
  clock.tick(1000);
  chat.bridge.acknowledgeTelegram('order:3', { ok: true, externalMessageIds: ['2'] });
  status = orders.recipientStatus(SITE);
  assert.ok(status.verifiedAt);
  assert.deepEqual([status.lastTestError, status.lastTest.status], ['', 'sent']);
  // Смена подписи без смены чата не сбрасывает подтверждение; смена чата — сбрасывает.
  const relabel = orders.setRecipient(SITE, { telegramChatId: '987654321', label: 'Дарья Трафик' });
  assert.deepEqual([relabel.version, Boolean(relabel.verifiedAt), relabel.label], [2, true, 'Дарья Трафик']);
  const moved = orders.setRecipient(SITE, { telegramChatId: '555555555', label: 'Дарья Трафик' });
  assert.deepEqual([moved.version, moved.verifiedAt, moved.lastTestError], [3, null, '']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM site_order_outbox').get().n, 3, 'смена получателя сама ничего не отправляет');
});
