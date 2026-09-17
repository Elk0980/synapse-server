/* Вид «Заявки с сайта»: только владелец и только Palitra, фиксированный сайт в маршрутах,
   смена компании отбрасывает старые ответы, повтор уведомления — явное действие с предупреждением.
   node --test sites/synapse/cabinet/site-orders.test.cjs (jsdom из среды проекта) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const plain = (text) => String(text).replace(/[  ]/g, ' ');
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const recipient = (extra = {}) => ({ configured: false, telegramChatId: '', label: '', version: 0, verifiedAt: null, lastTestError: '', lastTest: null, unnotifiedOrders: 0, updatedAt: null, ...extra });
const order = (id, status, extra = {}) => ({ id, requestId: `r-${id}`, kind: 'cart', status, createdAt: '2026-09-17T10:00:00.000Z', notifiedAt: null,
  name: 'Анна <b>', phone: '+7 999 828-10-10', comment: 'к 12:00', items: [{ id: 'rose-1', title: 'Розы', qty: 2, price: 329000 }, { id: 'x', title: 'На заказ', qty: 1, price: null }],
  knownTotal: 658000, unknownCount: 1, page: '/price.html', utm: {}, notify: null, ...extra });

function fixture({ role = 'owner', company = 'palitra-love' } = {}) {
  const dom = new JSDOM('<section data-view="site-orders" id="view"></section>', { runScripts: 'outside-only' });
  const w = dom.window, d = w.document, views = {}, calls = [], pending = [];
  w.SbCabinet = { registerView: (name, view) => { views[name] = view; } };
  w.eval(fs.readFileSync(__dirname + '/site-orders.js', 'utf8'));
  const state = { company };
  const ctx = {
    identity: { role, csrfToken: 'csrf-1', companies: [{ id: 'palitra-love', name: 'Palitra' }, { id: 'alvi', name: 'АЛВИ' }] },
    get selectedProjectId() { return state.company; },
    escapeHTML: h,
    apiJson: (url, options = {}) => { const call = { url, options }; calls.push(call); return new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; if (options.signal) options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }); }
  };
  return { w, d, views, calls, ctx, state, container: d.getElementById('view'), render: () => views['site-orders'].render(d.getElementById('view'), ctx) };
}

test('владелец Palitra: список, получатель не настроен, предупреждение о заявках без уведомления; маршруты фиксированы на /content/palitra', async () => {
  const f = fixture();
  const rendering = f.render();
  assert.equal(f.calls[0].url, '/content/palitra/orders?limit=50');
  f.calls[0].resolve({ orders: [order(2, 'notify_uncertain', { notify: { status: 'uncertain', error: '' } }), order(1, 'accepted')], recipient: recipient({ unnotifiedOrders: 1 }) });
  await rendering; await tick();
  const text = f.container.textContent;
  assert.match(text, /Получатель не настроен/);
  assert.match(f.d.querySelector('[data-orders-warning]').textContent, /1 заявок сохранены без уведомления/);
  const cards = f.d.querySelectorAll('.site-order');
  assert.equal(cards.length, 2);
  assert.match(cards[0].textContent, /№2/); assert.match(cards[0].textContent, /Доставка не подтверждена/); assert.match(cards[0].textContent, /может создать дубль/);
  assert.match(cards[1].textContent, /уведомление не отправлялось/);
  assert.match(plain(cards[0].textContent), /Розы × 2 — 6 580 ₽/); assert.match(cards[0].textContent, /цена уточняется/);
  assert.equal(cards[0].querySelector('b').textContent, '№2');
  assert.equal(f.d.querySelector('.site-order__contact').innerHTML.includes('<b>'), false, 'имя экранировано');
  assert.equal(f.d.querySelector('[data-recipient-test]').hidden, true, 'без получателя проверка недоступна');
  f.w.close();
});

test('«Показать ещё»: страницы по beforeId, одна догрузка за раз, старые заявки после первой сотни доступны; смена компании отбрасывает догрузку', async () => {
  const f = fixture();
  const rendering = f.render();
  assert.equal(f.calls[0].url, '/content/palitra/orders?limit=50');
  f.calls[0].resolve({ orders: [order(120, 'notified'), order(101, 'notified')], nextCursor: 101, recipient: recipient({ configured: true }) });
  await rendering; await tick();
  const more = f.d.querySelector('[data-orders-more]');
  assert.equal(more.hidden, false);
  more.click(); more.click(); await tick();
  assert.equal(f.calls.length, 2, 'двойной клик — одна догрузка');
  assert.equal(f.calls[1].url, '/content/palitra/orders?limit=50&beforeId=101');
  assert.equal(more.disabled, true);
  f.calls[1].resolve({ orders: [order(100, 'notified'), order(3, 'accepted')], nextCursor: 3, recipient: recipient({ configured: true }) }); await tick();
  assert.deepEqual([...f.d.querySelectorAll('.site-order b')].map((b) => b.textContent), ['№120', '№101', '№100', '№3']);
  assert.equal(more.hidden, false); assert.equal(more.disabled, false);
  more.click(); await tick();
  assert.equal(f.calls[2].url, '/content/palitra/orders?limit=50&beforeId=3');
  f.calls[2].resolve({ orders: [order(1, 'accepted')], nextCursor: null, recipient: recipient({ configured: true }) }); await tick();
  assert.equal([...f.d.querySelectorAll('.site-order')].length, 5);
  assert.equal(more.hidden, true); assert.match(f.d.querySelector('[data-orders-more-status]').textContent, /все заявки/);
  // Догрузка во время смены компании: ответ отбрасывается, вид уже не Palitra.
  const g = fixture();
  const start = g.render();
  g.calls[0].resolve({ orders: [order(50, 'notified')], nextCursor: 50, recipient: recipient() }); await start; await tick();
  g.d.querySelector('[data-orders-more]').click(); await tick();
  g.state.company = 'alvi'; await g.render(); await tick();
  assert.equal(g.calls[1].options.signal.aborted, true);
  g.calls[1].resolve({ orders: [order(2, 'notified')], nextCursor: null, recipient: recipient() }); await tick();
  assert.doesNotMatch(g.container.textContent, /№2|№50/);
  f.w.close(); g.w.close();
});

test('смена компании закрывает вид и отбрасывает старый ответ; не-Palitra не делает запросов; не-владелец не видит данных', async () => {
  const f = fixture();
  const first = f.render();
  f.state.company = 'alvi';
  const second = f.render();
  await second; await tick();
  assert.equal(f.calls.length, 1, 'для АЛВИ запросов нет');
  assert.match(f.container.textContent, /только для Palitra/);
  assert.equal(f.calls[0].options.signal.aborted, true, 'старый запрос отменён');
  f.calls[0].resolve({ orders: [order(9, 'notified')], recipient: recipient() });
  await first; await tick();
  assert.doesNotMatch(f.container.textContent, /№9/, 'старый ответ не применён');
  const member = fixture({ role: 'member' });
  await member.render();
  assert.equal(member.calls.length, 0); assert.match(member.container.textContent, /только владельцу/);
  f.w.close(); member.w.close();
});

test('сохранение получателя: числовой ID, PUT с CSRF, ответ обновляет статус; неверный ввод не уходит на сервер', async () => {
  const f = fixture();
  const rendering = f.render();
  f.calls[0].resolve({ orders: [], recipient: recipient() });
  await rendering; await tick();
  const form = f.d.querySelector('[data-recipient-form]');
  form.elements.telegramChatId.value = '@daria'; form.dispatchEvent(new f.w.Event('submit', { cancelable: true })); await tick();
  assert.equal(f.calls.length, 1); assert.match(form.querySelector('[role=status]').textContent, /числовой Telegram ID/);
  form.elements.telegramChatId.value = '123456789'; form.elements.label.value = 'Дарья'; form.dispatchEvent(new f.w.Event('submit', { cancelable: true })); await tick();
  assert.equal(f.calls[1].url, '/content/palitra/order-recipient'); assert.equal(f.calls[1].options.method, 'PUT');
  assert.equal(f.calls[1].options.headers['X-CSRF-Token'], 'csrf-1');
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { telegramChatId: '123456789', label: 'Дарья' });
  assert.equal(form.querySelector('button[type=submit]').disabled, true, 'на время запроса форма заблокирована');
  f.calls[1].resolve(recipient({ configured: true, telegramChatId: '123456789', label: 'Дарья', version: 1 })); await tick();
  assert.match(f.container.textContent, /ещё не подтверждён проверкой/);
  assert.match(form.querySelector('[role=status]').textContent, /проверочное сообщение/);
  assert.equal(f.d.querySelector('[data-recipient-test]').hidden, false);
  assert.equal(form.querySelector('button[type=submit]').disabled, false);
  f.w.close();
});

test('проверка получателя: POST test, затем опрос статуса до результата; ошибка 403 «не начал диалог» показывается', async () => {
  const f = fixture();
  const rendering = f.render();
  f.calls[0].resolve({ orders: [], recipient: recipient({ configured: true, telegramChatId: '123456789', version: 1 }) });
  await rendering; await tick();
  const realSetTimeout = f.w.setTimeout;
  f.w.setTimeout = (fn) => realSetTimeout(fn, 1);
  const wait = () => new Promise((r) => realSetTimeout(r, 25));
  f.d.querySelector('[data-recipient-test]').click(); await wait();
  assert.equal(f.calls[1].url, '/content/palitra/order-recipient/test'); assert.equal(f.calls[1].options.method, 'POST');
  f.calls[1].resolve({ ok: true, jobId: 'order:5', recipient: recipient({ configured: true, telegramChatId: '123456789', version: 1, lastTest: { status: 'pending' } }) }); await wait();
  assert.match(f.container.textContent, /Проверочное сообщение отправляется/);
  assert.equal(f.calls[2].url, '/content/palitra/order-recipient');
  f.calls[2].resolve(recipient({ configured: true, telegramChatId: '123456789', version: 1, lastTestError: "403 — Forbidden: bot can't initiate conversation with a user" })); await wait();
  assert.match(f.container.textContent, /Проверка не прошла: 403/); assert.match(f.container.textContent, /\/start/);
  assert.equal(f.calls.length, 3, 'после результата опрос остановлен');
  f.w.close();
});

test('повтор уведомления: для uncertain — только после подтверждения, POST renotify с CSRF, затем список перечитывается; 409 объясняется', async () => {
  const f = fixture();
  const rendering = f.render();
  f.calls[0].resolve({ orders: [order(4, 'notify_uncertain', { notify: { status: 'uncertain' } }), order(3, 'notify_failed', { notify: { status: 'error', error: 'Telegram: 403' } })], recipient: recipient({ configured: true, telegramChatId: '1', version: 1 }) });
  await rendering; await tick();
  const buttons = f.d.querySelectorAll('.site-order__renotify');
  assert.equal(buttons.length, 2); assert.match(buttons[0].textContent, /возможен дубль/);
  f.w.confirm = () => false; buttons[0].click(); await tick();
  assert.equal(f.calls.length, 1, 'отказ в подтверждении — запроса нет');
  f.w.confirm = () => true; buttons[0].click(); await tick();
  assert.equal(f.calls[1].url, '/content/palitra/orders/4/renotify'); assert.equal(f.calls[1].options.method, 'POST'); assert.equal(f.calls[1].options.headers['X-CSRF-Token'], 'csrf-1');
  f.calls[1].resolve({ ok: true, jobId: 'order:6' }); await tick();
  assert.equal(f.calls[2].url, '/content/palitra/orders?limit=50', 'список перечитан');
  // Сервер отдаёт обе заявки: №4 уже в очереди, №3 по-прежнему не доставлена.
  f.calls[2].resolve({ orders: [order(4, 'accepted', { notify: { status: 'pending' } }), order(3, 'notify_failed', { notify: { status: 'error', error: 'Telegram: 403' } })], nextCursor: null, recipient: recipient({ configured: true }) }); await tick();
  const cards = [...f.d.querySelectorAll('.site-order')];
  assert.match(cards[0].textContent, /отправляется…/);
  assert.equal(cards[0].querySelector('.site-order__renotify'), null, 'пока задание в очереди — повтор недоступен');
  assert.ok(cards[1].querySelector('.site-order__renotify'), 'у недоставленной заявки повтор остаётся');
  f.w.close();
});

test('перечитывание после действия при >100 показанных: limit не выше 100, старые строки и курсор сохраняются, свежие статусы применяются', async () => {
  const f = fixture();
  const range = (from, to, status = 'notified') => { const list = []; for (let id = from; id >= to; id--) list.push(order(id, status)); return list; };
  const rendering = f.render();
  f.calls[0].resolve({ orders: range(150, 101), nextCursor: 101, recipient: recipient({ configured: true }) });
  await rendering; await tick();
  const more = f.d.querySelector('[data-orders-more]');
  more.click(); await tick();
  f.calls[1].resolve({ orders: range(100, 51), nextCursor: 51, recipient: recipient({ configured: true }) }); await tick();
  more.click(); await tick();
  f.calls[2].resolve({ orders: range(50, 1, 'accepted'), nextCursor: null, recipient: recipient({ configured: true }) }); await tick();
  assert.equal([...f.d.querySelectorAll('.site-order')].length, 150);
  assert.equal(more.hidden, true);
  // Обновление: показано 150, сервер отдаёт не больше 100 — старые 50 строк и «всё показано» не теряются.
  f.d.querySelector('[data-orders-refresh]').click(); await tick();
  assert.equal(f.calls[3].url, '/content/palitra/orders?limit=100', 'limit не превышает серверный максимум');
  f.calls[3].resolve({ orders: [order(150, 'notify_failed', { notify: { status: 'error', error: 'Telegram: 403' } }), ...range(149, 51)], nextCursor: 51, recipient: recipient({ configured: true }) }); await tick();
  const ids = [...f.d.querySelectorAll('.site-order b')].map((b) => b.textContent);
  assert.equal(ids.length, 150, 'ничего из показанного не потеряно');
  assert.equal(ids[0], '№150'); assert.equal(ids[99], '№51'); assert.equal(ids[100], '№50'); assert.equal(ids[149], '№1');
  assert.equal(new Set(ids).size, 150, 'без дублей');
  assert.match(f.d.querySelectorAll('.site-order')[0].textContent, /Уведомление не доставлено/, 'свежий статус применён');
  assert.equal(more.hidden, true, 'курсор «всё показано» сохранён, а не сброшен на 51');
  // Новая заявка сверху после следующего обновления: свежая страница вытесняет ровно одну старую строку в хвост, но не теряет её.
  f.d.querySelector('[data-orders-refresh]').click(); await tick();
  f.calls[4].resolve({ orders: [order(151, 'accepted'), ...range(150, 52)], nextCursor: 52, recipient: recipient({ configured: true }) }); await tick();
  const after = [...f.d.querySelectorAll('.site-order b')].map((b) => b.textContent);
  assert.equal(after.length, 151); assert.equal(after[0], '№151'); assert.equal(after[100], '№51'); assert.equal(after[150], '№1');
  assert.equal(more.hidden, true);
  f.w.close();
});

test('renotify показанной заявки за пределами первой сотни: ответ POST применяется к строке, хвост и курсор сохраняются', async () => {
  const f = fixture();
  const range = (from, to, status = 'notified') => { const list = []; for (let id = from; id >= to; id--) list.push(order(id, status)); return list; };
  const rendering = f.render();
  f.calls[0].resolve({ orders: range(150, 101), nextCursor: 101, recipient: recipient({ configured: true }) });
  await rendering; await tick();
  const more = f.d.querySelector('[data-orders-more]');
  more.click(); await tick();
  f.calls[1].resolve({ orders: range(100, 51), nextCursor: 51, recipient: recipient({ configured: true }) }); await tick();
  more.click(); await tick();
  f.calls[2].resolve({ orders: range(50, 1, 'notify_failed').map((o) => ({ ...o, notify: { status: 'error', error: 'Telegram: 403' } })), nextCursor: null, recipient: recipient({ configured: true }) }); await tick();
  const target = [...f.d.querySelectorAll('.site-order')].find((card) => card.querySelector('b').textContent === '№3');
  const button = target.querySelector('.site-order__renotify');
  assert.ok(button, 'у старой недоставленной заявки есть повтор');
  button.click(); await tick();
  assert.equal(f.calls[3].url, '/content/palitra/orders/3/renotify'); assert.equal(f.calls[3].options.method, 'POST');
  f.calls[3].resolve({ ok: true, jobId: 'order:900', previous: { status: 'error' }, order: order(3, 'accepted', { notify: { status: 'pending', jobId: 'order:900' } }) }); await tick();
  // Тихое перечитывание отдаёт только 100 новейших — №3 в него не попадает.
  assert.equal(f.calls[4].url, '/content/palitra/orders?limit=100');
  f.calls[4].resolve({ orders: range(150, 51), nextCursor: 51, recipient: recipient({ configured: true }) }); await tick();
  const cards = [...f.d.querySelectorAll('.site-order')];
  assert.equal(cards.length, 150, 'хвост сохранён');
  const updated = cards.find((card) => card.querySelector('b').textContent === '№3');
  assert.match(updated.textContent, /отправляется…/, 'строка №3 показывает уведомление в очереди');
  assert.equal(updated.querySelector('.site-order__renotify'), null, 'повторной отправки не предлагается');
  assert.ok(cards.find((card) => card.querySelector('b').textContent === '№2').querySelector('.site-order__renotify'), 'соседняя недоставленная не тронута');
  assert.equal(f.d.querySelector('[data-orders-more]').hidden, true, 'курсор «всё показано» сохранён');
  assert.equal(f.calls.length, 5, 'ровно один POST и одно перечитывание');
  f.w.close();
});
