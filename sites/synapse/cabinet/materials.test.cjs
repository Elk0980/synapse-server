'use strict';
/* Контент-завод → Монтаж (№98 Г, макет 07.11 — №207): лента «время сверху вниз», шапка CfKit, окно публикации, загрузка ролика. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const script = fs.readFileSync(require.resolve('./materials.js'), 'utf8');
const kitSource = fs.readFileSync(path.join(__dirname, 'cf-kit.js'), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
const asset = (n) => `https://cabinet.test/content/publishing-assets/avokado/${n.repeat(32)}.mp4`;
const reels = () => [
  {id: 4, key: 'reel:4', source: 'materials', companyCode: 'avokado', title: 'Рилс про мастера', releaseDate: '2026-11-07', platforms: ['instagram', 'tiktok'],
    postId: null, currentVersion: {version: 2, mediaUrl: asset('b'), editId: 9, createdAt: '2026-11-05T10:00:00Z'}, versionCount: 2, openEdits: 1},
  {id: null, key: 'post:11', source: 'plan', companyCode: 'avokado', title: 'Из плана', releaseDate: '', platforms: ['vk'], postId: 11,
    currentVersion: {version: 1, mediaUrl: asset('c')}, versionCount: 1, openEdits: 0}];
const full = () => ({...reels()[0], versions: [{version: 1, mediaUrl: asset('a')}, {version: 2, mediaUrl: asset('b'), editId: 9}],
  edits: [{id: 9, kind: 'request', baseVersion: 1, status: 'done', resultVersion: 2, comment: 'Хью, убери паузу'}], log: []});

/* План как в кабинете: №1 вышел, №2 смонтирован (ролик связан через публикацию плана), №3 отснят, №4 в монтаже (по загрузкам съёмки),
   №5 запланирован (согласован), №6 сценарий на согласовании, №7 — пост без видео (в Монтаж не попадает). */
const idea = (n, date, over = {}) => ({ideaId: `idea-${n}`, date, platform: 'instagram', format: 'reel', role: 'reach', topic: `Тема ${n}`,
  variants: {instagram: {}, tiktok: {}, youtube_shorts: {}, vk: {}, telegram: {}}, ...over});
const mentor = () => ({companyCode: 'avokado', approval: {status: 'pending'},
  plan: {days: [idea(1, '2026-11-01'), idea(2, '2026-11-03'), idea(3, '2026-11-04', {productionStatus: 'shot', topic: '№3 Тема 3'}), idea(4, '2026-11-06'),
    idea(5, '2026-11-08'), idea(6, '2026-11-09'), idea(7, '2026-11-10', {format: 'post', platform: 'vk', variants: {vk: {}}})]},
  variants: [{ideaId: 'idea-5', platform: 'instagram', status: 'approved'}, {ideaId: 'idea-6', platform: 'instagram', status: 'pending'}]});
const planReels = () => [
  {id: 21, key: 'reel:21', source: 'materials', companyCode: 'avokado', title: 'Тема 1 монтаж', releaseDate: '2026-11-01', platforms: ['instagram', 'vk', 'telegram'],
    postId: 101, currentVersion: {version: 4, mediaUrl: asset('1'), createdAt: '2026-10-30T10:00:00Z'}, versionCount: 4, openEdits: 0},
  {id: 22, key: 'reel:22', source: 'materials', companyCode: 'avokado', title: 'Тема 2 монтаж', releaseDate: '2026-11-03', platforms: ['instagram', 'tiktok'],
    postId: 102, currentVersion: {version: 2, mediaUrl: asset('2'), createdAt: '2026-11-02T10:00:00Z'}, versionCount: 2, openEdits: 0},
  {id: 23, key: 'reel:23', source: 'materials', companyCode: 'avokado', title: 'Вне плана', releaseDate: '2026-11-05', platforms: ['tiktok'],
    postId: null, currentVersion: {version: 1, mediaUrl: asset('3'), createdAt: '2026-11-04T10:00:00Z'}, versionCount: 1, openEdits: 0}];
const posts = () => ({companyCode: 'avokado', posts: [
  {id: 101, status: 'published', title: 'Тема 1', text: 'Общий текст', captions: {instagram: 'Подпись для Инсты'}, timezone: 'Asia/Irkutsk',
    platformIds: ['instagram', 'vk', 'telegram'], planLink: {ideaId: 'idea-1', platform: 'instagram'},
    deliveries: [{channelId: 'instagram', status: 'published', url: 'https://www.instagram.com/reel/AbCdEf123/', finishedAt: '2026-11-01T10:00:00Z'},
      {channelId: 'vk', status: 'published', url: '', finishedAt: '2026-11-01T10:05:00Z'}, {channelId: 'telegram', status: 'published', url: null, finishedAt: '2026-11-01T10:06:00Z'}],
    externalReceipts: []},
  {id: 102, status: 'draft', title: 'Тема 2', text: '', captions: {}, platformIds: ['instagram', 'tiktok'], planLink: {ideaId: 'idea-2', platform: 'instagram'},
    deliveries: [], externalReceipts: []}]});
const information = () => ({companyCode: 'avokado', profile: {socials: [{type: 'vk', url: 'https://vk.com/avokado_test'}]}});

function fixture({permissions = ['autoposting.view', 'autoposting.edit'], respond, raw, plan = false, storage} = {}) {
  const dom = new JSDOM('<main id="view"></main>', {url: 'https://cabinet.test/#content/materials', runScripts: 'outside-only'});
  const w = dom.window, el = w.document.getElementById('view'), calls = [], navigations = [];
  if (storage) Object.entries(storage).forEach(([key, value]) => w.localStorage.setItem(key, value));
  w.eval(kitSource);
  w.SynapseModulesQueue = [];
  w.eval(script);
  const [id, definition] = w.SynapseModulesQueue[0];
  const answer = async (method, path, body, params) => {
    calls.push({method, path, body, params});
    const custom = respond && await respond({method, path, body, params});
    if (custom !== undefined) return custom;
    if (path === 'crm/autoposting/reels' && method === 'GET') return {companyCode: 'avokado', reels: plan ? planReels() : reels()};
    if (path === 'crm/autoposting/reels/4') return full();
    if (/^crm\/autoposting\/reels\/2\d$/.test(path)) return {...planReels().find((r) => 'crm/autoposting/reels/' + r.id === path), versions: [planReels().find((r) => 'crm/autoposting/reels/' + r.id === path).currentVersion], edits: [], log: []};
    if (plan && path === 'crm/media-mentor') return mentor();
    if (plan && path === 'crm/autoposting/posts') return posts();
    if (plan && path === 'shooting/reels') return {companyCode: 'avokado', reels: {'idea-4': {status: 'editing', takes: 5}}};
    if (plan && path === 'crm/company-information') return information();
    if (path.endsWith('/publication')) return {post: {id: 77}, reel: {...full(), postId: 77}};
    if (path === 'crm/autoposting/reels' && method === 'POST' && body?.mediaUrl) return {id: 9, key: 'reel:9', source: 'materials', companyCode: 'avokado', title: body.title,
      releaseDate: body.releaseDate, platforms: body.platforms, postId: null, currentVersion: {version: 1, mediaUrl: body.mediaUrl, sha256: body.sha256}, versionCount: 1, openEdits: 0};
    throw Object.assign(new Error('unexpected ' + path), {status: 500});
  };
  const ctx = {moduleId: id, companyCode: 'avokado', can: (p) => permissions.includes(p), signal: new w.AbortController().signal, route: {path: ''},
    settings: {content: {get: async () => ({settings: {contentPlanSheetUrl: 'https://docs.google.com/spreadsheets/d/test-sheet/edit'}})}},
    api: {get: (path, params) => answer('GET', path, undefined, params), post: (path, body) => answer('POST', path, body),
      ...(raw ? {raw: (method, path, body, options) => {calls.push({method, path, body, raw: true, headers: options?.headers});return raw({method, path, body, options});}} : {})},
    navigate: (route) => navigations.push(route)};
  return {w, el, id, definition, ctx, calls, navigations, mount: async () => {await definition.mount(el, ctx);await settle(2);}};
}
const titles = (f) => [...f.el.querySelectorAll('.mt-card .mt-card__title')].map((n) => n.textContent);

test('Монтаж: модуль content-materials; шапка «Монтаж» + «Загрузить ролик» + календарь ▦ ⇅ в одну строку; фильтров нет', async () => {
  const f = fixture();
  assert.equal(f.id, 'content-materials');
  assert.equal(f.definition.title, 'Монтаж');
  await f.mount();
  const row = f.el.querySelector('.cfk-head-row');
  assert.ok(row, 'шапка CfKit');
  assert.equal(row.querySelector('.cfk-title').textContent, 'Монтаж');
  assert.ok(row.querySelector('[data-upload-open]'), '«Загрузить ролик» в той же строке');
  assert.deepEqual([...row.querySelectorAll('[data-cfk-act]')].map((n) => n.dataset.cfkAct), ['calendar', 'sheet', 'sort']);
  assert.equal(row.querySelector('[data-cfk-act="sheet"]').getAttribute('href'), 'https://docs.google.com/spreadsheets/d/test-sheet/edit');
  assert.equal(f.el.querySelector('[data-filters]'), null);
  assert.doesNotMatch(f.el.textContent, /Выход с|Все площадки|Сбросить/);
  row.querySelector('[data-cfk-act="sort"]').click();
  assert.deepEqual([...f.el.querySelectorAll('[data-cfk-sort]')].map((n) => n.dataset.cfkSort), ['date', 'stage', 'uploads', 'number']);
  assert.match(f.el.querySelector('.cfk-sort-menu').textContent, /Дата выхода по умолчанию/);
  const dates = f.el.querySelector('.cfk-dates');
  assert.equal(dates.hidden, true, 'полоса дат скрыта до нажатия календаря');
  row.querySelector('[data-cfk-act="calendar"]').click();
  assert.equal(dates.hidden, false);
});

test('Монтаж: ответ другой компании не показывается', async () => {
  const f = fixture({respond: ({path, method}) => path === 'crm/autoposting/reels' && method === 'GET' ? {companyCode: 'alvi', reels: reels()} : undefined});
  await f.mount();
  assert.equal(f.el.querySelectorAll('.mt-card').length, 0);
});

test('Лента: выше — опубликованные, старт — у монтажёра по датам, «↓ впереди» — без материалов; пост без видео не попадает', async () => {
  const f = fixture({plan: true});
  await f.mount();
  assert.deepEqual(titles(f), ['№1 Тема 1', '№2 Тема 2', '№3 Тема 3', 'Вне плана', '№4 Тема 4', '№5 Тема 5', '№6 Тема 6']);
  const list = f.el.querySelector('[data-grid]');
  const kids = [...list.children];
  const sep = list.querySelector('.cfk-feed-sep'), ahead = list.querySelector('.cfk-feed-ahead');
  assert.ok(sep && ahead);
  assert.equal(sep.tagName, 'LI');
  assert.match(sep.textContent, /выше — опубликованные/);
  assert.match(ahead.textContent, /↓ впереди — ещё без материалов/);
  assert.equal(kids.indexOf(sep), 1, 'над первым неопубликованным');
  assert.equal(kids[kids.indexOf(ahead) + 1].querySelector('.mt-card__title').textContent, '№5 Тема 5');
  const card = (n) => [...list.querySelectorAll('.mt-card')].find((c) => c.querySelector('.mt-card__title').textContent.startsWith(`№${n} `));
  assert.equal(card(1).dataset.stage, 'published');
  assert.equal(card(2).dataset.stage, 'edit_review');
  assert.equal(card(3).dataset.stage, 'shot');
  assert.equal(card(4).dataset.stage, 'editing');
  assert.equal(card(5).dataset.stage, 'planned');
  assert.equal(card(6).dataset.stage, 'script_review');
  assert.match(card(2).querySelector('.mt-card__date').textContent, /^Вт 03\.11 · v2$/);
  assert.match(card(2).querySelector('.cfk-chip').textContent, /Монтаж на согласовании/);
  assert.match(card(3).textContent, /Отснято.*Идёт монтаж/s);
  assert.match(card(4).textContent, /В монтаже.*Идёт монтаж/s);
  assert.match(card(5).textContent, /Материалы не загружены/);
  assert.match(card(1).querySelector('.mt-card__pf').textContent, /^IG · TT · YT · VK · TG$/);
  // Превью — кадр самого ролика только у смонтированных и опубликованных; у остальных серый квадрат.
  assert.match(card(1).querySelector('video').getAttribute('src'), /1{32}\.mp4#t=0\.5$/);
  assert.ok(card(2).querySelector('video[preload="metadata"][muted]') || card(2).querySelector('video[preload="metadata"]'));
  for (const n of [3, 4, 5, 6]) { assert.equal(card(n).querySelector('video'), null); assert.ok(card(n).querySelector('.mt-thumb--empty')); }
  assert.equal(card(6).querySelector('button'), null, 'без материалов карточка не открывается');
});

test('Сортировка ⇅: «Номер» и «Новые загрузки сверху», выбор запоминается; без ленты разделителей нет', async () => {
  const f = fixture({plan: true});
  await f.mount();
  f.el.querySelector('[data-cfk-act="sort"]').click();
  f.el.querySelector('[data-cfk-sort="number"]').click();
  assert.deepEqual(titles(f).slice(0, 3), ['№1 Тема 1', '№2 Тема 2', '№3 Тема 3']);
  assert.equal(titles(f).at(-1), 'Вне плана');
  assert.equal(f.el.querySelector('.cfk-feed-ahead'), null);
  assert.equal(f.w.localStorage.getItem('cfkit.sort.materials'), 'number');
  f.el.querySelector('[data-cfk-act="sort"]').click();
  f.el.querySelector('[data-cfk-sort="uploads"]').click();
  assert.deepEqual(titles(f).slice(0, 3), ['Вне плана', '№2 Тема 2', '№1 Тема 1']);
  const again = fixture({plan: true, storage: {'cfkit.sort.materials': 'stage'}});
  await again.mount();
  assert.deepEqual(titles(again).slice(0, 4), ['№2 Тема 2', 'Вне плана', '№3 Тема 3', '№4 Тема 4'], 'смонтировано → отснято → в монтаже');
});

test('Окно публикации: маска IG/TT/YT/VK/TG, «вышло ↗» на пост, «вышло · сообщество ↗» из ссылок компании, «ссылка позже», текст, ✕', async () => {
  const f = fixture({plan: true});
  await f.mount();
  f.el.querySelector('[data-open="reel:21"]').click(); await settle();
  const modal = f.el.querySelector('[data-detail-modal]');
  assert.equal(modal.hidden, false);
  assert.equal(modal.querySelector('[data-title]').textContent, '№1 Тема 1');
  assert.deepEqual([...modal.querySelectorAll('input[name="mt-platform"]')].map((n) => n.value), ['instagram', 'tiktok', 'youtube_shorts', 'vk', 'telegram']);
  assert.equal(modal.querySelector('.mt-mask').dataset.mask, 'instagram');
  const ig = modal.querySelector('[data-pub="instagram"] a');
  assert.equal(ig.textContent, 'вышло ↗'); assert.equal(ig.getAttribute('href'), 'https://www.instagram.com/reel/AbCdEf123/');
  const vk = modal.querySelector('[data-pub="vk"] a');
  assert.equal(vk.textContent, 'вышло · сообщество ↗'); assert.equal(vk.getAttribute('href'), 'https://vk.com/avokado_test');
  assert.match(modal.querySelector('[data-pub="telegram"]').textContent, /вышло · ссылка позже/);
  assert.match(modal.querySelector('[data-pub="instagram"]').textContent, /01\.11/, 'время выхода');
  assert.equal(modal.querySelector('[data-caption]').textContent, 'Подпись для Инсты');
  const tg = modal.querySelector('input[name="mt-platform"][value="telegram"]');
  tg.checked = true; tg.dispatchEvent(new f.w.Event('change', {bubbles: true}));
  assert.equal(modal.querySelector('.mt-mask').dataset.mask, 'telegram');
  assert.equal(modal.querySelector('[data-caption]').textContent, 'Общий текст', 'нет своей подписи — общий текст');
  assert.equal(modal.querySelector('[data-publish]'), null, 'у вышедшего нет «Создать публикацию»');
  assert.ok(modal.querySelector('[data-download]'));
  const editBtn = [...modal.querySelectorAll('button')].find((b) => /Редактировать/.test(b.textContent));
  assert.ok(editBtn.disabled, 'без редактора — неактивно «скоро»'); assert.match(editBtn.textContent, /скоро/);
  assert.doesNotMatch(modal.textContent, /Удалить публикацию/, 'API снятия с площадки нет — кнопки нет');
  modal.querySelector('[data-back]').click();
  assert.equal(modal.hidden, true);
  f.el.querySelector('[data-open="reel:22"]').click(); await settle();
  assert.ok(modal.querySelector('[data-publish]'), 'у смонтированного — «Создать публикацию»');
  assert.match(modal.querySelector('[data-pub="instagram"]').textContent, /черновик публикации/);
  modal.dispatchEvent(new f.w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  assert.equal(modal.hidden, true, 'Escape закрывает');
});

test('Предпросмотр: маска меняется, версии, «Скачать», «Создать публикацию» с версией и площадками', async () => {
  const f = fixture();
  await f.mount();
  f.el.querySelector('[data-open="reel:4"]').click(); await settle();
  assert.equal(f.el.querySelector('.mt-mask').dataset.mask, 'instagram');
  const tiktok = f.el.querySelector('input[name="mt-platform"][value="tiktok"]');
  tiktok.checked = true; tiktok.dispatchEvent(new f.w.Event('change', {bubbles: true}));
  assert.equal(f.el.querySelector('.mt-mask').dataset.mask, 'tiktok');
  assert.equal(f.el.querySelectorAll('input[name="mt-platform"]').length, 5);
  assert.match(f.el.querySelector('[data-download]').getAttribute('href'), /b{32}\.mp4$/);
  const select = f.el.querySelector('[data-version]'); select.value = '1'; select.dispatchEvent(new f.w.Event('change', {bubbles: true}));
  assert.match(f.el.querySelector('[data-download]').getAttribute('href'), /a{32}\.mp4$/);
  f.el.querySelector('[data-publish]').click(); await settle();
  const call = f.calls.find((c) => c.path.endsWith('/publication'));
  assert.deepEqual(JSON.parse(JSON.stringify(call.body)), {version: 1, platformIds: ['instagram', 'tiktok']});
  assert.match(f.el.textContent, /Черновик публикации №77 создан\. Ничего не отправлено/);
  [...f.el.querySelectorAll('button')].find((b) => b.textContent === 'Открыть в «Постинге»').click();
  assert.deepEqual([...f.navigations], ['content-factory/plan']);
  assert.equal(f.w.SbCabinet.pendingMaterialOpen.postId, 77);
});

test('Права: без autoposting.edit нет «Создать публикацию», «Редактировать» и загрузки; рилс плана ведёт в «Постинг»', async () => {
  const viewer = fixture({permissions: ['autoposting.view']});
  await viewer.mount();
  viewer.el.querySelector('[data-open="reel:4"]').click(); await settle();
  assert.equal(viewer.el.querySelector('[data-publish]'), null); assert.equal(viewer.el.querySelector('[data-edit]'), null);
  assert.doesNotMatch(viewer.el.querySelector('[data-detail]').textContent, /Редактировать/);
  assert.ok(viewer.el.querySelector('[data-download]'));
  const editor = fixture();
  await editor.mount();
  editor.el.querySelector('[data-open="post:11"]').click(); await tick();
  editor.el.querySelector('[data-open-post]').click();
  assert.deepEqual({...editor.w.SbCabinet.pendingMaterialOpen}, {companyCode: 'avokado', postId: 11, source: 'materials'});
  assert.equal(editor.el.querySelector('[data-detail]').hidden, true);
});

test('Редактор есть — «Редактировать» активна и открывает существующий редактор', async () => {
  const f = fixture();
  let opened = null;
  let hostEl = null;
  f.w.SbCabinet.reelEditor = {open: (host, options) => { opened = options; hostEl = host; }};
  await f.mount();
  f.el.querySelector('[data-open="reel:4"]').click(); await settle();
  f.el.querySelector('[data-edit]').click(); await settle();
  assert.equal(opened.reel.id, 4); assert.equal(opened.version, 2);
  assert.ok(hostEl.matches("[data-detail-modal]"), "редактор поверх окна ролика");
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
function fillUpload(f, {name = 'reel_avokado02_v2.mp4', type = 'video/mp4', size = 18 * 1024 * 1024, title, platforms = ['instagram', 'vk'], open = true} = {}) {
  if (open) f.el.querySelector('[data-upload-open]').click();
  const form = f.el.querySelector('[data-upload]'), file = new f.w.File([new Uint8Array(4)], name, {type});
  Object.defineProperty(file, 'size', {value: size});
  Object.defineProperty(form.elements.file, 'files', {value: [file], configurable: true});
  form.elements.file.dispatchEvent(new f.w.Event('change', {bubbles: true}));
  if (title !== undefined) form.elements.title.value = title;
  if (platforms) {
    form.elements.releaseDate.value = '2026-11-08';
    for (const input of form.querySelectorAll('[name=platforms]')) input.checked = platforms.includes(input.value);
  }
  return {form, file, submit: async () => {form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true})); await settle();}};
}

test('Загрузка: кнопка «Загрузить ролик» только с autoposting.edit; окно открывается и закрывается', async () => {
  const viewer = fixture({permissions: ['autoposting.view'], raw: async () => okResponse({})});
  await viewer.mount();
  assert.equal(viewer.el.querySelector('[data-upload-open]'), null); assert.equal(viewer.el.querySelector('[data-upload]'), null);
  const editor = fixture({raw: async () => okResponse({})});
  await editor.mount();
  assert.ok(editor.el.querySelector('[data-upload-open]'));
  assert.equal(editor.el.querySelector('[data-upload]').hidden, true, 'окно скрыто до нажатия');
  editor.el.querySelector('[data-upload-open]').click();
  assert.equal(editor.el.querySelector('[data-upload]').hidden, false);
  assert.equal(editor.el.querySelector('[data-upload-modal]').hidden, false);
  editor.el.querySelector('[data-upload-cancel]').click();
  assert.equal(editor.el.querySelector('[data-upload]').hidden, true);
  assert.equal(editor.el.querySelector('[data-upload-modal]').hidden, true);
});

test('Загрузка: «К какому рилсу из плана?» — сверху отснятые и в монтаже, внизу «Новый — вне плана»; выбор подставляет тему, дату, площадки', async () => {
  const f = fixture({plan: true, raw: async () => okResponse({url: asset('d'), sha256: 'e'.repeat(64)})});
  await f.mount();
  f.el.querySelector('[data-upload-open]').click();
  const select = f.el.querySelector('[data-upload-idea]');
  const options = [...select.options];
  assert.deepEqual(options.slice(0, 2).map((o) => o.value), ['idea-3', 'idea-4']);
  assert.equal(select.querySelector('optgroup').label, 'Отснято и в монтаже');
  assert.equal(options.at(-1).textContent, 'Новый — вне плана'); assert.equal(options.at(-1).value, '');
  assert.ok(!options.some((o) => o.value === 'idea-1'), 'опубликованных в выборе нет');
  assert.equal(select.value, 'idea-3');
  const form = f.el.querySelector('[data-upload]');
  assert.equal(form.elements.title.value, '№3 Тема 3'); assert.equal(form.elements.releaseDate.value, '2026-11-04');
  assert.deepEqual([...form.querySelectorAll('[name=platforms]:checked')].map((i) => i.value), ['instagram', 'tiktok', 'youtube_shorts', 'vk', 'telegram']);
  assert.match(f.el.querySelector('[data-upload-link-note]').textContent, /после обновления сервера/);
  select.value = ''; select.dispatchEvent(new f.w.Event('change', {bubbles: true}));
  assert.equal(form.elements.title.value, ''); assert.equal([...form.querySelectorAll('[name=platforms]:checked')].length, 0);
  select.value = 'idea-4'; select.dispatchEvent(new f.w.Event('change', {bubbles: true}));
  const {submit} = fillUpload(f, {open: false, platforms: null});
  assert.equal(form.elements.title.value, '№4 Тема 4', 'имя файла не затирает тему рилса');
  await submit();
  const create = f.calls.find((c) => c.path === 'crm/autoposting/reels' && c.method === 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(create.body)), {title: '№4 Тема 4', releaseDate: '2026-11-06', platforms: ['instagram', 'tiktok', 'youtube_shorts', 'vk', 'telegram'], mediaUrl: asset('d'), sha256: 'e'.repeat(64)});
});

test('Загрузка: нажатие на отснятый рилс открывает окно загрузки с этим рилсом', async () => {
  const f = fixture({plan: true, raw: async () => okResponse({})});
  await f.mount();
  f.el.querySelector('[data-upload-for="idea-4"]').click();
  assert.equal(f.el.querySelector('[data-upload]').hidden, false);
  assert.equal(f.el.querySelector('[data-upload-idea]').value, 'idea-4');
});

test('Загрузка: файл → POST publishing-assets (сырой, Content-Type видео) → POST crm/autoposting/reels → ролик v1 в ленте', async () => {
  const f = fixture({raw: async () => okResponse({url: asset('d'), sha256: 'e'.repeat(64), size: 4, type: 'video/mp4'})});
  await f.mount();
  const {submit, file} = fillUpload(f, {title: '№2 «Первый визит» v2'});
  assert.equal(f.el.querySelector('[data-upload-idea]').value, '', 'без плана — «Новый — вне плана»');
  assert.equal(f.el.querySelector('[data-upload] [name=title]').value, '№2 «Первый визит» v2');
  await submit();
  const order = f.calls.filter((c) => c.method === 'POST').map((c) => c.path);
  assert.deepEqual(order, ['publishing-assets', 'crm/autoposting/reels'], 'сначала файл, потом карточка');
  const rawCall = f.calls.find((c) => c.raw);
  assert.equal(rawCall.body, file); assert.equal(rawCall.headers['Content-Type'], 'video/mp4');
  const create = f.calls.find((c) => c.path === 'crm/autoposting/reels' && c.method === 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(create.body)), {title: '№2 «Первый визит» v2', releaseDate: '2026-11-08', platforms: ['instagram', 'vk'], mediaUrl: asset('d'), sha256: 'e'.repeat(64)});
  const card = f.el.querySelector('[data-open="reel:9"]');
  assert.equal(f.el.querySelectorAll('.mt-card').length, 3);
  assert.match(card.textContent, /Первый визит/); assert.match(card.textContent, /Вс 08\.11 · v1/);
  assert.equal(f.el.querySelector('[data-upload]').hidden, true);
  assert.match(f.el.querySelector('[data-status]').textContent, /загружен как v1/);
  card.click(); await settle();
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
  assert.equal(refused.el.querySelector('[data-upload]').hidden, false, 'окно остаётся, можно исправить');

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

test('Загрузка: при открытом окне ролика кнопка скрыта, после ✕ снова видна', async () => {
  const f = fixture({raw: async () => okResponse({})});
  await f.mount();
  f.el.querySelector('[data-upload-open]').click();
  f.el.querySelector('[data-open="reel:4"]').click(); await settle();
  assert.equal(f.el.querySelector('[data-upload]').hidden, true); assert.equal(f.el.querySelector('[data-upload-open]').hidden, true);
  f.el.querySelector('[data-back]').click();
  assert.equal(f.el.querySelector('[data-upload-open]').hidden, false);
});

test('Без CfKit экран не падает: простая шапка и лента', async () => {
  const dom = new JSDOM('<main id="view"></main>', {url: 'https://cabinet.test/', runScripts: 'outside-only'});
  const w = dom.window; w.SynapseModulesQueue = []; w.eval(script);
  const [, definition] = w.SynapseModulesQueue[0], el = w.document.getElementById('view');
  const ctx = {companyCode: 'avokado', can: () => true, signal: new w.AbortController().signal, route: {path: ''},
    api: {get: async (path) => { if (path === 'crm/autoposting/reels') return {companyCode: 'avokado', reels: reels()}; throw new Error('нет'); }, post: async () => ({})}};
  const started = Date.now();
  const mounting = definition.mount(el, ctx);
  w.dispatchEvent(new w.CustomEvent('cfkit:ready'));
  await mounting; await settle(2);
  assert.ok(Date.now() - started < 1400, 'событие cfkit:ready не заставляет ждать таймаут');
  assert.equal(el.querySelector('.cfk-title').textContent, 'Монтаж');
  assert.equal(el.querySelectorAll('.mt-card').length, 2);
  assert.match(el.querySelector('.cfk-chip').textContent, /Монтаж на/);
});

/* Пакет H (specs/209-cf-stages): ответ нового сервера — idea.stage, publications, plan.stageFacts, company.timeZone; ролик знает ideaId. */
const freshMentor = () => {
  const data = mentor();
  data.company = {code: 'avokado', timeZone: 'Asia/Irkutsk', timeZoneSource: 'company'};
  data.plan.stageFacts = {stages: [], shooting: true, unpublished: false, note: ''};
  data.plan.days = data.plan.days.map((d) => d.ideaId === 'idea-2'
    ? {...d, stage: 'published', stageSource: 'publication', publications: [{platform: 'vk', status: 'published', url: 'https://vk.com/wall-1_7', publishedAt: '2026-11-03T04:00:00Z'}]}
    : d.ideaId === 'idea-5' ? {...d, stage: 'edit_review', stageSource: 'montage', publications: []} : {...d, publications: []});
  return data;
};
const freshReels = () => planReels().map((r) => r.id === 23 ? {...r, ideaId: 'idea-5', planLink: {ideaId: 'idea-5', source: 'materials'}} : r);
const fresh = (respond) => fixture({plan: true, raw: async () => okResponse({url: asset('d'), sha256: 'e'.repeat(64)}), respond: async (call) => {
  if (call.path === 'crm/media-mentor') return freshMentor();
  if (call.path === 'crm/autoposting/reels' && call.method === 'GET') return {companyCode: 'avokado', reels: freshReels()};
  return respond?.(call);
}});

test('пакет H, новый сервер: этап из idea.stage, ролик привязан по ideaId, «вышло ↗» из publications, «Иркутское время»', async () => {
  const f = fresh();
  await f.mount();
  const card = (n) => [...f.el.querySelectorAll('.mt-card')].find((node) => node.querySelector('.mt-card__title').textContent.startsWith(`№${n} `));
  assert.equal(card(2).dataset.stage, 'published', 'этап сервера, хотя публикация кабинета — черновик');
  assert.equal(card(2).dataset.group, 'above');
  assert.equal(card(5).dataset.stage, 'edit_review');
  assert.ok(card(5).querySelector('[data-open="reel:23"]'), 'ролик «вне плана» с ideaId стоит у рилса №5');
  assert.ok(!titles(f).includes('Вне плана'), 'и не висит отдельной карточкой');
  assert.equal(f.el.querySelector('.cfk-tz').textContent, 'Иркутское время');
  card(2).querySelector('[data-open]').click(); await settle();
  const vk = f.el.querySelector('[data-pub="vk"]');
  assert.equal(vk.dataset.pubState, 'post');
  assert.equal(vk.querySelector('a').getAttribute('href'), 'https://vk.com/wall-1_7');
  assert.match(vk.textContent, /вышло ↗/);
});

test('пакет H, новый сервер: «Загрузить ролик» к рилсу плана отправляет ideaId — «добавлено как v3 к №3»', async () => {
  const f = fresh(({method, path, body}) => path === 'crm/autoposting/reels' && method === 'POST'
    ? {id: 31, key: 'reel:31', source: 'materials', companyCode: 'avokado', title: body.title, releaseDate: body.releaseDate, platforms: body.platforms, postId: null,
      ideaId: body.ideaId, planLink: {ideaId: body.ideaId, source: 'materials'}, currentVersion: {version: 3, mediaUrl: body.mediaUrl}, versionCount: 3, openEdits: 0, appended: true, appendedVersion: 3}
    : undefined);
  await f.mount();
  f.el.querySelector('[data-upload-open]').click();
  assert.equal(f.el.querySelector('[data-upload-idea]').value, 'idea-3');
  assert.match(f.el.querySelector('[data-upload-link-note]').textContent, /первой версией ролика №3/);
  const {submit} = fillUpload(f, {open: false, platforms: null});
  await submit(); await settle();
  const create = f.calls.find((c) => c.path === 'crm/autoposting/reels' && c.method === 'POST');
  assert.equal(create.body.ideaId, 'idea-3');
  assert.equal('offPlan' in create.body, false, 'ideaId и offPlan вместе не отправляются');
  assert.match(f.el.querySelector('[data-status]').textContent, /Добавлено как v3 к №3\./);
  assert.ok(f.calls.filter((c) => c.path === 'crm/media-mentor').length >= 2, 'после связи с планом данные перечитаны');
});

test('пакет H, новый сервер: «Новый — вне плана» отправляет offPlan:true — «черновик в Контент-плане» или причина отказа', async () => {
  for (const [offPlan, expected] of [[{ideaId: 'draft-2026-11-08-01', created: true, reason: '', message: 'Черновик добавлен в план'}, /черновик в Контент-плане/],
    [{ideaId: null, created: false, reason: 'PLAN_DECIDED', message: 'x'}, /без связи с планом: план уже согласован целиком/]]) {
    const f = fresh(({method, path, body}) => path === 'crm/autoposting/reels' && method === 'POST'
      ? {id: 32, key: 'reel:32', source: 'materials', companyCode: 'avokado', title: body.title, releaseDate: body.releaseDate, platforms: body.platforms, postId: null,
        ideaId: offPlan.ideaId, currentVersion: {version: 1, mediaUrl: body.mediaUrl}, versionCount: 1, openEdits: 0, offPlan}
      : undefined);
    await f.mount();
    f.el.querySelector('[data-upload-open]').click();
    const select = f.el.querySelector('[data-upload-idea]');
    select.value = ''; select.dispatchEvent(new f.w.Event('change', {bubbles: true}));
    assert.match(f.el.querySelector('[data-upload-link-note]').textContent, /черновик рилса/);
    const {submit} = fillUpload(f, {open: false, title: 'Закулисье'});
    await submit(); await settle();
    const create = f.calls.find((c) => c.path === 'crm/autoposting/reels' && c.method === 'POST');
    assert.equal(create.body.offPlan, true);
    assert.equal('ideaId' in create.body, false);
    assert.match(f.el.querySelector('[data-status]').textContent, expected);
  }
});

test('пакет H, старый сервер: без plan.stageFacts загрузка идёт прежним запросом без ideaId/offPlan', async () => {
  const f = fixture({plan: true, raw: async () => okResponse({url: asset('d'), sha256: 'e'.repeat(64)})});
  await f.mount();
  const {submit} = fillUpload(f, {platforms: null});
  await submit();
  const create = f.calls.find((c) => c.path === 'crm/autoposting/reels' && c.method === 'POST');
  assert.equal('ideaId' in create.body, false);
  assert.equal('offPlan' in create.body, false);
  assert.match(f.el.querySelector('[data-status]').textContent, /загружен как v1/);
});

test('Макет 07.11: отменённый и заменённый ролики не «Монтаж на согласовании» в ленте — свёрнутым блоком внизу', async () => {
  const extra = [
    {id: 31, key: 'reel:31', source: 'materials', companyCode: 'avokado', title: 'Старая версия №2', releaseDate: '2026-11-03', platforms: ['instagram'],
      postId: 131, currentVersion: {version: 1, mediaUrl: asset('4')}, versionCount: 1, openEdits: 0},
    {id: 32, key: 'reel:32', source: 'materials', companyCode: 'avokado', title: 'Рилс убран из плана', releaseDate: '2026-11-04', platforms: ['vk'],
      postId: null, ideaId: 'idea-old', currentVersion: {version: 3, mediaUrl: asset('5')}, versionCount: 3, openEdits: 0}];
  const f = fixture({plan: true, respond: ({path, method}) => {
    if (path === 'crm/autoposting/reels' && method === 'GET') return {companyCode: 'avokado', reels: [...planReels(), ...extra]};
    if (path === 'crm/autoposting/posts') { const data = posts(); data.posts.push({id: 131, status: 'cancelled', title: 'Старая', platformIds: ['instagram'], deliveries: [], externalReceipts: []}); return data; }
    return undefined;
  }});
  await f.mount();
  const feed = [...f.el.querySelectorAll('[data-grid] .mt-card .mt-card__title')].map((n) => n.textContent);
  assert.ok(!feed.includes('Старая версия №2') && !feed.includes('Рилс убран из плана'), 'в общей ленте их нет');
  assert.ok(feed.includes('Вне плана'), 'ролик «вне плана» без связи остаётся в ленте');
  const box = f.el.querySelector('[data-retired]');
  assert.equal(box.hidden, false);
  assert.equal(box.open, false, 'блок свёрнут');
  assert.match(box.querySelector('summary').textContent, /Отменённые и заменённые · 2/);
  const chips = [...box.querySelectorAll('.mt-card .cfk-chip')].map((n) => n.textContent);
  assert.deepEqual(chips, ['Публикация отменена', 'Заменён в плане']);
  assert.doesNotMatch(box.textContent, /Монтаж на согласовании/);
});

test('Макет 07.11: тема плана уже начинается с «№3» — номер в карточке не дублируется («№3 №3 …»)', async () => {
  const f = fresh();
  await f.mount();
  const all = titles(f);
  assert.ok(all.includes('№3 Тема 3'), all.join(' | '));
  assert.ok(!all.some((t) => /^№(\d+)\s+№\1\b/.test(t)), all.join(' | '));
});

/* Живые данные 07.11 (синтетика той же формы): старые ролики без ideaId ссылаются на опубликованную (архивную) публикацию только
   через postId; её нет в списке /autoposting/posts — этап читается из GET /autoposting/posts/:id. */
test('Живые данные: ролик без ideaId с postId вышедшей публикации — «Опубликовано» выше точки старта, пост читается по id', async () => {
  const old = (id, title, postId, over = {}) => ({id, key: 'reel:' + id, source: 'materials', companyCode: 'avokado', title, releaseDate: '2026-10-20', platforms: ['instagram', 'tiktok'],
    ideaId: null, postId, currentVersion: {version: 1, mediaUrl: asset('6')}, versionCount: 1, openEdits: 0, ...over});
  const extra = [old(41, 'Старый вышедший', 141), old(42, 'Старый по отметке', 142), old(43, 'Старый черновик', 143),
    old(44, 'ОТМЕНЁН — старый дубль', null), old(45, 'заменён на v4 — прежний монтаж', null), old(46, 'Без связи, обычный', null)];
  const byId = {
    141: {id: 141, companyCode: 'avokado', status: 'published', archive: {archivedAt: '2026-10-25T00:00:00Z'}, platformIds: ['instagram'],
      deliveries: [{channelId: 'instagram', status: 'published', url: 'https://www.instagram.com/reel/OLD1/'}], externalReceipts: []},
    142: {id: 142, companyCode: 'avokado', status: 'needs_review', archive: {archivedAt: null}, platformIds: ['tiktok'],
      deliveries: [{channelId: 'tiktok', status: 'failed', errorCode: 'AUTH_FAILED'}], externalReceipts: [{platform: 'tiktok', url: 'https://www.tiktok.com/@demo/video/1', publishedAt: '2026-10-21T05:00:00Z', stale: false}]},
    143: {id: 143, companyCode: 'avokado', status: 'draft', archive: {archivedAt: null}, platformIds: ['instagram'], deliveries: [], externalReceipts: []}};
  const f = fixture({plan: true, respond: ({path, method}) => {
    if (path === 'crm/autoposting/reels' && method === 'GET') return {companyCode: 'avokado', reels: [...planReels(), ...extra]};
    const m = /^crm\/autoposting\/posts\/(\d+)$/.exec(path);
    if (m) return byId[m[1]] || Promise.reject(Object.assign(new Error('нет'), {status: 404}));
    return undefined;
  }});
  await f.mount();
  const asked = f.calls.filter((c) => /^crm\/autoposting\/posts\/\d+$/.test(c.path)).map((c) => c.path).sort();
  assert.deepEqual(asked, ['crm/autoposting/posts/141', 'crm/autoposting/posts/142', 'crm/autoposting/posts/143'], 'читаются только недостающие публикации роликов');
  const card = (title) => [...f.el.querySelectorAll('[data-grid] .mt-card')].find((n) => n.querySelector('.mt-card__title').textContent === title);
  assert.equal(card('Старый вышедший').dataset.stage, 'published', 'архивная вышедшая публикация — «Опубликовано»');
  assert.equal(card('Старый вышедший').dataset.group, 'above');
  assert.equal(card('Старый по отметке').dataset.stage, 'published', 'отметка «вышло» сильнее ошибки доставки той же площадки');
  assert.match(card('Старый по отметке').textContent, /Опубликовано/);
  assert.doesNotMatch(card('Старый вышедший').textContent, /Публикация отменена/);
  assert.equal(card('Старый черновик').dataset.stage, 'edit_review', 'без выхода — как раньше');
  assert.equal(card('Без связи, обычный').dataset.stage, 'edit_review');
  const feed = [...f.el.querySelectorAll('[data-grid] .mt-card')];
  const firstNow = feed.findIndex((n) => n.dataset.group !== 'above');
  assert.ok(feed.slice(0, firstNow).some((n) => n.querySelector('.mt-card__title').textContent === 'Старый вышедший'), 'опубликованные — выше точки старта');
  const titlesIn = (sel) => [...f.el.querySelectorAll(sel + ' .mt-card__title')].map((n) => n.textContent);
  assert.ok(!titlesIn('[data-grid]').some((t) => /^(ОТМЕНЁН|заменён)/i.test(t)), 'отменённые и заменённые — не в ленте');
  assert.deepEqual(titlesIn('[data-retired-list]').sort(), ['ОТМЕНЁН — старый дубль', 'заменён на v4 — прежний монтаж'].sort());
  const chips = [...f.el.querySelectorAll('[data-retired-list] .cfk-chip')].map((n) => n.textContent).sort();
  assert.deepEqual(chips, ['Заменён в плане', 'Публикация отменена']);
});

test('Живые данные: ролик с ideaId — этап идеи с сервера; публикация по его postId не читается', async () => {
  const f = fixture({plan: true, respond: ({path, method}) => {
    if (path === 'crm/autoposting/reels' && method === 'GET') return {companyCode: 'avokado', reels: [{id: 51, key: 'reel:51', source: 'materials', companyCode: 'avokado', title: 'С идеей',
      releaseDate: '2026-11-06', platforms: ['instagram'], ideaId: 'idea-4', postId: 999, currentVersion: {version: 1, mediaUrl: asset('7')}, versionCount: 1, openEdits: 0}]};
    if (path === 'crm/media-mentor') { const m = mentor(); m.plan.days[3].stage = 'published'; m.plan.days[3].stageSource = 'publication'; return m; }
    return undefined;
  }});
  await f.mount();
  const card = [...f.el.querySelectorAll('[data-grid] .mt-card')].find((n) => /Тема 4/.test(n.textContent));
  assert.equal(card.dataset.stage, 'published');
  assert.equal(card.dataset.group, 'above');
  assert.ok(!f.calls.some((c) => c.path === 'crm/autoposting/posts/999'));
});
