/* Несколько фото у товара на сайте Palitra: обложка photo + необязательный список gallery.
   Товар с одним фото размечается как раньше; галерея листается кнопками, клавиатурой и свайпом
   (прокрутка с привязкой к кадру). Небезопасные адреса отбрасываются.
   NODE_PATH=<jsdom> node --test sites/palitra-love/gallery.test.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const catalog = require('./assets/catalog-live.js');

const renderSource = fs.readFileSync(path.join(__dirname, 'price-render.js'), 'utf8');
function page() {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'https://palitra-love.ru/catalog', runScripts: 'outside-only' });
  dom.window.eval(renderSource);
  return dom;
}
const ITEM = { id: 'bukety-1', title: 'Белые гортензии', price: '4 590 руб.', photo: '/assets/img/gortenzii.jpg' };

test('одно фото: прежняя разметка обложки, никаких элементов галереи', () => {
  const dom = page();
  const html = dom.window.PalitraPrice.productCard(ITEM);
  assert.ok(html.includes('<div class="product-media"><img class="price-card__photo photo" src="/assets/img/gortenzii.jpg" alt="Белые гортензии" loading="lazy" decoding="async" width="800" height="1000"></div>'));
  assert.ok(!html.includes('data-gallery'));
  const empty = dom.window.PalitraPrice.productCard({ ...ITEM, photo: '', gallery: [] });
  assert.ok(empty.includes('product-media--empty'), 'без фото — прежняя заглушка');
  assert.ok(dom.window.PalitraPrice.productCard({ ...ITEM, gallery: [] }).includes('alt="Белые гортензии"'), 'пустой список не меняет карточку');
});

test('несколько фото: обложка первой, повторы и небезопасные адреса отброшены, не больше 9', () => {
  const dom = page();
  const { photosOf } = dom.window.PalitraPrice;
  assert.deepEqual([...photosOf({ ...ITEM, gallery: ['/api/assets/a.jpg', ITEM.photo, 'http://evil.example/x.jpg', '//evil.example/y.jpg', 'javascript:alert(1)', 42, ' /api/assets/b.jpg '] })],
    [ITEM.photo, '/api/assets/a.jpg', '/api/assets/b.jpg']);
  assert.equal(photosOf({ ...ITEM, gallery: Array.from({ length: 20 }, (_, i) => `/api/assets/${i}.jpg`) }).length, 9);
  assert.deepEqual([...photosOf({ ...ITEM, photo: '', gallery: ['/api/assets/a.jpg'] })], ['/api/assets/a.jpg'], 'без обложки первым идёт первое дополнительное');
});

test('галерея: доступная разметка, кнопки, счётчик и клавиатура листают кадры', () => {
  const dom = page();
  const w = dom.window;
  const root = w.document.getElementById('root');
  root.innerHTML = w.PalitraPrice.productCard({ ...ITEM, gallery: ['/api/assets/a.jpg', '/api/assets/b.jpg'] });
  const gallery = root.querySelector('[data-gallery]');
  assert.equal(gallery.getAttribute('role'), 'group');
  assert.equal(gallery.getAttribute('aria-roledescription'), 'галерея');
  const track = gallery.querySelector('[data-gallery-track]');
  const images = [...track.querySelectorAll('img')];
  assert.deepEqual(images.map((img) => img.getAttribute('alt')), ['Белые гортензии — фото 1 из 3', 'Белые гортензии — фото 2 из 3', 'Белые гортензии — фото 3 из 3']);
  assert.equal(track.getAttribute('tabindex'), '0');
  const prev = gallery.querySelector('[data-gallery-prev]');
  const next = gallery.querySelector('[data-gallery-next]');
  assert.equal(prev.getAttribute('aria-label'), 'Предыдущее фото');
  assert.equal(prev.disabled, true);
  assert.equal(gallery.querySelector('[data-gallery-count]').textContent, '1 / 3');
  // jsdom не считает раскладку: ширина кадра задаётся вручную, scrollTo сдвигает scrollLeft.
  Object.defineProperty(track, 'clientWidth', { configurable: true, value: 300 });
  track.scrollTo = ({ left }) => { track.scrollLeft = left; };
  next.click();
  assert.equal(track.scrollLeft, 300);
  assert.equal(gallery.querySelector('[data-gallery-count]').textContent, '2 / 3');
  assert.equal(prev.disabled, false);
  track.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(track.scrollLeft, 600);
  assert.equal(next.disabled, true);
  assert.equal(gallery.querySelector('[data-gallery-count]').textContent, '3 / 3');
  track.scrollLeft = 300; track.dispatchEvent(new w.Event('scroll'));
  assert.equal(gallery.querySelector('[data-gallery-count]').textContent, '2 / 3', 'свайп обновляет счётчик');
  prev.click();
  assert.equal(track.scrollLeft, 0);
  // Кнопка «Купить» и цена на месте.
  assert.ok(root.querySelector('[data-add][data-id="bukety-1"]'));
});

test('каталог: gallery проходит в карточку, разметка Product получает все фото', () => {
  const item = { ...ITEM, gallery: ['/api/assets/a.jpg', 'http://evil.example/x.jpg'], tags: ['bukety'] };
  const schema = catalog.schema([item], 'https://palitra-love.ru', '/catalog/bukety');
  assert.deepEqual(schema.itemListElement[0].item.image, ['https://palitra-love.ru/assets/img/gortenzii.jpg', 'https://palitra-love.ru/api/assets/a.jpg']);
  const single = catalog.schema([ITEM], 'https://palitra-love.ru', '/catalog/bukety');
  assert.equal(single.itemListElement[0].item.image, 'https://palitra-love.ru/assets/img/gortenzii.jpg', 'одно фото — строкой, как раньше');
  const dom = page();
  const html = catalog.card(item, dom.window.PalitraPrice.productCard);
  assert.ok(html.includes('data-gallery'));
  assert.ok(!html.includes('evil.example'));
});
