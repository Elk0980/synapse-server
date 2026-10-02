'use strict';
// CF7: форматы и цели ОВП месяца в «Настройках модуля», ограничения в сводке плана и переход из вопроса month.formats.
// Синтетический сервер в памяти по контракту CONTENT_FACTORY_CF7_MONTH_CHOICES_CONTRACT_20261001: [] = все подходящие,
// отсутствующее поле старого месяца = [], сохранение — существующий PUT месяца с ревизией. Реальных API и моделей нет.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

const FORMATS = [{id: 'post', label: 'Пост'}, {id: 'story', label: 'Сторис'}, {id: 'reel', label: 'Reels / Shorts / клип'}, {id: 'carousel', label: 'Карусель'}];
const ROLES = [{id: 'reach', label: 'Охватный'}, {id: 'affection', label: 'На влюбление'}, {id: 'sale', label: 'На продажу'}];
const PLATFORMS = [{id: 'telegram', label: 'Telegram'}, {id: 'youtube_shorts', label: 'YouTube Shorts'}];
const LEGACY = {priorities: ['Фотозона'], events: [], excludedDays: [], platforms: ['telegram'], perDay: {telegram: 1}, note: ''};

function server({months = {}, jobs = [], hold} = {}) {
  const calls = [], state = {one: {months: {...months}}, two: {months: {}}, jobs: [...jobs]};
  const days = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const monthDto = (code, month) => {
    const m = state[code].months[month] || {revision: 0, inputs: {priorities: [], events: [], excludedDays: [], platforms: [], perDay: {}, formats: [], roles: [], note: ''}};
    const per = Object.values(m.inputs.perDay).reduce((a, b) => a + b, 0);
    return JSON.parse(JSON.stringify({companyCode: code, month, daysInMonth: days(month), revision: m.revision, inputs: m.inputs, history: [],
      publicationCount: (days(month) - m.inputs.excludedDays.length) * per}));
  };
  async function crmQuery(p, params = {}, options = {}) {
    const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined, code = params.companyCode;
    calls.push({path: p, method, code, params, body});
    if (hold) await hold(p, code, method);
    if (p === '/media-mentor') return {companyCode: code, brief: {revision: 3, history: [], fields: {product: 'Шары под ключ', audience: 'Родители', pains: ['Нет времени'],
      goal: '', confirmedFacts: [], assets: [], shootingComfort: {level: 'unknown', notes: ''}, platforms: []}}, vocabulary: {formats: FORMATS, roles: ROLES}};
    if (p === '/media-mentor/inputs' && method === 'GET') return {companyCode: code, timezone: 'Asia/Irkutsk', profile: {revision: 1, history: [], fields: {genders: [], ageFrom: null, ageTo: null,
      geography: '', targetAction: '', targetUrl: '', occasions: [], questions: [], proofs: [], sourcesNote: '', styleNotes: ''}},
    vocabulary: {genders: [], platforms: PLATFORMS, formats: FORMATS, roles: ROLES, maxPerDay: 3}};
    const month = /^\/media-mentor\/inputs\/months\/(\d{4}-\d{2})$/.exec(p)?.[1];
    if (month && method === 'GET') return monthDto(code, month);
    if (month && method === 'PUT') {
      const m = state[code].months[month] || {revision: 0, inputs: monthDto(code, month).inputs};
      if (body.revision !== m.revision) throw Object.assign(new Error('Пожелания уже изменили.'), {status: 409});
      state[code].months[month] = {revision: m.revision + 1, inputs: {...m.inputs, ...body.inputs}};
      return monthDto(code, month);
    }
    if (p === '/autoposting/settings') return {companyCode: code, timezone: 'Asia/Irkutsk', channels: []};
    if (p === '/media-mentor/generation' && method === 'GET') return {companyCode: code, jobs: state.jobs.filter((item) => item.month === params.month)};
    throw Object.assign(new Error('Неожиданный адрес ' + p), {status: 404});
  }
  return {state, calls, crmQuery, writes: () => calls.filter((c) => c.method !== 'GET')};
}

function page({srv = server(), role = 'owner', permissions = [], project = 'one'} = {}) {
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(`<main><div id="content-factory-plan-bar"><button data-factory-action="compose">Составить план</button>
    <span data-factory-bar-status></span><section id="content-factory-compose" hidden></section></div>
    <section id="view" data-view="content-factory-settings"></section></main>`,
  {url: 'https://cabinet.test/cabinet.html#content-factory/plan', runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true});
  const w = dom.window, d = w.document, views = {};
  w.SbCabinet = {registerView(name, def) { views[name] = def; }};
  w.eval(fs.readFileSync(path.join(__dirname, 'content-factory.js'), 'utf8'));
  const ctx = {identity: {role, permissions, csrfToken: 'qa'}, selectedProjectId: project, crmQuery: srv.crmQuery,
    csrfOptions: (method, body) => ({method, headers: {'X-CSRF-Token': 'qa'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}), navigate() {}};
  const node = d.getElementById('view'), panel = d.getElementById('content-factory-compose'), bar = d.getElementById('content-factory-plan-bar');
  w.SbCabinet.contentFactory.bindPlanBar(bar, ctx);
  const f = {w, d, srv, ctx, node, panel, errors, views, close: () => w.close(),
    async render(next = ctx) { views['content-factory-settings'].render(node, next); await settle(); },
    async month(value) { const input = node.querySelector('#cf-month'); input.value = value; input.dispatchEvent(new w.Event('change', {bubbles: true})); await settle(); },
    async compose() { bar.querySelector('[data-factory-action="compose"]').click(); await settle(); },
    q: (s) => node.querySelector(s), qa: (s) => [...node.querySelectorAll(s)],
    mode: (kind) => node.querySelector(`[name="${kind}-mode"]:checked`)?.value,
    checked: (name) => [...node.querySelectorAll(`[name="${name}"]:checked`)].map((n) => n.value),
    summary: (kind) => node.querySelector(`[data-cf-choice-summary="${kind}"]`).textContent,
    click(selector) { node.querySelector(selector).click(); },
    change(selector, checked) { const input = node.querySelector(selector); input.checked = checked; input.dispatchEvent(new w.Event('change', {bubbles: true})); },
    async save() { node.querySelector('#cf-month-form').dispatchEvent(new w.Event('submit', {bubbles: true, cancelable: true})); await settle(); },
    state: () => node.querySelector('#cf-month-state').textContent, puts: () => srv.calls.filter((c) => c.method === 'PUT')};
  return f;
}

test('старый месяц без полей и пустой выбор — «Все подходящие», а не «ничего не выбрано»; без правок PUT не уходит', async () => {
  const srv = server({months: {'2026-10': {revision: 4, inputs: {...LEGACY}}}});
  const f = page({srv}); try {
    await f.render(); await f.month('2026-10');
    for (const kind of ['formats', 'roles']) {
      assert.equal(f.mode(kind), 'all', `${kind}: старый месяц читается как «Все подходящие»`);
      assert.equal(f.q(`[data-cf-choice-list="${kind}"]`).hidden, true);
      assert.doesNotMatch(f.summary(kind), /ничего|0|не выбран/i);
    }
    assert.equal(f.summary('formats'), 'Сейчас: все подходящие для площадки.');
    assert.equal(f.summary('roles'), 'Сейчас: все подходящие, без обязательных долей.');
    assert.match(f.q('[data-cf-choice="formats"]').textContent, /Форматы публикаций/);
    assert.match(f.q('[data-cf-choice="roles"]').textContent, /Цели публикаций \(ОВП\)/);
    assert.deepEqual(f.qa('[name="role"]').map((n) => n.closest('label').textContent), ['Охват', 'Влюбление', 'Продажи'], 'подписи ОВП как на доске');
    assert.doesNotMatch(f.q('#cf-month-form').textContent, /\b(post|story|reel|carousel|reach|affection|sale)\b/, 'служебные слова API не показываются');
    assert.match(f.q('#cf-month-form').textContent, /влияют только на следующие составления плана/);
    await f.save();
    assert.equal(f.state(), 'Изменений нет.', 'отсутствующее поле и [] — одно и то же, лишней записи нет');
    assert.deepEqual(f.puts(), []);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('«Только выбранные»: отметки по словарю, сводка «не сохранено», PUT с ревизией и порядком словаря; после перезагрузки выбор на месте', async () => {
  const srv = server({months: {'2026-10': {revision: 4, inputs: {...LEGACY}}}});
  const f = page({srv}); try {
    await f.render(); await f.month('2026-10');
    f.change('[name="formats-mode"][value="some"]', true);
    assert.equal(f.q('[data-cf-choice-list="formats"]').hidden, false);
    assert.equal(f.summary('formats'), 'Отметьте хотя бы один формат или выберите «Все подходящие».');
    f.change('[name="format"][value="reel"]', true); f.change('[name="format"][value="post"]', true);
    assert.equal(f.summary('formats'), 'Сейчас: только Пост, Reels / Shorts / клип — не сохранено.');
    f.change('[name="roles-mode"][value="some"]', true); f.change('[name="role"][value="sale"]', true);
    assert.equal(f.summary('roles'), 'Сейчас: только Продажи — не сохранено.');
    assert.equal(f.q('[data-cf-shorts-warning]').hidden, true, 'без YouTube Shorts предупреждения нет');
    await f.save();
    const puts = f.puts();
    assert.equal(puts.length, 1);
    assert.equal(puts[0].path, '/media-mentor/inputs/months/2026-10');
    assert.equal(puts[0].code, 'one');
    assert.equal(puts[0].body.revision, 4);
    assert.deepEqual(puts[0].body.inputs.formats, ['post', 'reel'], 'порядок словаря, без дублей');
    assert.deepEqual(puts[0].body.inputs.roles, ['sale']);
    assert.deepEqual(puts[0].body.inputs.platforms, ['telegram'], 'объём и площадки не меняются выбором');
    assert.deepEqual(puts[0].body.inputs.perDay, {telegram: 1});
    assert.match(f.state(), /Сохранено/);
    assert.equal(f.summary('formats'), 'Сейчас: только Пост, Reels / Shorts / клип.');
    await f.render(); await f.month('2026-10');
    assert.equal(f.mode('formats'), 'some'); assert.deepEqual(f.checked('format'), ['post', 'reel']);
    assert.equal(f.mode('roles'), 'some'); assert.deepEqual(f.checked('role'), ['sale']);
    // Возврат к «Все подходящие» отправляет [], а отметки не превращаются в «ничего».
    f.change('[name="formats-mode"][value="all"]', true);
    assert.equal(f.summary('formats'), 'Сейчас: все подходящие для площадки — не сохранено.');
    await f.save();
    assert.deepEqual(f.puts()[1].body.inputs.formats, []);
    assert.equal(f.puts()[1].body.revision, 5);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('«Только выбранные» без отметок не сохраняется; все четыре формата — «выбраны все», не ноль', async () => {
  const f = page({srv: server({months: {'2026-10': {revision: 1, inputs: {...LEGACY, formats: ['post', 'story', 'reel', 'carousel'], roles: []}}}})}); try {
    await f.render(); await f.month('2026-10');
    assert.equal(f.mode('formats'), 'some');
    assert.equal(f.summary('formats'), 'Сейчас: выбраны все: Пост, Сторис, Reels / Shorts / клип, Карусель.');
    f.change('[name="roles-mode"][value="some"]', true);
    await f.save();
    assert.deepEqual(f.puts(), [], 'пустой выбор не уходит на сервер');
    const error = f.q('[data-cf-choice-error="roles"]');
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /Отметьте хотя бы одну цель или выберите «Все подходящие»/);
    assert.match(f.state(), /Ничего не сохранено/);
    assert.equal(f.d.activeElement, f.q('[name="roles-mode"][value="some"]'));
    f.change('[name="role"][value="reach"]', true);
    assert.equal(error.hidden, true, 'ошибка снимается после отметки');
  } finally { f.close(); }
});

test('YouTube Shorts без формата Reels — предупреждение в форме сразу, без запуска; сохранение не блокируется', async () => {
  const f = page({srv: server({months: {'2026-10': {revision: 1, inputs: {...LEGACY, platforms: ['telegram', 'youtube_shorts'], perDay: {telegram: 1, youtube_shorts: 1}}}}})}); try {
    await f.render(); await f.month('2026-10');
    const warning = f.q('[data-cf-shorts-warning]');
    assert.equal(warning.hidden, true, '«Все подходящие» включает Reels');
    f.change('[name="formats-mode"][value="some"]', true); f.change('[name="format"][value="post"]', true);
    assert.equal(warning.hidden, false);
    assert.match(warning.textContent, /Для YouTube Shorts нужен формат «Reels \/ Shorts \/ клип»/);
    f.change('[name="format"][value="reel"]', true);
    assert.equal(warning.hidden, true);
    f.change('[name="format"][value="reel"]', false);
    await f.save();
    assert.equal(f.puts().length, 1, 'противоречие объясняет сервер вопросом плана, форма его не прячет');
    assert.equal(f.srv.calls.filter((c) => c.path.startsWith('/media-mentor/generation')).length, 0, 'настройки не запускают составление');
  } finally { f.close(); }
});

test('409: месяц перечитывается, свой ввод остаётся, чужая правка других полей подхватывается, совпадение названо; второй PUT — с новой ревизией', async () => {
  const srv = server({months: {'2026-10': {revision: 2, inputs: {...LEGACY, formats: [], roles: []}}}});
  const f = page({srv}); try {
    await f.render(); await f.month('2026-10');
    f.change('[name="formats-mode"][value="some"]', true); f.change('[name="format"][value="story"]', true);
    f.change('[name="roles-mode"][value="some"]', true); f.change('[name="role"][value="reach"]', true);
    // Другое окно: приоритеты и цели.
    srv.state.one.months['2026-10'] = {revision: 3, inputs: {...LEGACY, priorities: ['Выпускной'], formats: [], roles: ['sale']}};
    await f.save();
    assert.equal(f.puts().length, 1);
    assert.match(f.state(), /уже изменили в другом окне: загружена версия 3/);
    assert.match(f.state(), /В другом окне тоже меняли: цели ОВП — оставлен ваш вариант/);
    assert.match(f.state(), /Нажмите «Сохранить пожелания месяца» ещё раз/);
    assert.deepEqual(f.checked('format'), ['story'], 'свой выбор формата не потерян');
    assert.deepEqual(f.checked('role'), ['reach'], 'в конфликте оставлен свой вариант');
    assert.equal(f.q('#cf-priorities').value, 'Выпускной', 'поле, которое не трогали, обновлено из свежей версии');
    await f.save();
    const second = f.puts()[1];
    assert.equal(second.body.revision, 3);
    assert.deepEqual(second.body.inputs.formats, ['story']);
    assert.deepEqual(second.body.inputs.priorities, ['Выпускной'], 'чужая правка не затёрта');
    assert.match(f.state(), /Сохранено/);
    assert.equal(f.puts().length, 2, 'повторов без нажатия нет');
  } finally { f.close(); }
});

test('только просмотр: выбор виден и заблокирован, подсказки с примером работают, сохранения нет', async () => {
  const f = page({role: 'member', permissions: ['autoposting.view'],
    srv: server({months: {'2026-10': {revision: 1, inputs: {...LEGACY, formats: ['reel'], roles: []}}}})}); try {
    await f.render(); await f.month('2026-10');
    assert.ok(f.qa('[name="formats-mode"], [name="format"], [name="roles-mode"], [name="role"]').every((n) => n.disabled));
    assert.equal(f.summary('formats'), 'Сейчас: только Reels / Shorts / клип.');
    assert.equal(f.q('#cf-month-form button[type="submit"]'), null);
    for (const [kind, example] of [['formats', /Пост, Сторис.*Например: только Пост и Reels \/ Shorts \/ клип/], ['roles', /Охват —.*Влюбление —.*Продажи —.*Например: только Охват и Продажи/]]) {
      const button = f.q(`[aria-controls="cf-hint-${kind}"]`), note = f.d.getElementById(`cf-hint-${kind}`);
      assert.equal(note.hidden, true);
      button.click();
      assert.equal(button.getAttribute('aria-expanded'), 'true');
      assert.equal(note.hidden, false);
      assert.match(note.textContent, example);
    }
    await f.save();
    assert.deepEqual(f.puts(), []);
  } finally { f.close(); }
});

test('смена компании: поздний ответ месяца прежней компании не рисуется; выбор новой компании свой', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const srv = server({hold: (p, code) => (code === 'one' && p.endsWith('/months/2026-11') ? gate : null)});
  srv.state.one.months['2026-11'] = {revision: 1, inputs: {...LEGACY, formats: ['post'], roles: []}};
  srv.state.two.months['2026-11'] = {revision: 1, inputs: {...LEGACY, formats: [], roles: ['sale']}};
  const f = page({srv}); try {
    await f.render();
    const input = f.q('#cf-month'); input.value = '2026-11'; input.dispatchEvent(new f.w.Event('change', {bubbles: true}));
    await settle();
    await f.render({...f.ctx, selectedProjectId: 'two'}); await f.month('2026-11');
    release(); await settle();
    assert.equal(f.mode('formats'), 'all', 'у второй компании форматы не ограничены');
    assert.deepEqual(f.checked('role'), ['sale']);
    assert.equal(f.qa('#cf-month-form').length, 1);
  } finally { f.close(); }
});

const needsInput = (questions) => ({id: 'job-7', companyCode: 'one', month: '2026-10', status: 'needs_input', attempts: 0, maxAttempts: 3,
  createdAt: '2026-10-01T05:00:00Z', inputs: {briefRevision: 3, profileRevision: 1, monthRevision: 1}, executor: null, questions, proposals: []});

test('вопрос month.formats ведёт в пожелания нужного месяца, подсвечивает «Форматы публикаций» и ничего не запускает', async () => {
  const srv = server({months: {'2026-10': {revision: 1, inputs: {...LEGACY, platforms: ['youtube_shorts'], perDay: {youtube_shorts: 1}, formats: ['post'], roles: []}}},
    jobs: [needsInput([{id: 'formats', target: 'month.formats', text: 'Для YouTube Shorts нужен формат Reels / Shorts / клип. Добавьте его в выбранные форматы или уберите объём YouTube Shorts.', required: true}])]});
  const f = page({srv}); try {
    await f.compose();
    const month = f.panel.querySelector('#cf-gen-month'); month.value = '2026-10'; month.dispatchEvent(new f.w.Event('change', {bubbles: true})); await settle();
    assert.equal(f.panel.querySelector('[data-cf-gen-status]').dataset.cfGenStatus, 'needs_input');
    const link = f.panel.querySelector('[data-cf-question-target="month.formats"]');
    assert.match(link.textContent, /«Пожелания на месяц» октябрь 2026 → «Форматы публикаций»/);
    const href = link.getAttribute('href');
    assert.equal(href, '#content-factory/settings?company=one&month=2026-10&focus=formats');
    // Сводка до запуска: ограничения месяца и противоречие Shorts видны заранее.
    assert.match(f.panel.querySelector('[data-cf-gen-limits]').textContent, /Ограничения месяца: форматы — только Пост; цели \(ОВП\) — все подходящие, без обязательных долей\./);
    assert.ok(f.panel.querySelector('[data-cf-gen-shorts]'));
    // Переход по ссылке (маршрутизатор кабинета отдаёт вид настроек; здесь отрисовываем его напрямую).
    f.w.location.hash = href.slice(1);
    await f.render();
    assert.equal(f.q('#cf-month').value, '2026-10', 'открыт месяц вопроса, а не текущий');
    const group = f.q('[data-cf-choice="formats"]');
    assert.ok(group.classList.contains('cf-focus'), 'группа форматов подсвечена');
    assert.equal(f.d.activeElement, f.q('[name="formats-mode"][value="some"]'), 'фокус на текущем выборе группы');
    assert.match(f.state(), /Уточните форматы месяца и сохраните\. План не составляется автоматически/);
    assert.equal(f.w.location.hash, '#content-factory/settings', 'параметры перехода использованы один раз');
    assert.equal(f.q('[data-cf-choice="roles"]').classList.contains('cf-focus'), false);
    assert.deepEqual(srv.writes(), [], 'вход и переход не пишут и не запускают составление');
    // Уточнение выбора само не запускает модель.
    f.change('[name="format"][value="reel"]', true);
    await f.save();
    assert.deepEqual(srv.writes().map((c) => `${c.method} ${c.path}`), ['PUT /media-mentor/inputs/months/2026-10']);
    await f.render();
    assert.equal(f.q('[data-cf-choice="formats"]').classList.contains('cf-focus'), false, 'повторная отрисовка не подсвечивает снова');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('переход из вопроса для другой компании не применяется; month.platforms подсвечивает площадки', async () => {
  const f = page({srv: server({months: {'2026-12': {revision: 1, inputs: {...LEGACY}}}})}); try {
    f.w.location.hash = 'content-factory/settings?company=two&month=2026-12&focus=formats';
    await f.render();
    assert.notEqual(f.q('#cf-month').value, '2026-12');
    assert.equal(f.qa('.cf-focus').length, 0);
    f.w.location.hash = 'content-factory/settings?company=one&month=2026-12&focus=platforms';
    await f.render();
    assert.equal(f.q('#cf-month').value, '2026-12');
    assert.ok(f.q('[data-cf-choice="platforms"]').classList.contains('cf-focus'));
    assert.match(f.state(), /Уточните площадки и объём месяца/);
    assert.deepEqual(f.srv.writes(), []);
  } finally { f.close(); }
});

test('сводка плана: пустой выбор назван «все подходящие», вход в сводку ничего не запускает', async () => {
  const srv = server({months: {'2026-10': {revision: 1, inputs: {...LEGACY, formats: [], roles: ['reach', 'sale']}}}});
  const f = page({srv}); try {
    await f.compose();
    const month = f.panel.querySelector('#cf-gen-month'); month.value = '2026-10'; month.dispatchEvent(new f.w.Event('change', {bubbles: true})); await settle();
    const limits = f.panel.querySelector('[data-cf-gen-limits]');
    assert.match(limits.textContent, /форматы — все подходящие для площадки; цели \(ОВП\) — только Охват, Продажи\./);
    assert.equal(limits.querySelector('a').getAttribute('href'), '#content-factory/settings?company=one&month=2026-10&focus=formats');
    assert.equal(f.panel.querySelector('[data-cf-gen-shorts]'), null);
    assert.ok(f.panel.querySelector('[data-cf-gen-limits]').compareDocumentPosition(f.panel.querySelector('[data-cf-gen="start"]')) & f.w.Node.DOCUMENT_POSITION_FOLLOWING,
      'ограничения стоят до кнопки запуска');
    assert.deepEqual(srv.writes(), [], 'вход в сводку не создаёт задач');
  } finally { f.close(); }
});
