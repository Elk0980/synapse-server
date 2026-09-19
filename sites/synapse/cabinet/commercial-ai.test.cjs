const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const {JSDOM} = require('jsdom');
const script = fs.readFileSync(require.resolve('./commercial.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

const aiSummary = (patch = {}) => ({entries: 3,
  actual: {consumption: 180, subscriptions: 1800, spend: 1980, invoiced: 1980, estimated: 0},
  planned: {consumption: 450, subscriptions: 0, spend: 450, invoiced: 0, estimated: 450},
  topups: {actual: 9000, planned: 0}, clientPaid: {actual: 0, planned: 2500},
  unknown: {count: 1, withoutAmount: 1},
  currencies: {USD: {actual: 22, planned: 5}},
  basis: 'Фактически потрачено — только actual.spend. План и оценка в него не входят.', ...patch});
const financePayload = (patch = {}) => ({entries: [], total: 0, from: '2026-09-01', to: '2026-09-30',
  totals: {income: 0, expense: 1980, balance: -1980, plannedIncome: 0, plannedExpense: 450},
  ai: aiSummary(), ...patch});
const trialsPayload = () => ({total: 2, offset: 0, verdicts: ['pending', 'accepted'],
  trials: [{id: 1, setId: 'set-a', taskId: 'task-1', modelId: 'vendor/model-1', success: true, verdict: 'accepted'}],
  conclusions: {sampleSize: 2, basis: 'Размер выборки указан рядом с каждой долей.',
    models: [{provider: 'test-provider', modelId: 'vendor/model-1', sampleSize: 2, attempts: 3,
      successes: 1, successRate: 50, factViolations: 1, isolationViolations: 0, manualEdits: 0,
      averageScore: 4, averageDurationMs: 750, costPerAcceptedTask: {USD: 0.4},
      costComplete: false, verdicts: {accepted: 1}}]}});

function fixture({role = 'owner', query} = {}) {
  const dom = new JSDOM('<section id="view"></section>', {url: 'https://test.local', runScripts: 'outside-only'});
  const w = dom.window, node = w.document.getElementById('view'), calls = [];
  const views = {};
  w.SbCabinet = {registerView(name, definition) { views[name] = definition; }};
  w.crypto.randomUUID ||= () => 'test-uuid-0000';
  // jsdom не реализует диалоги: подменяем ровно то, что использует раздел.
  w.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  w.HTMLDialogElement.prototype.close = function close() { this.open = false; };
  w.eval(script);
  const ctx = {
    identity: {role, permissions: [], csrfToken: 'csrf-token'},
    escapeHTML: (value) => String(value).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])),
    scopeParams: () => ({companyCode: 'avokado'}),
    csrfOptions: (method, body) => ({method, headers: {'X-CSRF-Token': 'csrf-token'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})}),
    crmQuery: async (path, params, options = {}) => {
      const call = {path, params, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null};
      calls.push(call);
      if (query) { const value = query(call); if (value !== undefined) return value; }
      if (path === '/ai-trials') return trialsPayload();
      if (path === '/deals') return {deals: []};
      return financePayload();
    },
  };
  return {dom, w, node, calls, ctx, view: views.finance, close: () => w.close()};
}
const dialog = (w) => w.document.querySelector('dialog.commercial-dialog');

test('раздел Финансов показывает отдельные суммы расходов на ИИ', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick(); await tick();
    const block = f.node.querySelector('.commercial-ai');
    assert.ok(block, 'блок расходов на ИИ отображается');
    const text = block.textContent;
    assert.match(text, /Фактически потрачено/);
    assert.match(text, /1\s*980/, 'факт показан отдельно');
    assert.match(text, /450/, 'план показан отдельно');
    assert.match(text, /9\s*000/, 'пополнение показано отдельно');
    assert.match(text, /2\s*500/, 'оплата клиента показана отдельно');
    assert.match(text, /без подтверждённой стоимости: 1/);
    assert.match(text, /из них без суммы: 1/);
    assert.match(text, /USD 22 факт \/ 5 план/);
    assert.match(text, /Фактически потрачено — только actual\.spend/);
  } finally { f.close(); }
});

test('форма расхода на ИИ отправляет сервис, аккаунт, клиента, модель, режим и валюту', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick(); await tick();
    f.node.querySelector('[data-new-ai]').click();
    const form = dialog(f.w).querySelector('form');
    assert.ok(form);
    form.elements.service.value = 'test-provider';
    form.elements.accountLabel.value = 'рабочий аккаунт';
    form.elements.client.value = 'cli-client';
    form.elements.modelId.value = 'vendor/model-1';
    form.elements.sourceAmount.value = '2';
    form.elements.amount.value = '180';
    form.elements.rateValue.value = '90';
    form.elements.rateAt.value = '2026-09-19';
    form.elements.rateSource.value = 'Курс банка';
    form.elements.confirmation.value = 'Счёт провайдера';
    form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true}));
    await tick(); await tick();
    const write = f.calls.find((call) => call.method === 'POST' && call.path === '/finances');
    assert.ok(write, 'запрос ушёл в существующий журнал Финансов');
    assert.equal(write.params.companyCode, 'avokado');
    assert.equal(write.body.type, 'expense');
    assert.equal(write.body.amount, 180);
    assert.deepEqual([write.body.ai.service, write.body.ai.accountLabel], ['test-provider', 'рабочий аккаунт']);
    assert.equal(write.body.ai.client, 'cli-client');
    assert.equal(write.body.ai.modelId, 'vendor/model-1', 'модель отдельно от клиента');
    assert.equal(write.body.ai.mode, 'api');
    assert.equal(write.body.ai.movement, 'consumption');
    assert.equal(write.body.ai.costKnown, true);
    assert.equal(write.body.ai.sourceCurrency, 'USD');
    assert.deepEqual(write.body.ai.rate, {value: 90, at: '2026-09-19', source: 'Курс банка'});
  } finally { f.close(); }
});

test('неподтверждённая стоимость в форме блокирует сумму нулём', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick(); await tick();
    f.node.querySelector('[data-new-ai]').click();
    const form = dialog(f.w).querySelector('form');
    form.elements.amount.value = '900';
    form.elements.costKnown.value = 'no';
    form.elements.costBasis.value = 'invoice';
    form.dispatchEvent(new f.w.Event('change', {bubbles: true}));
    assert.equal(form.elements.amount.value, '0', 'сумма обнулена');
    assert.equal(form.elements.amount.readOnly, true, 'заглушку не ввести');
    form.elements.service.value = 'test-provider';
    form.elements.accountLabel.value = 'аккаунт';
    form.elements.state.value = 'planned';
    form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true}));
    await tick(); await tick();
    const write = f.calls.find((call) => call.method === 'POST' && call.path === '/finances');
    assert.equal(write.body.amount, 0);
    assert.equal(write.body.ai.costKnown, false);
    assert.equal(write.body.ai.costBasis, null, 'без основания это неизвестность, а не оценка');
    assert.equal(write.body.ai.sourceAmount, null);
  } finally { f.close(); }
});

test('подписка прячет движение и требует период', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick(); await tick();
    f.node.querySelector('[data-new-ai]').click();
    const form = dialog(f.w).querySelector('form');
    form.elements.mode.value = 'subscription';
    form.dispatchEvent(new f.w.Event('change', {bubbles: true}));
    assert.equal(form.elements.movement.closest('label').hidden, true);
    assert.equal(form.elements.periodFrom.closest('label').hidden, false);
    form.elements.service.value = 'vendor';
    form.elements.accountLabel.value = 'аккаунт';
    form.elements.periodFrom.value = '2026-09-01';
    form.elements.periodTo.value = '2026-09-30';
    form.elements.amount.value = '1800';
    form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true}));
    await tick(); await tick();
    const write = f.calls.find((call) => call.method === 'POST' && call.path === '/finances');
    assert.equal(write.body.ai.mode, 'subscription');
    assert.equal(write.body.ai.movement, undefined);
    assert.deepEqual([write.body.ai.periodFrom, write.body.ai.periodTo], ['2026-09-01', '2026-09-30']);
  } finally { f.close(); }
});

test('таблица испытаний показывает выборку, долю успеха и неполноту стоимости', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick(); await tick();
    f.node.querySelector('[data-open-trials]').click();
    await tick(); await tick();
    const block = f.node.querySelector('.commercial-trials');
    assert.ok(block, 'таблица испытаний отображается');
    const text = block.textContent;
    assert.match(text, /vendor\/model-1/);
    assert.match(text, /50%/);
    assert.match(text, /USD 0\.4/);
    assert.match(text, /есть строки без стоимости/);
    assert.match(text, /Размер выборки указан/);
    assert.ok(f.calls.some((call) => call.path === '/ai-trials' && call.params.companyCode === 'avokado'));
  } finally { f.close(); }
});

test('форма испытания отправляет фактическую модель и не принимает тексты клиентов', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick(); await tick();
    f.node.querySelector('[data-open-trials]').click();
    await tick(); await tick();
    f.node.querySelector('[data-new-trial]').click();
    const form = dialog(f.w).querySelector('form');
    assert.equal(form.querySelector('[name="clientText"]'), null, 'поля для текста клиента нет');
    form.elements.setId.value = 'set-a';
    form.elements.taskId.value = 'task-1';
    form.elements.provider.value = 'test-provider';
    form.elements.modelId.value = 'vendor/model-1';
    form.elements.attempts.value = '2';
    form.elements.success.value = 'yes';
    form.elements.verdict.value = 'accepted';
    form.elements.note.value = 'Принято по фактам';
    form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true}));
    await tick(); await tick();
    const write = f.calls.find((call) => call.method === 'POST' && call.path === '/ai-trials');
    assert.ok(write);
    assert.equal(write.body.modelId, 'vendor/model-1');
    assert.equal(write.body.success, true);
    assert.equal(write.body.costKnown, false);
    assert.equal(write.body.verdict, 'accepted');
    assert.match(f.node.textContent, /Испытания моделей/);
  } finally { f.close(); }
});

test('не владельцу раздел не открывается', () => {
  const f = fixture({role: 'editor'});
  try {
    f.view.render(f.node, f.ctx);
    assert.match(f.node.textContent, /Раздел доступен владельцу/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
