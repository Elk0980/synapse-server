// Раздел (категория) товара в редакторе Palitra (замечания Дарьи 20.09: «как добавить категорию»,
// «по ключевому слову определялось»). Подсказка раздела по названию — только предложение с явным
// применением; других товаров и данных не меняет. Синтетические данные, без рабочего каталога.
// NODE_PATH=<jsdom> node --test sites/synapse/price-editor-palitra-category.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'price-editor-palitra.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'price-render-palitra.js'), 'utf8');
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const tick = () => new Promise((resolve) => setImmediate(resolve));
const profile = { role: 'owner', csrfToken: 'synthetic-csrf-only' };
const SEED = {
  version: 1, blocks: { self: { title: 'Популярное', max: 8 }, two: { title: 'Подборки', max: 8 } }, showcase: { self: ['vypiska-1'], two: [] },
  categories: [
    { id: 'vypiska', title: 'Выписка из роддома', kind: 'programs', block: 'self', items: [{ id: 'vypiska-1', title: 'Выписка мальчика', price: '9 270 руб.', oldPrice: '9 990 руб.', quizEnabled: true, photo: '/api/assets/v.jpg' }] },
    { id: 'bukety', title: 'Букеты', kind: 'programs', block: 'self', items: [{ id: 'bukety-1', title: 'Белые гортензии', price: '' }] },
    { id: 'korziny', title: 'Корзины и композиции', kind: 'programs', block: 'self', items: [] },
    { id: 'dr-muzhchine', title: 'День рождения мужчине', kind: 'programs', block: 'self', items: [{ id: 'dr-muzhchine-1', title: 'Новая позиция', price: '' }] },
    { id: 's9', title: 'Услуги', kind: 'table', block: 'two', head: ['Услуга', 'Длительность', 'Цена'], items: [{ id: 's9-1', title: 'Доставка', price: '' }] },
  ],
};

async function editor(seed = SEED) {
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(html, { url: 'https://cabinet.test/price-editor-palitra.html', runScripts: 'outside-only', virtualConsole: vc });
  const w = dom.window; w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {}; w.CSS = { escape: (s) => s }; w.alert = () => {};
  let saved = structuredClone(seed); let puts = 0;
  w.fetch = async (url, opts = {}) => {
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url === '/content/whoami') return ok(profile);
    if (opts.method === 'PUT') { puts += 1; saved = { ...JSON.parse(opts.body), version: 2 }; return ok({ ok: true, version: 2 }); }
    return ok(structuredClone(saved));
  };
  w.eval(renderer); w.eval(code);
  for (let i = 0; i < 5; i++) await tick();
  const d = w.document;
  const open = (id) => { d.querySelector(`[data-edit="${id}"]`).click(); return d.querySelector(`form[data-form="${id}"]`); };
  const submit = (form) => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const typeTitle = (form, value) => { form.elements.title.value = value; form.elements.title.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const save = async () => { d.querySelector('#ed-save').click(); for (let i = 0; i < 5; i++) await tick(); return saved; };
  const where = (doc, id) => doc.categories.find((c) => c.items.some((it) => it.id === id))?.id;
  return { w, d, errors, open, submit, typeTitle, save, where, puts: () => puts, status: () => d.querySelector('#ed-status').textContent, close: () => w.close() };
}

test('suggestCategory: ключевые слова и название раздела, только существующие разделы того же вида, ничья — без подсказки', async () => {
  const e = await editor();
  try {
    const s = (title, current = 'dr-muzhchine') => { const r = e.w.PalitraEditorCategory.suggestCategory(SEED, title, current); return r && r.id; };
    assert.equal(s('Букет из 25 роз'), 'bukety');
    assert.equal(s('Выписка девочки, розовая'), 'vypiska', '«розовая» — не «розы»');
    assert.equal(s('Букет из белых роз и эустомы'), 'bukety', 'несколько слов одного раздела');
    assert.equal(s('Корзина с ромашками'), 'korziny');
    assert.equal(s('Композиция в коробке'), 'korziny', 'слово из названия раздела');
    assert.equal(s('Шары папе на юбилей'), null, 'совпадение с текущим разделом не подсказывается');
    assert.equal(s('Шары папе на юбилей', 'bukety'), 'dr-muzhchine');
    assert.equal(s('Шары на праздник'), null, 'нет совпадений — нет подсказки');
    assert.equal(s('Букет в корзине'), null, 'ничья — нет подсказки');
    assert.equal(s('Шары-гиганты'), null, 'раздела «гиганты» в документе нет — не выдумываем');
    assert.equal(s('Букет доставка', 's9'), null, 'таблица не получает подсказку раздела с карточками');
    assert.equal(s(''), null);
  } finally { e.close(); }
});

test('форма: выбор раздела переносит товар при «Готово»; id, цены, фото, oldPrice, quizEnabled и отметка «популярное» сохраняются', async () => {
  const e = await editor();
  try {
    const form = e.open('vypiska-1');
    const select = form.querySelector('select[name="category"]');
    assert.deepEqual([...select.options].map((o) => o.value), ['vypiska', 'bukety', 'korziny', 'dr-muzhchine'], 'только разделы того же вида');
    assert.equal(select.value, 'vypiska');
    select.value = 'korziny';
    e.submit(form);
    const saved = await e.save();
    assert.equal(e.where(saved, 'vypiska-1'), 'korziny');
    const it = saved.categories.find((c) => c.id === 'korziny').items[0];
    assert.deepEqual(it, { ...SEED.categories[0].items[0], card: '', duration: '', who: '', desc: '', composition: '', note: '', items: [] });
    assert.deepEqual(saved.showcase.self, ['vypiska-1'], 'витрина ссылается на тот же id');
    assert.equal(saved.categories.find((c) => c.id === 'vypiska').items.length, 0);
    assert.equal(saved.categories.find((c) => c.id === 'bukety').items[0].title, 'Белые гортензии', 'другие товары не тронуты');
    assert.deepEqual(e.errors, []);
  } finally { e.close(); }
});

test('подсказка по названию появляется при вводе и применяется только кнопкой; без нажатия раздел не меняется', async () => {
  const e = await editor();
  try {
    let form = e.open('dr-muzhchine-1');
    const box = form.querySelector('[data-cat-suggest]');
    assert.equal(box.hidden, true, '«Новая позиция» — подсказки нет');
    e.typeTitle(form, 'Букет белых роз');
    assert.equal(box.hidden, false);
    assert.match(box.textContent, /похоже на раздел «Букеты»/);
    assert.equal(form.querySelector('select[name="category"]').value, 'dr-muzhchine', 'подсказка сама раздел не меняет');
    e.submit(form);
    let saved = await e.save();
    assert.equal(e.where(saved, 'dr-muzhchine-1'), 'dr-muzhchine', 'без явного выбора товар остался на месте');
    assert.equal(saved.categories.find((c) => c.id === 'dr-muzhchine').items[0].title, 'Букет белых роз');

    form = e.open('dr-muzhchine-1');
    form.querySelector('[data-cat-apply]').click();
    assert.equal(form.querySelector('select[name="category"]').value, 'bukety');
    assert.equal(form.querySelector('[data-cat-suggest]').hidden, true, 'после выбора подсказка скрыта');
    e.submit(form);
    saved = await e.save();
    assert.equal(e.where(saved, 'dr-muzhchine-1'), 'bukety');
    assert.deepEqual(saved.categories.find((c) => c.id === 'bukety').items.map((it) => it.id), ['bukety-1', 'dr-muzhchine-1'], 'добавлен в конец раздела');
  } finally { e.close(); }
});

test('перенос не превышает 8 популярных в разделе: товар остаётся на месте с понятным предупреждением', async () => {
  const seed = structuredClone(SEED);
  const full = Array.from({ length: 8 }, (_, i) => ({ id: `bukety-p${i}`, title: `Букет ${i}`, price: '' }));
  seed.categories[1].items.push(...full);
  seed.showcase.self = ['vypiska-1', ...full.slice(0, 7).map((it) => it.id)];
  seed.showcase.two = [full[7].id];
  const e = await editor(seed);
  try {
    const form = e.open('vypiska-1');
    form.querySelector('select[name="category"]').value = 'bukety';
    e.submit(form);
    assert.match(e.status(), /уже 8 популярных/);
    const saved = await e.save();
    assert.equal(e.where(saved, 'vypiska-1'), 'vypiska');
  } finally { e.close(); }
});

test('кнопка «Создать раздел «Акции»» создаёт один раздел promo без ошибок, повторное нажатие дубля не делает', async () => {
  const e = await editor();
  try {
    // Рендер Palitra заглушку «Акций» не выводит, поэтому кнопка добавляется так же, как её разметка в редакторе.
    const click = () => {
      const button = e.d.createElement('button'); button.type = 'button'; button.dataset.addpromo = '1';
      e.d.body.append(button); button.click(); button.remove();
    };
    click();
    assert.deepEqual(e.errors, [], 'нажатие не падает на отсутствующей функции');
    click();
    const saved = await e.save();
    const promo = saved.categories.filter((c) => c.id === 'promo');
    assert.equal(promo.length, 1);
    assert.deepEqual(promo[0], { id: 'promo', title: 'Акции', kind: 'programs', block: 'self', items: [] });
    assert.equal(saved.categories[0].id, 'promo', 'раздел добавлен первым');
    assert.equal(saved.categories.length, SEED.categories.length + 1, 'остальные разделы на месте');
  } finally { e.close(); }
});
