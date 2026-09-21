'use strict';
/* Экран подсказки плана: проверяется на настоящем файле кабинета, а не на копии разметки. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, 'media-mentor.js'), 'utf8');

const VOCAB = {
  platforms: [{ id: 'vk', label: 'ВКонтакте' }, { id: 'telegram', label: 'Telegram' }],
  formats: [{ id: 'post', label: 'Пост' }, { id: 'reel', label: 'Reels' }],
  roles: [{ id: 'reach', label: 'Охват' }, { id: 'sale', label: 'Продажа' }],
  shootingComfort: [{ id: 'unknown', label: 'Не выяснено' }],
  assetKinds: [{ id: 'photo', label: 'Фото' }], minDays: 7, maxDays: 14,
};
const DATA = {
  companyCode: 'alvi', notice: '',
  brief: { revision: 3, updatedAt: '2026-09-19T10:00:00Z', history: [],
    fields: { goal: 'Ц', product: 'П', audience: 'А', pains: [], confirmedFacts: [],
      assets: [{ id: 'a1', title: 'Фото', kind: 'photo', note: '' }],
      shootingComfort: { level: 'unknown', notes: '' }, platforms: ['vk', 'telegram'] } },
  plan: null, approval: { status: 'absent' }, approvals: [], vocabulary: VOCAB,
  capabilities: {},
};

function boot({ answer, throws = null } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://cabinet.test/', runScripts: 'outside-only' });
  const { window } = dom;
  const calls = [];
  const ctx = {
    identity: { role: 'owner', permissions: [], csrfToken: 't' },
    selectedProjectId: 'alvi',
    crmQuery: async () => DATA,
    apiJson: async (url, options) => { calls.push({ url, options }); if (throws) throw Error(throws); return answer; },
    csrfOptions: (method, body) => ({ method, body }),
    registerView: () => {},
  };
  window.SbCabinet = ctx;
  window.eval(source);
  return { window, ctx, calls, dom };
}

async function openPlan(boot1) {
  const { window, ctx, calls } = boot1;
  const root = window.document.querySelector('#root');
  window.SbCabinet.mediaMentor.render(root, ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { root, window, ctx, calls };
}

test('на экране плана есть подсказка и она не обещает сохранения', async () => {
  const { root } = await openPlan(boot({ answer: {} }));
  const block = root.querySelector('[data-suggest]');
  assert.ok(block, 'блок подсказки отсутствует');
  assert.match(block.textContent, /Ничего не сохранится/);
  assert.ok(root.querySelector('[data-suggest-run]'));
});

test('раздел больше не утверждает, что подсказок модели нет', async () => {
  const { root } = await openPlan(boot({ answer: {} }));
  assert.ok(!root.textContent.includes('подсказок модели здесь нет'));
});

test('выбор длины плана ограничен 7–14 днями', async () => {
  const { root } = await openPlan(boot({ answer: {} }));
  const values = [...root.querySelectorAll('[data-suggest-days] option')].map((o) => Number(o.value));
  assert.deepEqual(values, [7, 8, 9, 10, 11, 12, 13, 14]);
});

test('без даты начала к модели не обращаемся', async () => {
  const b = boot({ answer: { status: 'ok', items: [], notice: '' } });
  const { root, calls } = await openPlan(b);
  root.querySelector('[data-suggest-run]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 0);
  assert.match(root.querySelector('[data-suggest-state]').textContent, /Укажите дату/);
});

test('предложение показывается, но в форму само не попадает', async () => {
  const items = [{ date: '2026-09-21', platform: 'vk', format: 'post', role: 'reach',
    topic: 'Тема дня', hook: 'Зацепка', assetId: '', mentorNote: '' }];
  const b = boot({ answer: { status: 'ok', items, dropped: [], notice: 'Это предложение модели' } });
  const { root } = await openPlan(b);
  root.querySelector('[data-suggest-start]').value = '2026-09-21';
  root.querySelector('[data-suggest-run]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(root.querySelector('[data-suggest-result]').textContent, /Тема дня/);
  assert.equal(root.querySelectorAll('[data-rows="days"] [data-row]').length, 0, 'позиции подставились без участия человека');
});

test('«Подставить в форму» наполняет строки плана', async () => {
  const items = [{ date: '2026-09-21', platform: 'vk', format: 'post', role: 'reach',
    topic: 'Тема дня', hook: '', assetId: 'a1', mentorNote: '' }];
  const b = boot({ answer: { status: 'ok', items, dropped: [], notice: 'n' } });
  const { root } = await openPlan(b);
  root.querySelector('[data-suggest-start]').value = '2026-09-21';
  root.querySelector('[data-suggest-run]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  root.querySelector('[data-suggest-apply]').click();
  const rows = root.querySelectorAll('[data-rows="days"] [data-row]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelector('[data-field="topic"]').value, 'Тема дня');
  assert.equal(rows[0].querySelector('[data-field="assetId"]').value, 'a1');
});

test('недоступная модель показывает причину и не даёт кнопки подстановки', async () => {
  const b = boot({ answer: { status: 'unavailable', items: [], dropped: [], notice: 'Провайдеры недоступны' } });
  const { root } = await openPlan(b);
  root.querySelector('[data-suggest-start]').value = '2026-09-21';
  root.querySelector('[data-suggest-run]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(root.querySelector('[data-suggest-result]').textContent, /Провайдеры недоступны/);
  assert.equal(root.querySelector('[data-suggest-apply]'), null);
});

test('отброшенные моделью позиции видны человеку', async () => {
  const b = boot({ answer: { status: 'ok', notice: 'n',
    items: [{ date: '2026-09-21', platform: 'vk', format: 'post', role: 'reach', topic: 'Т', hook: '', assetId: '', mentorNote: '' }],
    dropped: ['площадка не выбрана в брифе: instagram'] } });
  const { root } = await openPlan(b);
  root.querySelector('[data-suggest-start]').value = '2026-09-21';
  root.querySelector('[data-suggest-run]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(root.querySelector('[data-suggest-result]').textContent, /instagram/);
});

test('ошибка запроса не рушит экран', async () => {
  const b = boot({ answer: {}, throws: 'Сеть недоступна' });
  const { root } = await openPlan(b);
  root.querySelector('[data-suggest-start]').value = '2026-09-21';
  root.querySelector('[data-suggest-run]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(root.querySelector('[data-suggest-state]').textContent, /Сеть недоступна/);
  assert.equal(root.querySelector('[data-suggest-run]').disabled, false);
});

test('запрос уходит на адрес content с кодом компании и CSRF', async () => {
  const b = boot({ answer: { status: 'ok', items: [], dropped: [], notice: 'n' } });
  const { root, calls } = await openPlan(b);
  root.querySelector('[data-suggest-start]').value = '2026-09-21';
  root.querySelector('[data-suggest-days]').value = '10';
  root.querySelector('[data-suggest-run]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^\/content\/media-mentor-suggest\?companyCode=alvi$/);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(JSON.stringify(calls[0].options.body), JSON.stringify({ startDate: '2026-09-21', days: 10 }));
});

// --- разбор брифа ---
test('на брифе есть разбор и он не обещает сохранения', async () => {
  const { root } = await openPlan(boot({ answer: {} }));
  const block = root.querySelector('[data-analyze]');
  assert.ok(block, 'блок разбора отсутствует');
  assert.match(block.textContent, /Ничего не сохраняется/);
});

test('разбор показывает позиционирование, рубрики и пробелы', async () => {
  const b = boot({ answer: { status: 'ok', notice: 'разбор модели',
    positioning: 'Салон у дома', audience: 'Женщины 30-45',
    rubrics: [{ title: 'До и после', why: 'показывает результат', formats: ['post'] }],
    gaps: ['нет цен'], dropped: [] } });
  const { root } = await openPlan(b);
  root.querySelector('[data-analyze-run]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const text = root.querySelector('[data-analyze-result]').textContent;
  assert.match(text, /Салон у дома/);
  assert.match(text, /До и после/);
  assert.match(text, /нет цен/);
  assert.match(text, /Пост/, 'формат показан человеческим названием');
});

test('неразобранный ответ модели не выдаётся за разбор', async () => {
  const b = boot({ answer: { status: 'unusable', rubrics: [], gaps: [], dropped: [], notice: 'Не удалось разобрать' } });
  const { root } = await openPlan(b);
  root.querySelector('[data-analyze-run]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const text = root.querySelector('[data-analyze-result]').textContent;
  assert.match(text, /Не удалось разобрать/);
  assert.ok(!text.includes('Позиционирование'));
});

test('разбор уходит на свой адрес и без параметров плана', async () => {
  const b = boot({ answer: { status: 'ok', rubrics: [], gaps: [], dropped: [], notice: 'n', positioning: 'П' } });
  const { root, calls } = await openPlan(b);
  root.querySelector('[data-analyze-run]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^\/content\/media-mentor-analyze\?companyCode=alvi$/);
  assert.equal(JSON.stringify(calls[0].options.body), '{}');
});

// --- разбор результатов ---
test('на экране есть разбор результатов с периодом', async () => {
  const { root } = await openPlan(boot({ answer: {} }));
  assert.ok(root.querySelector('[data-review]'));
  assert.ok(root.querySelector('[data-review-from]').value);
  assert.ok(root.querySelector('[data-review-to]').value);
});

test('перевёрнутый период к модели не уходит', async () => {
  const b = boot({ answer: { status: 'ok' } });
  const { root, calls } = await openPlan(b);
  root.querySelector('[data-review-from]').value = '2026-09-19';
  root.querySelector('[data-review-to]').value = '2026-09-01';
  root.querySelector('[data-review-run]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 0);
  assert.match(root.querySelector('[data-review-state]').textContent, /позже/);
});

test('разбор результатов показывает выводы, правки и опору на цифру', async () => {
  const b = boot({ answer: { status: 'ok', notice: 'разбор по цифрам',
    findings: [{ statement: 'Охват растёт', basis: 'views=1200' }],
    planChanges: [{ action: 'strengthen', actionLabel: 'усилить', platform: 'vk', format: 'post', why: 'больше просмотров' }],
    questions: [], skipped: [], dropped: [] } });
  const { root } = await openPlan(b);
  root.querySelector('[data-review-run]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const text = root.querySelector('[data-review-result]').textContent;
  assert.match(text, /Охват растёт/);
  assert.match(text, /views=1200/);
  assert.match(text, /усилить/);
  assert.match(text, /ВКонтакте/);
});

test('площадки без данных названы прямо', async () => {
  const b = boot({ answer: { status: 'no_data', notice: 'Разбор не строится',
    findings: [], planChanges: [], questions: [], skipped: ['telegram'], dropped: [] } });
  const { root } = await openPlan(b);
  root.querySelector('[data-review-run]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const text = root.querySelector('[data-review-result]').textContent;
  assert.match(text, /Разбор не строится/);
  assert.match(text, /Telegram/);
});

test('разбор результатов уходит на свой адрес с периодом', async () => {
  const b = boot({ answer: { status: 'ok', findings: [], planChanges: [], questions: [], skipped: [], dropped: [], notice: 'n' } });
  const { root, calls } = await openPlan(b);
  root.querySelector('[data-review-from]').value = '2026-09-01';
  root.querySelector('[data-review-to]').value = '2026-09-19';
  root.querySelector('[data-review-run]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(calls[0].url, /^\/content\/media-mentor-review\?companyCode=alvi$/);
  assert.equal(JSON.stringify(calls[0].options.body), JSON.stringify({ from: '2026-09-01', to: '2026-09-19' }));
});
