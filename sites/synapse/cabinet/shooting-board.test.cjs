'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const SCRIPT = 'Лена: Привет!\n[Вставка: витрина крупно]\nРеквизит: поднос\nТаня: Беру два!';

function page({sketch = {available: true, used: 0, limit: 20, reason: ''}, canEdit = true} = {}) {
  const dom = new JSDOM('<main id="m"></main>', {url: 'https://cabinet.test/cabinet.html', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window, calls = [], registered = {};
  w.SynapseModules = {register: (id, def) => { registered[id] = def; }};
  for (const file of ['shooting-script.js', 'shooting-upload.js', 'shooting-board.js', 'shooting.js']) w.eval(read(file));
  let detail = {reel: {board: [], boardRevision: 0, sketches: {}, sketchStatus: sketch}, uploads: []};
  const ctx = {companyCode: 'avokado', route: {path: 'r1'}, csrfToken: 'csrf', navigate() {},
    crm: async () => ({approval: {status: 'approved'}, plan: {days: [{ideaId: 'r1', date: '2026-11-12', format: 'reel', topic: 'Меню', script: SCRIPT}]}, variants: []}),
    api: {get: async (p) => p === 'shooting/reels' ? {canEdit, storage: {canUpload: true}, reels: {}} : detail,
      put: async (p, body) => { calls.push(['put', p, body]); detail = {reel: {...detail.reel, board: body.frames, boardRevision: body.revision + 1, updatedBy: 'SAMPLE'}, uploads: []}; return detail; },
      post: async (p, body) => { calls.push(['post', p, body]); detail = {reel: {...detail.reel, sketches: {[body.frame]: {id: 9, url: '/content/shooting/sketches/9?companyCode=avokado'}}}, uploads: []}; return {}; }},
    settings: {content: {get: async () => ({settings: {}})}}};
  return {w, d: w.document, registered, ctx, calls};
}

test('раскадровка: черновик из сценария, правка и сохранение с версией, эскиз с пометкой тестовой версии', async () => {
  const p = page(), root = p.d.getElementById('m');
  await p.registered['content-shooting'].mount(root, p.ctx); await settle();
  root.querySelector('[data-tab=board]').click(); await settle();
  const frames = root.querySelectorAll('.shoot-board__frame');
  assert.equal(frames.length, 3);
  assert.equal(frames[1].querySelector('[data-key=angle]').value, 'крупный план');
  assert.equal(frames[1].querySelector('[data-key=notes]').value, 'поднос');
  assert.equal(root.querySelectorAll('.shoot-sketch__badge').length, 3);
  assert.ok([...root.querySelectorAll('.shoot-sketch__badge')].every((b) => b.textContent === '🧪 ТЕСТОВАЯ ВЕРСИЯ'));
  frames[0].querySelector('[data-key=angle]').value = 'снизу, на уровне стойки';
  root.querySelector('[data-board-save]').click(); await settle();
  const put = p.calls.find((c) => c[0] === 'put');
  assert.equal(put[1], 'shooting/reels/r1/board'); assert.equal(put[2].revision, 0); assert.equal(put[2].frames[0].angle, 'снизу, на уровне стойки');
  assert.match(root.textContent, /Раскадровка сохранена/);
  root.querySelector('[data-sketch="1"]').click(); await settle();
  const post = p.calls.find((c) => c[0] === 'post');
  assert.equal(post[1], 'shooting/reels/r1/sketch'); assert.equal(post[2].frame, 1); assert.equal(post[2].line, 'Лена: Привет!');
  assert.ok(root.querySelector('[data-board-frame="1"] img'), 'эскиз показан в кадре');
});

test('эскиз недоступен — кнопка выключена, причина видна', async () => {
  const p = page({sketch: {available: false, used: 0, limit: 20, reason: 'Эскизы недоступны: у Хью нет проверенного ключа OpenAI. Нужно от Влада: …'}});
  const root = p.d.getElementById('m');
  await p.registered['content-shooting'].mount(root, p.ctx); await settle();
  root.querySelector('[data-tab=board]').click(); await settle();
  assert.ok([...root.querySelectorAll('[data-sketch]')].every((b) => b.disabled));
  assert.match(root.querySelector('.shoot-sketch').textContent, /недоступны.*Нужно от Влада/);
});
