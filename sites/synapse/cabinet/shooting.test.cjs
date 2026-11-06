'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const script = require('./shooting-script.js');
const uploader = require('./shooting-upload.js');
const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); };

const SCRIPT = 'Лена: Привет! Это Авокадо.\n[Вставка: витрина крупно]\nРеквизит: фартук, поднос\nТаня: А что нового?\nЛена: Новое меню!\nДействие: Таня пробует';
const snapshot = {approval: {status: 'pending'}, plan: {days: [
  {ideaId: 'r-late', date: '2026-11-14', format: 'reel', topic: 'Второй по дате', hook: 'Стоп!'},
  {ideaId: 'r-first', date: '2026-11-12', format: 'reel', topic: 'Новое меню', hook: 'Угадайте', script: SCRIPT, filmingBy: 'SAMPLE оператор'},
  {ideaId: 'r-post', date: '2026-11-11', format: 'post', topic: 'Пост'},
  {ideaId: 'r-pending', date: '2026-11-10', format: 'reel', topic: 'Не согласован'}]},
variants: [{ideaId: 'r-late', status: 'approved'}, {ideaId: 'r-first', status: 'approved'}, {ideaId: 'r-post', status: 'approved'}, {ideaId: 'r-pending', status: 'pending'}]};

test('разбор сценария «Имя: реплика», запасной вариант без ролей, расписание и порядок рилсов', () => {
  const parsed = script.parse(SCRIPT);
  assert.deepEqual(parsed.actors, ['Лена', 'Таня']);
  assert.deepEqual(parsed.frames.map((f) => f.type), ['line', 'insert', 'line', 'line', 'action']);
  assert.deepEqual(parsed.frames[1].props, ['фартук', 'поднос']); assert.deepEqual(parsed.props, ['фартук', 'поднос']);
  const plain = script.parse('Просто текст без ролей\nвторая строка');
  assert.equal(plain.hasRoles, false); assert.equal(plain.frames.length, 2);
  const fallback = script.parse('', {hook: 'Стоп!', topic: 'Тема'});
  assert.equal(fallback.source, 'hook'); assert.match(fallback.frames[0].text, /Хук.*Стоп!/);
  // Выход в четверг 12.11, дедлайн за 3 дня — пн 09.11; съёмка по вт/чт → последний подходящий день — чт 05.11.
  const plan = script.schedule('2026-11-12', {deadlineDays: 3, shootingWeekdays: [2, 4]});
  assert.deepEqual([plan.deadline, plan.shootDate, plan.weekday], ['2026-11-09', '2026-11-05', 'четверг']);
  assert.equal(script.schedule('2026-11-12', {}).configured, false);
  const list = script.reels(snapshot, {'r-late': {status: 'shot', takes: 2}});
  // Номер — номер строки в плане (r-first вторая строка), порядок — по дате выхода.
  assert.deepEqual(list.map((r) => [r.number, r.idea.ideaId, r.status]), [[2, 'r-first', 'approved'], [1, 'r-late', 'shot']]);
  const text = script.shareText(parsed, 'Лена', {title: 'Рилс №1'});
  assert.match(text, /\*\*▶ ЛЕНА: Привет! Это Авокадо.\*\*/); assert.match(text, /^Таня: А что нового\?$/m); assert.match(text, /Реквизит: фартук, поднос/);
});

test('загрузка продолжается с принятого байта после сетевого обрыва и 409', async () => {
  const size = 25, stored = []; let offset = 0, calls = 0;
  const file = {name: 'IMG.MOV', size, type: 'video/quicktime', lastModified: 1, slice: (a, b) => ({a, b})};
  const fetchImpl = async (url, options = {}) => {
    const ok = (body) => ({ok: true, status: 200, json: async () => body});
    const state = () => ({id: 1, offset, size, status: offset === size ? 'stored' : 'uploading', chunkBytes: 10});
    if (options.method === 'POST') return ok({upload: state()});
    if (options.method === 'PATCH') {
      calls += 1;
      if (calls === 2) throw new TypeError('Failed to fetch'); // обрыв сети
      if (calls === 3) { offset = 10; return {ok: false, status: 409, json: async () => ({error: 'Смещение', details: {upload: state()}})}; }
      const {a, b} = options.body; assert.equal(Number(options.headers['upload-offset']), a); assert.equal(a, offset);
      stored.push([a, b]); offset = b; return ok({upload: state()});
    }
    return ok({upload: state()});
  };
  const progress = [];
  const result = await uploader.upload({file, ideaId: 'r-first', companyCode: 'avokado', fetchImpl, backoffMs: 1, onProgress: (o) => progress.push(o)});
  assert.equal(result.status, 'stored'); assert.deepEqual(stored, [[0, 10], [10, 20], [20, 25]]); assert.equal(progress.at(-1), 25);
});

test('«Сценарий по секундам»: строки таблицы, время, «В кадре»/«Титр» к сцене, «ДО СЪЁМКИ» — не сцена; этапы CfKit', () => {
  const parsed = script.parse([
    '0–3 с | Актёр | Пятьсот рублей — и курс? | Актёр у стойки | Наезд | 500 ₽',
    '3–6 с | Администратор | Первый визит стоит пятьсот. | Администратор за стойкой | Склейка | Первый визит',
    '6–8 с | — | | Прайс крупно | Перебивка | ',
    '8 с · Лена: Ждём вас!',
    'В кадре: Лена у двери',
    'Титр: Запись в профиле',
    'ДО СЪЁМКИ: сверить цену с мастером'].join('\n'));
  assert.deepEqual(parsed.actors, ['Актёр', 'Администратор', 'Лена']);
  assert.equal(parsed.frames.length, 4, '«В кадре» и «Титр» дополняют сцену, а не создают новую');
  assert.deepEqual([parsed.frames[0].time, parsed.frames[0].shot, parsed.frames[0].action, parsed.frames[0].title], ['0–3 с', 'Актёр у стойки', 'Наезд', '500 ₽']);
  assert.equal(parsed.frames[2].type, 'action'); assert.equal(parsed.frames[2].text, 'Прайс крупно');
  assert.deepEqual([parsed.frames[3].time, parsed.frames[3].actor, parsed.frames[3].shot, parsed.frames[3].title], ['8 с', 'Лена', 'Лена у двери', 'Запись в профиле']);
  assert.deepEqual(parsed.before, ['сверить цену с мастером']);
  const reel = (status, extra = {}) => ({status, idea: {date: '2026-11-01', ...extra}});
  assert.deepEqual(['approved', 'shot', 'editing', 'draft'].map((s) => script.stageOf(reel(s))), ['planned', 'shot', 'editing', 'edit_review']);
  assert.equal(script.stageOf(reel('approved', {stage: 'published'})), 'published', 'этап из плана, когда сервер его отдаёт');
  assert.equal(script.onShoot(reel('approved', {stage: 'published'}), '2026-11-07'), false, 'опубликованное не показывается');
  assert.equal(script.onShoot(reel('approved', {stage: 'ready'}), '2026-11-07'), false, 'готовое с прошедшей датой не показывается');
  assert.equal(script.onShoot(reel('approved', {stage: 'ready', date: '2026-11-20'}), '2026-11-07'), true);
  assert.equal(script.onShoot(reel('draft'), '2026-11-07'), true, 'без признака публикации рилс остаётся');
});

function page({companyCode = 'avokado', path: route = '', canEdit = true, kit = true, settings = {deadlineDays: 3, shootingWeekdays: [2, 4]}} = {}) {
  const dom = new JSDOM('<main id="m"></main>', {url: 'https://cabinet.test/cabinet.html', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window, registered = {}, calls = [], navigations = [];
  w.SynapseModules = {register: (id, def) => { registered[id] = def; }};
  w.HTMLElement.prototype.scrollIntoView = function () { w.__scrolled = this; };
  for (const file of [...(kit ? ['cf-kit.js'] : []), 'shooting-script.js', 'shooting-upload.js', 'shooting-prompter.js', 'shooting-board.js', 'shooting.js']) w.eval(read(file));
  const ctx = {companyCode, route: {path: route}, csrfToken: 'csrf', navigate: (to) => navigations.push(to),
    crm: async (p, params) => { calls.push(['crm', p, params.companyCode]); return snapshot; },
    api: {get: async (p) => { calls.push(['get', p]); return p === 'shooting/reels'
      ? {canEdit, storage: {canUpload: true, usedBytes: 0, quotaBytes: 40 * 1024 ** 3}, reels: {}}
      : {reel: {board: [], sketches: {}, sketchStatus: {available: false, reason: 'нет ключа'}},
        uploads: [{id: 5, kind: 'take', frame: 1, status: 'stored', name: 'take1.mov', size: 1e8, mime: 'video/quicktime', fileUrl: '/f/5'},
        {id: 6, kind: 'draft', frame: null, status: 'stored', name: 'draft.mp4', size: 5e7, mime: 'video/mp4', fileUrl: '/f/6'}]}; }, put: async () => ({})},
    settings: {content: {get: async () => ({settings: {...settings, contentPlanSheetUrl: 'https://docs.google.com/spreadsheets/d/SAMPLE/edit'}})}}};
  return {w, d: w.document, registered, ctx, calls, navigations};
}
const card = (root, ideaId) => root.querySelector(`.shoot-row[data-idea="${ideaId}"]`);

test('№121: Съёмка показывает все видео-позиции плана с номером строки плана, даже если Хью поставил post/story', async () => {
  // Как на боевом 05.11: площадка только «Instagram / Reels», Хью проставил форматы post/reel/story/post/story.
  const live = {approval: {status: 'pending'}, plan: {days: [
    {ideaId: 'idea-06', date: '2026-11-06', platform: 'instagram', format: 'post', topic: 'Раз', script: 'Влад: Привет'},
    {ideaId: 'idea-07', date: '2026-11-07', platform: 'instagram', format: 'reel', topic: 'Частый вопрос новичка'},
    {ideaId: 'idea-08', date: '2026-11-08', platform: 'instagram', format: 'story', topic: 'Три'},
    {ideaId: 'idea-10', date: '2026-11-10', platform: 'instagram', format: 'post', topic: 'Четыре', filmingBy: 'SAMPLE оператор'},
    {ideaId: 'idea-12', date: '2026-11-12', platform: 'instagram', format: 'story', topic: 'Пять'},
    {ideaId: 'idea-13', date: '2026-11-13', platform: 'instagram', format: 'post', topic: 'Фото без съёмки'},
    {ideaId: 'idea-14', date: '2026-11-14', platform: 'vk', format: 'post', topic: 'Версия-рилс', variants: {vk: {format: 'reel'}}},
    {ideaId: 'idea-15', date: '2026-11-15', platform: 'tiktok', format: 'post', topic: 'TikTok'}]},
  variants: ['06', '07', '08', '10', '12', '13', '14', '15'].map((n) => ({ideaId: `idea-${n}`, status: 'approved'}))};
  const list = script.reels(live);
  assert.deepEqual(list.map((r) => [r.number, r.idea.ideaId]),
    [[1, 'idea-06'], [2, 'idea-07'], [3, 'idea-08'], [4, 'idea-10'], [5, 'idea-12'], [7, 'idea-14'], [8, 'idea-15']],
    'все пять позиций Reels и видео-версии; фото-пост без сценария (№6) не снимается; номера как в плане');
  assert.equal(list.find((r) => r.idea.ideaId === 'idea-07').number, 2, '«Частый вопрос новичка» — №2, как в плане');
  assert.deepEqual(list.slice(0, 3).map((r) => r.kind), ['Видео', 'Рилс', 'Сторис']);
  // Экран: карточки по порядку, номер строки плана в названии; вид — в полном виде.
  const p = page({settings: {}}), root = p.d.getElementById('m');
  p.ctx.crm = async () => live;
  await p.registered['content-shooting'].mount(root, p.ctx);
  const nums = [...root.querySelectorAll('.shoot-row__topic')].map((node) => node.textContent.split(' ')[0]);
  assert.deepEqual(nums, ['№1', '№2', '№3', '№4', '№5', '№7', '№8']);
  assert.deepEqual([...card(root, 'idea-14').querySelectorAll('.shoot-nb')].map((n) => n.textContent), ['VK'], 'значки площадок из версий плана');
  assert.deepEqual([...card(root, 'idea-15').querySelectorAll('.shoot-nb')].map((n) => n.textContent), ['TT']);
  const opened = page({path: 'idea-08', settings: {}}), openedRoot = opened.d.getElementById('m');
  opened.ctx.crm = async () => live;
  await opened.registered['content-shooting'].mount(openedRoot, opened.ctx); await settle();
  assert.ok(card(openedRoot, 'idea-08').querySelector('.shoot-full'), 'подпуть раскрывает карточку');
  assert.match(card(openedRoot, 'idea-08').querySelector('.shoot-full__grid').textContent, /Формат\s*Сторис/);
  assert.equal(opened.w.__scrolled, card(openedRoot, 'idea-08'), 'и прокручивает к ней');
});

test('экран «Съёмка» по макету 07.11: шапка CfKit, карточка без «Сменить статус», две кнопки, загрузка и площадки', async () => {
  const p = page(), root = p.d.getElementById('m');
  assert.equal(typeof p.registered['content-shooting'].mount, 'function');
  await p.registered['content-shooting'].mount(root, p.ctx);
  assert.deepEqual(p.calls[0], ['crm', '/media-mentor', 'avokado']);
  const head = root.querySelector('.cfk-head');
  assert.equal(head.querySelector('.cfk-title').textContent, 'Согласованные рилсы');
  assert.ok(head.querySelector('[data-cfk-act=calendar]') && head.querySelector('[data-cfk-act=sort]'));
  assert.match(head.querySelector('a[data-cfk-act=sheet]').href, /^https:\/\/docs\.google\.com\/spreadsheets\/d\/SAMPLE/);
  assert.ok(!root.textContent.includes('⚙'), 'шестерёнки на «Съёмке» нет');
  const strip = root.querySelector('.cfk-dates');
  assert.equal(strip.hidden, true, 'полоса дат скрыта, пока не нажат календарь');
  head.querySelector('[data-cfk-act=calendar]').click();
  assert.equal(strip.hidden, false);
  assert.ok(strip.querySelector('[data-cfk-day="2026-11-05"].has'), 'точка в день съёмки');
  const rows = [...root.querySelectorAll('.shoot-row')];
  assert.deepEqual(rows.map((row) => row.dataset.idea), ['r-first', 'r-late'], 'по дате съёмки');
  const first = rows[0];
  assert.match(first.querySelector('.shoot-row__meta').textContent, /Съёмка чт, 05\.11 · выход чт, 12\.11/);
  assert.equal(first.querySelector('[data-stage]').textContent, 'Запланировано', 'этап из общей цепочки, без «Снимается»');
  assert.ok(first.querySelector('.cfk-chip'), 'чип CfKit');
  assert.equal(first.querySelector('.shoot-row__topic').textContent, '№2 Новое меню');
  assert.equal(first.querySelector('.shoot-row__chev').textContent, '▾');
  assert.deepEqual([...first.querySelectorAll('.shoot-pair__btn')].map((b) => b.textContent), ['Суфлёр', 'Раскадровка']);
  assert.equal(first.querySelector('.shoot-upload--main').textContent, 'Загрузить материал');
  assert.ok(!/Сменить статус|Общий план|Снимается/.test(root.textContent));
  assert.ok(!root.querySelector('select.shoot-status'), 'ручной смены статуса нет');
  assert.deepEqual([...rows[1].querySelectorAll('.shoot-nb')].map((n) => n.textContent), [], 'без площадок — без значков');
  // Нажатие на карточку раскрывает полный вид: сцены «Сцена №N», загрузка у каждой, «До съёмки» после сцен.
  first.querySelector('.shoot-row__meta').click(); await settle();
  const open = card(root, 'r-first');
  assert.equal(open.querySelector('.shoot-row__chev').textContent, '▴');
  assert.equal(open.querySelectorAll('.shoot-frame').length, 5);
  assert.deepEqual([...open.querySelectorAll('.shoot-frame__head b')].slice(0, 2).map((b) => b.textContent), ['Сцена №1', 'Сцена №2']);
  assert.equal(open.querySelectorAll('.shoot-frame .shoot-upload').length, 5, 'кнопка у каждой сцены');
  assert.match(open.querySelector('[data-files="1"]').textContent, /take1\.mov/);
  assert.ok(open.querySelector('[data-drafts] video'), 'черновик монтажа в полном виде');
  assert.match(open.textContent, /СнимаетSAMPLE оператор/);
  assert.ok(open.querySelector('.shoot-frames').compareDocumentPosition(open.querySelector('.shoot-pair')) & 4, 'кнопки — под полным видом');
  // Кнопка внутри карточки не сворачивает её; нажатие в тексте полного вида — сворачивает.
  open.querySelector('.shoot-frame .shoot-upload').click();
  assert.ok(card(root, 'r-first').querySelector('.shoot-full'));
  card(root, 'r-first').querySelector('.shoot-frame__say').click();
  assert.equal(card(root, 'r-first').querySelector('.shoot-full'), null);
  const viewer = page({path: 'r-first', canEdit: false}), viewerRoot = viewer.d.getElementById('m');
  await viewer.registered['content-shooting'].mount(viewerRoot, viewer.ctx); await settle();
  assert.ok([...viewerRoot.querySelectorAll('.shoot-upload')].every((b) => b.disabled), 'без права правки загрузка недоступна');
});

test('сортировка ⇅: номер, сначала без материалов, статус; выбор запоминается; полоса дат перематывает к дню', async () => {
  const p = page(), root = p.d.getElementById('m');
  p.ctx.api.get = async (path) => path === 'shooting/reels'
    ? {canEdit: true, storage: {canUpload: true}, reels: {'r-first': {status: 'shot', takes: 3}}} : {uploads: []};
  await p.registered['content-shooting'].mount(root, p.ctx);
  const order = () => [...root.querySelectorAll('.shoot-row')].map((row) => row.dataset.idea);
  assert.deepEqual(order(), ['r-first', 'r-late']);
  const pick = (id) => { root.querySelector('[data-cfk-act=sort]').click(); root.querySelector(`[data-cfk-sort="${id}"]`).click(); };
  root.querySelector('[data-cfk-act=sort]').click();
  assert.deepEqual([...root.querySelectorAll('[data-cfk-sort]')].map((b) => b.dataset.cfkSort), ['shoot', 'status', 'nomaterial', 'number']);
  root.querySelector('[data-cfk-act=sort]').click();
  pick('number'); assert.deepEqual(order(), ['r-late', 'r-first']);
  pick('nomaterial'); assert.deepEqual(order(), ['r-late', 'r-first'], 'без материалов — первым');
  pick('status'); assert.deepEqual(order(), ['r-first', 'r-late'], 'отснято → запланировано');
  assert.equal(card(root, 'r-first').querySelector('[data-stage]').textContent, 'Отснято');
  assert.equal(p.w.localStorage.getItem('cfkit.sort.content-shooting'), 'status');
  pick('shoot');
  root.querySelector('[data-cfk-act=calendar]').click();
  root.querySelector('[data-cfk-day="2026-11-10"]').click();
  assert.equal(p.w.__scrolled, card(root, 'r-late'), 'к первому рилсу этого дня или позже');
});

test('без CfKit — простая шапка и свой чип этапа; CfKit пришёл позже — шапка перерисована', async () => {
  const p = page({kit: false}), root = p.d.getElementById('m');
  await p.registered['content-shooting'].mount(root, p.ctx);
  assert.equal(root.querySelector('h1').textContent, 'Согласованные рилсы');
  assert.equal(root.querySelector('.shoot-chip').textContent, 'Запланировано');
  p.w.eval(read('cf-kit.js'));
  assert.ok(root.querySelector('.cfk-head'), 'событие cfkit:ready перерисовало шапку');
});

test('«Суфлёр» и «Раскадровка» открываются окнами с «← Съёмка»', async () => {
  const p = page(), root = p.d.getElementById('m');
  await p.registered['content-shooting'].mount(root, p.ctx); await settle();
  card(root, 'r-first').querySelector('[data-prompter-open]').click();
  const prompter = p.d.querySelector('.prompter');
  assert.ok(prompter); assert.equal(prompter.querySelector('.prompter__back').textContent, '← Съёмка');
  assert.match(prompter.querySelector('.prompter__title').textContent, /Суфлёр · №2/);
  prompter.querySelector('.prompter__back').click();
  assert.equal(p.d.querySelector('.prompter'), null);
  card(root, 'r-first').querySelector('[data-board-open]').click(); await settle();
  const board = p.d.querySelector('.shoot-win');
  assert.equal(board.querySelector('.shoot-win__badge').textContent, 'Тестовая версия');
  assert.equal(board.querySelectorAll('.shoot-board__frame').length, 5);
  assert.match(board.querySelector('[data-board-frame="1"] [data-files="1"]').textContent, /take1\.mov/, 'загрузки кадра видны в окне');
  board.querySelector('.shoot-win__back').click();
  assert.equal(p.d.querySelector('.shoot-win'), null);
});

test('без настроек — честная подсказка; смена компании обрывает чужие загрузки', async () => {
  const p = page({settings: {}}), root = p.d.getElementById('m');
  await p.registered['content-shooting'].mount(root, p.ctx);
  assert.match(root.querySelector('.shoot-warning').textContent, /не заданы.*Настройки → Контент/);
  assert.match(card(root, 'r-first').querySelector('.shoot-row__meta').textContent, /день съёмки не задан/);
  const job = {companyCode: 'avokado', controller: new p.w.AbortController()};
  p.w.SbShooting.view.active.set('x', job);
  await p.registered['content-shooting'].mount(root, {...p.ctx, companyCode: 'alvi'});
  assert.equal(job.controller.signal.aborted, true); assert.equal(p.w.SbShooting.view.active.size, 0);
});

test('контракт А: без csrfToken байты идут через api.raw; ошибка — тот же файл продолжает; подпуть без перезагрузки плана', async () => {
  const p = page({path: 'r-first'}), root = p.d.getElementById('m'), raws = [];
  delete p.ctx.csrfToken;
  let fails = 1;
  p.ctx.api.raw = async (method, target, body, headers) => {
    raws.push([target, method, headers['X-CSRF-Token'], headers['upload-offset']]);
    if (method === 'PATCH' && fails-- > 0) throw Object.assign(new Error('Слишком большой кусок'), {status: 413});
    const done = method === 'PATCH';
    return {ok: true, status: 200, json: async () => ({upload: {id: 9, offset: done ? 5 : 0, size: 5, status: done ? 'stored' : 'uploading', chunkBytes: 5}})};
  };
  const def = p.registered['content-shooting'];
  await def.mount(root, p.ctx); await settle();
  const button = card(root, 'r-first').querySelector('[data-slot="1"] .shoot-upload');
  assert.equal(button.disabled, false, 'api.raw оболочки включает загрузку');
  const view = root.__shooting, file = {name: 'A.MOV', size: 5, type: 'video/quicktime', lastModified: 2, slice: () => 'bytes'};
  view.startUpload(file, 1, 'r-first'); await settle();
  assert.match(card(root, 'r-first').querySelector('[data-files="1"]').textContent, /Слишком большой кусок/);
  view.startUpload(file, 1, 'r-first'); await settle();
  assert.deepEqual(raws.map(([t, m]) => `${m} ${t}`), ['POST shooting/uploads', 'PATCH shooting/uploads/9', 'POST shooting/uploads', 'PATCH shooting/uploads/9']);
  assert.ok(raws.every(([, , csrf]) => csrf === undefined), 'CSRF добавляет оболочка, модуль его не подделывает');
  assert.equal(raws[1][3], '0', 'Upload-Offset передаётся оболочке');
  assert.equal(p.w.SbShooting.view.active.size, 0, 'повтор того же файла после ошибки завершился');
  const crmCalls = p.calls.filter(([kind]) => kind === 'crm').length;
  def.onRoute({path: ''});
  assert.equal(root.querySelectorAll('.shoot-row').length, 2, 'список без повторной загрузки');
  def.onRoute({path: 'r-late'}); await settle();
  assert.ok(card(root, 'r-late').querySelector('.shoot-full'));
  assert.equal(p.calls.filter(([kind]) => kind === 'crm').length, crmCalls, 'план из CRM не перечитывается');
  def.unmount(root);
  const none = page({path: 'r-first'}), noneRoot = none.d.getElementById('m');
  delete none.ctx.csrfToken;
  await none.registered['content-shooting'].mount(noneRoot, none.ctx); await settle();
  assert.ok([...noneRoot.querySelectorAll('.shoot-upload')].every((b) => b.disabled));
  assert.match(noneRoot.querySelector('.shoot-slot__reason').textContent, /Загрузка недоступна/);
});

test('№120: полный вид рилса без реквизита не выводит «null»; «До съёмки» после сцен', async () => {
  const p = page({path: 'r-late'}), root = p.d.getElementById('m');
  await p.registered['content-shooting'].mount(root, p.ctx); await settle();
  const open = card(root, 'r-late');
  assert.doesNotMatch(open.querySelector('.shoot-full__grid').textContent, /Реквизит/);
  assert.doesNotMatch(root.textContent, /\bnull\b|\bundefined\b/);
  snapshot.plan.days[0].script = 'Лена: Стоп!\nДО СЪЁМКИ: проверить свет';
  const q = page({path: 'r-late'}), qRoot = q.d.getElementById('m');
  await q.registered['content-shooting'].mount(qRoot, q.ctx); await settle();
  const full = card(qRoot, 'r-late').querySelector('.shoot-full');
  assert.equal(full.querySelectorAll('.shoot-frame').length, 1, '«ДО СЪЁМКИ» — не сцена');
  assert.ok(full.querySelector('.shoot-frames').compareDocumentPosition(full.querySelector('.shoot-before')) & 4, '«До съёмки» после сцен');
  assert.match(full.querySelector('.shoot-before').textContent, /До съёмки.*проверить свет/);
  delete snapshot.plan.days[0].script;
});
