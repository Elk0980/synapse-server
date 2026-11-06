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

function fixture({permissions = ['autoposting.view', 'autoposting.edit'], respond, raw} = {}) {
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
    if (path === 'crm/autoposting/reels' && method === 'POST' && body?.mediaUrl) return {id: 9, key: 'reel:9', source: 'materials', companyCode: 'avokado', title: body.title,
      releaseDate: body.releaseDate, platforms: body.platforms, postId: null, currentVersion: {version: 1, mediaUrl: body.mediaUrl, sha256: body.sha256}, versionCount: 1, openEdits: 0};
    throw Object.assign(new Error('unexpected ' + path), {status: 500});
  };
  const ctx = {moduleId: id, companyCode: 'avokado', can: (p) => permissions.includes(p), signal: new w.AbortController().signal, route: {path: ''},
    api: {get: (path, params) => answer('GET', path, undefined, params), post: (path, body) => answer('POST', path, body),
      ...(raw ? {raw: (method, path, body, options) => {calls.push({method, path, body, raw: true, headers: options?.headers});return raw({method, path, body, options});}} : {})},
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

/* Загрузка готового ролика (№145): кнопка только с правом, порядок запросов, ошибки словами. Сервер не меняется. */
const okResponse = (data, status = 201) => ({ok: status < 300, status, json: async () => data});
function fillUpload(f, {name = 'reel_avokado02_v2.mp4', type = 'video/mp4', size = 18 * 1024 * 1024, title, platforms = ['instagram', 'vk']} = {}) {
  f.el.querySelector('[data-upload-open]').click();
  const form = f.el.querySelector('[data-upload]'), file = new f.w.File([new Uint8Array(4)], name, {type});
  Object.defineProperty(file, 'size', {value: size});
  Object.defineProperty(form.elements.file, 'files', {value: [file], configurable: true});
  form.elements.file.dispatchEvent(new f.w.Event('change', {bubbles: true}));
  if (title !== undefined) form.elements.title.value = title;
  form.elements.releaseDate.value = '2026-11-08';
  for (const input of form.querySelectorAll('[name=platforms]')) input.checked = platforms.includes(input.value);
  return {form, file, submit: async () => {form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true})); for (let i = 0; i < 6; i++) await tick();}};
}

test('Загрузка: кнопка «Загрузить ролик» только с autoposting.edit', async () => {
  const viewer = fixture({permissions: ['autoposting.view'], raw: async () => okResponse({})});
  await viewer.mount();
  assert.equal(viewer.el.querySelector('[data-upload-open]'), null); assert.equal(viewer.el.querySelector('[data-upload]'), null);
  const editor = fixture({raw: async () => okResponse({})});
  await editor.mount();
  assert.ok(editor.el.querySelector('[data-upload-open]'));
  assert.equal(editor.el.querySelector('[data-upload]').hidden, true, 'форма скрыта до нажатия');
  editor.el.querySelector('[data-upload-open]').click();
  assert.equal(editor.el.querySelector('[data-upload]').hidden, false);
  editor.el.querySelector('[data-upload-cancel]').click();
  assert.equal(editor.el.querySelector('[data-upload]').hidden, true);
});

test('Загрузка: файл → POST publishing-assets (сырой, Content-Type видео) → POST crm/autoposting/reels → ролик v1 в сетке', async () => {
  const f = fixture({raw: async () => okResponse({url: asset('d'), sha256: 'e'.repeat(64), size: 4, type: 'video/mp4'})});
  await f.mount();
  const {submit, file} = fillUpload(f, {title: '№2 «Первый визит» v2'});
  assert.equal(f.el.querySelector('[data-upload] [name=title]').value, '№2 «Первый визит» v2');
  await submit();
  const order = f.calls.filter((c) => c.method === 'POST').map((c) => c.path);
  assert.deepEqual(order, ['publishing-assets', 'crm/autoposting/reels'], 'сначала файл, потом карточка');
  const rawCall = f.calls.find((c) => c.raw);
  assert.equal(rawCall.body, file); assert.equal(rawCall.headers['Content-Type'], 'video/mp4');
  const create = f.calls.find((c) => c.path === 'crm/autoposting/reels' && c.method === 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(create.body)), {title: '№2 «Первый визит» v2', releaseDate: '2026-11-08', platforms: ['instagram', 'vk'], mediaUrl: asset('d'), sha256: 'e'.repeat(64)});
  const cards = f.el.querySelectorAll('.mt-card');
  assert.equal(cards.length, 3); assert.match(cards[0].textContent, /Первый визит/); assert.match(cards[0].textContent, /v1/); assert.match(cards[0].textContent, /08\.11\.2026/);
  assert.equal(f.el.querySelector('[data-upload]').hidden, true);
  assert.match(f.el.querySelector('[data-status]').textContent, /загружен как v1/);
  f.el.querySelector('[data-open="reel:9"]').click(); await tick(); await tick();
  assert.match(f.el.querySelector('[data-download]').getAttribute('href'), /d{32}\.mp4$/);
  assert.ok(f.el.querySelector('[data-player]'), 'предпросмотр нового ролика');
});

test('Загрузка: название подставляется из имени файла; без файла, названия или площадки запрос не уходит', async () => {
  const f = fixture({raw: async () => okResponse({url: asset('d'), sha256: ''})});
  await f.mount();
  const {form, submit} = fillUpload(f, {platforms: []});
  assert.equal(form.elements.title.value, 'reel_avokado02_v2');
  await submit();
  assert.match(f.el.querySelector('[data-upload-status]').textContent, /хотя бы одну площадку/);
  form.elements.title.value = '';
  await submit();
  assert.match(f.el.querySelector('[data-upload-status]').textContent, /Введите название/);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 0);
});

test('Загрузка: ошибки словами — больше 60 МБ, не видео, отказ сервера, ошибка сети', async () => {
  const big = fixture({raw: async () => okResponse({})});
  await big.mount();
  const {submit} = fillUpload(big, {size: 61 * 1024 * 1024, title: 'Большой'});
  assert.match(big.el.querySelector('[data-upload-status]').textContent, /больше лимита 60 МБ/, 'сразу после выбора файла');
  await submit();
  assert.equal(big.calls.filter((c) => c.method === 'POST').length, 0, 'большой файл не отправляется');

  const photo = fixture({raw: async () => okResponse({})});
  await photo.mount();
  fillUpload(photo, {name: 'kadr.jpg', type: 'image/jpeg', title: 'Фото'});
  assert.match(photo.el.querySelector('[data-upload-status]').textContent, /не видео/);

  const refused = fixture({raw: async () => okResponse({error: 'Файл не соответствует выбранному формату видео'}, 415)});
  await refused.mount();
  await fillUpload(refused, {title: 'Битый'}).submit();
  assert.match(refused.el.querySelector('[data-upload-status]').textContent, /не соответствует выбранному формату видео/);
  assert.equal(refused.calls.filter((c) => c.path === 'crm/autoposting/reels' && c.method === 'POST').length, 0, 'карточка без файла не создаётся');
  assert.equal(refused.el.querySelector('[data-upload]').hidden, false, 'форма остаётся, можно исправить');

  const offline = fixture({raw: async () => { throw new TypeError('Failed to fetch'); }});
  await offline.mount();
  await fillUpload(offline, {title: 'Сеть'}).submit();
  assert.match(offline.el.querySelector('[data-upload-status]').textContent, /Ошибка сети/);
  assert.equal(offline.el.querySelector('[data-upload-submit]').disabled, false, 'кнопка снова доступна');

  const legacy = fixture();
  await legacy.mount();
  await fillUpload(legacy, {title: 'Старый кабинет'}).submit();
  assert.match(legacy.el.querySelector('[data-upload-status]').textContent, /обновите кабинет/);
});

test('Загрузка: при открытой карточке ролика кнопка и форма скрыты, после «← Все материалы» кнопка снова видна', async () => {
  const f = fixture({raw: async () => okResponse({})});
  await f.mount();
  f.el.querySelector('[data-upload-open]').click();
  f.el.querySelector('[data-open="reel:4"]').click(); await tick(); await tick();
  assert.equal(f.el.querySelector('[data-upload]').hidden, true); assert.equal(f.el.querySelector('[data-upload-open]').hidden, true);
  f.el.querySelector('[data-back]').click();
  assert.equal(f.el.querySelector('[data-upload-open]').hidden, false);
});
