/* Клиентская проверка 02.10.2026 (specs/084-palitra-site-client-check).
   «Подробнее» у карточки без описания больше не открывает пустой блок: честная строка о том, что описания нет.
   Названия «Товар №…» и «Цена уточняется» — данные прайса: рендер их не подменяет и не прячет товар.
   Копия кнопки в окне товара не наследует временную отметку «В корзине».
   node --test sites/palitra-love/client-check.test.cjs (jsdom из среды проекта) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const order = require('./assets/order.js');
const catalog = require('./assets/catalog-live.js');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const AUTO_NOTE = 'Цена на момент публикации, актуальную подтверждаем при заказе';
// Синтетический прайс той же формы, что живой: выписка с автоматическим примечанием, позиции импорта
// без названия и цены, позиция с описанием, позиция с примечанием владельца, скрытая цветочная категория.
const PRICE = { version: 3, categories: [
  { id: 'vypiska', title: 'Выписка из роддома', items: [
    { id: 'vypiska-1', title: 'Выписка мальчика', price: '9 270 руб.', note: AUTO_NOTE, photo: '/assets/img/vypiska-malchik.jpg' },
    { id: 'import-drive-manual-014', title: 'Товар №001', price: '', photo: '/api/assets/a.webp' },
    { id: 'import-tg-563-1', title: 'Товар №003', price: '10 000 руб.', desc: 'Фонтан из шаров, большое сердце.', note: 'Цена из публикации от 07.05.2026; актуальность уточняется при заказе.', photo: '/api/assets/b.webp' },
    { id: 'owner-note', title: 'Набор с надписью', price: '', note: 'Надпись согласуем', photo: '' }
  ] },
  { id: 'bukety', title: 'Букеты', items: [{ id: 'flower-1', title: 'Букет', price: '1000', photo: '/assets/img/hrizantema.jpg' }] }
] };

function page(url = '/catalog') {
  const file = url === '/price.html' ? 'price.html' : url.replace(/^\//, '').replace(/\/$/, '') + '/index.html';
  const dom = new JSDOM(read(file), { url: 'https://palitra-love.ru' + url, runScripts: 'outside-only' });
  dom.window.eval(read('config.js'));
  dom.window.eval(read('assets/app.js'));
  dom.window.eval(read('assets/price-format.js'));
  dom.window.eval(read('price-render.js'));
  dom.window.PalitraPrice.load = async () => PRICE;
  return dom;
}
const card = (w, id) => w.document.querySelector(`[data-products] .product-card[data-id="${id}"]`);

test('каталог: каждая позиция шаров видна с названием и ценой из прайса; «Подробнее» не пустое', async () => {
  const original = JSON.stringify(PRICE);
  const dom = page(), w = dom.window;
  await catalog.mount(w);
  const ids = [...w.document.querySelectorAll('[data-products] .product-card')].map((node) => node.dataset.id);
  assert.deepEqual(ids, ['vypiska-1', 'import-drive-manual-014', 'import-tg-563-1', 'owner-note'], 'ни одна позиция без названия или цены не скрыта; цветы скрыты, как прежде');
  // Название и цена — ровно из прайса: «Товар №…» и «Цена уточняется» не подменяются.
  assert.equal(card(w, 'import-drive-manual-014').querySelector('h3').textContent, 'Товар №001');
  assert.equal(card(w, 'import-drive-manual-014').querySelector('.price').textContent, 'Цена уточняется');
  assert.equal(card(w, 'vypiska-1').querySelector('.price').textContent, '9 270 ₽');
  const missing = (id) => card(w, id).querySelector('[data-product-details] [data-details-missing]');
  // Нет описания и примечание служебное (скрыто) — честная строка; есть описание или примечание владельца — строки нет.
  assert.equal(missing('vypiska-1').textContent, w.PalitraPrice.DETAILS_MISSING);
  assert.equal(missing('import-drive-manual-014').textContent, w.PalitraPrice.DETAILS_MISSING);
  assert.equal(missing('import-tg-563-1'), null);
  assert.equal(missing('owner-note'), null);
  assert.equal(card(w, 'owner-note').querySelector('[data-product-details] .note').textContent, 'Надпись согласуем');
  for (const id of ids) {
    const details = card(w, id).querySelector('[data-product-details]');
    assert.ok(details.querySelector('.price-card__description,.note'), `${id}: «Подробнее» содержит текст`);
    assert.doesNotMatch(details.textContent, /публикации|актуальност/, `${id}: служебное примечание скрыто`);
  }
  assert.equal(w.PalitraPrice.DETAILS_MISSING, catalog.DETAILS_MISSING, 'запасная разметка каталога — та же строка');
  assert.match(w.PalitraPrice.DETAILS_MISSING, /ещё не добавлено/);
  assert.doesNotMatch(w.PalitraPrice.DETAILS_MISSING, /\d/, 'строка не содержит цифр, сумм и составов');
  assert.equal(JSON.stringify(PRICE), original, 'данные прайса не изменены');
  dom.window.close();
});

test('запасная разметка каталога (без price-render.js) — та же строка вместо пустого «Подробнее»', () => {
  const html = catalog.fallbackCard({ id: 'x', title: 'Товар №009', price: '', note: AUTO_NOTE }, { extraClass: 'card', tags: ['vypiska'] });
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelector('[data-details-missing]').textContent, catalog.DETAILS_MISSING);
  assert.equal(doc.querySelector('h3').textContent, 'Товар №009');
  assert.equal(doc.querySelector('.price').textContent, 'Цена уточняется');
  const described = new JSDOM(catalog.fallbackCard({ id: 'y', title: 'Набор', desc: 'Состав из прайса' }, {})).window.document;
  assert.equal(described.querySelector('[data-details-missing]'), null);
});

test('прайс: та же строка; редактор ЛК строку не показывает и примечание видит как есть', async () => {
  const dom = page('/price.html'), w = dom.window, p = w.PalitraPrice;
  const html = p.renderSections(PRICE);
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelectorAll('.product-card').length, 4);
  assert.equal(doc.querySelectorAll('[data-details-missing]').length, 2);
  const editor = new JSDOM(p.renderSections(PRICE, { editor: true, starHtml: () => '', editHtml: () => '' })).window.document;
  assert.equal(editor.querySelectorAll('[data-details-missing]').length, 0);
  assert.match(editor.body.textContent, /Цена на момент публикации/);
  dom.window.close();
});

test('окно товара без описания: строка «описание ещё не добавлено», цена и рабочая «Купить» без отметки «В корзине»', async () => {
  const dom = page(), w = dom.window;
  await catalog.mount(w);
  const api = order.mount(w);
  const node = card(w, 'vypiska-1');
  const add = node.querySelector('[data-add]');
  add.click();
  assert.equal(add.textContent, 'В корзине', 'на карточке — временная отметка');
  assert.equal(api.cart.list().find((item) => item.id === 'vypiska-1').qty, 1);
  node.querySelector('[data-product-details] > summary').click();
  const dialog = w.document.querySelector('.product-dialog');
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('#product-dialog-title').textContent, 'Выписка мальчика');
  assert.equal(dialog.querySelector('[data-details-missing]').textContent, w.PalitraPrice.DETAILS_MISSING);
  assert.equal(dialog.querySelector('.price').textContent, '9 270 ₽');
  const copy = dialog.querySelector('[data-add]');
  assert.equal(copy.textContent, 'Купить', 'копия кнопки в окне — исходная подпись');
  assert.equal(copy.classList.contains('is-added'), false);
  copy.click();
  assert.equal(api.cart.list().find((item) => item.id === 'vypiska-1').qty, 2, 'кнопка в окне по-прежнему добавляет в корзину');
  // Строка об отсутствии описания не выдаётся за описание: другой класс, приглушённое примечание.
  assert.equal(dialog.querySelector('.price-card__description'), null);
  // Повторное открытие сразу после добавления в окне: снова исходная «Купить», количество не меняется само.
  dialog.querySelector('[data-product-close]').click();
  node.querySelector('[data-product-details] > summary').click();
  assert.equal(dialog.querySelector('[data-add]').textContent, 'Купить');
  assert.equal(api.cart.list().find((item) => item.id === 'vypiska-1').qty, 2);
  dialog.querySelector('[data-cart-open]').click();
  assert.equal(dialog.open, false, 'оформление закрывает окно товара');
  assert.equal(w.document.querySelector('[data-cart]').hidden, false, 'и открывает корзину');
  assert.deepEqual(api.cart.list().map((item) => [item.id, item.qty]), [['vypiska-1', 2]], 'в корзине ровно добавленное');
  w.close();
});

test('окно товара с описанием: описание из прайса, строки об отсутствии нет; неизвестная цена — словами', async () => {
  const dom = page(), w = dom.window;
  await catalog.mount(w);
  order.mount(w);
  card(w, 'import-tg-563-1').querySelector('[data-product-details] > summary').click();
  let dialog = w.document.querySelector('.product-dialog');
  assert.equal(dialog.querySelector('.price-card__description').textContent, 'Фонтан из шаров, большое сердце.');
  assert.equal(dialog.querySelector('[data-details-missing]'), null);
  dialog.querySelector('[data-product-close]').click();
  card(w, 'import-drive-manual-014').querySelector('[data-product-details] > summary').click();
  dialog = w.document.querySelector('.product-dialog');
  assert.equal(dialog.querySelector('#product-dialog-title').textContent, 'Товар №001');
  assert.equal(dialog.querySelector('.price').textContent, 'Цена уточняется');
  assert.equal(dialog.querySelector('.price').dataset.priceKnown, 'false');
  w.close();
});
