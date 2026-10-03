/* Редактор прайса Palitra: место под фото резервируется до загрузки (specs/086).
   Причина замечания «пропадают фото при прокрутке»: ленивое фото без размеров до загрузки имело высоту 0,
   каждая догрузка сдвигала страницу на высоту фото (на стенде 303 карточки: высота страницы росла
   с 79 954 до 128 849 px во время прокрутки). jsdom раскладку не измеряет — проверяются разметка и правило CSS;
   измерения прокрутки — в отчёте (Chromium, локальный стенд), не Safari.
   node --test sites/synapse/price-editor-palitra-photos.test.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const html = read('price-editor-palitra.html');
const renderer = () => { const window = {}; vm.runInNewContext(read('price-render-palitra.js'), { window }); return window.PalitraPrice; };
const DATA = { categories: [{ id: 'vypiska', title: 'Выписка', items: [
  { id: 'a', title: 'С фото', price: '100', photo: '/api/assets/a.webp' },
  { id: 'b', title: 'Без фото', price: '' }
] }] };

test('фото карточки: ленивое, с размерами 4:5 до загрузки; без фото — без img', () => {
  const out = renderer().renderSections(DATA, { editor: true, starHtml: () => '', editHtml: () => '' });
  const imgs = out.match(/<img [^>]*>/g) || [];
  assert.equal(imgs.length, 1);
  for (const attr of ['loading="lazy"', 'decoding="async"', 'width="800"', 'height="1000"', 'class="price-card__photo"']) assert.ok(imgs[0].includes(attr), attr);
  assert.ok(imgs[0].includes('src="/api/assets/a.webp"'), 'путь фото не меняется рендером (подставляет редактор)');
});

test('CSS редактора резервирует место под фото: ширина карточки × 5/4, без перебивающих правил', () => {
  const css = html.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]*\.price-card__photo[^{}]*)\{([^}]*)\}/g)].map((m) => [m[1].trim().split('\n').pop().trim(), m[2]]);
  const main = rules.find(([selector]) => selector === '.pc .price-card__photo');
  assert.ok(main, 'правило .pc .price-card__photo есть');
  for (const decl of [/(^|;)\s*width:\s*100%/, /height:\s*auto/, /aspect-ratio:\s*4\s*\/\s*5/, /object-fit:\s*cover/, /display:\s*block/]) assert.match(main[1], decl);
  for (const [selector, body] of rules) {
    if (selector === '.pc .price-card__photo') continue;
    assert.doesNotMatch(body, /(^|;)\s*(width|height|aspect-ratio)\s*:/, `${selector} не перебивает размеры`);
  }
  assert.match(html, /<script src="price-render-palitra\.js\?v=20261002photos1"><\/script>/, 'новый рендер не берётся из кеша браузера');
});
