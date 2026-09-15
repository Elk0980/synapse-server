'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../../sites/alvi');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const price = JSON.parse(fs.readFileSync(path.join(root, 'data/price.json'), 'utf8'));
const source = html.slice(html.indexOf('const DEFAULT_QUIZ_ITEMS'), html.indexOf('// T4/T6: mobile'));
const renderer = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'price-render.js'), 'utf8'), { window: renderer });
function quiz(load = async () => price) {
  let submit, change, loads = 0;
  const consent = { checked: true, addEventListener(type, fn) { if (type === 'change') change = fn; } };
  const button = { disabled: true };
  const form = { values: {}, querySelector: s => s.includes('personal_data_consent') ? consent : button, addEventListener(type, fn) { if (type === 'submit') submit = fn; } };
  const result = { hidden: true, focus() {}, scrollIntoView() {} }, grid = {};
  const AlviPrice = { ...renderer.AlviPrice, async load() { loads++; return load(); } };
  const context = { window: { AlviPrice }, AlviPrice, quizForm: form, quizResult: result, quizResultGrid: grid, reducedMotionQuery: { matches: true }, FormData: class { constructor(f) { this.values = { ...f.values }; } get(k) { return this.values[k]; } } };
  vm.runInNewContext(source + '\nconst originalRender = renderQuizResults; renderQuizResults = (items, links) => { this.selected = items; originalRender(items, links); }; setupQuiz();', context);
  return {
    button, result, grid, get loads() { return loads; },
    changeConsent(checked) { consent.checked = checked; change(); },
    async choose(key) {
      const [recipient, time, priority] = key.split('|');
      form.values = { recipient, time, priority }; context.selected = [];
      await submit({ preventDefault() {} });
      return { html: grid.innerHTML || '', ids: Array.from(context.selected, item => item.id) };
    }
  };
}
test('both recommendations respect guests and visible duration for all 18 service combinations', async () => {
  const options = [...html.matchAll(/name="time" value="([^"]+)"[^>]*>([^<]+)</g)].map(m => [m[1], m[2]]);
  assert.deepEqual(options, [['hour', '1–1,5 часа'], ['few-hours', '2–3 часа'], ['half-day', '3–4 часа']]);
  const allowed = { 'self|hour': ['s1-9', 's4-2'], 'self|few-hours': ['s1-1', 's1-7'], 'self|half-day': ['s1-7'], 'couple|hour': ['s4-1'], 'couple|few-hours': ['s2-1', 's2-2', 's2-3'], 'couple|half-day': ['s2-3'] };
  const q = quiz();
  for (const [answers, ids] of Object.entries(allowed)) for (const priority of ['tension', 'restore', 'together']) {
    const result = await q.choose(`${answers}|${priority}`);
    assert.equal(result.ids.length, Math.min(2, ids.length), `${answers}|${priority}`);
    assert.ok(result.ids.every(id => ids.includes(id)), `${answers}|${priority}: ${result.ids}`);
    assert.equal(new Set(result.ids).size, result.ids.length);
    assert.equal(q.result.hidden, false);
    const bookings = [...result.html.matchAll(/href="([^"]+)"[^>]*>Записаться</g)].map(m => m[1]);
    assert.equal(bookings.length, result.ids.length);
    assert.ok(bookings.every(url => url === 'https://n1070017.yclients.com/'));
  }
});
test('all gift combinations open certificates without booking or a catalog request, then service choices restore booking', async () => {
  const q = quiz(async () => { throw new Error('must not load'); });
  for (const time of ['hour', 'few-hours', 'half-day']) for (const priority of ['tension', 'restore', 'together']) {
    const result = await q.choose(`gift|${time}|${priority}`);
    assert.match(result.html, /Подарочный сертификат ALVI/);
    assert.match(result.html, /href="price\.html#s8">Выбрать сертификат/);
    assert.doesNotMatch(result.html, /Записаться|yclients/);
    assert.equal(q.result.hidden, false);
  }
  assert.equal(q.loads, 0);
  const next = quiz(); await next.choose('gift|hour|restore');
  const service = await next.choose('self|hour|restore');
  assert.match(service.html, />Записаться</);
  assert.doesNotMatch(service.html, /Выбрать сертификат/);
});
test('result photo stays inside one HTML attribute, including quotes and ampersands', async () => {
  const data = structuredClone(price), photo = 'img/test "quoted" & <tag>.jpg';
  data.categories[0].items.find(item => item.id === 's1-9').photo = photo;
  const result = await quiz(async () => data).choose('self|hour|restore');
  const styles = [...result.html.matchAll(/<article class="quiz-result__card" style="([^"]*)">/g)].map(m => m[1]);
  assert.equal(styles.length, result.ids.length, 'quotes must not end the style attribute');
  const decode = value => value.replace(/&(quot|amp|lt|gt);/g, (_, entity) => ({ quot: '"', amp: '&', lt: '<', gt: '>' })[entity]);
  assert.equal(decode(styles[0]), `--card-photo:url(${JSON.stringify(photo)})`);
  assert.equal(decode(styles[1]), '--card-photo:url("img/card-s4-2.jpg")');
  assert.doesNotMatch(result.html, /<tag>/);
});
test('legacy API booking URL cannot replace the known widget', async () => {
  const data = { ...price, links: { book: 'https://t.me/+79246180555' } };
  const result = await quiz(async () => data).choose('self|hour|restore');
  assert.match(result.html, /href="https:\/\/n1070017\.yclients\.com\/"[^>]*>Записаться/);
  assert.match(result.html, /href="https:\/\/t\.me\/\+79246180555"[^>]*>Помочь с выбором/);
});
test('catalog edits remove unavailable or out-of-range results and admit eligible new services', async () => {
  const data = structuredClone(price);
  for (const category of data.categories) for (const item of category.items) item.quizEnabled = false;
  data.categories.find(c => c.block === 'self').items.push(
    { id: 'new-fit', title: 'Новая программа', duration: '1,5 часа', price: '1 000 ₽', quizEnabled: true },
    { id: 'new-long', title: 'Длинная программа', duration: '2 часа', quizEnabled: true },
    { id: 'new-unknown', title: 'Без длительности', duration: '', quizEnabled: true }
  );
  const result = await quiz(async () => data).choose('self|hour|restore');
  assert.deepEqual(result.ids, ['new-fit']);
  const empty = await quiz(async () => data).choose('couple|hour|restore');
  assert.match(empty.html, /В подборке нет программ под выбранные условия/);
  assert.match(empty.html, /href="price\.html">Посмотреть весь прайс/);
  assert.doesNotMatch(empty.html, />Записаться</);
});
test('missing or failed catalog gives a visible next step', async () => {
  for (const load of [async () => null, async () => { throw new Error('unavailable'); }]) {
    const q = quiz(load), result = await q.choose('self|hour|restore');
    assert.match(result.html, /Не удалось загрузить подборку/);
    assert.match(result.html, /href="price\.html">Посмотреть весь прайс/);
    assert.equal(q.result.hidden, false);
    assert.equal(q.button.disabled, false);
  }
});
test('consent and pending state prevent repeated or overlapping quiz results', async () => {
  let resolve;
  const q = quiz(() => new Promise(done => { resolve = done; }));
  q.changeConsent(false); await q.choose('self|hour|restore');
  assert.equal(q.loads, 0);
  q.changeConsent(true);
  const pending = q.choose('self|hour|restore');
  assert.equal(q.button.disabled, true);
  q.changeConsent(false); q.changeConsent(true);
  assert.equal(q.button.disabled, true);
  await q.choose('couple|few-hours|restore');
  assert.equal(q.loads, 1);
  resolve(price); await pending;
  assert.equal(q.button.disabled, false);
});
