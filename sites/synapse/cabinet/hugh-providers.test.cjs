const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const {JSDOM} = require('jsdom');
const script = fs.readFileSync(require.resolve('./hugh-providers.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

const KEY = 'sk-ui-test-0123456789';
const provider = (patch = {}) => ({name: 'deepseek', title: 'DeepSeek', console: 'https://platform.deepseek.com/',
  hosts: ['api.deepseek.com'], apiStyle: 'openai-chat-completions', baseUrl: '', modelId: '',
  keyConfigured: false, keySetAt: null, enabled: false, timeoutMs: 60000, maxOutputTokens: 1200,
  contractSupported: true, unsupportedReason: '', configRevision: 0, checkCurrent: false,
  pricePromptUsdPer1k: null, priceCompletionUsdPer1k: null, budgetUsd: null, revision: 0,
  saved: false, checkState: 'not_checked', checkMessage: '', checkedAt: null, checkStale: false,
  updatedAt: null, updatedBy: '', ...patch});
const status = (patch = {}) => ({storeAvailable: true, lockedReason: '', apiStyle: 'openai-chat-completions',
  providers: [provider()],
  notice: 'Ключ хранится зашифрованным и не возвращается. Сохранение ничего не включает.', ...patch});

function fixture({role = 'owner', respond} = {}) {
  const dom = new JSDOM('<div id="hugh-providers" hidden></div>', {url: 'https://test.local', runScripts: 'outside-only'});
  const w = dom.window, calls = [];
  w.SbCabinet = {};
  w.eval(script);
  const apiJson = async (path, options = {}) => {
    const call = {path, method: options.method, body: options.body ? JSON.parse(options.body) : null,
      csrf: options.headers?.['X-CSRF-Token']};
    calls.push(call);
    if (respond) { const value = respond(call); if (value !== undefined) return value; }
    return status();
  };
  const identity = {role, csrfToken: 'csrf-token'};
  w.SbCabinet.initHughProviders({identity, byId: (id) => w.document.getElementById(id), apiJson,
    escapeHTML: (value) => String(value).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]))});
  return {dom, w, calls, host: w.document.getElementById('hugh-providers'), close: () => w.close()};
}

test('не владельцу блок не показывается и запросов не делает', async () => {
  const f = fixture({role: 'editor'});
  try {
    await tick();
    assert.equal(f.calls.length, 0);
    assert.equal(f.host.hidden, true);
  } finally { f.close(); }
});

test('владелец видит список провайдеров без единого ключа в разметке', async () => {
  const f = fixture({respond: () => status({providers: [provider({keyConfigured: true,
    keySetAt: '2026-09-19T10:00:00.000Z', baseUrl: 'https://api.deepseek.com/v1', modelId: 'vendor/model-1',
    revision: 1, saved: true})]})});
  try {
    await tick(); await tick();
    assert.equal(f.host.hidden, false);
    assert.match(f.host.textContent, /DeepSeek/);
    assert.match(f.host.textContent, /ключ задан/);
    assert.match(f.host.textContent, /не возвращается/);
    assert.equal(f.host.querySelector('[name="apiKey"]').value, '', 'поле ключа пустое');
    assert.equal(f.host.querySelector('[name="apiKey"]').type, 'password');
    assert.equal(f.host.innerHTML.includes(KEY), false);
    assert.equal(f.calls[0].method, 'GET');
  } finally { f.close(); }
});

test('сохранение отправляет ключ один раз и стирает его из формы', async () => {
  const saved = [];
  const f = fixture({respond: (call) => {
    if (call.method === 'PUT') { saved.push(call); return provider({keyConfigured: true, revision: 1, saved: true}); }
    return status({providers: [provider({keyConfigured: saved.length > 0, revision: saved.length})]});
  }});
  try {
    await tick(); await tick();
    const form = f.host.querySelector('form[data-form="deepseek"]');
    form.elements.baseUrl.value = 'https://api.deepseek.com/v1';
    form.elements.modelId.value = 'vendor/model-1';
    form.elements.apiKey.value = KEY;
    form.elements.budgetUsd.value = '20';
    form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true}));
    await tick(); await tick(); await tick();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].path, '/content/hugh-providers/deepseek');
    assert.equal(saved[0].csrf, 'csrf-token', 'запись идёт с CSRF-токеном');
    assert.equal(saved[0].body.apiKey, KEY);
    assert.equal(saved[0].body.enabled, false, 'сохранение не включает провайдера');
    assert.equal(saved[0].body.budgetUsd, 20);
    // Ключа не остаётся ни в форме, ни в разметке, ни в браузерном хранилище.
    assert.equal(f.host.innerHTML.includes(KEY), false);
    assert.equal(f.host.querySelector('[name="apiKey"]')?.value || '', '');
    assert.equal(f.w.localStorage.length, 0);
    assert.equal(f.w.location.search, '');
  } finally { f.close(); }
});

test('пустое поле ключа не перезаписывает уже сохранённый ключ', async () => {
  const saved = [];
  const f = fixture({respond: (call) => {
    if (call.method === 'PUT') { saved.push(call); return provider({keyConfigured: true, revision: 2}); }
    return status({providers: [provider({keyConfigured: true, revision: 1, saved: true, checkCurrent: true,
      checkState: 'ok', baseUrl: 'https://api.deepseek.com/v1', modelId: 'vendor/model-1'})]});
  }});
  try {
    await tick(); await tick();
    const form = f.host.querySelector('form[data-form="deepseek"]');
    form.elements.enabled.checked = true;
    form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true}));
    await tick(); await tick(); await tick();
    assert.equal(saved.length, 1);
    assert.equal('apiKey' in saved[0].body, false, 'ключ не отправлен повторно');
    assert.equal(saved[0].body.enabled, true);
    assert.equal(saved[0].body.revision, 1);
  } finally { f.close(); }
});

test('проверка соединения — отдельное действие с отдельным маршрутом', async () => {
  const f = fixture({respond: (call) => {
    if (call.path.endsWith('/check')) return provider({keyConfigured: true, revision: 1,
      checkState: 'ok', checkMessage: 'Соединение подтверждено', checkedAt: '2026-09-19T10:05:00.000Z'});
    return status({providers: [provider({keyConfigured: true, revision: 1, saved: true,
      checkState: 'ok', checkMessage: 'Соединение подтверждено', checkedAt: '2026-09-19T10:05:00.000Z'})]});
  }});
  try {
    await tick(); await tick();
    f.host.querySelector('[data-check="deepseek"]').click();
    await tick(); await tick(); await tick();
    const check = f.calls.find((call) => call.path.endsWith('/check'));
    assert.ok(check);
    assert.equal(check.method, 'POST');
    assert.equal(check.csrf, 'csrf-token');
    assert.match(f.host.textContent, /Соединение подтверждено/);
  } finally { f.close(); }
});

test('закрытое хранилище объясняет причину и не даёт форм', async () => {
  const f = fixture({respond: () => status({storeAvailable: false,
    lockedReason: 'HUGH_PROVIDER_MASTER_KEY не задан: хранилище ключей закрыто'})});
  try {
    await tick(); await tick();
    assert.match(f.host.textContent, /HUGH_PROVIDER_MASTER_KEY не задан/);
    assert.equal(f.host.querySelector('form[data-form="deepseek"]').hidden, true, 'форма скрыта');
  } finally { f.close(); }
});

test('устаревшая проверка не выдаётся за свежую и не позволяет включить', async () => {
  const f = fixture({respond: () => status({providers: [provider({keyConfigured: true, revision: 3,
    saved: true, checkState: 'ok', checkMessage: 'Соединение подтверждено',
    checkedAt: '2026-09-19T10:05:00.000Z', checkStale: true, checkCurrent: false})]})});
  try {
    await tick(); await tick();
    assert.match(f.host.textContent, /для прошлой версии настройки/);
    assert.equal(f.host.querySelector('[name="enabled"]').disabled, true, 'включение недоступно');
    assert.match(f.host.textContent, /станет доступно после успешной проверки/);
  } finally { f.close(); }
});

test('без свежей проверки включение недоступно, со свежей — доступно', async () => {
  const fresh = fixture({respond: () => status({providers: [provider({keyConfigured: true, revision: 2,
    saved: true, checkState: 'ok', checkCurrent: true, checkedAt: '2026-09-19T10:05:00.000Z'})]})});
  try {
    await tick(); await tick();
    assert.equal(fresh.host.querySelector('[name="enabled"]').disabled, false);
  } finally { fresh.close(); }
  const stale = fixture();
  try {
    await tick(); await tick();
    assert.equal(stale.host.querySelector('[name="enabled"]').disabled, true);
  } finally { stale.close(); }
});

test('провайдер без реализованного контракта показан без формы и с причиной', async () => {
  const f = fixture({respond: () => status({providers: [provider({name: 'anthropic', title: 'Anthropic (резерв)',
    contractSupported: false, unsupportedReason: 'Адаптер не написан: API устроен иначе.'})]})});
  try {
    await tick(); await tick();
    assert.match(f.host.textContent, /через этот контракт не подключается/);
    assert.match(f.host.textContent, /Адаптер не написан/);
    assert.equal(f.host.querySelector('form[data-form="anthropic"]'), null, 'формы нет');
    assert.equal(f.host.querySelector('[name="apiKey"]'), null, 'поля ключа нет');
  } finally { f.close(); }
});

test('успешная проверка не выдаётся за подтверждение официальности хоста', async () => {
  const f = fixture();
  try {
    await tick(); await tick();
    assert.match(f.host.textContent, /не подтверждает, что хост\s+принадлежит провайдеру/);
  } finally { f.close(); }
});

/* Расход и границы. Владелец должен увидеть потраченное до того, как провайдер замолчит,
   и отличить «лимит не задан» от «лимит есть и не достигнут». */
const spend = (patch = {}) => ({provider: 'deepseek', spentUsd: 0, requests: 0,
  limitUsd: null, stopped: false, reason: '', ...patch});

test('расход провайдера за окно виден в его карточке', async () => {
  const f = fixture({respond: () => status({providers: [provider({keyConfigured: true,
    spend: spend({spentUsd: 1.25, requests: 7, limitUsd: 5})})]})});
  try {
    await tick(); await tick();
    const note = f.host.querySelector('[data-spend="deepseek"]').textContent;
    assert.match(note, /1,25 \$/);
    assert.match(note, /обращений 7/);
    assert.match(note, /личный лимит 5,00 \$/);
  } finally { f.close(); }
});

test('мелкий расход не округляется до нуля', async () => {
  const f = fixture({respond: () => status({providers: [provider({keyConfigured: true,
    spend: spend({spentUsd: 0.0012, requests: 2})})]})});
  try {
    await tick(); await tick();
    const note = f.host.querySelector('[data-spend="deepseek"]').textContent;
    assert.match(note, /0,0012 \$/, 'первые обращения не должны выглядеть как «ничего не потрачено»');
  } finally { f.close(); }
});

test('отсутствие личного лимита названо словами, а не пустотой', async () => {
  const f = fixture({respond: () => status({providers: [provider({keyConfigured: true, spend: spend()})]})});
  try {
    await tick(); await tick();
    assert.match(f.host.querySelector('[data-spend="deepseek"]').textContent, /личный лимит не задан/);
  } finally { f.close(); }
});

test('исчерпанный личный лимит показан причиной, а не молчанием', async () => {
  const f = fixture({respond: () => status({providers: [provider({keyConfigured: true,
    spend: spend({spentUsd: 5, limitUsd: 5, stopped: true,
      reason: 'Достигнут личный лимит расходов провайдера deepseek'})})]})});
  try {
    await tick(); await tick();
    assert.match(f.host.querySelector('[data-spend="deepseek"]').textContent, /Достигнут личный лимит/);
  } finally { f.close(); }
});

test('сервер не прислал расход — карточка работает без строки о деньгах', async () => {
  const f = fixture({respond: () => status({providers: [provider({keyConfigured: true})]})});
  try {
    await tick(); await tick();
    assert.equal(f.host.querySelector('[data-spend="deepseek"]'), null);
    assert.match(f.host.textContent, /DeepSeek/);
  } finally { f.close(); }
});

test('общий расход за окно виден отдельно от личного', async () => {
  const f = fixture({respond: () => status({budget: {configured: true, blockedByConfig: false,
    windowDays: 30, resetAt: '2026-10-21T00:00:00.000Z', spentUsd: 3.5, limitUsd: 20,
    requests: 12, maxRequests: 0, stopped: false, reason: ''}})});
  try {
    await tick(); await tick();
    const note = f.host.querySelector('[data-budget]').textContent;
    assert.match(note, /3,50 \$ из 20,00 \$/);
    assert.match(note, /окно 30 дн\./i);
  } finally { f.close(); }
});

test('неверно заданные границы показываются тревогой, а не примечанием', async () => {
  const f = fixture({respond: () => status({budget: {configured: true, blockedByConfig: true,
    windowDays: 30, resetAt: '2026-10-21T00:00:00.000Z', spentUsd: 0, limitUsd: 0, requests: 0,
    maxRequests: 0, stopped: true, reason: 'Границы бюджета заданы неверно: платный резерв остановлен'}})});
  try {
    await tick(); await tick();
    const node = f.host.querySelector('[data-budget]');
    assert.equal(node.getAttribute('role'), 'alert');
    assert.match(node.textContent, /заданы неверно/);
  } finally { f.close(); }
});

test('незаданная общая граница названа прямо, а не выглядит как ноль расхода', async () => {
  const f = fixture({respond: () => status({budget: {configured: false, blockedByConfig: false,
    windowDays: 30, resetAt: '2026-10-21T00:00:00.000Z', spentUsd: 0, limitUsd: 0, requests: 0,
    maxRequests: 0, stopped: false, reason: ''}})});
  try {
    await tick(); await tick();
    assert.match(f.host.querySelector('[data-budget]').textContent, /без денежного потолка/);
  } finally { f.close(); }
});
