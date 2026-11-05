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

function page({companyCode = 'avokado', path: route = '', canEdit = true, settings = {deadlineDays: 3, shootingWeekdays: [2, 4]}} = {}) {
  const dom = new JSDOM('<main id="m"></main>', {url: 'https://cabinet.test/cabinet.html', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window, registered = {}, calls = [], navigations = [];
  w.SynapseModules = {register: (id, def) => { registered[id] = def; }};
  for (const file of ['shooting-script.js', 'shooting-upload.js', 'shooting.js']) w.eval(read(file));
  const ctx = {companyCode, route: {path: route}, csrfToken: 'csrf', navigate: (to) => navigations.push(to),
    crm: async (p, params) => { calls.push(['crm', p, params.companyCode]); return snapshot; },
    api: {get: async (p) => { calls.push(['get', p]); return p === 'shooting/reels'
      ? {canEdit, storage: {canUpload: true, usedBytes: 0, quotaBytes: 40 * 1024 ** 3}, reels: {}}
      : {uploads: [{id: 5, kind: 'take', frame: 1, status: 'stored', name: 'take1.mov', size: 1e8, mime: 'video/quicktime', fileUrl: '/f/5'},
        {id: 6, kind: 'draft', frame: null, status: 'stored', name: 'draft.mp4', size: 5e7, mime: 'video/mp4', fileUrl: '/f/6'}]}; }, put: async () => ({})},
    settings: {content: {get: async () => ({settings})}}};
  return {w, d: w.document, registered, ctx, calls, navigations};
}

test('экран «Съёмка»: список по порядку с днём и дедлайном, карточка с кнопкой у каждого кадра', async () => {
  const p = page(), root = p.d.getElementById('m');
  assert.equal(typeof p.registered['content-shooting'].mount, 'function');
  await p.registered['content-shooting'].mount(root, p.ctx);
  const rows = [...root.querySelectorAll('.shoot-row')].map((row) => row.textContent);
  assert.equal(rows.length, 2); assert.match(rows[0], /№2.*Новое меню.*Рилс.*съёмка чт, 05.11.*дедлайн.*согласовано/);
  assert.deepEqual(p.calls[0], ['crm', '/media-mentor', 'avokado']);
  root.querySelector('.shoot-row__open').click();
  assert.deepEqual(p.navigations, ['content/shooting/r-first']);
  p.registered['content-shooting'].unmount(root);
  const card = page({path: 'r-first'}), cardRoot = card.d.getElementById('m');
  await card.registered['content-shooting'].mount(cardRoot, card.ctx); await settle();
  assert.equal(cardRoot.querySelectorAll('.shoot-frame').length, 5);
  assert.equal(cardRoot.querySelectorAll('.shoot-frame .shoot-upload').length, 5, 'кнопка напротив каждого кадра');
  assert.ok(cardRoot.querySelector('[data-frame=other] .shoot-upload'), '«Другое / дополнительно»');
  assert.match(cardRoot.querySelector('[data-files="1"]').textContent, /take1\.mov/);
  assert.ok(cardRoot.querySelector('[data-drafts] video'), 'черновик монтажа в карточке');
  assert.match(cardRoot.textContent, /снимает: SAMPLE оператор/);
  const viewer = page({path: 'r-first', canEdit: false}), viewerRoot = viewer.d.getElementById('m');
  await viewer.registered['content-shooting'].mount(viewerRoot, viewer.ctx); await settle();
  assert.ok([...viewerRoot.querySelectorAll('.shoot-upload')].every((b) => b.disabled), 'без права правки загрузка недоступна');
});

test('без настроек — честная подсказка; смена компании обрывает чужие загрузки', async () => {
  const p = page({settings: {}}), root = p.d.getElementById('m');
  await p.registered['content-shooting'].mount(root, p.ctx);
  assert.match(root.querySelector('.shoot-warning').textContent, /не заданы.*Настройки → Контент/);
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
  const button = root.querySelector('[data-slot="1"] .shoot-upload');
  assert.equal(button.disabled, false, 'api.raw оболочки включает загрузку');
  const view = root.__shooting, file = {name: 'A.MOV', size: 5, type: 'video/quicktime', lastModified: 2, slice: () => 'bytes'};
  view.startUpload(file, 1); await settle();
  assert.match(root.querySelector('[data-files="1"]').textContent, /Слишком большой кусок/);
  view.startUpload(file, 1); await settle();
  assert.deepEqual(raws.map(([t, m]) => `${m} ${t}`), ['POST shooting/uploads', 'PATCH shooting/uploads/9', 'POST shooting/uploads', 'PATCH shooting/uploads/9']);
  assert.ok(raws.every(([, , csrf]) => csrf === undefined), 'CSRF добавляет оболочка, модуль его не подделывает');
  assert.equal(raws[1][3], '0', 'Upload-Offset передаётся оболочке');
  assert.equal(p.w.SbShooting.view.active.size, 0, 'повтор того же файла после ошибки завершился');
  const crmCalls = p.calls.filter(([kind]) => kind === 'crm').length;
  def.onRoute({path: ''});
  assert.equal(root.querySelectorAll('.shoot-row').length, 2, 'список без повторной загрузки');
  def.onRoute({path: 'r-first'}); await settle();
  assert.equal(root.querySelectorAll('.shoot-frame').length, 5);
  assert.equal(p.calls.filter(([kind]) => kind === 'crm').length, crmCalls, 'план из CRM не перечитывается');
  def.unmount(root);
  const none = page({path: 'r-first'}), noneRoot = none.d.getElementById('m');
  delete none.ctx.csrfToken;
  await none.registered['content-shooting'].mount(noneRoot, none.ctx); await settle();
  assert.ok([...noneRoot.querySelectorAll('.shoot-upload')].every((b) => b.disabled));
  assert.match(noneRoot.querySelector('.shoot-slot__reason').textContent, /Загрузка недоступна/);
});

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
  // Экран: строки по порядку, номер строки плана, подпись вида.
  const p = page(), root = p.d.getElementById('m');
  p.ctx.crm = async () => live;
  await p.registered['content-shooting'].mount(root, p.ctx);
  const nums = [...root.querySelectorAll('.shoot-row__num')].map((node) => node.textContent);
  assert.deepEqual(nums, ['№1', '№2', '№3', '№4', '№5', '№7', '№8']);
  assert.equal(root.querySelectorAll('.shoot-row__kind')[2].textContent, 'Сторис');
  const card = page({path: 'idea-08'}), cardRoot = card.d.getElementById('m');
  card.ctx.crm = async () => live;
  await card.registered['content-shooting'].mount(cardRoot, card.ctx); await settle();
  assert.equal(cardRoot.querySelector('h1').textContent, 'Сторис №3 · Три');
});
