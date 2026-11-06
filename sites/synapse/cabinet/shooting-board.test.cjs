'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const SCRIPT = [
  '0–3 с | Лена | Привет! | Лена у стойки, улыбается | Наезд камеры | Добро пожаловать',
  '[Вставка: витрина крупно]',
  'Реквизит: поднос',
  'Таня: Беру два!'].join('\n');

function page({sketch = {available: true, used: 0, limit: 20, reason: ''}, canEdit = true, saved = {}} = {}) {
  const dom = new JSDOM('<main id="m"></main>', {url: 'https://cabinet.test/cabinet.html', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window, calls = [], registered = {};
  w.SynapseModules = {register: (id, def) => { registered[id] = def; }};
  for (const file of ['shooting-script.js', 'shooting-upload.js', 'shooting-board.js', 'shooting.js']) w.eval(read(file));
  let detail = {reel: {board: [], boardRevision: 0, sketches: {}, sketchStatus: sketch, ...saved},
    uploads: [{id: 3, kind: 'take', frame: 2, status: 'stored', name: 'vitrina.mov', size: 2e7, mime: 'video/quicktime', fileUrl: '/f/3'}]};
  const ctx = {companyCode: 'avokado', route: {path: ''}, csrfToken: 'csrf', navigate() {},
    crm: async () => ({approval: {status: 'approved'}, plan: {days: [{ideaId: 'r1', date: '2026-11-12', format: 'reel', topic: 'Меню', script: SCRIPT}]}, variants: []}),
    api: {get: async (p) => p === 'shooting/reels' ? {canEdit, storage: {canUpload: true}, reels: {}} : detail,
      post: async (p, body) => { calls.push(['post', p, body]); detail = {...detail, reel: {...detail.reel, sketches: {[body.frame]: {id: 9, url: '/content/shooting/sketches/9?companyCode=avokado'}}}}; return {}; }},
    settings: {content: {get: async () => ({settings: {}})}}};
  return {w, d: w.document, registered, ctx, calls};
}
async function openBoard(p) {
  const root = p.d.getElementById('m');
  await p.registered['content-shooting'].mount(root, p.ctx); await settle();
  root.querySelector('[data-board-open]').click(); await settle();
  return p.d.querySelector('.shoot-win');
}

test('раскадровка — окно «← Съёмка» с пометкой «Тестовая версия»: кадры по сценам, время, в кадре, действие, титр, «Загрузить»', async () => {
  const p = page(), win = await openBoard(p);
  assert.equal(win.getAttribute('role'), 'dialog');
  assert.equal(win.querySelector('.shoot-win__back').textContent, '← Съёмка');
  assert.equal(win.querySelector('.shoot-win__title').textContent, 'Раскадровка · №1');
  assert.equal(win.querySelector('.shoot-win__badge').textContent, 'Тестовая версия');
  const frames = win.querySelectorAll('.shoot-board__frame');
  assert.equal(frames.length, 3);
  assert.equal(frames[0].querySelector('.shoot-board__head b').textContent, 'Кадр 1 · 0–3 с');
  assert.equal(frames[0].querySelector('.shoot-board__shot').textContent, 'В кадре: Лена у стойки, улыбается');
  assert.match(frames[0].textContent, /Действие: Наезд камеры/); assert.match(frames[0].textContent, /Титр: «Добро пожаловать»/);
  assert.match(frames[1].textContent, /Действие: витрина крупно/);
  assert.equal(frames[2].querySelector('.shoot-board__shot').textContent, 'В кадре: Таня говорит в камеру', 'без «В кадре» — черновик из сценария');
  assert.ok([...frames].every((f) => f.querySelector('.shoot-board__head .shoot-upload').textContent === 'Загрузить'), '«Загрузить» у каждого кадра');
  assert.match(frames[1].querySelector('[data-files="2"]').textContent, /vitrina\.mov/);
  assert.equal(win.querySelectorAll('.shoot-sketch__ph').length, 3, 'нет картинки — заглушка');
  assert.ok([...win.querySelectorAll('.shoot-sketch__ph')].every((n) => n.textContent === 'эскиз · тест'));
  // Эскиз по нажатию — тот же запрос сервера, после ответа в кадре картинка.
  frames[0].querySelector('[data-sketch="1"]').click(); await settle();
  const post = p.calls.find((c) => c[0] === 'post');
  assert.equal(post[1], 'shooting/reels/r1/sketch'); assert.equal(post[2].frame, 1); assert.equal(post[2].line, 'Лена: Привет!');
  assert.equal(post[2].shot, 'Лена у стойки, улыбается');
  assert.ok(win.querySelector('[data-board-frame="1"] img.shoot-sketch__img'), 'эскиз показан в кадре');
  assert.equal(win.querySelectorAll('.shoot-sketch__ph').length, 2);
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', {key: 'Escape'}));
  assert.equal(p.d.querySelector('.shoot-win'), null);
});

test('эскиз недоступен — заглушка без кнопки, причина видна; сохранённая раскадровка показывается', async () => {
  const p = page({sketch: {available: false, used: 0, limit: 20, reason: 'Эскизы недоступны: у Хью нет проверенного ключа OpenAI.'},
    saved: {board: [{shot: 'старое', angle: 'снизу', transition: 'склейка', notes: ''}]}});
  const win = await openBoard(p);
  assert.equal(win.querySelectorAll('[data-sketch]').length, 0);
  assert.match(win.querySelector('.shoot-board__note').textContent, /тестовая версия.*ключа OpenAI/);
  assert.match(win.querySelector('[data-board-frame="1"]').textContent, /Ракурс: снизу · Смена плана: склейка/);
  const viewer = page({canEdit: false}), viewerWin = await openBoard(viewer);
  assert.equal(viewerWin.querySelectorAll('[data-sketch]').length, 0, 'без права правки эскиз не рисуется');
  assert.ok([...viewerWin.querySelectorAll('.shoot-upload')].every((b) => b.disabled));
});
