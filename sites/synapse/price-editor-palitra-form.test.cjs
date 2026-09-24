// Форма товара редактора Palitra после замечаний Дарьи (24.09.2026): обязательно только название,
// понятная цена с нормализацией однозначных чисел, редактируемое примечание, старые поля спрятаны
// в «Дополнительно» и сохраняются без потерь. Совместимость с корзиной — через priceKopecks сервера.
// NODE_PATH=<jsdom> node --test sites/synapse/price-editor-palitra-form.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { priceKopecks } = require('../../ops/content/site-orders.js');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'price-editor-palitra.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'price-render-palitra.js'), 'utf8');
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const tick = () => new Promise((resolve) => setImmediate(resolve));
const profile = { role: 'owner', csrfToken: 'synthetic-csrf-only' };
const LEGACY = {
  id: 'bukety-1', title: 'Букет из хризантем', price: '9 270 руб.', desc: 'Нежный букет.',
  note: 'Цена из публикации от 07.05.2026; актуальность уточняется при заказе.',
  card: 'Хризантемы', who: 'маме', duration: '2 часа', composition: 'хризантемы, зелень', items: ['15 хризантем', 'лента'],
  oldPrice: '10 990 руб.', quizEnabled: true, photo: '/api/assets/a.jpg'
};
const SEED = { version: 1, blocks: { self: { title: 'Популярное', max: 8 }, two: { title: 'На двоих', max: 8 } }, showcase: { self: [], two: [] },
  categories: [{ id: 'bukety', title: 'Букеты', kind: 'programs', block: 'self', items: [LEGACY, { id: 'bukety-2', title: 'Без цены', price: '' }] }] };

async function editor() {
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(html, { url: 'https://cabinet.test/price-editor-palitra.html', runScripts: 'outside-only', virtualConsole: vc });
  const w = dom.window; w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {}; w.CSS = { escape: (s) => s }; w.alert = () => {};
  let saved = structuredClone(SEED);
  w.fetch = async (url, opts = {}) => {
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url === '/content/whoami') return ok(profile);
    if (opts.method === 'PUT') { saved = { ...JSON.parse(opts.body), version: 2, updatedAt: '2026-09-24T10:00:00Z' }; return ok({ ok: true, version: 2, updatedAt: saved.updatedAt }); }
    assert.equal(opts.method || 'GET', 'GET');
    return ok(structuredClone(saved));
  };
  w.eval(renderer); w.eval(code);
  for (let i = 0; i < 5; i++) await tick();
  const d = w.document;
  const open = (id) => { d.querySelector(`[data-edit="${id}"]`).click(); return d.querySelector(`form[data-form="${id}"]`); };
  const submit = (form) => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const save = async () => { d.querySelector('#ed-save').click(); for (let i = 0; i < 5; i++) await tick(); return saved; };
  const status = () => d.querySelector('#ed-status').textContent;
  // Объект из окна jsdom копируется в реалм теста: deepEqual сравнивает прототипы.
  const normalize = (value) => ({ ...w.PalitraEditorPrice.normalizePrice(value) });
  return { w, d, errors, open, submit, save, status, normalize, close: () => w.close() };
}

test('normalizePrice: однозначные числа → формат сайта, копейки сохраняются, пусто остаётся пустым, текст и ноль — без изменений', async () => {
  const e = await editor();
  try {
    const n = e.normalize;
    assert.deepEqual(n('7720'), { value: '7 720 руб.', kind: 'number' });
    assert.deepEqual(n(' 7 720 руб. '), { value: '7 720 руб.', kind: 'number' }, 'уже нормализованное не меняется');
    assert.deepEqual(n('7 720 руб'), { value: '7 720 руб.', kind: 'number' }, 'неразрывные пробелы');
    assert.deepEqual(n('10990 ₽'), { value: '10 990 руб.', kind: 'number' });
    assert.deepEqual(n('1234567р.'), { value: '1 234 567 руб.', kind: 'number' });
    assert.deepEqual(n('7720,50'), { value: '7 720,50 руб.', kind: 'number' });
    assert.deepEqual(n('7720.5'), { value: '7 720,50 руб.', kind: 'number' });
    assert.deepEqual(n('0,50'), { value: '0,50 руб.', kind: 'number' });
    assert.deepEqual(n('0007720'), { value: '7 720 руб.', kind: 'number' });
    assert.deepEqual(n(''), { value: '', kind: 'empty' });
    assert.deepEqual(n('   '), { value: '', kind: 'empty' });
    for (const text of ['от 5000', '7720 за шт.', '5000–7000', '7720 руб/шт', 'договорная', '0', '0 руб.', '7720,999', '99999999999999']) {
      const result = n(text);
      assert.equal(result.kind, 'text', text);
      assert.equal(result.value, text.replace(/\s+/g, ' ').trim(), text + ' сохраняется как введено');
    }
  } finally { e.close(); }
});

test('совместимость с корзиной: нормализованная строка даёт те же копейки, что ввёл владелец; текстовые цены — «уточняется»', async () => {
  const e = await editor();
  try {
    const n = e.normalize;
    for (const [input, kopecks] of [['7720', 772000], ['7720,50', 772050], ['7720.05', 772005], ['9 270 руб.', 927000], ['10990 ₽', 1099000], ['0,50', 50]]) {
      assert.equal(priceKopecks(n(input).value), kopecks, input);
    }
    for (const text of ['от 5000', '7720 за шт.', '5000–7000']) assert.equal(priceKopecks(n(text).value), null, text);
  } finally { e.close(); }
});

test('форма: обязательно только название; старые поля в «Дополнительно» с честной подписью; примечание редактируется', async () => {
  const e = await editor();
  try {
    const form = e.open('bukety-1');
    assert.ok(form, 'форма открылась');
    const required = [...form.querySelectorAll('[required]')].map((i) => i.name);
    assert.deepEqual(required, ['title']);
    assert.match(form.textContent, /Обязательно только название/);
    assert.equal(form.querySelector('input[name="price"]').getAttribute('type'), null, 'цена — текстовое поле, строковые цены не ломаются');
    assert.equal(form.querySelector('input[name="price"]').getAttribute('inputmode'), 'decimal');
    assert.match(form.textContent, /7720 → сохранится «7 720 руб\.»/);
    assert.equal(form.querySelector('input[name="note"]').value, LEGACY.note);
    assert.match(form.textContent, /на сайте не показывается — здесь её можно стереть/);
    const more = form.querySelector('details.ed-more');
    assert.ok(more && !more.open, 'дополнительные поля свёрнуты');
    assert.match(more.textContent, /Сайт Palitra эти поля сейчас не показывает/);
    for (const name of ['card', 'who', 'duration', 'composition']) assert.equal(more.querySelector(`[name="${name}"]`).value, LEGACY[name], name);
    assert.equal(more.querySelector('textarea[name="items"]').value, '15 хризантем\nлента');
    assert.doesNotMatch(form.textContent, /на главной|Длительность.*главн/, 'нет обещаний показа на главной');
    assert.deepEqual(e.errors, []);
  } finally { e.close(); }
});

test('обычное редактирование: цена 7720 → «7 720 руб.», все старые поля, oldPrice/quizEnabled и примечание сохраняются без потерь; сохраняется только эта позиция', async () => {
  const e = await editor();
  try {
    const form = e.open('bukety-1');
    form.querySelector('input[name="price"]').value = '7720';
    form.querySelector('input[name="desc"]').value = 'Обновлённое описание';
    e.submit(form);
    const saved = await e.save();
    const item = saved.categories[0].items[0];
    assert.equal(item.price, '7 720 руб.');
    assert.equal(item.desc, 'Обновлённое описание');
    for (const key of ['title', 'note', 'card', 'who', 'duration', 'composition', 'photo', 'oldPrice', 'quizEnabled']) assert.deepEqual(item[key], LEGACY[key], key);
    assert.deepEqual(item.items, LEGACY.items);
    assert.deepEqual(saved.categories[0].items[1], { id: 'bukety-2', title: 'Без цены', price: '' }, 'соседняя позиция не тронута');
    assert.match(e.status(), /Сохранено/);
    assert.deepEqual(e.errors, []);
  } finally { e.close(); }
});

test('нечисловая цена сохраняется как введено с предупреждением; пустая цена остаётся пустой, не 0; примечание можно стереть', async () => {
  const e = await editor();
  try {
    let form = e.open('bukety-1');
    form.querySelector('input[name="price"]').value = 'от 5 000 руб. за шт.';
    form.querySelector('input[name="note"]').value = '';
    e.submit(form);
    assert.match(e.status(), /сохранена как текст.*цена уточняется/);
    let saved = await e.save();
    assert.equal(saved.categories[0].items[0].price, 'от 5 000 руб. за шт.');
    assert.equal(saved.categories[0].items[0].note, '');
    form = e.open('bukety-1');
    form.querySelector('input[name="price"]').value = '';
    form.querySelector('input[name="note"]').value = 'Состав: 15 хризантем';
    e.submit(form);
    assert.doesNotMatch(e.status(), /как текст/);
    saved = await e.save();
    assert.equal(saved.categories[0].items[0].price, '');
    assert.equal(saved.categories[0].items[0].note, 'Состав: 15 хризантем');
    assert.ok(!JSON.stringify(saved).includes('"price":"0'), 'пусто не превращается в 0');
    assert.deepEqual(e.errors, []);
  } finally { e.close(); }
});

test('существующие действия подписаны понятно: как видят покупатели, новый раздел (категория), добавить товар', async () => {
  const e = await editor();
  try {
    const site = e.d.querySelector('#ed-open-price');
    assert.equal(site.textContent.trim(), 'Как видят покупатели ↗');
    assert.equal(site.getAttribute('href'), 'https://palitra-love.synapsebusiness.ru/price.html');
    assert.equal(e.d.querySelector('#ed-addcat').textContent.trim(), '+ Новый раздел (категория)');
    assert.equal(e.d.querySelector('[data-additem="bukety"]').textContent.trim(), '+ Добавить товар');
    assert.doesNotMatch(html, /price-render\.js с сайта Palitra|palitra-love\.synapsebusiness\.ru\. Проверьте/, 'устаревший текст ошибки убран');
  } finally { e.close(); }
});
