const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const order = require('./assets/order.js');
const catalog = require('./assets/catalog-live.js');
const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const tick = async () => {for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));};
const PRICE = {categories: [
  {id: 'bukety', title: 'Букеты', items: [{id: 'flower-1', title: 'Букет', price: '1000', photo: '/assets/img/hrizantema.jpg'}]},
  {id: 'shary', title: 'Шары', items: [{id: 'balloon-1', title: 'Набор шаров', desc: 'Подробный состав', note: 'Надпись согласуем', price: '2000', photo: '/assets/img/shary-detkam.jpg', gallery: ['/assets/img/shary-dr-detok.jpg']}]},
  {id: 'mixed', title: 'Смешанная подборка', items: [{id: 'flower-2', title: 'Композиция', price: '3000', photo: '/assets/img/gortenzii.jpg'}]}
]};
function page(url = '/catalog') {
  const dom = new JSDOM(read(url === '/' ? 'index.html' : 'catalog/index.html'), {url: 'https://palitra-love.ru' + url, runScripts: 'outside-only'});
  dom.window.eval(read('config.js'));
  dom.window.eval(read('assets/app.js'));
  dom.window.eval(read('price-render.js'));
  dom.window.PalitraPrice.load = async () => PRICE;
  return dom;
}

test('скрытие цветов обратимо, не мутирует прайс, редактор сохраняет все товары; каталог и схема согласованы', async () => {
  const original = JSON.stringify(PRICE), dom = page(), w = dom.window, p = w.PalitraPrice;
  assert.equal(w.PALITRA_CONFIG.FLOWERS_VISIBLE, false);
  assert.deepEqual(Array.from(p.publicData(PRICE).categories.flatMap(x => x.items), x => x.id), ['balloon-1']);
  assert.equal(p.publicData(PRICE, {editor: true}), PRICE);
  assert.doesNotMatch(p.renderNav(PRICE), /Букеты/);
  assert.match(p.renderNav(PRICE, {editor: true}), /Букеты/);
  assert.doesNotMatch(p.renderSections(PRICE), /flower-1|flower-2/);
  await catalog.mount(w);
  assert.deepEqual([...w.document.querySelectorAll('[data-products] [data-add]')].map(x => x.dataset.id), ['balloon-1']);
  assert.equal(JSON.parse(w.document.querySelector('#palitra-catalog-schema').textContent).numberOfItems, 1);
  assert.equal(w.document.querySelector('[data-filter="bukety"]').hidden, true);
  w.PALITRA_CONFIG.FLOWERS_VISIBLE = true;
  assert.equal(p.publicData(PRICE), PRICE);
  assert.match(p.renderSections(PRICE), /flower-1/);
  assert.equal(JSON.stringify(PRICE), original, 'данные и исходные фотографии не изменены');
  dom.window.close();
});

test('прямой адрес скрытой категории не показывает товары; старые товары корзины не удаляются молча', async () => {
  const dom = page('/catalog/bukety'), w = dom.window;
  await catalog.mount(w);
  assert.equal(w.document.querySelectorAll('[data-products] [data-add]').length, 0);
  assert.match(w.document.querySelector('h1').textContent, /пока скрыт/);
  w.localStorage.setItem(order.CART_KEY, JSON.stringify({items: [{id: 'flower-1', qty: 1}]}));
  const api = order.mount(w); await api.loadIndex(); api.renderItems();
  assert.equal(api.cart.list()[0].id, 'flower-1');
  assert.ok(w.document.querySelector('.cart-line--missing'));
  dom.window.close();
});

test('подробности скрыты в сетке, открываются диалогом с фото и ценой; покупка и возврат фокуса работают', async () => {
  const dom = page(), w = dom.window; await catalog.mount(w);
  const api = order.mount(w), card = w.document.querySelector('[data-products] .product-card');
  const details = card.querySelector('details'), summary = details.querySelector('summary');
  assert.equal(details.open, false);
  assert.ok(details.querySelector('.price-card__description'));
  card.querySelector('[data-gallery-prev]').disabled = false;
  card.querySelector('[data-gallery-next]').disabled = true;
  summary.click();
  const dialog = w.document.querySelector('.product-dialog');
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('#product-dialog-title').textContent, 'Набор шаров');
  assert.equal(dialog.querySelectorAll('[data-gallery-track] img').length, 2);
  assert.equal(dialog.querySelector('[data-gallery-prev]').disabled, true);
  assert.equal(dialog.querySelector('[data-gallery-next]').disabled, false);
  assert.equal(dialog.querySelector('.price').textContent, '2000');
  dialog.querySelector('[data-add]').click();
  assert.deepEqual(api.cart.list(), [{id: 'balloon-1', qty: 1}]);
  dialog.querySelector('[data-cart-open]').click();
  assert.equal(dialog.open, false, 'оформление снимает модальность товара');
  assert.equal(w.document.querySelector('[data-cart]').hidden, false, 'корзина открывается после закрытия товара');
  assert.equal(w.document.body.classList.contains('product-dialog-open'), false);
  assert.ok(w.document.activeElement.hasAttribute('data-cart-close'), 'фокус доступен внутри корзины');
  api.closeCart(); summary.click();
  dialog.querySelector('[data-product-close]').click();
  assert.equal(dialog.open, false); assert.equal(w.document.activeElement, summary);
  summary.click(); dialog.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  assert.equal(dialog.open, false);
  dom.window.close();
});

const location = {href: 'https://palitra-love.ru/catalog', origin: 'https://palitra-love.ru', pathname: '/catalog'};
const fields = {name: 'Тест', contactChannel: 'phone', contact: '+7 999 111-22-33', consent: true,
  deliveryAddress: 'Тестовый адрес', deliveryDate: '2026-10-01', deliveryInterval: 'По согласованию', comment: 'Надпись'};

test('новый контракт: четыре канала, условный Telegram и доставка; старый телефон остаётся совместимым', () => {
  for (const [contactChannel, contact] of [['phone', fields.contact], ['whatsapp', fields.contact], ['telegram', '@example_test'], ['max', 'https://max.ru/example_test']]) {
    const request = order.buildPayload('request', {name: 'Тест', contactChannel, contact, consent: true}, [], location);
    assert.equal(request.contactChannel, contactChannel); assert.equal(request.contact, contact);
    assert.equal(request.phone, undefined); assert.equal(request.deliveryDate, undefined);
    const cart = order.buildPayload('cart', {...fields, contactChannel, contact}, [{id: 'balloon-1', qty: 2}], location);
    assert.equal(cart.deliveryAddress, fields.deliveryAddress); assert.equal(cart.deliveryDate, fields.deliveryDate);
    assert.equal(cart.deliveryInterval, fields.deliveryInterval); assert.equal(cart.comment, fields.comment);
    assert.equal(cart.telegramUsername, contactChannel === 'telegram' ? contact : undefined);
  }
  const telegram = order.buildPayload('request', {name: 'Тест', contactChannel: 'telegram', telegramUsername: 'Example_Test', consent: true}, [], location);
  assert.equal(telegram.contact, '@example_test');
  for (const [patch, field] of [[{contactChannel: ''}, 'contactChannel'], [{contactChannel: 'email'}, 'contactChannel'], [{contact: '12'}, 'contact'], [{contactChannel: 'telegram', telegramUsername: 'x'}, 'telegramUsername'], [{deliveryAddress: ''}, 'deliveryAddress'], [{deliveryDate: '2026-02-30'}, 'deliveryDate'], [{deliveryInterval: ''}, 'deliveryInterval'], [{contactChannel: 'max', contact: 'person@example.com'}, 'contact'], [{contactChannel: 'max', contact: 'javascript:alert(1)'}, 'contact']]) {
    assert.throws(() => order.buildPayload('cart', {...fields, ...patch}, [{id: 'balloon-1', qty: 1}], location), error => error.field === field);
  }
  const legacy = order.buildPayload('cart', {name: 'Тест', phone: fields.contact, consent: true}, [{id: 'balloon-1', qty: 1}], location);
  assert.equal(legacy.phone, fields.contact); assert.equal(legacy.contactChannel, undefined);
  for (const [contactChannel, contact] of [['phone', 'abc79991112233'], ['whatsapp', '7999/1112233'], ['max', 'user:name'], ['max', 'https://'], ['max', 'https://user:pass@max.ru']]) {
    assert.throws(() => order.buildPayload('request', {...fields, contactChannel, contact}, [], location), error => error.field === 'contact');
  }
});

test('цветочная тематическая страница скрыта; пустой подбор сохраняет ответы и ведёт в короткую форму', () => {
  const dom = new JSDOM(read('uchitelyu/index.html'), {url: 'https://palitra-love.ru/uchitelyu', runScripts: 'outside-only'}), w = dom.window;
  w.eval(read('config.js')); w.eval(read('assets/app.js')); w.eval(read('assets/quiz.js'));
  assert.equal(w.document.querySelector('main[data-flowers]').hidden, true);
  assert.ok(w.document.querySelector('[data-no-flowers] a[href="/#zayavka"]'));
  for (let i = 0; i < 3; i++) w.document.querySelector('[data-answer]').click();
  const cta = w.document.querySelector('[data-order-custom]');
  assert.ok(cta); cta.dispatchEvent(new w.MouseEvent('click', {bubbles: true, cancelable: true}));
  assert.match(w.sessionStorage.getItem(order.DRAFT_KEY), /Нужен индивидуальный подбор/);
  dom.window.close();
});

test('новые поля меняют отпечаток заявки, одинаковый телефон в другой записи — нет', async () => {
  const payload = order.buildPayload('cart', fields, [{id: 'balloon-1', qty: 1}], location);
  const fp = await order.fingerprint(payload);
  assert.equal(await order.fingerprint({...payload, contact: '89991112233'}), fp);
  for (const [key, value] of [['contactChannel', 'whatsapp'], ['contact', '89991112244'], ['deliveryAddress', 'Другой адрес'], ['deliveryDate', '2026-10-02'], ['deliveryInterval', 'Вечером'], ['comment', 'Другая надпись']]) assert.notEqual(await order.fingerprint({...payload, [key]: value}), fp, key);
});

test('реальные формы: условный ник, сохранение после ошибки, квиз в короткой заявке и отправка всех новых полей', async () => {
  const dom = page('/'), w = dom.window, calls = [];
  w.sessionStorage.setItem(order.DRAFT_KEY, JSON.stringify({occasion: 'Выписка', lines: ['Нужны голубые шары']}));
  let fail = true;
  w.fetch = async (url, options) => {calls.push(JSON.parse(options.body)); return fail
    ? {status: 503, json: async () => ({code: 'ORDERS_UNAVAILABLE'})}
    : {status: 201, json: async () => ({ok: true, orderId: 77})};};
  const api = order.mount(w), f = w.document.querySelector('#zayavka form');
  assert.equal(f.querySelector('[name="date"]'), null);
  assert.equal(f.querySelector('[name="occasion"]').type, 'hidden');
  assert.match(f.querySelector('[data-request-context]').textContent, /голубые шары/);
  f.elements.name.value = 'Тест'; f.elements.contactChannel.value = 'telegram';
  f.elements.contactChannel.dispatchEvent(new w.Event('change'));
  assert.equal(f.elements.contact.disabled, true); assert.equal(f.elements.telegramUsername.disabled, false);
  f.elements.telegramUsername.value = 'example_test'; f.elements.consent.checked = true;
  const send = async () => {f.dispatchEvent(new w.Event('submit', {cancelable: true})); await tick();};
  await send();
  assert.equal(f.elements.telegramUsername.value, 'example_test'); assert.equal(f.elements.contact.disabled, true);
  assert.equal(calls[0].contact, '@example_test'); assert.match(calls[0].comment, /голубые шары/);
  fail = false; await send();
  assert.equal(calls[1].requestId, calls[0].requestId);
  assert.equal(f.elements.contactChannel.value, 'phone'); assert.equal(f.elements.telegramUsername.disabled, true);
  assert.equal(f.elements.contact.disabled, false);
  const cart = w.document.querySelector('[data-order-form="cart"]');
  for (const [key, value] of Object.entries(fields)) if (key !== 'consent') cart.elements[key].value = value;
  cart.elements.consent.checked = true; api.cart.add('balloon-1');
  cart.dispatchEvent(new w.Event('submit', {cancelable: true})); await tick();
  assert.equal(calls.at(-1).kind, 'cart'); assert.equal(calls.at(-1).deliveryDate, fields.deliveryDate);
  assert.equal(calls.at(-1).deliveryAddress, fields.deliveryAddress); assert.equal(api.cart.count(), 0);
  assert.doesNotMatch(w.localStorage.getItem(order.CART_KEY), /111|Тест/);
  dom.window.close();
});

test('все страницы имеют новую полную корзину без почты; неопределённые часы и тарифы не обещаются', () => {
  const pages = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? pages(path.join(dir, entry.name)) : entry.name.endsWith('.html') ? [path.join(dir, entry.name)] : []);
  for (const file of pages(__dirname)) {
    const dom = new JSDOM(fs.readFileSync(file, 'utf8')), d = dom.window.document, cart = d.querySelector('[data-order-form="cart"]');
    for (const field of ['name', 'contactChannel', 'contact', 'telegramUsername', 'deliveryAddress', 'deliveryDate', 'deliveryInterval', 'comment', 'consent']) assert.ok(cart.elements[field], file + ':' + field);
    assert.equal(d.querySelector('input[type="email"],input[name="email"]'), null);
    assert.doesNotMatch(d.body.textContent, /30 минут|09:00–21:00|350–650|650–1800|4000 руб\.|Предоплата.*100%/);
    dom.window.close();
  }
});
