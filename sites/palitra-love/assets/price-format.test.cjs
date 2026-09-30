const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const priceFormat = require('./price-format.js');
const order = require('./order.js');
const catalog = require('./catalog-live.js');

test('числовая цена: разделители тысяч, дроби и рубли имеют одну запись без потери копеек', () => {
  for (const [input, expected] of [
    [9270, '9 270 ₽'], ['9270', '9 270 ₽'], ['9 270 руб.', '9 270 ₽'], ['9.270', '9 270 ₽'],
    ['9\u00a0270 р', '9 270 ₽'], ['9\u202f270 ₽', '9 270 ₽'], ['1.234.567 руб.', '1 234 567 ₽'],
    ['9.27', '9,27 ₽'], ['9,2', '9,20 ₽'], ['9 270,05 руб.', '9 270,05 ₽'], ['9.270,50', '9 270,50 ₽'],
    ['9270.00', '9 270 ₽'], ['0', '0 ₽'], ['0,05', '0,05 ₽'], ['0009270,50', '9 270,50 ₽'],
    ['900719925474099123 руб.', '900 719 925 474 099 123 ₽']
  ]) assert.equal(priceFormat.format(input), expected, String(input));
  for (const [value, expected] of [[927000, '9 270 ₽'], [927050, '9 270,50 ₽'], [5, '0,05 ₽'], [0, '0 ₽']]) assert.equal(priceFormat.formatRub(value), expected);
  for (const value of [null, undefined, NaN, Infinity, -1, 1.5]) assert.equal(priceFormat.formatRub(value), 'Цена уточняется');
});

test('условия и единицы сохраняются, диапазон/неоднозначная цена/произвольный текст не превращаются в сумму', () => {
  assert.equal(priceFormat.format('от 9270руб./шт.'), 'от 9 270 ₽ /шт.');
  assert.equal(priceFormat.format('От 9.270 руб. / набор'), 'От 9 270 ₽ / набор');
  assert.equal(priceFormat.format('9270 /м²'), '9 270 ₽ /м²');
  assert.equal(priceFormat.format('9270,5 руб. /шт.'), '9 270,50 ₽ /шт.');
  for (const value of ['9270–12000 руб.', 'от 9270 до 12000 ₽', '9,270', '9 27', '9.27.0', '1 234 56',
    '9270 руб. при заказе от 5 шт.', 'по запросу', 'Стоимость обсуждается', '2 × 9270', '-9270', '9e3',
    '9270 / 10шт.', 'Цена <b>9270</b>', '9270 $']) assert.equal(priceFormat.format(value), value);
  for (const value of ['', '  ', null, undefined]) assert.equal(priceFormat.format(value), '');
});

test('карточка, fallback и корзина показывают одну запись; исходник, неизвестный итог и payload неизменны', async () => {
  const dom = new JSDOM('<body><div id="cards"></div><aside data-cart hidden><button data-cart-close>Закрыть</button><div data-cart-items></div><p data-cart-summary></p><span data-total></span></aside></body>', { url: 'https://palitra-love.ru/catalog', runScripts: 'outside-only' });
  try {
    const w = dom.window, data = { categories: [{ id: 'shary', items: [
      { id: 'a', title: 'А', price: '9 270 руб.' }, { id: 'b', title: 'Б', price: '9.270' },
      { id: 'c', title: 'В', price: 'от 9270 руб./шт.' }, { id: 'd', title: 'Г', price: '9270–12000 руб.' },
      { id: 'e', title: 'Д', price: '' }, { id: 'f', title: 'Е', price: '<img src=x onerror=alert(1)>' }
    ] }] }, before = JSON.stringify(data);
    for (const script of ['assets/price-format.js', 'price-render.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', script), 'utf8'));
    w.PalitraPrice.load = async () => data;
    const cards = w.document.getElementById('cards');
    cards.innerHTML = data.categories[0].items.map(item => w.PalitraPrice.productCard(item)).join('');
    const cart = order.mount(w); await cart.loadIndex();
    for (const item of data.categories[0].items) cart.cart.add(item.id, 2);
    cart.renderItems();
    for (const item of data.categories[0].items) {
      const expected = priceFormat.format(item.price) || 'Цена уточняется';
      assert.equal(w.document.getElementById(item.id).querySelector('.price').textContent, expected);
      const fallback = w.document.createElement('div'); fallback.innerHTML = catalog.card(item);
      assert.equal(fallback.querySelector('.price').textContent, expected);
      assert.ok(w.document.querySelector(`[data-cart-line="${item.id}"] .cart-line__info span`).textContent.startsWith(expected));
    }
    assert.equal(w.document.querySelector('[data-total]').textContent, '18 540 ₽', 'условные и dotted-строки остаются вне расчёта по прежнему контракту');
    assert.match(w.document.querySelector('[data-cart-summary]').textContent, /5 поз. — цена уточняется менеджером/);
    assert.equal(w.document.querySelectorAll('img[onerror]').length, 0, 'ценовой текст экранирован');
    assert.equal(JSON.stringify(data), before);
    assert.equal(order.parsePrice('9.270'), null); assert.equal(order.parsePrice('от 9270'), null);
    const payload = order.buildPayload('cart', { name: 'Покупатель', phone: '+79991234567', consent: true }, cart.cart.list(), w.location);
    assert.deepEqual(payload.items, data.categories[0].items.map(item => ({ id: item.id, qty: 2 })));
    assert.equal(Object.hasOwn(payload, 'knownTotal'), false);
    const editor = w.PalitraPrice.productCard(data.categories[0].items[0], { editor: true, starHtml: () => '', editHtml: () => '' });
    assert.match(editor, /9 270 руб\./, 'редактор оставляет строку как сохранена');
  } finally { dom.window.close(); }
});

test('недоступный форматтер не ломает браузерный рендер или оформление', async () => {
  const dom = new JSDOM('<body></body>', { url: 'https://palitra-love.ru/', runScripts: 'outside-only' });
  try {
    for (const script of ['price-render.js', 'assets/catalog-live.js', 'assets/order.js']) assert.doesNotThrow(() => dom.window.eval(fs.readFileSync(path.join(__dirname, '..', script), 'utf8')));
    assert.match(dom.window.PalitraPrice.productCard({ id: 'a', title: 'А', price: '9270 руб.' }), /9270 руб\./);
  } finally { dom.window.close(); }
});
