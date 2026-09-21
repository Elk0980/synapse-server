'use strict';
/* Заявка на материалы на настоящем экране кабинета, вместе с модулем требований. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const screen = fs.readFileSync(path.join(__dirname, 'media-mentor.js'), 'utf8');
const materials = fs.readFileSync(path.join(__dirname, 'media-mentor-materials.js'), 'utf8');

const VOCAB = {
  platforms: [{ id: 'vk', label: 'ВКонтакте' }, { id: 'telegram', label: 'Telegram' }],
  formats: [{ id: 'post', label: 'Пост' }, { id: 'reel', label: 'Reels' }],
  roles: [{ id: 'reach', label: 'Охват' }], shootingComfort: [{ id: 'hands_only', label: 'Руки' }],
  assetKinds: [{ id: 'photo', label: 'Фото' }], minDays: 7, maxDays: 14,
};
const dataWith = (days) => ({
  companyCode: 'alvi', notice: '',
  brief: { revision: 3, updatedAt: null, history: [],
    fields: { goal: 'Ц', product: 'Тайский массаж', audience: 'А', pains: [], confirmedFacts: [],
      assets: [{ id: 'a1', title: 'Фото', kind: 'photo', note: '' }],
      shootingComfort: { level: 'hands_only', notes: '' }, platforms: ['vk', 'telegram'] } },
  plan: { revision: 1, briefRevision: 3, startDate: '2026-09-21', endDate: '2026-09-27',
    windowDays: 7, updatedAt: null, history: [], days },
  approval: { status: 'absent' }, approvals: [], vocabulary: VOCAB, capabilities: {},
});
const day = (over = {}) => ({ date: '2026-09-21', platform: 'vk', format: 'post', role: 'reach',
  topic: 'Разминка спины', hook: '', assetId: '', mentorNote: '', ...over });

async function open(days, { withMaterials = true } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://cabinet.test/', runScripts: 'outside-only' });
  const { window } = dom;
  const calls = [];
  const ctx = { identity: { role: 'owner', permissions: [], csrfToken: 't' }, selectedProjectId: 'alvi',
    crmQuery: async () => dataWith(days), apiJson: async (url) => { calls.push(url); return {}; },
    csrfOptions: (method, body) => ({ method, body }), registerView: () => {} };
  window.SbCabinet = ctx;
  if (withMaterials) window.eval(materials);
  window.eval(screen);
  const root = window.document.querySelector('#root');
  window.SbCabinet.mediaMentor.render(root, ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { root, window, calls };
}

test('заявка появляется только для позиций без исходника', async () => {
  const { root } = await open([day(), day({ date: '2026-09-22', assetId: 'a1' })]);
  const block = root.querySelector('.mentor-materials');
  assert.ok(block);
  assert.equal(block.querySelectorAll('.mentor-plan-list > li').length, 1);
});

test('все исходники выбраны — заявки нет и экран не захламляется', async () => {
  const { root } = await open([day({ assetId: 'a1' })]);
  assert.equal(root.querySelector('.mentor-materials'), null);
});

test('в заявке видно площадку, формат, соотношение и разрешение', async () => {
  const { root } = await open([day({ format: 'reel' })]);
  const text = root.querySelector('.mentor-materials').textContent;
  assert.match(text, /ВКонтакте/);
  assert.match(text, /Reels/);
  assert.match(text, /9:16/);
  assert.match(text, /2160 × 3840/);
});

test('безопасная зона площадки видна прямо в списке', async () => {
  const { root } = await open([day({ format: 'reel', platform: 'tiktok' })]);
  const text = root.querySelector('.mentor-materials').textContent;
  assert.match(text, /вне краёв, которые закрывает интерфейс/);
  assert.match(text, /снизу 19%/);
});

test('неподтверждённые требования площадки показываются предупреждением', async () => {
  const { root } = await open([day({ format: 'story', platform: 'telegram' })]);
  assert.match(root.querySelector('.mentor-materials').textContent, /не подтверждена|самой строгой/);
});

test('промт готов к копированию и содержит требования стандарта', async () => {
  const { root } = await open([day()]);
  const prompt = root.querySelector('[data-prompt="0"]').value;
  assert.match(prompt, /строго 4:5/, 'лента ВКонтакте ждёт вертикаль, а не 16:9');
  assert.match(prompt, /PNG без потерь/);
  assert.match(prompt, /только руки и процесс/);
});

test('кнопка копирования сообщает об успехе', async () => {
  const { root, window } = await open([day()]);
  let copied = '';
  window.navigator.clipboard = { writeText: async (value) => { copied = value; } };
  root.querySelector('[data-prompt-copy="0"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(copied, /Разминка спины/);
  assert.match(root.querySelector('[data-prompt-state="0"]').textContent, /скопирован/);
});

test('недоступный буфер обмена не молчит', async () => {
  const { root, window } = await open([day()]);
  window.navigator.clipboard = { writeText: async () => { throw Error('нет доступа'); } };
  root.querySelector('[data-prompt-copy="0"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(root.querySelector('[data-prompt-state="0"]').textContent, /скопируйте вручную/);
});

test('больше двух роликов — предупреждение про лимит аккаунта', async () => {
  const days = ['2026-09-21', '2026-09-22', '2026-09-23'].map((date) => day({ date, format: 'reel' }));
  const { root } = await open(days);
  assert.match(root.querySelector('.mentor-materials').textContent, /два ролика в окно/);
});

test('заявка не обращается к серверу и к модели', async () => {
  const { calls } = await open([day(), day({ date: '2026-09-22', format: 'reel' })]);
  assert.equal(calls.length, 0);
});

test('без модуля требований экран не падает и заявку не рисует', async () => {
  const { root } = await open([day()], { withMaterials: false });
  assert.equal(root.querySelector('.mentor-materials'), null);
  assert.ok(root.querySelector('#mentor-plan-form'), 'остальной экран должен работать');
});
