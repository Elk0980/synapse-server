'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../../sites/alvi');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const price = JSON.parse(fs.readFileSync(path.join(root, 'data/price.json'), 'utf8'));
const source = html.slice(html.indexOf('const QUIZ_PROGRAMS ='), html.indexOf('// T4/T6: mobile'));
function quiz() {
  let submit;
  const form = { values: {}, querySelector: () => null, addEventListener(type, fn) { if (type === 'submit') submit = fn; } };
  const result = { hidden: true, focus() {}, scrollIntoView() {} };
  const action = {}, title = {}, copy = {};
  const context = { quizForm: form, quizResult: result, quizResultAction: action, quizResultTitle: title, quizResultCopy: copy, reducedMotionQuery: { matches: true }, FormData: class { constructor(f) { this.values = f.values; } get(k) { return this.values[k]; } } };
  vm.runInNewContext(source + '\nsetupQuiz(); this.matches = QUIZ_MATCHES;', context);
  return { matches: context.matches, choose(key) { const [recipient, time, priority] = key.split('|'); form.values = { recipient, time, priority }; submit({ preventDefault() {} }); return { ...action, title: title.textContent, hidden: result.hidden }; } };
}
test('all gift combinations open certificate help, and later service choices restore booking', () => {
  const q = quiz();
  assert.equal(Object.keys(q.matches).length, 27);
  const keys = Object.keys(q.matches).sort((a, b) => Number(b.startsWith('gift')) - Number(a.startsWith('gift')));
  for (const key of keys) {
    const result = q.choose(key), gift = key.startsWith('gift|');
    assert.equal(result.hidden, false, key);
    assert.ok(result.title, key);
    assert.equal(result.textContent, gift ? 'Оформить сертификат' : 'Записаться', key);
    assert.equal(result.href, gift ? 'https://t.me/+79246180555' : 'https://n1070017.yclients.com/', key);
  }
});
test('three visible time ranges include the catalog duration of every recommended service', () => {
  const options = [...html.matchAll(/name="time" value="([^"]+)"[^>]*>([^<]+)</g)].map(m => [m[1], m[2]]);
  assert.deepEqual(options, [['hour', '1–1,5 часа'], ['few-hours', '2–3 часа'], ['half-day', '3–4 часа']]);
  const ranges = { hour: [60, 90], 'few-hours': [120, 180], 'half-day': [180, 240] };
  const ids = { relax: 's1-9', soul: 's1-1', aroma: 's1-7', back: 's4-2', pair: 's4-1', renewal: 's2-2', calm: 's2-1', spaDay: 's2-3' };
  const items = new Map(price.categories.flatMap(c => c.items || []).map(x => [x.id, x]));
  const duration = text => text.split('/').map(part => (Number(part.match(/(\d+)\s*час/)?.[1] || 0) * 60) + Number(part.match(/(\d+)\s*мин/)?.[1] || 0));
  for (const [key, program] of Object.entries(quiz().matches)) {
    if (program === 'gift') continue;
    const item = items.get(ids[program]), [min, max] = ranges[key.split('|')[1]];
    assert.ok(item, program);
    assert.ok(duration(item.duration).every(n => n >= min && n <= max), `${key}: ${item.duration}`);
  }
});
