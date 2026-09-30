const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const html = read('../cabinet.html');
const parsed = new JSDOM(html);
const scripts = [...parsed.window.document.querySelectorAll('script:not([src])')].map(n => n.textContent);
const bootstrap = scripts.find(t => t.includes('const cabinetAssets'));
const shell = scripts.find(t => t.includes('canonicalSiteEditors'));
parsed.window.close();
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0)); };

function page({hash = '#content-factory/sources', permissions = ['autoposting.view'], role = 'client', source, savedCompany} = {}) {
  const errors = [], requests = [], assets = [], renders = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {url: 'https://cabinet.test/cabinet.html' + hash, runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true});
  const w = dom.window, d = w.document;
  w.matchMedia = q => ({matches: false, media: q, addEventListener() {}, removeEventListener() {}});
  w.scrollTo = () => {};
  // Native AbortSignal.any is used by the real cabinet API wrapper.
  w.AbortController = AbortController; w.AbortSignal = AbortSignal;
  const views = {autoposting: {render(node, ctx) {
    renders.push(ctx.selectedProjectId);
    if (!node.firstChild) node.innerHTML = '<input aria-label="Черновик">';
  }}};
  w.SbCabinet = {views: new Proxy(views, {get: (o, k) => o[k] || {render() {}, initialize() {}, updateSummary() {}}}), renderModuleGuide() {}};
  d.write = text => assets.push(text);
  w.eval(bootstrap);
  w.eval(read('telegram-sources.js'));
  w.eval(read('telegram-sources-view.js'));
  w.eval(read('module-guide.js'));
  if (savedCompany) w.localStorage.setItem('synapse_cabinet_project_v2:7', savedCompany);
  w.fetch = async (url, options = {}) => {
    requests.push({url, method: options.method || 'GET', signal: options.signal});
    if (url.startsWith('/content/telegram-sources/')) {
      const data = source ? await source(url, options) : {enabled: false, items: [{name: 'Исходник ' + url.split('/').at(-1), status: 'text'}]};
      return {ok: true, status: 200, json: async () => data};
    }
    return {ok: true, status: 200, json: async () => ({login: 'qa', userId: 7, displayName: 'QA', role, permissions, csrfToken: 'qa', companies: [{id: 'one', name: 'Первый'}, {id: 'two', name: 'Второй'}]})};
  };
  w.eval(shell);
  return {w, d, errors, requests, assets, renders, settle, close: () => w.close(),
    sourceCalls: () => requests.filter(r => r.url.startsWith('/content/telegram-sources/')),
    panel: () => d.querySelector('[data-view="telegram-sources"]'),
    tab: () => d.querySelector('[data-factory-view="telegram-sources"]'),
    async company(name) { [...d.querySelectorAll('#project-menu button')].find(n => n.textContent.includes(name)).click(); await settle(); }
  };
}

for (const hash of ['#content-factory/sources', '#telegram-sources']) test('вкладка и реальная маршрутизация ' + hash, async () => {
  const f = page({hash}); try {
    await f.settle();
    assert.equal(f.w.location.hash, '#content-factory/sources');
    assert.equal(f.panel().hidden, false); assert.equal(f.tab().hidden, false);
    assert.equal(f.tab().textContent, 'Исходники из Telegram');
    assert.equal(f.tab().getAttribute('aria-current'), 'page');
    assert.match(f.d.title, /^Контент завод — Первый/);
    assert.equal(f.d.querySelector('#content-factory-link').getAttribute('aria-current'), 'page');
    assert.match(f.panel().textContent, /Приём новых исходников выключен/);
    assert.deepEqual(f.sourceCalls().map(r => r.url), ['/content/telegram-sources/one']);
    assert.ok(f.requests.every(r => r.method === 'GET'));
    const sourceScripts = [...f.assets.join('').matchAll(/src="([^"]+)"/g)].map(m => m[1]);
    const base = sourceScripts.findIndex(s => s.startsWith('cabinet/telegram-sources.js?'));
    const adapter = sourceScripts.findIndex(s => s.startsWith('cabinet/telegram-sources-view.js?'));
    assert.ok(base >= 0 && adapter > base);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

for (const permissions of [[], ['content-factory.view']]) test('чужое общее право не открывает исходники: ' + permissions, async () => {
  const f = page({permissions}); try {
    await f.settle(); assert.equal(f.tab().hidden, true);
    assert.equal(f.d.querySelector('#access-denied-view').hidden, false);
    assert.equal(f.sourceCalls().length, 0); assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('owner использует прежний доступ; неизвестная сохранённая компания не становится scope запроса', async () => {
  const f = page({role: 'owner', permissions: [], savedCompany: 'outside'}); try {
    await f.settle(); assert.equal(f.panel().hidden, false);
    assert.deepEqual(f.sourceCalls().map(r => r.url), ['/content/telegram-sources/one']);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('смена компании уничтожает прежний список и игнорирует запоздалый ответ', async () => {
  let finish;
  const f = page({source: url => url.endsWith('/one') ? new Promise(r => finish = r) : Promise.resolve({enabled: true, items: [{name: 'Второй проект', status: 'text'}]})});
  try {
    await f.settle(); assert.equal(typeof finish, 'function');
    const oldSignal = f.sourceCalls()[0].signal;
    await f.company('Второй');
    assert.equal(oldSignal.aborted, true);
    assert.equal(f.w.location.hash, '#content-factory/sources');
    assert.match(f.panel().textContent, /Второй проект/);
    finish({enabled: true, items: [{name: 'Первый секретный файл', status: 'text'}]});
    await f.settle(); assert.doesNotMatch(f.panel().textContent, /Первый секретный файл/);
    assert.equal(f.panel().querySelectorAll('h3').length, 1);
    assert.deepEqual(f.sourceCalls().map(r => r.url), ['/content/telegram-sources/one', '/content/telegram-sources/two']);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('уход/возврат очищает исходники, скрытый вид не читает новый проект, черновик материалов сохранён', async () => {
  const f = page({hash: '#content-factory/materials'}); try {
    await f.settle(); const draft = f.d.querySelector('#autoposting-view input'); draft.value = 'Несохранённый текст';
    assert.equal(f.sourceCalls().length, 0);
    f.tab().click(); await f.settle(); assert.match(f.panel().textContent, /Исходник one/);
    const oldSignal = f.sourceCalls()[0].signal;
    f.d.querySelector('[href="#content-factory/materials"]').click(); await f.settle();
    assert.equal(f.panel().textContent, ''); assert.equal(oldSignal.aborted, true);
    assert.equal(f.d.querySelector('#autoposting-view input'), draft); assert.equal(draft.value, 'Несохранённый текст');
    await f.company('Второй'); assert.equal(f.sourceCalls().length, 1);
    f.tab().click(); await f.settle();
    assert.match(f.panel().textContent, /Исходник two/); assert.doesNotMatch(f.panel().textContent, /Исходник one/);
    f.w.history.back(); await f.settle(); assert.equal(f.panel().textContent, '');
    f.w.history.forward(); await f.settle(); assert.match(f.panel().textContent, /Исходник two/);
    assert.ok(f.requests.every(r => r.method === 'GET')); assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('пагинация и повтор после ошибки идут через штатный API только в текущую компанию', async () => {
  let attempt = 0;
  const f = page({source: async url => {
    if (++attempt === 1) throw Error('offline');
    return url.includes('?before=8') ? {enabled: false, items: [{name: 'Старый исходник', status: 'text'}]} : {enabled: false, items: [{name: 'Новый исходник', status: 'text'}], nextBefore: 8};
  }});
  try {
    await f.settle(); assert.match(f.panel().textContent, /Не удалось загрузить/);
    [...f.panel().querySelectorAll('button')].find(n => n.textContent === 'Повторить загрузку').click(); await f.settle();
    [...f.panel().querySelectorAll('button')].find(n => n.textContent === 'Показать ещё').click(); await f.settle();
    assert.match(f.panel().textContent, /Новый исходник/); assert.match(f.panel().textContent, /Старый исходник/);
    assert.equal(f.sourceCalls().at(-1).url, '/content/telegram-sources/one?before=8');
    assert.ok(f.requests.every(r => r.method === 'GET')); assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('adapter сам отклоняет отсутствующую/чужую компанию, отсутствие права и скрытый экран', async () => {
  const f = page({hash: '#content-factory/materials'}); try {
    await f.settle(); const view = f.w.SbCabinet.views['telegram-sources'];
    let calls = 0;
    const base = {currentView: 'telegram-sources', selectedProjectId: 'one', identity: {role: 'client', permissions: ['autoposting.view'], companies: [{id: 'one'}]}, apiJson: async () => { calls++; return {items: []}; }};
    for (const ctx of [{...base, selectedProjectId: null}, {...base, selectedProjectId: 'outside'}, {...base, identity: {...base.identity, permissions: []}}, {...base, currentView: 'autoposting'}]) {
      view.render(f.panel(), ctx); await f.settle();
    }
    assert.equal(calls, 0); assert.equal(f.sourceCalls().length, 0); assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('выход очищает исходники до ответа сервера', async () => {
  const f = page(); try {
    await f.settle(); const signal = f.sourceCalls()[0].signal;
    f.w.fetch = () => new Promise(() => {});
    f.d.querySelector('#logout').click();
    assert.equal(f.panel().textContent, ''); assert.equal(signal.aborted, true);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});
