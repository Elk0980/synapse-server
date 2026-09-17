/* Корзина и заявка менеджеру: только id/qty в хранилище, показ по live-прайсу, стабильный requestId,
   честный успех только после ответа сервера, ошибки сохраняют корзину и поля.
   node --test sites/palitra-love/assets/order.test.cjs (jsdom из среды проекта) */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const order = require('./order.js');

const PRICE = { categories: [{ id: 'bukety', title: 'Букеты', items: [
  { id: 'rose-1', title: 'Розы', price: '3 290 руб.' },
  { id: 'unknown-1', title: 'Композиция на заказ', price: '' }
] }] };
const memory = () => { const map = new Map(); return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), dump: () => Object.fromEntries(map) }; };
const location = { href: 'https://palitra-love.synapsebusiness.ru/price.html?utm_source=vk&x=1', origin: 'https://palitra-love.synapsebusiness.ru', pathname: '/price.html' };
const fields = { name: 'Анна', phone: '8 999 828-10-10', comment: 'к 12:00', consent: true };
// toLocaleString('ru-RU') разделяет тысячи узким неразрывным пробелом — сравниваем с обычным.
const plain = (text) => String(text).replace(/[  ]/g, ' ');
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

test('корзина хранит только id и количество, лимиты соблюдаются, удалённая позиция помечается, а не пропадает', () => {
  const storage = memory();
  const cart = order.createCart(storage);
  assert.equal(cart.add('rose-1'), true);
  cart.add('rose-1'); cart.add('unknown-1', 2); cart.add('gone-9');
  assert.deepEqual(cart.list(), [{ id: 'rose-1', qty: 2 }, { id: 'unknown-1', qty: 2 }, { id: 'gone-9', qty: 1 }]);
  assert.deepEqual(JSON.parse(storage.getItem(order.CART_KEY)), { items: cart.list() });
  cart.setQty('rose-1', 99); assert.equal(cart.list()[0].qty, 20);
  cart.setQty('unknown-1', 0); assert.equal(cart.list().some((i) => i.id === 'unknown-1'), false);
  assert.equal(cart.add('<bad id>'), false);
  const view = order.describe(cart.list(), order.priceIndex(PRICE));
  assert.equal(view.knownTotal, 3290 * 100 * 20);
  assert.deepEqual(view.lines.map((l) => [l.title, l.missing]), [['Розы', false], ['gone-9', true]]);
  assert.equal(view.missingCount, 1);
  assert.equal(plain(order.formatRub(view.knownTotal)), '65 800 ₽');
  assert.equal(order.describe([{ id: 'unknown-1', qty: 1 }], order.priceIndex(PRICE)).unknownCount, 1);
  assert.equal(order.parsePrice('0'), 0); assert.equal(order.parsePrice('от 2 500'), null);
});

test('payload по контракту: нормализация, utm, honeypot, без клиентских цен; ошибки полей', async () => {
  const payload = order.buildPayload('cart', { ...fields, website: '' }, [{ id: 'rose-1', qty: 2, price: 1 }], location);
  assert.deepEqual(payload, { kind: 'cart', name: 'Анна', phone: '8 999 828-10-10', comment: 'к 12:00', consent: true,
    items: [{ id: 'rose-1', qty: 2 }], page: 'https://palitra-love.synapsebusiness.ru/price.html', utm: { utm_source: 'vk' }, website: '' });
  const request = order.buildPayload('request', { ...fields, occasion: 'Выписка', date: '2026-09-20' }, [], location);
  assert.equal(request.kind, 'request'); assert.deepEqual(request.items, []); assert.equal(request.occasion, 'Выписка');
  assert.throws(() => order.buildPayload('cart', { ...fields, consent: false }, [{ id: 'rose-1', qty: 1 }], location), (e) => e.field === 'consent');
  assert.throws(() => order.buildPayload('cart', { ...fields, phone: '12' }, [{ id: 'rose-1', qty: 1 }], location), (e) => e.field === 'phone');
  assert.throws(() => order.buildPayload('cart', fields, [], location), (e) => e.field === 'items');
  // requestId стабилен для того же смысла и меняется при изменении контактов/состава; контакты в хранилище не попадают.
  const session = memory();
  const cryptoApi = require('node:crypto').webcrypto;
  const fp1 = await order.fingerprint(payload, cryptoApi.subtle);
  const id1 = order.requestIdFor('cart', fp1, session, cryptoApi);
  assert.equal(order.requestIdFor('cart', await order.fingerprint({ ...payload, phone: '+7 (999) 828-10-10', page: 'x' }, cryptoApi.subtle), session, cryptoApi), id1, 'тот же телефон в другой записи и другая страница — тот же requestId');
  const id2 = order.requestIdFor('cart', await order.fingerprint({ ...payload, items: [{ id: 'rose-1', qty: 3 }] }, cryptoApi.subtle), session, cryptoApi);
  assert.notEqual(id2, id1);
  assert.match(id2, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(session.dump()).includes('828'), 'номер телефона не хранится');
});

test('requestId без sessionStorage: память страницы даёт тот же id для одинакового повтора, сброс после успеха/изменения', async () => {
  const cryptoApi = require('node:crypto').webcrypto;
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  order.forgetRequest('cart', null);
  const id1 = order.requestIdFor('cart', 'fp-a', broken, cryptoApi);
  assert.equal(order.requestIdFor('cart', 'fp-a', broken, cryptoApi), id1, 'бросающее хранилище — тот же id');
  assert.equal(order.requestIdFor('cart', 'fp-a', null, cryptoApi), id1, 'storage=null — тот же id');
  assert.notEqual(order.requestIdFor('cart', 'fp-b', null, cryptoApi), id1, 'другой смысл — новый id');
  order.forgetRequest('cart', broken);
  assert.notEqual(order.requestIdFor('cart', 'fp-b', null, cryptoApi), order.requestIdFor('request', 'fp-b', null, cryptoApi), 'виды заявок независимы');
  const after = order.requestIdFor('cart', 'fp-b', null, cryptoApi);
  order.forgetRequest('cart', null);
  assert.notEqual(order.requestIdFor('cart', 'fp-b', null, cryptoApi), after, 'после успеха новый id даже для того же смысла');
  order.forgetRequest('cart', null); order.forgetRequest('request', null);
});

/* Страница с корзиной как на сайте: карточка с «В корзину», панель, форма; fetch подменён. */
function page({ responses = [], price = PRICE, priceLoad } = {}) {
  const html = `<!doctype html><body data-page="price"><header><button class="cart-button" data-cart-open>Корзина · <span data-cart-count>0</span></button></header>
    <article class="pc price-card"><div class="product-footer"><div class="product-purchase"><p class="price">3 290 руб.</p><button class="button product-add" type="button" data-add data-id="rose-1" data-title="Розы">В корзину</button></div></div></article>
    <button type="button" data-add data-id="gone-9" data-title="Нет">В корзину</button>
    <aside class="cart" data-cart hidden aria-hidden="true"><button type="button" data-cart-close>Закрыть</button><div data-cart-items></div><p data-cart-summary></p><span data-total></span>
      <form data-order-form="cart"><input name="name"><input name="phone" type="tel"><textarea name="comment"></textarea><input type="checkbox" name="consent"><button>Отправить</button></form></aside>
    <section id="zayavka"><form><input name="name"><input name="phone"><select name="occasion"><option>Выписка</option></select><input name="date"><textarea name="comment"></textarea><input type="checkbox" name="consent"><button>Оставить заявку</button></form></section></body>`;
  const dom = new JSDOM(html, { url: location.href, runScripts: 'outside-only' });
  const win = dom.window;
  const calls = [];
  win.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return { status: next.status, json: async () => next.body };
  };
  win.PalitraPrice = { load: priceLoad || (async () => price) };
  Object.defineProperty(win, 'crypto', { value: require('node:crypto').webcrypto, configurable: true });
  order.forgetRequest('cart', null); order.forgetRequest('request', null);
  const api = order.mount(win);
  const form = win.document.querySelector('[data-order-form="cart"]');
  const fill = (values = fields) => { form.elements.name.value = values.name; form.elements.phone.value = values.phone; form.elements.comment.value = values.comment; form.elements.consent.checked = values.consent; };
  const submit = () => form.dispatchEvent(new win.Event('submit', { cancelable: true }));
  const status = () => form.querySelector('[data-order-status]');
  return { win, doc: win.document, api, calls, form, fill, submit, status, close: () => win.close() };
}

test('добавление в корзину, панель, счётчик; отправка — один запрос без cookie, успех только по 201 с orderId, корзина очищается', async () => {
  const p = page({ responses: [{ status: 201, body: { ok: true, orderId: 12, requestId: 'x', status: 'accepted', message: 'Заявка №12 принята. Менеджер свяжется с вами, подтвердит состав и стоимость, согласует оплату и доставку.' } }] });
  try {
    const add = p.doc.querySelector('[data-add][data-id="rose-1"]');
    add.click(); add.click();
    assert.equal(p.doc.querySelector('[data-cart-count]').textContent, '2');
    assert.equal(add.textContent, 'В корзине');
    p.doc.querySelector('[data-cart-open]').click(); await tick();
    const panel = p.doc.querySelector('[data-cart]');
    assert.equal(panel.hidden, false);
    assert.match(panel.querySelector('[data-cart-items]').textContent, /Розы/);
    assert.match(plain(panel.querySelector('[data-cart-items]').textContent), /3 290 ₽ × 2 = 6 580 ₽/);
    assert.equal(plain(panel.querySelector('[data-total]').textContent), '6 580 ₽');
    assert.ok(!JSON.stringify(p.win.localStorage).includes('Розы'), 'названия в localStorage не хранятся');
    p.fill(); p.submit(); p.submit(); await tick();
    assert.equal(p.calls.length, 1, 'двойной клик — один запрос');
    assert.equal(p.calls[0].url, '/api/orders');
    assert.equal(p.calls[0].options.credentials, 'omit');
    assert.deepEqual(p.calls[0].body.items, [{ id: 'rose-1', qty: 2 }]);
    assert.equal(p.calls[0].body.kind, 'cart'); assert.equal(p.calls[0].body.website, '');
    assert.match(p.calls[0].body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(p.status().dataset.state, 'success');
    assert.match(p.status().textContent, /Заявка №12 принята/);
    assert.doesNotMatch(p.status().textContent, /прочитал|доставлено менеджеру/);
    assert.equal(p.api.cart.count(), 0);
    assert.equal(p.form.getAttribute('aria-busy'), 'false');
    assert.equal(p.form.querySelector('button').disabled, false);
  } finally { p.close(); }
});

test('сеть/429/503 сохраняют корзину и поля, кнопка снова активна; повтор идёт с тем же requestId; 200 duplicate — успех', async () => {
  const p = page({ responses: [new TypeError('network'), { status: 429, body: { ok: false, code: 'RATE_LIMITED' } }, { status: 503, body: { ok: false, code: 'ORDERS_UNAVAILABLE' } }, { status: 200, body: { ok: true, duplicate: true, orderId: 7, status: 'accepted' } }] });
  try {
    p.doc.querySelector('[data-add][data-id="rose-1"]').click();
    p.fill(); p.submit(); await tick();
    assert.equal(p.status().dataset.state, 'error'); assert.match(p.status().textContent, /нет связи/);
    assert.equal(p.api.cart.count(), 1); assert.equal(p.form.elements.name.value, 'Анна'); assert.equal(p.form.querySelector('button').disabled, false);
    p.submit(); await tick(); assert.match(p.status().textContent, /Слишком много заявок/);
    p.submit(); await tick(); assert.match(p.status().textContent, /временно недоступен/);
    p.submit(); await tick();
    assert.equal(p.calls.length, 4);
    assert.equal(new Set(p.calls.map((c) => c.body.requestId)).size, 1, 'все повторы — один requestId');
    assert.equal(p.status().dataset.state, 'success'); assert.match(p.status().textContent, /№7/);
    assert.equal(p.api.cart.count(), 0);
  } finally { p.close(); }
});

test('изменение контактов даёт новый requestId; 409 REQUEST_MISMATCH → новый id на следующей попытке; ITEM_UNKNOWN → корзина цела', async () => {
  const p = page({ responses: [new TypeError('network'), { status: 409, body: { ok: false, code: 'REQUEST_MISMATCH' } }, { status: 400, body: { ok: false, code: 'ITEM_UNKNOWN', itemId: 'rose-1' } }] });
  try {
    p.doc.querySelector('[data-add][data-id="rose-1"]').click();
    p.fill(); p.submit(); await tick();
    p.fill({ ...fields, phone: '+7 999 000-00-00' }); p.submit(); await tick();
    assert.notEqual(p.calls[1].body.requestId, p.calls[0].body.requestId, 'другой телефон — другой requestId');
    assert.match(p.status().textContent, /изменился/);
    p.submit(); await tick();
    assert.notEqual(p.calls[2].body.requestId, p.calls[1].body.requestId, 'после 409 id обновлён');
    assert.match(p.status().textContent, /недоступна/);
    assert.equal(p.api.cart.count(), 1, 'корзина сохранена');
  } finally { p.close(); }
});

test('зависшее тело ответа: таймаут покрывает чтение, форма разблокируется; сбой подготовки (digest) тоже снимает блокировку', async () => {
  const stuck = () => ({ status: 201, json: () => new Promise(() => {}) });
  const p = page({ responses: [stuck, { status: 201, body: { ok: true, orderId: 5, status: 'accepted' } }] });
  try {
    p.doc.querySelector('[data-add][data-id="rose-1"]').click();
    p.fill();
    const realSend = order.send;
    // Таймаут маленький только для этого сценария: send читается модулем напрямую, поэтому проверяем через options.
    const sendPromise = order.send(p.win, { kind: 'cart' }, { timeoutMs: 30 });
    await assert.rejects(sendPromise, (error) => error.code === 'NETWORK');
    assert.equal(p.calls.length, 1);
    // Через форму: подготовка падает (digest бросает) → ошибка показана, форма и кнопка снова активны, запроса нет.
    const subtle = p.win.crypto.subtle;
    Object.defineProperty(p.win, 'crypto', { value: { subtle: { digest: async () => { throw new Error('digest failed'); } }, randomUUID: () => '00000000-0000-4000-8000-000000000000' }, configurable: true });
    p.submit(); await tick();
    assert.equal(p.calls.length, 1, 'запроса не было');
    assert.equal(p.status().dataset.state, 'error');
    assert.equal(p.form.getAttribute('aria-busy'), 'false');
    assert.equal(p.form.querySelector('button').disabled, false);
    assert.equal(p.api.cart.count(), 1);
    Object.defineProperty(p.win, 'crypto', { value: { subtle, randomUUID: () => '11111111-1111-4111-8111-111111111111' }, configurable: true });
    p.submit(); await tick();
    assert.equal(p.calls.length, 2); assert.equal(p.status().dataset.state, 'success');
    assert.ok(realSend === order.send);
  } finally { p.close(); }
});

test('изменение корзины во время отправки: после успеха вычитается только отправленный снимок, новое остаётся', async () => {
  let release;
  const p = page({ responses: [() => new Promise((resolve) => { release = () => resolve({ status: 201, json: async () => ({ ok: true, orderId: 8, status: 'accepted' }) }); })] });
  try {
    p.doc.querySelector('[data-add][data-id="rose-1"]').click();
    p.fill(); p.submit(); await tick();
    assert.equal(p.form.getAttribute('aria-busy'), 'true');
    // Пока запрос идёт, клиент добавляет ещё одну «Розы» и новую позицию.
    p.doc.querySelector('[data-add][data-id="rose-1"]').click();
    p.doc.querySelector('[data-add][data-id="gone-9"]').click();
    assert.equal(p.api.cart.count(), 3);
    release(); await tick();
    assert.equal(p.status().dataset.state, 'success');
    assert.deepEqual(p.calls[0].body.items, [{ id: 'rose-1', qty: 1 }], 'ушёл снимок на момент отправки');
    assert.deepEqual(p.api.cart.list(), [{ id: 'rose-1', qty: 1 }, { id: 'gone-9', qty: 1 }], 'добавленное во время отправки не потеряно');
  } finally { p.close(); }
});

test('прайс ещё грузится: позиции не объявляются удалёнными, отправка ждёт; ошибка загрузки → retry; после загрузки — названия и цены', async () => {
  let resolveLoad, attempts = 0;
  const loads = [];
  const priceLoad = () => new Promise((resolve) => { attempts += 1; loads.push(resolve); resolveLoad = resolve; });
  const p = page({ responses: [{ status: 201, body: { ok: true, orderId: 2, status: 'accepted' } }], priceLoad });
  try {
    p.doc.querySelector('[data-add][data-id="rose-1"]').click();
    p.doc.querySelector('[data-cart-open]').click(); await tick();
    const panel = p.doc.querySelector('[data-cart]');
    assert.match(panel.querySelector('[data-cart-items]').textContent, /Загружаем прайс/);
    assert.equal(panel.querySelector('.cart-line--missing'), null, 'до загрузки ничего не помечено удалённым');
    assert.equal(panel.querySelector('[data-total]').textContent, '—');
    p.fill(); p.submit(); await tick();
    assert.equal(p.calls.length, 0, 'без прайса заявка не уходит');
    assert.match(p.status().textContent, /Загружаем прайс/);
    assert.equal(p.form.getAttribute('aria-busy'), 'true', 'ждём прайс, форма занята');
    assert.equal(attempts, 1, 'ожидание использует уже идущую загрузку');
    resolveLoad(null); await tick();
    assert.equal(p.calls.length, 0, 'прайс не загрузился — заявка не ушла');
    assert.match(p.status().textContent, /Не удалось загрузить прайс/);
    assert.equal(p.form.querySelector('button').disabled, false, 'форма разблокирована');
    assert.match(panel.querySelector('[data-cart-summary]').textContent, /Не удалось загрузить прайс/);
    assert.ok(panel.querySelector('[data-price-retry]'), 'кнопка повтора');
    assert.equal(panel.querySelector('.cart-line--missing'), null);
    panel.querySelector('[data-price-retry]').click(); await tick();
    assert.equal(attempts, 2, 'повтор запросил прайс заново');
    resolveLoad(PRICE); await tick();
    assert.match(plain(panel.querySelector('[data-cart-items]').textContent), /Розы3 290 ₽ × 1/);
    assert.equal(panel.querySelector('[data-price-retry]'), null);
    p.submit(); await tick();
    assert.equal(p.calls.length, 1); assert.equal(p.status().dataset.state, 'success');
  } finally { p.close(); }
});

test('без согласия и с пустой корзиной запроса нет; недоступная позиция блокирует отправку до удаления; форма повода шлёт kind=request', async () => {
  const p = page({ responses: [{ status: 201, body: { ok: true, orderId: 3, status: 'accepted' } }] });
  try {
    p.doc.querySelector('[data-add][data-id="rose-1"]').click();
    p.fill({ ...fields, consent: false }); p.submit(); await tick();
    assert.equal(p.calls.length, 0); assert.match(p.status().textContent, /согласие/);
    p.api.cart.clear(); p.fill(); p.submit(); await tick();
    assert.equal(p.calls.length, 0); assert.match(p.status().textContent, /пуста/);
    p.doc.querySelector('[data-add][data-id="gone-9"]').click();
    p.doc.querySelector('[data-cart-open]').click(); await tick();
    assert.match(p.doc.querySelector('.cart-line--missing').textContent, /больше нет в прайсе/);
    p.fill(); p.submit(); await tick();
    assert.equal(p.calls.length, 0); assert.match(p.status().textContent, /недоступна/);
    p.doc.querySelector('.cart-line--missing [data-remove]').click();
    assert.equal(p.api.cart.count(), 0);
    const request = p.doc.querySelector('#zayavka form');
    request.elements.name.value = 'Иван'; request.elements.phone.value = '+7 999 828 10 10'; request.elements.occasion.value = 'Выписка'; request.elements.date.value = '2026-09-20'; request.elements.consent.checked = true;
    request.dispatchEvent(new p.win.Event('submit', { cancelable: true })); await tick();
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].body.kind, 'request'); assert.deepEqual(p.calls[0].body.items, []); assert.equal(p.calls[0].body.occasion, 'Выписка');
    assert.equal(request.querySelector('[data-order-status]').dataset.state, 'success');
    // Escape закрывает панель; ловушка для ботов есть и скрыта от пользователя.
    p.doc.dispatchEvent(new p.win.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(p.doc.querySelector('[data-cart]').hidden, true);
    assert.equal(p.form.querySelector('[name=website]').getAttribute('aria-hidden'), 'true');
  } finally { p.close(); }
});
