const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const script = fs.readFileSync(require.resolve('./materials.js'), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const asset = (n) => `https://cabinet.test/content/publishing-assets/avokado/${n.repeat(32)}.mp4`;
const reels = () => [
  {id: 4, key: 'reel:4', source: 'materials', companyCode: 'avokado', title: 'Рилс про мастера', releaseDate: '2026-11-07', platforms: ['instagram', 'tiktok'],
    postId: null, currentVersion: {version: 2, mediaUrl: asset('b'), editId: 9}, versionCount: 2, openEdits: 1},
  {id: null, key: 'post:11', source: 'plan', companyCode: 'avokado', title: 'Из плана', releaseDate: '', platforms: ['vk'], postId: 11,
    currentVersion: {version: 1, mediaUrl: asset('c')}, versionCount: 1, openEdits: 0}];
const full = () => ({...reels()[0], versions: [{version: 1, mediaUrl: asset('a')}, {version: 2, mediaUrl: asset('b'), editId: 9}],
  edits: [{id: 9, kind: 'request', baseVersion: 1, status: 'done', resultVersion: 2, comment: 'Хью, убери паузу'}], log: []});

function fixture({permissions = ['autoposting.view', 'autoposting.edit'], respond} = {}) {
  const dom = new JSDOM('<main id="view"></main>', {url: 'https://cabinet.test/#content/materials', runScripts: 'outside-only'});
  const w = dom.window, el = w.document.getElementById('view'), calls = [], navigations = [];
  w.SynapseModulesQueue = [];
  w.eval(script);
  const [id, definition] = w.SynapseModulesQueue[0];
  const answer = async (method, path, body, params) => {
    calls.push({method, path, body, params});
    const custom = respond && await respond({method, path, body, params});
    if (custom !== undefined) return custom;
    if (path === 'crm/autoposting/reels' && method === 'GET') return {companyCode: 'avokado', reels: reels()};
    if (path === 'crm/autoposting/reels/4') return full();
    if (path.endsWith('/publication')) return {post: {id: 77}, reel: {...full(), postId: 77}};
    throw Object.assign(new Error('unexpected ' + path), {status: 500});
  };
  const ctx = {moduleId: id, companyCode: 'avokado', can: (p) => permissions.includes(p), signal: new w.AbortController().signal, route: {path: ''},
    api: {get: (path, params) => answer('GET', path, undefined, params), post: (path, body) => answer('POST', path, body)},
    navigate: (route) => navigations.push(route)};
  return {w, el, id, definition, ctx, calls, navigations, mount: () => definition.mount(el, ctx)};
}

test('Материалы: модуль content-materials, сетка с версиями и правками, фильтры уходят на сервер', async () => {
  const f = fixture();
  assert.equal(f.id, 'content-materials');
  await f.mount();
  const cards = f.el.querySelectorAll('.mt-card');
  assert.equal(cards.length, 2);
  assert.match(cards[0].textContent, /v2/); assert.match(cards[0].textContent, /правок: 1/); assert.match(cards[0].textContent, /07\.11\.2026/);
  assert.match(cards[1].textContent, /из контент-плана/);
  const form = f.el.querySelector('[data-filters]'), fields = form.elements;
  fields.from.value = '2026-11-01'; fields.to.value = '2026-11-30'; fields.platform.value = 'tiktok';
  form.dispatchEvent(new f.w.Event('change', {bubbles: true})); await tick();
  assert.deepEqual({...f.calls.at(-1).params}, {from: '2026-11-01', to: '2026-11-30', platform: 'tiktok'});
  fields.from.value = '2026-12-10'; form.dispatchEvent(new f.w.Event('change', {bubbles: true})); await tick();
  assert.equal(f.calls.length, 2, 'перепутанные даты не уходят на сервер');
  assert.match(f.el.querySelector('[data-status]').textContent, /позже/);
});

test('Материалы: ответ другой компании не показывается', async () => {
  const f = fixture({respond: ({path, method}) => path === 'crm/autoposting/reels' && method === 'GET' ? {companyCode: 'alvi', reels: reels()} : undefined});
  await f.mount();
  assert.equal(f.el.querySelectorAll('.mt-card').length, 0);
});

test('Предпросмотр: маска площадки меняется, версии, «Скачать», «Создать публикацию» с версией и площадками', async () => {
  const f = fixture();
  await f.mount();
  f.el.querySelector('[data-open="reel:4"]').click(); await tick(); await tick();
  assert.equal(f.el.querySelector('.mt-mask').dataset.mask, 'instagram');
  const tiktok = f.el.querySelector('input[name="mt-platform"][value="tiktok"]');
  tiktok.checked = true; tiktok.dispatchEvent(new f.w.Event('change', {bubbles: true}));
  assert.equal(f.el.querySelector('.mt-mask').dataset.mask, 'tiktok');
  assert.equal(f.el.querySelectorAll('input[name="mt-platform"]').length, 6);
  assert.match(f.el.querySelector('[data-download]').getAttribute('href'), /b{32}\.mp4$/);
  const select = f.el.querySelector('[data-version]'); select.value = '1'; select.dispatchEvent(new f.w.Event('change', {bubbles: true}));
  assert.match(f.el.querySelector('[data-download]').getAttribute('href'), /a{32}\.mp4$/);
  f.el.querySelector('[data-publish]').click(); await tick(); await tick();
  const call = f.calls.find((c) => c.path.endsWith('/publication'));
  assert.deepEqual(JSON.parse(JSON.stringify(call.body)), {version: 1, platformIds: ['instagram', 'tiktok']});
  assert.match(f.el.textContent, /Черновик публикации №77 создан\. Ничего не отправлено/);
  [...f.el.querySelectorAll('button')].find((b) => b.textContent === 'Открыть в «Постинге»').click();
  assert.deepEqual([...f.navigations], ['content-factory/plan']);
  assert.equal(f.w.SbCabinet.pendingMaterialOpen.postId, 77);
});

test('Права: без autoposting.edit нет «Создать публикацию» и «Редактировать»; рилс плана ведёт в «Постинг»', async () => {
  const viewer = fixture({permissions: ['autoposting.view']});
  await viewer.mount();
  viewer.el.querySelector('[data-open="reel:4"]').click(); await tick(); await tick();
  assert.equal(viewer.el.querySelector('[data-publish]'), null); assert.equal(viewer.el.querySelector('[data-edit]'), null);
  assert.ok(viewer.el.querySelector('[data-download]'));
  const editor = fixture();
  await editor.mount();
  editor.el.querySelector('[data-open="post:11"]').click(); await tick();
  editor.el.querySelector('[data-open-post]').click();
  assert.deepEqual({...editor.w.SbCabinet.pendingMaterialOpen}, {companyCode: 'avokado', postId: 11, source: 'materials'});
  editor.el.querySelector('[data-back]').click();
  assert.equal(editor.el.querySelector('[data-detail]').hidden, true);
});

test('Маски шести площадок: шапка, подпись, безопасная зона; кнопки только у ленточных площадок', () => {
  const f = fixture(), mask = f.w.SbCabinet.reelMask;
  assert.deepEqual(Array.from(mask.PLATFORMS, (p) => p.id), ['instagram', 'tiktok', 'youtube_shorts', 'vk', 'telegram', 'max']);
  for (const p of mask.PLATFORMS) {
    const box = f.w.document.createElement('div'); box.innerHTML = mask.html(p.id);
    assert.ok(box.querySelector('.mt-mask__top') && box.querySelector('.mt-mask__bottom') && box.querySelector('.mt-mask__safe'));
    assert.equal(!!box.querySelector('.mt-mask__rail'), !['telegram', 'max'].includes(p.id));
  }
});
