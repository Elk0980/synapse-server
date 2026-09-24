/* Замечания Дарьи 20.09.2026 (реализация 24.09): на телефоне два товара в строке, компактная цена +
   одна кнопка «Купить» (добавляет в корзину), без перехода в Telegram и дублирующих призывов в карточке,
   служебные примечания импорта «Цена из публикации…» не показываются на сайте.
   jsdom раскладку не измеряет: правила сетки проверяются по тексту styles.css, поведение — рендером
   настоящих страниц. Визуальная приёмка на 320/360/390/414 — вручную в браузере.
   node --test sites/palitra-love/mobile-cards.test.cjs (jsdom из среды проекта) */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const catalogLive = require('./assets/catalog-live.js');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const css = read('assets/styles.css');
const renderer = () => { const window = {}; vm.runInNewContext(read('price-render.js'), { window }); return window.PalitraPrice; };
const PRICE = { version: 3, categories: [
  { id: 'bukety', title: 'Букеты', items: [
    { id: 'b-1', title: 'Букет из хризантем', price: '3 290 руб.', desc: 'Нежный букет.', note: 'Цена из публикации от 07.05.2026; актуальность уточняется при заказе.', photo: '/api/assets/a.jpg' },
    { id: 'b-2', title: 'Корзина с пионами', price: '', note: 'Цена на момент публикации, актуальную подтверждаем при заказе', photo: '/api/assets/b.jpg' },
    { id: 'b-3', title: 'Букет невесты', price: '5 100 руб.', note: 'Состав: 15 роз и эвкалипт', photo: '' }
  ] }
] };

/* Извлекает тело медиа-блока по точному префиксу правила. */
function mediaBlock(prefix) {
  const start = css.lastIndexOf(prefix);
  assert.ok(start >= 0, `нет блока ${prefix}`);
  let depth = 0, i = css.indexOf('{', start);
  for (; i < css.length; i++) { if (css[i] === '{') depth++; else if (css[i] === '}' && --depth === 0) break; }
  return css.slice(start, i + 1);
}

test('сетка: на телефоне (≤480) прайс и каталог — две колонки; планшет 481–800 — две; десктоп — 2 (прайс) / 3 (каталог)', () => {
  const phone = mediaBlock('/* ---- Правки по замечаниям Дарьи 20.09.2026');
  assert.match(phone, /@media\(max-width:480px\)\{[\s\S]*\.price-grid,body\[data-page="catalog"\] \.grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  // Последнее правило для ≤480 в файле — двухколоночное: более ранний `minmax(0,1fr)` (одна колонка) перекрыт.
  const oneColumn = css.lastIndexOf('.grid,.home-products .grid,.price-grid,.price-ladder,.quiz-results,.occasion-side-card{grid-template-columns:minmax(0,1fr)}');
  assert.ok(oneColumn >= 0 && oneColumn < css.lastIndexOf('.price-grid,body[data-page="catalog"] .grid{grid-template-columns:repeat(2,minmax(0,1fr))'), 'двухколоночное правило идёт после одноколоночного');
  assert.match(css, /@media\(min-width:481px\) and \(max-width:800px\)\{\s*\.grid,\.home-products \.grid,\.price-grid,\.price-ladder,\.quiz-results\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.match(css, /\r?\n\.grid,\.price-ladder\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}\r?\n\.price-grid,\.home-products \.grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  // Компактная карточка на телефоне: кнопка «Купить» не ниже 40px касания, цена читаема, фото 4:5 без обрезки деталей (object-fit: cover сохранён от 4:5-исходников).
  // Дефект приёмки 320px: низ карточки — одна колонка, цена своей строкой, «Купить» во всю ширину;
  // цифры цены не переносятся. Правило идёт после `.product-purchase{grid-template-columns:minmax(0,1fr) auto}`.
  assert.match(phone, /\.product-purchase\{grid-template-columns:minmax\(0,1fr\);/);
  assert.ok(css.lastIndexOf('.product-purchase{grid-template-columns:minmax(0,1fr) auto}') < css.lastIndexOf('.product-purchase{grid-template-columns:minmax(0,1fr);'), 'одноколоночный низ перекрывает двухколоночный');
  assert.match(phone, /\.product-add\{width:100%;min-height:40px/);
  assert.match(phone, /\.pc__price\{width:100%;font-size:17px;line-height:1\.2;white-space:nowrap;overflow-wrap:normal\}/);
  assert.match(phone, /\.price\[data-price-known="false"\]\{font-size:12px;line-height:1\.3;white-space:normal\}/);
  assert.match(phone, /\.price-card h3\{margin:0 0 6px;font-size:15px/);
  assert.doesNotMatch(css, /\.product-links\{/, 'стилей для убранного блока ссылок не осталось');
  assert.doesNotMatch(css, /line-clamp|text-overflow:ellipsis/, 'тексты карточек не обрезаются');
});

test('каталог (настоящая страница, общий рендер): в каждой карточке одна кнопка «Купить», нет Telegram и второй заявки; служебные примечания скрыты, примечание владельца показано, цены не подменены', async () => {
  const dom = new JSDOM(read('catalog/index.html'), { url: 'https://palitra-love.synapsebusiness.ru/catalog', runScripts: 'outside-only' });
  const win = dom.window;
  win.PALITRA_CONFIG = { SITE_URL: win.location.origin };
  win.eval(read('assets/app.js'));
  win.eval(read('price-render.js'));
  win.PalitraPrice.load = async () => PRICE;
  await catalogLive.mount(win);
  const cards = [...win.document.querySelectorAll('[data-products] .price-card')];
  assert.equal(cards.length, 3);
  for (const card of cards) {
    const buttons = card.querySelectorAll('button');
    assert.equal(buttons.length, 1, 'одна кнопка');
    assert.equal(buttons[0].textContent, 'Купить');
    assert.ok(buttons[0].hasAttribute('data-add') && buttons[0].dataset.id, 'кнопка добавляет в корзину по id позиции');
    assert.equal(card.querySelectorAll('a').length, 0, 'ссылок (Telegram, заявка) в карточке нет');
    assert.doesNotMatch(card.textContent, /публикации|актуальност/);
  }
  assert.equal(cards[0].querySelector('.price').textContent, '3 290 руб.');
  assert.equal(cards[0].querySelector('.price').dataset.priceKnown, 'true');
  assert.equal(cards[1].querySelector('.price').textContent, 'Цена уточняется');
  assert.equal(cards[1].querySelector('.price').dataset.priceKnown, 'false');
  assert.ok(!cards[1].textContent.includes('0 ₽') && !cards[1].textContent.includes('0 руб'), 'неизвестная цена не превращается в 0');
  assert.equal(cards[2].querySelector('.note').textContent, 'Состав: 15 роз и эвкалипт');
  assert.equal(cards[0].querySelector('.note'), null);
  assert.equal(cards[1].querySelector('.note'), null);
  assert.deepEqual(PRICE.categories[0].items.map((item) => item.note).filter(Boolean).length, 3, 'данные прайса не изменены рендером');
  win.close();
});

test('прайс (общий рендер по разделам): «Купить» добавляет в корзину и счётчик растёт, примечания импорта не показаны', async () => {
  const P = renderer();
  const html = `<!doctype html><body data-page="price"><header><button class="cart-button" data-cart-open>Корзина · <span data-cart-count>0</span></button></header>
    <div id="price-content">${P.renderSections(PRICE)}</div>
    <aside class="cart" data-cart hidden aria-hidden="true"><button type="button" data-cart-close>Закрыть</button><div data-cart-items></div><p data-cart-summary></p><span data-total></span>
      <form data-order-form="cart"><input name="name"><input name="phone" type="tel"><textarea name="comment"></textarea><input type="checkbox" name="consent"><button>Отправить</button></form></aside></body>`;
  const dom = new JSDOM(html, { url: 'https://palitra-love.synapsebusiness.ru/price.html', runScripts: 'outside-only' });
  const win = dom.window;
  win.PalitraPrice = { load: async () => PRICE };
  const order = require('./assets/order.js');
  order.forgetRequest('cart', null);
  order.mount(win);
  const content = win.document.getElementById('price-content');
  assert.equal(content.querySelectorAll('.price-card').length, 3);
  assert.equal(content.querySelectorAll('a').length, 0);
  assert.deepEqual([...content.querySelectorAll('button')].map((b) => b.textContent), ['Купить', 'Купить', 'Купить']);
  assert.doesNotMatch(content.textContent, /публикации|актуальност/);
  assert.match(content.textContent, /Состав: 15 роз и эвкалипт/);
  const buy = content.querySelector('[data-add][data-id="b-2"]');
  buy.click();
  assert.equal(win.document.querySelector('[data-cart-count]').textContent, '1', 'позиция с неизвестной ценой тоже добавляется — цену подтвердит менеджер');
  assert.equal(buy.textContent, 'В корзине');
  assert.equal(buy.dataset.label, 'Купить');
  assert.equal(win.document.querySelector('[data-cart]').hidden, true, 'корзина не открывается сама, без онлайн-оплаты');
  win.close();
});

test('статические страницы: ни в одной карточке нет кнопки Telegram и статической цены числом (примеры без id каталога не выглядят покупаемыми)', () => {
  const pages = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['assets', 'data'].includes(entry.name)) walk(full); }
      else if (entry.name.endsWith('.html')) pages.push(full);
    }
  }(__dirname));
  assert.equal(pages.length, 24);
  for (const file of pages) {
    const html = fs.readFileSync(file, 'utf8');
    const name = path.relative(__dirname, file);
    assert.ok(!html.includes('product-telegram') && !html.includes('product-links'), `${name}: кнопка/ссылка Telegram внутри карточки`);
    for (const price of html.matchAll(/<p class="price"[^>]*>([^<]*)<\/p>/g)) {
      assert.equal(price[1], 'Цена уточняется', `${name}: статическая цена «${price[1]}» в разметке`);
      assert.match(price[0], /data-price-known="false"/, `${name}: неизвестная цена помечена`);
    }
    assert.ok(!/<p class="price[^"]*">[^<]*\d[^<]*(руб|₽)/.test(html), `${name}: цена числом в статической разметке`);
  }
});

test('главная: карточки-примеры без «Купить» (нет id в каталоге), без Telegram; одно действие — заявка под повод', () => {
  const dom = new JSDOM(read('index.html'), { url: 'https://palitra-love.synapsebusiness.ru/', runScripts: 'outside-only' });
  const win = dom.window;
  win.PALITRA_CONFIG = { SITE_URL: win.location.origin };
  win.eval(read('assets/app.js'));
  const cards = [...win.document.querySelectorAll('[data-products] .product-card')];
  assert.equal(cards.length, 4);
  for (const card of cards) {
    assert.equal(card.querySelector('[data-add]'), null, 'пример нельзя «купить» как позицию каталога');
    assert.equal(card.querySelectorAll('a').length, 0, 'ссылок в карточке нет');
    const buttons = card.querySelectorAll('button');
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].textContent, 'Заказать под Ваш повод');
    assert.ok(buttons[0].dataset.occasion);
    assert.equal(card.querySelector('.price').textContent, 'Цена уточняется');
  }
  win.close();
});
