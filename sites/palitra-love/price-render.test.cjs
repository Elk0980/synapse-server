/* Единая карточка товара: прайс и каталог рисуют одну структуру, пустая цена — словами,
   фото — только безопасное, без фото — заглушка того же размера. Режим редактора сохраняет опции.
   node --test sites/palitra-love/price-render.test.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const catalogLive = require('./assets/catalog-live.js');

function renderer() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'price-render.js'), 'utf8'), { window });
  return window.PalitraPrice;
}
const P = renderer();
const full = { id: 'vypiska-1', title: 'Выписка мальчика', price: '9 270 руб.', desc: 'Шары и цветы к выходу.', note: 'Цена на момент публикации', photo: '/assets/img/vypiska-malchik.jpg' };
const bare = { id: 'x-2', title: 'Очень длинное название позиции без цены и без фотографии для проверки переносов', price: '' };
const classSequence = (html) => [...html.matchAll(/class="([^"]+)"/g)].map((m) => m[1]);

test('карточка прайса: фиксированный порядок блоков, известная цена как строка ЛК, одна кнопка «Купить», без Telegram и второй заявки', () => {
  const html = P.productCard(full);
  assert.match(html, /^<article class="pc price-card product-card" id="vypiska-1" data-id="vypiska-1">/);
  // Примечание владельца — в содержимом, до низа; низ у всех карточек одинаков: цена + «Купить».
  const order = ['pc price-card product-card', 'product-media', 'price-card__photo photo', 'price-card__body', 'pc__title', 'price-card__description', 'note', 'product-footer', 'product-purchase', 'pc__price price', 'button product-add'];
  assert.deepEqual(classSequence(html), order);
  assert.match(html, /data-price-known="true">9 270 руб\.</);
  assert.match(html, /width="800" height="1000"/);
  assert.match(html, /<button class="button product-add" type="button" data-add data-id="vypiska-1" data-title="Выписка мальчика">Купить<\/button>/);
  // Замечание Дарьи 20.09: в карточке нет перехода в Telegram и дублирующих призывов — только «Купить».
  assert.doesNotMatch(html, /t\.me\/|product-links|product-telegram|\/#zayavka|Заказать под Ваш повод|В корзину/);
  assert.equal((html.match(/<button /g) || []).length, 1);
  assert.equal((html.match(/<a /g) || []).length, 0);
  // Без примечания низ карточки совпадает с карточкой с примечанием: footer не зависит от note.
  const bare = P.productCard({ ...full, note: '' });
  assert.equal(bare.slice(bare.indexOf('<div class="product-footer">')), html.slice(html.indexOf('<div class="product-footer">')));
});

test('служебные примечания импорта («Цена из публикации…», «Цена на момент публикации…») скрыты на сайте, примечание владельца остаётся, редактор видит всё; строки прайса не меняются', () => {
  const auto1 = 'Цена из публикации от 07.05.2026; актуальность уточняется при заказе.';
  const auto2 = 'Цена на момент публикации, актуальную подтверждаем при заказе';
  const custom = 'Состав: 15 шаров, лента в подарок';
  assert.equal(P.isAutoPriceNote(auto1), true);
  assert.equal(P.isAutoPriceNote(auto2), true);
  assert.equal(P.isAutoPriceNote(' цена из публикации от 01.01.2026; актуальность уточняется '), true);
  assert.equal(P.isAutoPriceNote(custom), false);
  assert.equal(P.isAutoPriceNote('Цена из публикации в журнале, состав как на фото'), false, 'без слова «актуальность» — обычное примечание');
  assert.equal(P.isAutoPriceNote(''), false);
  for (const note of [auto1, auto2]) {
    const item = { ...full, note };
    const html = P.productCard(item);
    assert.doesNotMatch(html, /class="note"|публикации|актуальност/);
    assert.match(html, /data-price-known="true">9 270 руб\./, 'живая цена не подменяется');
    assert.equal(item.note, note, 'объект позиции не мутируется');
    // Карточка без служебного примечания идентична карточке, у которой примечания нет вовсе.
    assert.equal(html, P.productCard({ ...full, note: '' }));
    // Редактор ЛК показывает примечание как есть — владелец может его увидеть и убрать сам.
    const editor = P.productCard(item, { editor: true, starHtml: () => '', editHtml: () => '' });
    assert.match(editor, new RegExp(`<p class="note">${note.replace(/[.;]/g, '\\$&')}</p>`));
  }
  assert.match(P.productCard({ ...full, note: custom }), /<p class="note">Состав: 15 шаров, лента в подарок<\/p>/);
  assert.match(catalogLive.card({ ...full, note: custom, tags: ['bukety'] }), /<p class="note">Состав: 15 шаров/);
  assert.doesNotMatch(catalogLive.card({ ...full, note: auto1, tags: ['bukety'] }), /class="note"/);
  assert.equal(catalogLive.card({ ...full, note: auto2, tags: ['bukety'] }, P.productCard), catalogLive.card({ ...full, note: auto2, tags: ['bukety'] }), 'запасная разметка скрывает то же самое');
});

test('пустая цена — «Цена уточняется», не 0; без фото — заглушка 4:5; текст не обрезается', () => {
  const html = P.productCard(bare);
  assert.match(html, /data-price-known="false">Цена уточняется</);
  assert.doesNotMatch(html, /\b0\s*₽|0 руб/);
  assert.match(html, /product-media product-media--empty/);
  assert.doesNotMatch(html, /price-card__photo/);
  assert.match(html, new RegExp(bare.title));
  assert.doesNotMatch(html, /price-card__description|class="note"/);
  // Пробельная цена тоже неизвестна.
  assert.match(P.productCard({ ...bare, price: '   ' }), /data-price-known="false"/);
});

test('экранирование и относительные пути фото', () => {
  const html = P.productCard({ id: 'e', title: '<b>x</b>', desc: '"q"', price: '1 & 2', photo: './img/a.jpg' });
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /&quot;q&quot;/);
  assert.match(html, /1 &amp; 2/);
  assert.match(html, /src="\/img\/a\.jpg"/);
});

test('каталог использует ту же карточку: одинаковая структура классов, теги раздела, unsafe-фото → заглушка', () => {
  const data = { categories: [{ id: 'bukety', title: 'Букеты', items: [full, { ...bare, photo: 'javascript:bad' }] }] };
  const list = catalogLive.entries(data, '/catalog/bukety');
  const shared = catalogLive.card(list[0], P.productCard);
  const fallback = catalogLive.card(list[0]);
  assert.match(shared, /^<article class="pc price-card product-card card" id="vypiska-1" data-id="vypiska-1" data-cat="bukety">/);
  assert.deepEqual(classSequence(shared), classSequence(fallback), 'запасная разметка не расходится с общей');
  assert.equal(shared, fallback);
  assert.match(catalogLive.card(list[1], P.productCard), /product-media--empty/);
  assert.doesNotMatch(catalogLive.card(list[1], P.productCard), /javascript:/);
});

test('разделы и навигация: пустые разделы скрыты на сайте, режим редактора получает свои вставки', () => {
  const data = { categories: [
    { id: 'a', title: 'A', items: [full] },
    { id: 'b', title: 'B', items: [] }
  ] };
  const site = P.renderSections(data);
  assert.equal((site.match(/<section class="ps"/g) || []).length, 1);
  assert.equal((site.match(/<article /g) || []).length, 1);
  assert.equal(P.renderNav(data), '<li><a class="pnav__top" href="#a">A</a></li>');
  const editor = P.renderSections(data, {
    editor: true,
    starHtml: (item) => `<i class="star">${item.id}</i>`,
    editHtml: (item) => `<button class="ed">${item.id}</button>`,
    titleExtra: (cat) => `<em>${cat.id}</em>`,
    addCardHtml: (cat) => `<div class="add">${cat.id}</div>`
  });
  assert.equal((editor.match(/<section class="ps"/g) || []).length, 2);
  assert.match(editor, /<i class="star">vypiska-1<\/i>/);
  assert.match(editor, /<button class="ed">vypiska-1<\/button>/);
  assert.doesNotMatch(editor, /product-telegram|\/#zayavka|data-add/);
  assert.match(editor, /<em>b<\/em>/);
  assert.match(editor, /В этом разделе пока нет позиций\./);
  assert.match(editor, /<div class="add">b<\/div>/);
  assert.match(P.renderNav(data, { editor: true, prefix: '<li>x</li>' }), /^<li>x<\/li><li>.*#a.*<li>.*#b/s);
});
