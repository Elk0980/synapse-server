'use strict';
// CF13: адаптер вида «Исходники» — запись только в свою компанию, CSRF, XHR-прогресс, открытие свежей карточки.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {JSDOM} = require('jsdom');
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

function adapter({role = 'client', permissions = ['autoposting.view', 'autoposting.edit']} = {}) {
  const dom = new JSDOM('<section data-view="telegram-sources"></section>', {url: 'https://cabinet.test/cabinet.html#content-factory/sources', runScripts: 'outside-only'});
  const w = dom.window, views = {}, fetches = [], xhrs = [], events = [], navigations = [];
  let args = null;
  w.SbCabinet = {registerView(name, def) { views[name] = def; }, telegramSources: {mount(options) { args = options; return {destroy() {}}; }}};
  w.fetch = async (url, options = {}) => { fetches.push({url, ...options}); return {ok: url.endsWith('/metadata'), status: url.endsWith('/metadata') ? 200 : 409, json: async () => (url.endsWith('/metadata') ? {item: {id: 1}} : {error: 'Исходник уже изменён', details: {code: 'X'}})}; };
  w.XMLHttpRequest = class { constructor() { this.headers = {}; this.upload = {}; xhrs.push(this); } open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; } send(body) { this.body = body; } abort() { this.aborted = true; this.onabort?.(); } };
  w.addEventListener('sb:content-factory-open-draft', (e) => events.push(e.detail));
  w.eval(fs.readFileSync(path.join(__dirname, 'telegram-sources-view.js'), 'utf8'));
  const ctx = {currentView: 'telegram-sources', selectedProjectId: 'one', identity: {role, permissions, csrfToken: 'qa-token', companies: [{id: 'one'}]},
    apiJson: async (url) => ({url}), navigate: (to) => navigations.push(to)};
  views['telegram-sources'].render(w.document.querySelector('section'), ctx);
  return {w, args: () => args, fetches, xhrs, events, navigations, views, ctx, close: () => w.close()};
}

test('адаптер: запись только в свою компанию с CSRF; чтение чужого адреса отклоняется без запроса; без права правки записи нет', async () => {
  const f = adapter(); try {
    const {send, request, uploadFile} = f.args();
    await send('/content/telegram-sources/one/1/metadata', 'PATCH', {revision: 1, metadata: {}});
    assert.equal(f.fetches[0].method, 'PATCH'); assert.equal(f.fetches[0].headers['X-CSRF-Token'], 'qa-token'); assert.equal(f.fetches[0].headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(f.fetches[0].body), {revision: 1, metadata: {}});
    await assert.rejects(send('/content/telegram-sources/one/2/attach', 'POST', {}), (e) => e.status === 409 && e.message === 'Исходник уже изменён' && e.code === 'X');
    await assert.rejects(send('/content/telegram-sources/two/1/metadata', 'PATCH', {}), (e) => e.status === 403);
    await assert.rejects(send('/content/telegram-sources/one/1/metadata', 'DELETE', {}), (e) => e.status === 403);
    await assert.rejects(request('/content/telegram-sources/two'), (e) => e.status === 403);
    await assert.rejects(request('/content/crm/autoposting/posts?companyCode=two'), (e) => e.status === 403);
    assert.deepEqual(await request('/content/crm/autoposting/posts?companyCode=one'), {url: '/content/crm/autoposting/posts?companyCode=one'});
    await assert.rejects(uploadFile('/content/telegram-sources/two/upload', null), (e) => e.status === 403);
    assert.equal(f.fetches.length, 2, 'отклонённые адреса не запрашиваются');
  } finally { f.close(); }
  const viewer = adapter({permissions: ['autoposting.view']}); try {
    assert.equal(viewer.args().send, undefined); assert.equal(viewer.args().uploadFile, undefined);
  } finally { viewer.close(); }
});

test('адаптер: XHR-загрузка одного файла с CSRF и прогрессом; сеть — status 0; смена компании прерывает запрос', async () => {
  const f = adapter(); try {
    const progress = [];
    const done = f.args().uploadFile('/content/telegram-sources/one/upload', 'BODY', {onProgress: (a, b) => progress.push([a, b])});
    const xhr = f.xhrs[0];
    assert.deepEqual([xhr.method, xhr.url, xhr.headers['X-CSRF-Token'], xhr.body], ['POST', '/content/telegram-sources/one/upload', 'qa-token', 'BODY']);
    xhr.upload.onprogress({loaded: 5, total: 10, lengthComputable: true}); xhr.upload.onprogress({loaded: 7, total: 0, lengthComputable: false});
    assert.deepEqual(progress, [[5, 10], [7, 0]]);
    xhr.status = 201; xhr.responseText = '{"item":{"id":3},"duplicate":false}'; xhr.onload();
    assert.deepEqual(JSON.parse(JSON.stringify(await done)), {status: 201, body: {item: {id: 3}, duplicate: false}});
    const lost = f.args().uploadFile('/content/telegram-sources/one/upload', 'BODY'); f.xhrs[1].onerror();
    await assert.rejects(lost, (e) => e.status === 0);
    const pending = f.args().uploadFile('/content/telegram-sources/one/upload', 'BODY');
    f.views['telegram-sources'].onLeave();
    assert.equal(f.xhrs[2].aborted, true); await assert.rejects(pending, (e) => e.status === 0);
  } finally { f.close(); }
});

test('адаптер: «Открыть карточку» — общий слот, переход на Контент-план и событие открытия с источником «Исходники»', async () => {
  const f = adapter(); try {
    f.args().openPost(77); f.args().openPost(-1);
    assert.deepEqual(f.navigations, ['content-factory/plan']);
    assert.deepEqual({...f.w.SbCabinet.pendingMaterialOpen}, {companyCode: 'one', postId: 77, source: 'sources'});
    await new Promise((r) => setTimeout(r, 5)); await settle();
    assert.deepEqual(f.events.map((e) => ({...e})), [{companyCode: 'one', postId: 77, source: 'sources'}]);
  } finally { f.close(); }
});
